from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator
import base64
import hashlib
import hmac
import json
import os
import secrets
import shutil
import sqlite3
from uuid import uuid4


DEFAULT_PROFILE = {
    "settings": {},
    "setup": {},
    "chartSetupUi": {},
    "chartTemplates": [],
    "activeTemplateId": "",
    "history": [],
}

NAUGHTY_WORDS = {
    "fuck",
    "shit",
    "bitch",
    "asshole",
    "cunt",
    "nigger",
    "faggot",
    "retard",
}


def validate_display_name(display_name: str) -> str:
    cleaned = " ".join(display_name.strip().split())
    if not 3 <= len(cleaned) <= 24:
        raise ValueError("Display name must be 3-24 characters.")
    allowed = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 _-.")
    if any(character not in allowed for character in cleaned):
        raise ValueError("Display name can only use letters, numbers, spaces, _, -, and periods.")
    lowered = cleaned.lower().replace(" ", "")
    if any(word in lowered for word in NAUGHTY_WORDS):
        raise ValueError("Choose a different display name.")
    return cleaned


def default_display_name(username: str) -> str:
    try:
        return validate_display_name(username)
    except ValueError:
        suffix = "".join(character for character in username if character.isalnum())[:10] or "User"
        return validate_display_name(f"Trader {suffix}")


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso_now() -> str:
    return utc_now().isoformat()


def hash_password(password: str) -> str:
    try:
        import bcrypt

        return "bcrypt$" + bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")
    except Exception:
        salt = secrets.token_bytes(16)
        digest = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=2**14, r=8, p=1, dklen=32)
        return "scrypt$" + base64.b64encode(salt).decode("ascii") + "$" + base64.b64encode(digest).decode("ascii")


def verify_password(password: str, password_hash: str) -> bool:
    if password_hash.startswith("bcrypt$"):
        try:
            import bcrypt

            return bcrypt.checkpw(password.encode("utf-8"), password_hash.removeprefix("bcrypt$").encode("utf-8"))
        except Exception:
            return False
    if password_hash.startswith("scrypt$"):
        try:
            _, salt_value, digest_value = password_hash.split("$", 2)
            salt = base64.b64decode(salt_value)
            expected = base64.b64decode(digest_value)
            actual = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=2**14, r=8, p=1, dklen=32)
            return hmac.compare_digest(actual, expected)
        except Exception:
            return False
    return False


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


class ProfileStore:
    def __init__(self, root_dir: Path) -> None:
        self.root_dir = root_dir
        self.database_url = os.getenv("DATABASE_URL", f"sqlite:///{root_dir / 'data' / 'app_state.sqlite3'}")
        self.is_postgres = self.database_url.startswith(("postgresql://", "postgres://"))

    @contextmanager
    def connection(self) -> Iterator[Any]:
        if self.is_postgres:
            import psycopg
            from psycopg.rows import dict_row

            with psycopg.connect(self.database_url, row_factory=dict_row) as conn:
                yield conn
        else:
            path = self.database_url.removeprefix("sqlite:///")
            Path(path).parent.mkdir(parents=True, exist_ok=True)
            conn = sqlite3.connect(path)
            conn.row_factory = sqlite3.Row
            try:
                yield conn
                conn.commit()
            finally:
                conn.close()

    def initialize(self) -> None:
        with self.connection() as conn:
            cursor = conn.cursor()
            if self.is_postgres:
                cursor.execute(
                    """
                    CREATE TABLE IF NOT EXISTS app_users (
                        id SERIAL PRIMARY KEY,
                        username TEXT UNIQUE NOT NULL,
                        display_name TEXT UNIQUE NOT NULL,
                        password_hash TEXT NOT NULL,
                        force_password_change BOOLEAN NOT NULL DEFAULT FALSE,
                        is_admin BOOLEAN NOT NULL DEFAULT FALSE,
                        created_at TIMESTAMPTZ NOT NULL,
                        updated_at TIMESTAMPTZ NOT NULL
                    )
                    """
                )
                cursor.execute(
                    """
                    CREATE TABLE IF NOT EXISTS user_profiles (
                        user_id INTEGER PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
                        settings_json JSONB NOT NULL DEFAULT '{}'::jsonb,
                        setup_json JSONB NOT NULL DEFAULT '{}'::jsonb,
                        chart_setup_ui_json JSONB NOT NULL DEFAULT '{}'::jsonb,
                        chart_templates_json JSONB NOT NULL DEFAULT '[]'::jsonb,
                        active_template_id TEXT NOT NULL DEFAULT '',
                        history_json JSONB NOT NULL DEFAULT '[]'::jsonb,
                        updated_at TIMESTAMPTZ NOT NULL
                    )
                    """
                )
                cursor.execute(
                    """
                    CREATE TABLE IF NOT EXISTS auth_sessions (
                        token_hash TEXT PRIMARY KEY,
                        user_id INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
                        created_at TIMESTAMPTZ NOT NULL,
                        expires_at TIMESTAMPTZ NOT NULL
                    )
                    """
                )
                cursor.execute("CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_id ON auth_sessions(user_id)")
                cursor.execute(
                    """
                    CREATE TABLE IF NOT EXISTS analytics_visitors (
                        visitor_id TEXT PRIMARY KEY,
                        user_id INTEGER REFERENCES app_users(id) ON DELETE SET NULL,
                        first_seen_at TIMESTAMPTZ NOT NULL,
                        last_seen_at TIMESTAMPTZ NOT NULL
                    )
                    """
                )
                cursor.execute(
                    """
                    CREATE TABLE IF NOT EXISTS analytics_visits (
                        visit_id TEXT PRIMARY KEY,
                        visitor_id TEXT NOT NULL REFERENCES analytics_visitors(visitor_id) ON DELETE CASCADE,
                        user_id INTEGER REFERENCES app_users(id) ON DELETE SET NULL,
                        started_at TIMESTAMPTZ NOT NULL,
                        last_seen_at TIMESTAMPTZ NOT NULL,
                        landing_path TEXT NOT NULL DEFAULT '/',
                        referrer TEXT NOT NULL DEFAULT '',
                        user_agent TEXT NOT NULL DEFAULT '',
                        event_count INTEGER NOT NULL DEFAULT 0
                    )
                    """
                )
                cursor.execute(
                    """
                    CREATE TABLE IF NOT EXISTS analytics_events (
                        id BIGSERIAL PRIMARY KEY,
                        visitor_id TEXT NOT NULL,
                        visit_id TEXT NOT NULL,
                        user_id INTEGER REFERENCES app_users(id) ON DELETE SET NULL,
                        event_name TEXT NOT NULL,
                        path TEXT NOT NULL DEFAULT '/',
                        payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
                        created_at TIMESTAMPTZ NOT NULL
                    )
                    """
                )
                cursor.execute("CREATE INDEX IF NOT EXISTS idx_analytics_events_created_at ON analytics_events(created_at)")
                cursor.execute("CREATE INDEX IF NOT EXISTS idx_analytics_events_name ON analytics_events(event_name)")
                cursor.execute("CREATE INDEX IF NOT EXISTS idx_analytics_visits_started_at ON analytics_visits(started_at)")
            else:
                cursor.execute(
                    """
                    CREATE TABLE IF NOT EXISTS app_users (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        username TEXT UNIQUE NOT NULL,
                        display_name TEXT UNIQUE NOT NULL,
                        password_hash TEXT NOT NULL,
                        force_password_change INTEGER NOT NULL DEFAULT 0,
                        is_admin INTEGER NOT NULL DEFAULT 0,
                        created_at TEXT NOT NULL,
                        updated_at TEXT NOT NULL
                    )
                    """
                )
                cursor.execute(
                    """
                    CREATE TABLE IF NOT EXISTS user_profiles (
                        user_id INTEGER PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
                        settings_json TEXT NOT NULL DEFAULT '{}',
                        setup_json TEXT NOT NULL DEFAULT '{}',
                        chart_setup_ui_json TEXT NOT NULL DEFAULT '{}',
                        chart_templates_json TEXT NOT NULL DEFAULT '[]',
                        active_template_id TEXT NOT NULL DEFAULT '',
                        history_json TEXT NOT NULL DEFAULT '[]',
                        updated_at TEXT NOT NULL
                    )
                    """
                )
                cursor.execute(
                    """
                    CREATE TABLE IF NOT EXISTS auth_sessions (
                        token_hash TEXT PRIMARY KEY,
                        user_id INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
                        created_at TEXT NOT NULL,
                        expires_at TEXT NOT NULL
                    )
                    """
                )
                cursor.execute("CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_id ON auth_sessions(user_id)")
                cursor.execute(
                    """
                    CREATE TABLE IF NOT EXISTS analytics_visitors (
                        visitor_id TEXT PRIMARY KEY,
                        user_id INTEGER REFERENCES app_users(id) ON DELETE SET NULL,
                        first_seen_at TEXT NOT NULL,
                        last_seen_at TEXT NOT NULL
                    )
                    """
                )
                cursor.execute(
                    """
                    CREATE TABLE IF NOT EXISTS analytics_visits (
                        visit_id TEXT PRIMARY KEY,
                        visitor_id TEXT NOT NULL REFERENCES analytics_visitors(visitor_id) ON DELETE CASCADE,
                        user_id INTEGER REFERENCES app_users(id) ON DELETE SET NULL,
                        started_at TEXT NOT NULL,
                        last_seen_at TEXT NOT NULL,
                        landing_path TEXT NOT NULL DEFAULT '/',
                        referrer TEXT NOT NULL DEFAULT '',
                        user_agent TEXT NOT NULL DEFAULT '',
                        event_count INTEGER NOT NULL DEFAULT 0
                    )
                    """
                )
                cursor.execute(
                    """
                    CREATE TABLE IF NOT EXISTS analytics_events (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        visitor_id TEXT NOT NULL,
                        visit_id TEXT NOT NULL,
                        user_id INTEGER REFERENCES app_users(id) ON DELETE SET NULL,
                        event_name TEXT NOT NULL,
                        path TEXT NOT NULL DEFAULT '/',
                        payload_json TEXT NOT NULL DEFAULT '{}',
                        created_at TEXT NOT NULL
                    )
                    """
                )
                cursor.execute("CREATE INDEX IF NOT EXISTS idx_analytics_events_created_at ON analytics_events(created_at)")
                cursor.execute("CREATE INDEX IF NOT EXISTS idx_analytics_events_name ON analytics_events(event_name)")
                cursor.execute("CREATE INDEX IF NOT EXISTS idx_analytics_visits_started_at ON analytics_visits(started_at)")
            self.ensure_user_columns(conn)
            self.ensure_default_user(conn)
            self.ensure_score_tables(conn)
            self.migrate_profile_history(conn)

    def ensure_score_tables(self, conn: Any) -> None:
        cursor = conn.cursor()
        if self.is_postgres:
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS score_entries (
                    score_id TEXT PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
                    migration_hash TEXT UNIQUE,
                    display_name_snapshot TEXT NOT NULL,
                    ticker TEXT NOT NULL,
                    asset_class TEXT NOT NULL,
                    scenario TEXT NOT NULL,
                    score DOUBLE PRECISION NOT NULL DEFAULT 0,
                    base_score DOUBLE PRECISION NOT NULL DEFAULT 0,
                    return_pct DOUBLE PRECISION NOT NULL DEFAULT 0,
                    final_pnl DOUBLE PRECISION NOT NULL DEFAULT 0,
                    max_drawdown_pct DOUBLE PRECISION NOT NULL DEFAULT 0,
                    number_of_trades INTEGER NOT NULL DEFAULT 0,
                    entry_timing_score DOUBLE PRECISION NOT NULL DEFAULT 0,
                    exit_timing_score DOUBLE PRECISION NOT NULL DEFAULT 0,
                    completed_at TIMESTAMPTZ,
                    created_at TIMESTAMPTZ NOT NULL,
                    detail_json JSONB NOT NULL DEFAULT '{}'::jsonb
                )
                """
            )
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS saved_replays (
                    user_id INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
                    score_id TEXT NOT NULL REFERENCES score_entries(score_id) ON DELETE CASCADE,
                    saved_at TIMESTAMPTZ NOT NULL,
                    PRIMARY KEY (user_id, score_id)
                )
                """
            )
        else:
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS score_entries (
                    score_id TEXT PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
                    migration_hash TEXT UNIQUE,
                    display_name_snapshot TEXT NOT NULL,
                    ticker TEXT NOT NULL,
                    asset_class TEXT NOT NULL,
                    scenario TEXT NOT NULL,
                    score REAL NOT NULL DEFAULT 0,
                    base_score REAL NOT NULL DEFAULT 0,
                    return_pct REAL NOT NULL DEFAULT 0,
                    final_pnl REAL NOT NULL DEFAULT 0,
                    max_drawdown_pct REAL NOT NULL DEFAULT 0,
                    number_of_trades INTEGER NOT NULL DEFAULT 0,
                    entry_timing_score REAL NOT NULL DEFAULT 0,
                    exit_timing_score REAL NOT NULL DEFAULT 0,
                    completed_at TEXT,
                    created_at TEXT NOT NULL,
                    detail_json TEXT NOT NULL DEFAULT '{}'
                )
                """
            )
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS saved_replays (
                    user_id INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
                    score_id TEXT NOT NULL REFERENCES score_entries(score_id) ON DELETE CASCADE,
                    saved_at TEXT NOT NULL,
                    PRIMARY KEY (user_id, score_id)
                )
                """
            )
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_score_entries_user_created ON score_entries(user_id, created_at DESC)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_score_entries_score ON score_entries(score DESC)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_score_entries_completed ON score_entries(completed_at DESC)")

    def migrate_profile_history(self, conn: Any) -> None:
        cursor = conn.cursor()
        rows = cursor.execute(
            """
            SELECT u.id, u.display_name, p.history_json
            FROM app_users u
            JOIN user_profiles p ON p.user_id = u.id
            """
        ).fetchall()
        for row in rows:
            history = self._json_value(row["history_json"], [])
            for item in history if isinstance(history, list) else []:
                if isinstance(item, dict) and item.get("hardcore") is True:
                    self.insert_score_entry(int(row["id"]), str(row["display_name"] or "Trader"), item, conn=conn, migration=True)

    def ensure_user_columns(self, conn: Any) -> None:
        cursor = conn.cursor()
        if self.is_postgres:
            cursor.execute("ALTER TABLE app_users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE")
            cursor.execute("ALTER TABLE app_users ADD COLUMN IF NOT EXISTS display_name TEXT")
            for row in cursor.execute("SELECT id, username FROM app_users WHERE display_name IS NULL OR display_name = ''").fetchall():
                cursor.execute("UPDATE app_users SET display_name = %s WHERE id = %s", [default_display_name(str(row["username"])), row["id"]])
            cursor.execute("ALTER TABLE app_users ALTER COLUMN display_name SET NOT NULL")
            cursor.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_app_users_display_name ON app_users (lower(display_name))")
            return
        rows = cursor.execute("PRAGMA table_info(app_users)").fetchall()
        if not any(str(row["name"]) == "is_admin" for row in rows):
            cursor.execute("ALTER TABLE app_users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0")
        if not any(str(row["name"]) == "display_name" for row in rows):
            cursor.execute("ALTER TABLE app_users ADD COLUMN display_name TEXT")
            for row in cursor.execute("SELECT id, username FROM app_users WHERE display_name IS NULL OR display_name = ''").fetchall():
                cursor.execute("UPDATE app_users SET display_name = ? WHERE id = ?", [default_display_name(str(row["username"])), row["id"]])
            cursor.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_app_users_display_name ON app_users (lower(display_name))")

    def ensure_default_user(self, conn: Any) -> None:
        username = os.getenv("DEFAULT_USERNAME", "1")
        password = os.getenv("DEFAULT_PASSWORD", "1")
        admin_username = os.getenv("DEFAULT_ADMIN_USERNAME", username)
        is_admin = username == admin_username
        existing = self.get_user_by_username(username, conn)
        if existing:
            if is_admin and not existing.get("isAdmin", False):
                self.set_user_admin(existing["id"], True, conn)
            return
        self.create_user(username, password, force_password_change=False, is_admin=is_admin, conn=conn)

    def _user_from_row(self, row: Any | None) -> dict[str, Any] | None:
        if not row:
            return None
        return {
            "id": int(row["id"]),
            "username": str(row["username"]),
            "displayName": str(row["display_name"] or row["username"]),
            "passwordHash": str(row["password_hash"]),
            "forcePasswordChange": bool(row["force_password_change"]),
            "isAdmin": bool(row["is_admin"]),
        }

    def get_user_by_username(self, username: str, conn: Any | None = None) -> dict[str, Any] | None:
        def run(connection: Any) -> dict[str, Any] | None:
            cursor = connection.cursor()
            placeholder = "%s" if self.is_postgres else "?"
            row = cursor.execute(f"SELECT * FROM app_users WHERE username = {placeholder}", [username]).fetchone()
            return self._user_from_row(row)

        if conn is not None:
            return run(conn)
        with self.connection() as connection:
            return run(connection)

    def get_user_by_id(self, user_id: int) -> dict[str, Any] | None:
        with self.connection() as conn:
            cursor = conn.cursor()
            placeholder = "%s" if self.is_postgres else "?"
            row = cursor.execute(f"SELECT * FROM app_users WHERE id = {placeholder}", [user_id]).fetchone()
            return self._user_from_row(row)

    def get_user_by_display_name(self, display_name: str, conn: Any | None = None) -> dict[str, Any] | None:
        cleaned = validate_display_name(display_name)

        def run(connection: Any) -> dict[str, Any] | None:
            cursor = connection.cursor()
            placeholder = "%s" if self.is_postgres else "?"
            row = cursor.execute(f"SELECT * FROM app_users WHERE lower(display_name) = lower({placeholder})", [cleaned]).fetchone()
            return self._user_from_row(row)

        if conn is not None:
            return run(conn)
        with self.connection() as connection:
            return run(connection)

    def create_user(
        self,
        username: str,
        password: str,
        force_password_change: bool,
        is_admin: bool = False,
        conn: Any | None = None,
    ) -> dict[str, Any]:
        def run(connection: Any) -> dict[str, Any]:
            now = iso_now()
            cursor = connection.cursor()
            if self.is_postgres:
                row = cursor.execute(
                    """
                    INSERT INTO app_users (username, display_name, password_hash, force_password_change, is_admin, created_at, updated_at)
                    VALUES (%s, %s, %s, %s, %s, %s, %s)
                    RETURNING *
                    """,
                    [username, default_display_name(username), hash_password(password), force_password_change, is_admin, now, now],
                ).fetchone()
            else:
                cursor.execute(
                    """
                    INSERT INTO app_users (username, display_name, password_hash, force_password_change, is_admin, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    [username, default_display_name(username), hash_password(password), int(force_password_change), int(is_admin), now, now],
                )
                row = cursor.execute("SELECT * FROM app_users WHERE id = ?", [cursor.lastrowid]).fetchone()
            user = self._user_from_row(row)
            assert user is not None
            self.ensure_profile(user["id"], connection)
            return user

        if conn is not None:
            return run(conn)
        with self.connection() as connection:
            return run(connection)

    def update_display_name(self, user_id: int, display_name: str) -> dict[str, Any]:
        cleaned = validate_display_name(display_name)
        with self.connection() as conn:
            existing = self.get_user_by_display_name(cleaned, conn)
            if existing and existing["id"] != user_id:
                raise ValueError("Display name is already taken.")
            placeholder = "%s" if self.is_postgres else "?"
            conn.cursor().execute(
                f"UPDATE app_users SET display_name = {placeholder}, updated_at = {placeholder} WHERE id = {placeholder}",
                [cleaned, iso_now(), user_id],
            )
        user = self.get_user_by_id(user_id)
        assert user is not None
        return user

    def set_user_admin(self, user_id: int, is_admin: bool, conn: Any | None = None) -> None:
        def run(connection: Any) -> None:
            placeholder = "%s" if self.is_postgres else "?"
            connection.cursor().execute(
                f"UPDATE app_users SET is_admin = {placeholder}, updated_at = {placeholder} WHERE id = {placeholder}",
                [is_admin if self.is_postgres else int(is_admin), iso_now(), user_id],
            )

        if conn is not None:
            run(conn)
            return
        with self.connection() as connection:
            run(connection)

    def ensure_profile(self, user_id: int, conn: Any) -> None:
        cursor = conn.cursor()
        now = iso_now()
        if self.is_postgres:
            cursor.execute(
                """
                INSERT INTO user_profiles (user_id, updated_at)
                VALUES (%s, %s)
                ON CONFLICT (user_id) DO NOTHING
                """,
                [user_id, now],
            )
        else:
            cursor.execute("INSERT OR IGNORE INTO user_profiles (user_id, updated_at) VALUES (?, ?)", [user_id, now])

    def create_session(self, user_id: int, days: int = 30) -> str:
        token = secrets.token_urlsafe(32)
        now = utc_now()
        expires_at = now + timedelta(days=days)
        with self.connection() as conn:
            cursor = conn.cursor()
            if self.is_postgres:
                cursor.execute(
                    "INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at) VALUES (%s, %s, %s, %s)",
                    [token_hash(token), user_id, now.isoformat(), expires_at.isoformat()],
                )
            else:
                cursor.execute(
                    "INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
                    [token_hash(token), user_id, now.isoformat(), expires_at.isoformat()],
                )
        return token

    def user_for_session(self, token: str | None) -> dict[str, Any] | None:
        if not token:
            return None
        now = iso_now()
        with self.connection() as conn:
            cursor = conn.cursor()
            placeholder = "%s" if self.is_postgres else "?"
            row = cursor.execute(
                f"""
                SELECT u.*
                FROM auth_sessions s
                JOIN app_users u ON u.id = s.user_id
                WHERE s.token_hash = {placeholder} AND s.expires_at > {placeholder}
                """,
                [token_hash(token), now],
            ).fetchone()
            return self._user_from_row(row)

    def delete_session(self, token: str | None) -> None:
        if not token:
            return
        with self.connection() as conn:
            placeholder = "%s" if self.is_postgres else "?"
            conn.cursor().execute(f"DELETE FROM auth_sessions WHERE token_hash = {placeholder}", [token_hash(token)])

    def get_profile(self, user_id: int) -> dict[str, Any]:
        with self.connection() as conn:
            self.ensure_profile(user_id, conn)
            cursor = conn.cursor()
            placeholder = "%s" if self.is_postgres else "?"
            row = cursor.execute(f"SELECT * FROM user_profiles WHERE user_id = {placeholder}", [user_id]).fetchone()
            if not row:
                return dict(DEFAULT_PROFILE)
            return {
                "settings": self._json_value(row["settings_json"], {}),
                "setup": self._json_value(row["setup_json"], {}),
                "chartSetupUi": self._json_value(row["chart_setup_ui_json"], {}),
                "chartTemplates": self._json_value(row["chart_templates_json"], []),
                "activeTemplateId": row["active_template_id"] or "",
                "history": self._json_value(row["history_json"], []),
            }

    def update_profile(self, user_id: int, profile: dict[str, Any]) -> dict[str, Any]:
        next_profile = {
            "settings": profile.get("settings", {}),
            "setup": profile.get("setup", {}),
            "chartSetupUi": profile.get("chartSetupUi", {}),
            "chartTemplates": profile.get("chartTemplates", []),
            "activeTemplateId": profile.get("activeTemplateId", ""),
        }
        with self.connection() as conn:
            self.ensure_profile(user_id, conn)
            cursor = conn.cursor()
            now = iso_now()
            if self.is_postgres:
                from psycopg.types.json import Jsonb

                cursor.execute(
                    """
                    UPDATE user_profiles
                    SET settings_json = %s,
                        setup_json = %s,
                        chart_setup_ui_json = %s,
                        chart_templates_json = %s,
                        active_template_id = %s,
                        updated_at = %s
                    WHERE user_id = %s
                    """,
                    [
                        Jsonb(next_profile["settings"]),
                        Jsonb(next_profile["setup"]),
                        Jsonb(next_profile["chartSetupUi"]),
                        Jsonb(next_profile["chartTemplates"]),
                        str(next_profile["activeTemplateId"]),
                        now,
                        user_id,
                    ],
                )
            else:
                cursor.execute(
                    """
                    UPDATE user_profiles
                    SET settings_json = ?,
                        setup_json = ?,
                        chart_setup_ui_json = ?,
                        chart_templates_json = ?,
                        active_template_id = ?,
                        updated_at = ?
                    WHERE user_id = ?
                    """,
                    [
                        json.dumps(next_profile["settings"]),
                        json.dumps(next_profile["setup"]),
                        json.dumps(next_profile["chartSetupUi"]),
                        json.dumps(next_profile["chartTemplates"]),
                        str(next_profile["activeTemplateId"]),
                        now,
                        user_id,
                    ],
                )
        return self.get_profile(user_id)

    def _json_value(self, value: Any, fallback: Any) -> Any:
        if value is None:
            return fallback
        if isinstance(value, (dict, list)):
            return value
        try:
            return json.loads(value)
        except Exception:
            return fallback

    def record_visit(self, visitor_id: str, visit_id: str, path: str, referrer: str, user_agent: str, user_id: int | None = None) -> None:
        now = iso_now()
        clean_path = (path or "/")[:400]
        clean_referrer = (referrer or "")[:500]
        clean_user_agent = (user_agent or "")[:500]
        with self.connection() as conn:
            cursor = conn.cursor()
            if self.is_postgres:
                cursor.execute(
                    """
                    INSERT INTO analytics_visitors (visitor_id, user_id, first_seen_at, last_seen_at)
                    VALUES (%s, %s, %s, %s)
                    ON CONFLICT (visitor_id) DO UPDATE
                    SET last_seen_at = EXCLUDED.last_seen_at,
                        user_id = COALESCE(EXCLUDED.user_id, analytics_visitors.user_id)
                    """,
                    [visitor_id, user_id, now, now],
                )
                cursor.execute(
                    """
                    INSERT INTO analytics_visits (visit_id, visitor_id, user_id, started_at, last_seen_at, landing_path, referrer, user_agent)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (visit_id) DO UPDATE
                    SET last_seen_at = EXCLUDED.last_seen_at,
                        user_id = COALESCE(EXCLUDED.user_id, analytics_visits.user_id)
                    """,
                    [visit_id, visitor_id, user_id, now, now, clean_path, clean_referrer, clean_user_agent],
                )
            else:
                cursor.execute(
                    """
                    INSERT OR IGNORE INTO analytics_visitors (visitor_id, user_id, first_seen_at, last_seen_at)
                    VALUES (?, ?, ?, ?)
                    """,
                    [visitor_id, user_id, now, now],
                )
                cursor.execute(
                    """
                    UPDATE analytics_visitors
                    SET last_seen_at = ?, user_id = COALESCE(?, user_id)
                    WHERE visitor_id = ?
                    """,
                    [now, user_id, visitor_id],
                )
                cursor.execute(
                    """
                    INSERT OR IGNORE INTO analytics_visits (visit_id, visitor_id, user_id, started_at, last_seen_at, landing_path, referrer, user_agent)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    [visit_id, visitor_id, user_id, now, now, clean_path, clean_referrer, clean_user_agent],
                )
                cursor.execute(
                    """
                    UPDATE analytics_visits
                    SET last_seen_at = ?, user_id = COALESCE(?, user_id)
                    WHERE visit_id = ?
                    """,
                    [now, user_id, visit_id],
                )

    def record_event(self, visitor_id: str, visit_id: str, event_name: str, path: str, payload: dict[str, Any] | None = None, user_id: int | None = None) -> None:
        now = iso_now()
        clean_payload = self._safe_payload(payload or {})
        clean_event = event_name[:80]
        clean_path = (path or "/")[:400]
        with self.connection() as conn:
            cursor = conn.cursor()
            if self.is_postgres:
                from psycopg.types.json import Jsonb

                cursor.execute(
                    """
                    INSERT INTO analytics_events (visitor_id, visit_id, user_id, event_name, path, payload_json, created_at)
                    VALUES (%s, %s, %s, %s, %s, %s, %s)
                    """,
                    [visitor_id, visit_id, user_id, clean_event, clean_path, Jsonb(clean_payload), now],
                )
                cursor.execute(
                    """
                    UPDATE analytics_visits
                    SET last_seen_at = %s,
                        user_id = COALESCE(%s, user_id),
                        event_count = event_count + 1
                    WHERE visit_id = %s
                    """,
                    [now, user_id, visit_id],
                )
                cursor.execute(
                    "UPDATE analytics_visitors SET last_seen_at = %s, user_id = COALESCE(%s, user_id) WHERE visitor_id = %s",
                    [now, user_id, visitor_id],
                )
            else:
                cursor.execute(
                    """
                    INSERT INTO analytics_events (visitor_id, visit_id, user_id, event_name, path, payload_json, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    [visitor_id, visit_id, user_id, clean_event, clean_path, json.dumps(clean_payload), now],
                )
                cursor.execute(
                    """
                    UPDATE analytics_visits
                    SET last_seen_at = ?, user_id = COALESCE(?, user_id), event_count = event_count + 1
                    WHERE visit_id = ?
                    """,
                    [now, user_id, visit_id],
                )
                cursor.execute(
                    "UPDATE analytics_visitors SET last_seen_at = ?, user_id = COALESCE(?, user_id) WHERE visitor_id = ?",
                    [now, user_id, visitor_id],
                )

    def analytics_dashboard(self) -> dict[str, Any]:
        now = utc_now()
        cutoff_1d = (now - timedelta(days=1)).isoformat()
        cutoff_7d = (now - timedelta(days=7)).isoformat()
        cutoff_14d = (now - timedelta(days=14)).isoformat()
        cutoff_30d = (now - timedelta(days=30)).isoformat()
        with self.connection() as conn:
            return {
                "generatedAt": now.isoformat(),
                "totals": {
                    "users": self._count(conn, "SELECT COUNT(*) FROM app_users"),
                    "visitors": self._count(conn, "SELECT COUNT(*) FROM analytics_visitors"),
                    "visits": self._count(conn, "SELECT COUNT(*) FROM analytics_visits"),
                    "events": self._count(conn, "SELECT COUNT(*) FROM analytics_events"),
                },
                "activeUsers": {
                    "day": self._count(conn, "SELECT COUNT(DISTINCT user_id) FROM analytics_events WHERE user_id IS NOT NULL AND created_at >= {}", [cutoff_1d]),
                    "week": self._count(conn, "SELECT COUNT(DISTINCT user_id) FROM analytics_events WHERE user_id IS NOT NULL AND created_at >= {}", [cutoff_7d]),
                    "month": self._count(conn, "SELECT COUNT(DISTINCT user_id) FROM analytics_events WHERE user_id IS NOT NULL AND created_at >= {}", [cutoff_30d]),
                },
                "visitCounts": {
                    "day": self._count(conn, "SELECT COUNT(*) FROM analytics_visits WHERE started_at >= {}", [cutoff_1d]),
                    "week": self._count(conn, "SELECT COUNT(*) FROM analytics_visits WHERE started_at >= {}", [cutoff_7d]),
                    "month": self._count(conn, "SELECT COUNT(*) FROM analytics_visits WHERE started_at >= {}", [cutoff_30d]),
                },
                "visitsByDay": self._visits_by_day(conn, cutoff_14d),
                "visitsByHour": self._visits_by_hour(conn, cutoff_7d),
                "eventsByName": self._events_by_name(conn, cutoff_30d),
                "topPages": self._top_pages(conn, cutoff_30d),
                "funnel": self._funnel(conn, cutoff_30d),
                "serverLoad": self.server_load_snapshot(),
            }

    def insert_score_entry(
        self,
        user_id: int,
        display_name: str,
        scorecard: dict[str, Any],
        replay_metadata: dict[str, Any] | None = None,
        trades: list[dict[str, Any]] | None = None,
        conn: Any | None = None,
        migration: bool = False,
    ) -> dict[str, Any]:
        def run(connection: Any) -> dict[str, Any]:
            now = iso_now()
            migration_hash = self._score_migration_hash(user_id, scorecard) if migration else None
            if migration_hash and self._score_exists(connection, migration_hash):
                existing = self._score_by_migration_hash(connection, migration_hash)
                return existing if existing else scorecard
            completed_at = self._score_completed_at(scorecard, now, migration)
            score_id = str(scorecard.get("scoreId") or uuid4().hex)
            detail = {
                "scorecard": scorecard,
                "replayMetadata": replay_metadata or {},
                "trades": trades or [],
            }
            params = [
                score_id,
                user_id,
                migration_hash,
                display_name,
                str(scorecard.get("ticker", "")),
                str(scorecard.get("assetClass", "")),
                str(scorecard.get("scenario", "Random")),
                float(scorecard.get("score", 0) or 0),
                float(scorecard.get("baseScore", scorecard.get("score", 0)) or 0),
                float(scorecard.get("returnPct", 0) or 0),
                float(scorecard.get("finalPnl", 0) or 0),
                float(scorecard.get("maxDrawdownPct", 0) or 0),
                int(scorecard.get("numberOfTrades", 0) or 0),
                float(scorecard.get("entryTimingScore", 0) or 0),
                float(scorecard.get("exitTimingScore", 0) or 0),
                completed_at,
                now,
            ]
            cursor = connection.cursor()
            if self.is_postgres:
                from psycopg.types.json import Jsonb

                cursor.execute(
                    """
                    INSERT INTO score_entries (
                        score_id, user_id, migration_hash, display_name_snapshot, ticker, asset_class, scenario,
                        score, base_score, return_pct, final_pnl, max_drawdown_pct, number_of_trades,
                        entry_timing_score, exit_timing_score, completed_at, created_at, detail_json
                    )
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (score_id) DO NOTHING
                    """,
                    [*params, Jsonb(detail)],
                )
            else:
                cursor.execute(
                    """
                    INSERT OR IGNORE INTO score_entries (
                        score_id, user_id, migration_hash, display_name_snapshot, ticker, asset_class, scenario,
                        score, base_score, return_pct, final_pnl, max_drawdown_pct, number_of_trades,
                        entry_timing_score, exit_timing_score, completed_at, created_at, detail_json
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    [*params, json.dumps(detail)],
                )
            inserted = self._score_by_id(connection, score_id)
            return inserted if inserted else {**scorecard, "scoreId": score_id}

        if conn is not None:
            return run(conn)
        with self.connection() as connection:
            return run(connection)

    def scoreboard_dashboard(self, user_id: int) -> dict[str, Any]:
        now = utc_now()
        cutoff_31d = (now - timedelta(days=31)).isoformat()
        cutoff_252d = (now - timedelta(days=252)).isoformat()
        with self.connection() as conn:
            placeholder = self._placeholder()
            personal = self._score_rows(conn, f"WHERE user_id = {placeholder}", [user_id], "created_at DESC", 50)
            return {
                "personal": personal,
                "global31d": self._leaderboard(conn, "score", cutoff_31d),
                "global252d": self._leaderboard(conn, "score", cutoff_252d),
                "replays": self._saved_replay_rows(conn, user_id),
                "metrics": {
                    "score": self._leaderboard(conn, "score", None),
                    "returnPct": self._leaderboard(conn, "return_pct", None),
                    "finalPnl": self._leaderboard(conn, "final_pnl", None),
                    "entryTimingScore": self._leaderboard(conn, "entry_timing_score", None),
                    "exitTimingScore": self._leaderboard(conn, "exit_timing_score", None),
                },
            }

    def save_replay(self, user_id: int, score_id: str) -> None:
        with self.connection() as conn:
            if not self._score_belongs_to_user(conn, user_id, score_id):
                raise ValueError("Score entry not found.")
            now = iso_now()
            cursor = conn.cursor()
            if self.is_postgres:
                cursor.execute(
                    """
                    INSERT INTO saved_replays (user_id, score_id, saved_at)
                    VALUES (%s, %s, %s)
                    ON CONFLICT (user_id, score_id) DO UPDATE SET saved_at = EXCLUDED.saved_at
                    """,
                    [user_id, score_id, now],
                )
                cursor.execute(
                    """
                    DELETE FROM saved_replays
                    WHERE user_id = %s AND score_id NOT IN (
                        SELECT score_id FROM saved_replays WHERE user_id = %s ORDER BY saved_at DESC LIMIT 20
                    )
                    """,
                    [user_id, user_id],
                )
            else:
                cursor.execute(
                    """
                    INSERT OR REPLACE INTO saved_replays (user_id, score_id, saved_at)
                    VALUES (?, ?, ?)
                    """,
                    [user_id, score_id, now],
                )
                cursor.execute(
                    """
                    DELETE FROM saved_replays
                    WHERE user_id = ? AND score_id NOT IN (
                        SELECT score_id FROM saved_replays WHERE user_id = ? ORDER BY saved_at DESC LIMIT 20
                    )
                    """,
                    [user_id, user_id],
                )

    def delete_replay(self, user_id: int, score_id: str) -> None:
        with self.connection() as conn:
            placeholder = self._placeholder()
            conn.cursor().execute(f"DELETE FROM saved_replays WHERE user_id = {placeholder} AND score_id = {placeholder}", [user_id, score_id])

    def _score_completed_at(self, scorecard: dict[str, Any], fallback: str, migration: bool) -> str | None:
        value = scorecard.get("completedAt")
        parsed = self._parse_score_date(value)
        if parsed:
            return parsed.isoformat()
        return None if migration else fallback

    def _score_migration_hash(self, user_id: int, scorecard: dict[str, Any]) -> str:
        parts = [
            str(user_id),
            str(scorecard.get("ticker", "")),
            str(scorecard.get("scenario", "")),
            str(scorecard.get("completedAt") or scorecard.get("date") or ""),
            str(scorecard.get("score", "")),
            str(scorecard.get("finalPnl", "")),
        ]
        return hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()

    def _score_exists(self, conn: Any, migration_hash: str) -> bool:
        placeholder = self._placeholder()
        row = conn.cursor().execute(f"SELECT 1 FROM score_entries WHERE migration_hash = {placeholder}", [migration_hash]).fetchone()
        return bool(row)

    def _score_by_migration_hash(self, conn: Any, migration_hash: str) -> dict[str, Any] | None:
        placeholder = self._placeholder()
        rows = self._score_rows(conn, f"WHERE migration_hash = {placeholder}", [migration_hash], "created_at DESC", 1)
        return rows[0] if rows else None

    def _score_by_id(self, conn: Any, score_id: str) -> dict[str, Any] | None:
        placeholder = self._placeholder()
        rows = self._score_rows(conn, f"WHERE score_id = {placeholder}", [score_id], "created_at DESC", 1)
        return rows[0] if rows else None

    def _score_belongs_to_user(self, conn: Any, user_id: int, score_id: str) -> bool:
        placeholder = self._placeholder()
        row = conn.cursor().execute(
            f"SELECT 1 FROM score_entries WHERE user_id = {placeholder} AND score_id = {placeholder}",
            [user_id, score_id],
        ).fetchone()
        return bool(row)

    def _score_rows(self, conn: Any, where_sql: str, params: list[Any], order_by: str, limit: int) -> list[dict[str, Any]]:
        query = f"""
            SELECT score_id, user_id, display_name_snapshot, ticker, asset_class, scenario,
                   score, base_score, return_pct, final_pnl, max_drawdown_pct, number_of_trades,
                   entry_timing_score, exit_timing_score, completed_at, created_at, detail_json
            FROM score_entries
            {where_sql}
            ORDER BY {order_by}
            LIMIT {int(limit)}
        """
        rows = conn.cursor().execute(query, params).fetchall()
        return [self._score_row_to_payload(row) for row in rows]

    def _score_row_to_payload(self, row: Any, rank: int | None = None, metric: str | None = None) -> dict[str, Any]:
        detail = self._json_value(row["detail_json"], {})
        scorecard = detail.get("scorecard", {}) if isinstance(detail, dict) else {}
        payload = {
            **scorecard,
            "scoreId": row["score_id"],
            "userId": int(row["user_id"]),
            "displayName": row["display_name_snapshot"],
            "ticker": row["ticker"],
            "assetClass": row["asset_class"],
            "scenario": row["scenario"],
            "score": float(row["score"]),
            "baseScore": float(row["base_score"]),
            "returnPct": float(row["return_pct"]),
            "finalPnl": float(row["final_pnl"]),
            "maxDrawdownPct": float(row["max_drawdown_pct"]),
            "numberOfTrades": int(row["number_of_trades"]),
            "entryTimingScore": float(row["entry_timing_score"]),
            "exitTimingScore": float(row["exit_timing_score"]),
            "completedAt": row["completed_at"],
            "createdAt": row["created_at"],
            "hardcore": True,
        }
        if rank is not None:
            payload["rank"] = rank
        if metric:
            payload["metric"] = metric
            payload["value"] = float(payload.get(metric, 0) or 0)
        return payload

    def _leaderboard(self, conn: Any, column: str, cutoff: str | None, limit: int = 20) -> list[dict[str, Any]]:
        metric_map = {
            "score": "score",
            "return_pct": "returnPct",
            "final_pnl": "finalPnl",
            "entry_timing_score": "entryTimingScore",
            "exit_timing_score": "exitTimingScore",
        }
        where_sql = "WHERE completed_at IS NOT NULL"
        params: list[Any] = []
        if cutoff:
            where_sql += f" AND completed_at >= {self._placeholder()}"
            params.append(cutoff)
        rows = self._score_rows(conn, where_sql, params, f"{column} DESC, created_at DESC", limit)
        metric = metric_map.get(column, column)
        return [{**row, "rank": index + 1, "metric": metric, "value": float(row.get(metric, 0) or 0)} for index, row in enumerate(rows)]

    def _saved_replay_rows(self, conn: Any, user_id: int) -> list[dict[str, Any]]:
        placeholder = self._placeholder()
        rows = conn.cursor().execute(
            f"""
            SELECT e.score_id, e.user_id, e.display_name_snapshot, e.ticker, e.asset_class, e.scenario,
                   e.score, e.base_score, e.return_pct, e.final_pnl, e.max_drawdown_pct, e.number_of_trades,
                   e.entry_timing_score, e.exit_timing_score, e.completed_at, e.created_at, e.detail_json,
                   r.saved_at
            FROM saved_replays r
            JOIN score_entries e ON e.score_id = r.score_id
            WHERE r.user_id = {placeholder}
            ORDER BY r.saved_at DESC
            LIMIT 20
            """,
            [user_id],
        ).fetchall()
        payload = []
        for row in rows:
            item = self._score_row_to_payload(row)
            item["savedAt"] = row["saved_at"]
            payload.append(item)
        return payload

    def _parse_score_date(self, value: Any) -> datetime | None:
        if not value or not isinstance(value, str) or value in {"Hidden", "2000-01-03"}:
            return None
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None

    def server_load_snapshot(self) -> dict[str, Any]:
        usage = shutil.disk_usage(self.root_dir)
        load_avg = None
        try:
            load_avg = os.getloadavg()
        except (AttributeError, OSError):
            load_avg = None
        return {
            "disk": {
                "totalBytes": usage.total,
                "usedBytes": usage.used,
                "freeBytes": usage.free,
                "usedPct": round((usage.used / max(usage.total, 1)) * 100, 2),
            },
            "loadAverage": list(load_avg) if load_avg else [],
            "cpuCount": os.cpu_count() or 0,
        }

    def _placeholder(self) -> str:
        return "%s" if self.is_postgres else "?"

    def _query_with_placeholders(self, sql: str) -> str:
        return sql.format(self._placeholder())

    def _count(self, conn: Any, sql: str, params: list[Any] | None = None) -> int:
        cursor = conn.cursor()
        query = self._query_with_placeholders(sql) if "{}" in sql else sql
        row = cursor.execute(query, params or []).fetchone()
        if not row:
            return 0
        return int(row[0] if not isinstance(row, dict) else next(iter(row.values())))

    def _visits_by_day(self, conn: Any, cutoff: str) -> list[dict[str, Any]]:
        cursor = conn.cursor()
        placeholder = self._placeholder()
        if self.is_postgres:
            query = f"""
                SELECT started_at::date::text AS day,
                       COUNT(*) AS visits,
                       COUNT(DISTINCT visitor_id) AS visitors,
                       COUNT(DISTINCT user_id) AS users
                FROM analytics_visits
                WHERE started_at >= {placeholder}
                GROUP BY day
                ORDER BY day
            """
        else:
            query = f"""
                SELECT substr(started_at, 1, 10) AS day,
                       COUNT(*) AS visits,
                       COUNT(DISTINCT visitor_id) AS visitors,
                       COUNT(DISTINCT user_id) AS users
                FROM analytics_visits
                WHERE started_at >= {placeholder}
                GROUP BY day
                ORDER BY day
            """
        return [
            {"day": row["day"], "visits": int(row["visits"]), "visitors": int(row["visitors"]), "users": int(row["users"])}
            for row in cursor.execute(query, [cutoff]).fetchall()
        ]

    def _visits_by_hour(self, conn: Any, cutoff: str) -> list[dict[str, Any]]:
        cursor = conn.cursor()
        placeholder = self._placeholder()
        if self.is_postgres:
            query = f"""
                SELECT EXTRACT(HOUR FROM started_at)::int AS hour,
                       COUNT(*) AS visits
                FROM analytics_visits
                WHERE started_at >= {placeholder}
                GROUP BY hour
                ORDER BY hour
            """
        else:
            query = f"""
                SELECT CAST(substr(started_at, 12, 2) AS INTEGER) AS hour,
                       COUNT(*) AS visits
                FROM analytics_visits
                WHERE started_at >= {placeholder}
                GROUP BY hour
                ORDER BY hour
            """
        return [{"hour": int(row["hour"]), "visits": int(row["visits"])} for row in cursor.execute(query, [cutoff]).fetchall()]

    def _events_by_name(self, conn: Any, cutoff: str) -> list[dict[str, Any]]:
        cursor = conn.cursor()
        placeholder = self._placeholder()
        rows = cursor.execute(
            f"""
            SELECT event_name, COUNT(*) AS count
            FROM analytics_events
            WHERE created_at >= {placeholder}
            GROUP BY event_name
            ORDER BY count DESC, event_name
            LIMIT 10
            """,
            [cutoff],
        ).fetchall()
        return [{"name": row["event_name"], "count": int(row["count"])} for row in rows]

    def _top_pages(self, conn: Any, cutoff: str) -> list[dict[str, Any]]:
        cursor = conn.cursor()
        placeholder = self._placeholder()
        rows = cursor.execute(
            f"""
            SELECT path, COUNT(*) AS count
            FROM analytics_events
            WHERE created_at >= {placeholder} AND event_name = 'page_view'
            GROUP BY path
            ORDER BY count DESC, path
            LIMIT 8
            """,
            [cutoff],
        ).fetchall()
        return [{"path": row["path"], "count": int(row["count"])} for row in rows]

    def _funnel(self, conn: Any, cutoff: str) -> list[dict[str, Any]]:
        steps = [
            ("Visits", "SELECT COUNT(*) FROM analytics_visits WHERE started_at >= {}"),
            ("Logins", "SELECT COUNT(*) FROM analytics_events WHERE created_at >= {} AND event_name = 'login_success'"),
            ("Session Starts", "SELECT COUNT(*) FROM analytics_events WHERE created_at >= {} AND event_name = 'session_started'"),
            ("Completions", "SELECT COUNT(*) FROM analytics_events WHERE created_at >= {} AND event_name = 'session_completed'"),
        ]
        return [{"label": label, "count": self._count(conn, query, [cutoff])} for label, query in steps]

    def _safe_payload(self, payload: dict[str, Any]) -> dict[str, Any]:
        blocked = ("password", "token", "cookie", "secret", "auth")

        def clean(value: Any, depth: int = 0) -> Any:
            if depth > 3:
                return None
            if isinstance(value, dict):
                return {
                    str(key)[:80]: clean(item, depth + 1)
                    for key, item in value.items()
                    if not any(part in str(key).lower() for part in blocked)
                }
            if isinstance(value, list):
                return [clean(item, depth + 1) for item in value[:20]]
            if isinstance(value, (str, int, float, bool)) or value is None:
                return value[:300] if isinstance(value, str) else value
            return str(value)[:300]

        cleaned = clean(payload)
        return cleaned if isinstance(cleaned, dict) else {}
