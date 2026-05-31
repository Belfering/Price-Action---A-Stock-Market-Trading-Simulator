from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import duckdb
import pandas as pd


REQUIRED_COLUMNS = ["timestamp", "open", "high", "low", "close", "volume"]
REGULAR_SESSION_BARS = 390
ASSET_CLASS_TICKERS = {
    "Equity": ["SPY", "QQQ", "IWM", "DIA", "SMH", "XLF", "XLE", "XLV", "XBI", "XLP", "XLU", "XLRE"],
    "Bond": ["TLT", "HYG", "JNK", "EMB"],
    "Commodity": ["GLD", "SLV", "USO", "UNG"],
    "Crypto": ["BTCUSD", "ETHUSD"],
    "Forex": ["EURUSD", "USDJPY", "GBPUSD", "AUDUSD", "USDCAD"],
    "Volatility": ["VIXY", "SVXY", "UVXY"],
    "Leveraged": ["TQQQ", "UPRO", "SOXL", "FAS", "LABU", "NUGT", "UCO", "TMF"],
    "Inverse": ["SQQQ", "SPXU", "SOXS", "FAZ", "LABD"],
}
SYMBOL_ASSET_CLASS = {
    symbol: asset_class
    for asset_class, symbols in ASSET_CLASS_TICKERS.items()
    for symbol in symbols
}
SYMBOL_DESCRIPTIONS = {
    "SPY": "S&P 500",
    "QQQ": "NASDAQ",
    "IWM": "Small caps",
    "DIA": "Dow 30",
    "SMH": "Semiconductors",
    "XLF": "Financials",
    "XLE": "Energy",
    "XLV": "Health care",
    "XBI": "Biotech",
    "XLP": "Staples",
    "XLU": "Utilities",
    "XLRE": "Real estate",
    "TLT": "Long bonds",
    "HYG": "High yield",
    "JNK": "Junk bonds",
    "EMB": "EM bonds",
    "GLD": "Gold",
    "SLV": "Silver",
    "USO": "Oil",
    "UNG": "Natural gas",
    "BTCUSD": "Bitcoin",
    "ETHUSD": "Ethereum",
    "EURUSD": "Euro",
    "USDJPY": "Yen",
    "GBPUSD": "Pound",
    "AUDUSD": "Aussie",
    "USDCAD": "Canada",
    "VIXY": "Long VIX",
    "SVXY": "Short VIX",
    "UVXY": "2x VIX",
    "TQQQ": "3x NASDAQ",
    "UPRO": "3x S&P 500",
    "SOXL": "3x semis",
    "FAS": "3x financials",
    "LABU": "3x biotech",
    "NUGT": "2x gold miners",
    "UCO": "2x oil",
    "TMF": "3x long bonds",
    "SQQQ": "Inverse NASDAQ",
    "SPXU": "Inverse S&P",
    "SOXS": "Inverse semis",
    "FAZ": "Inverse financials",
    "LABD": "Inverse biotech",
}


def sanitize_ohlc_outliers(df: pd.DataFrame) -> pd.DataFrame:
    """Repair isolated bad high/low prints that would distort normalized charts."""
    if df.empty:
        return df.copy()

    repaired = df.copy()
    for column in ["open", "high", "low", "close"]:
        repaired[column] = pd.to_numeric(repaired[column], errors="raise")

    date_series = pd.to_datetime(repaired["timestamp"]).dt.date
    groupers = [repaired["symbol"], date_series] if "symbol" in repaired.columns else [date_series]

    for _, indices in repaired.groupby(groupers, sort=False).groups.items():
        group = repaired.loc[indices]
        open_price = group["open"].astype(float)
        high = group["high"].astype(float)
        low = group["low"].astype(float)
        close = group["close"].astype(float)
        body_high = pd.concat([open_price, close], axis=1).max(axis=1)
        body_low = pd.concat([open_price, close], axis=1).min(axis=1)

        price_reference = float(pd.concat([open_price.abs(), close.abs()]).median())
        if not price_reference or price_reference <= 0:
            continue

        move_sample = pd.concat([close.diff().abs(), open_price.sub(close).abs()])
        move_sample = move_sample[move_sample > 0]
        typical_move = float(move_sample.median()) if not move_sample.empty else price_reference * 0.001
        outlier_extension = max(price_reference * 0.04, min(typical_move * 12, price_reference * 0.08))
        repaired_extension = max(price_reference * 0.008, min(typical_move * 4, price_reference * 0.02))

        high_extension = high - body_high
        low_extension = body_low - low
        high_outliers = high_extension > outlier_extension
        low_outliers = low_extension > outlier_extension

        if high_outliers.any():
            repaired.loc[high_outliers[high_outliers].index, "high"] = body_high.loc[high_outliers] + repaired_extension
        if low_outliers.any():
            repaired.loc[low_outliers[low_outliers].index, "low"] = body_low.loc[low_outliers] - repaired_extension

        fixed_high = pd.concat([repaired.loc[indices, "high"].astype(float), body_high], axis=1).max(axis=1)
        fixed_low = pd.concat([repaired.loc[indices, "low"].astype(float), body_low], axis=1).min(axis=1)
        repaired.loc[indices, "high"] = fixed_high
        repaired.loc[indices, "low"] = fixed_low.clip(lower=0.01)

    return repaired


@dataclass(frozen=True)
class SessionRef:
    symbol: str
    date: str
    parquet_path: str
    asset_class: str
    daily_return: float
    gap_pct: float | None
    volatility_score: float
    volume_score: int
    open_price: float | None = None
    close_price: float | None = None
    daily_sma_200_at_open: float | None = None
    above_200_sma: bool | None = None


class MarketDataStore:
    def __init__(self, root_dir: Path) -> None:
        self.root_dir = root_dir
        self.data_dir = root_dir / "data"
        self.candle_dir = self.data_dir / "candles"
        self.catalog_path = self.data_dir / "catalog.duckdb"

    def available(self) -> bool:
        return self.catalog_path.exists()

    def build_from_parquet(self, source_path: Path, symbol: str = "SPY") -> None:
        df = pd.read_parquet(source_path)
        df = normalize_candles(df, symbol)
        self.write_partitioned(df)
        self.rebuild_catalog()

    def write_partitioned(self, df: pd.DataFrame) -> None:
        df = df.copy()
        df["timestamp"] = pd.to_datetime(df["timestamp"])
        df["symbol"] = df.get("symbol", df.get("ticker", "SPY"))
        df["date"] = df["timestamp"].dt.strftime("%Y-%m-%d")
        df["year"] = df["timestamp"].dt.year.astype(str)

        for (symbol, year), group in df.groupby(["symbol", "year"], sort=True):
            out_dir = self.candle_dir / f"symbol={symbol}" / f"year={year}"
            out_dir.mkdir(parents=True, exist_ok=True)
            group[["symbol", *REQUIRED_COLUMNS]].sort_values("timestamp").to_parquet(out_dir / "candles.parquet", index=False)

    def rebuild_catalog(self) -> None:
        paths = sorted(self.candle_dir.glob("symbol=*/year=*/candles.parquet"))
        self.data_dir.mkdir(parents=True, exist_ok=True)
        rows: list[dict[str, Any]] = []
        symbol_state: dict[str, dict[str, Any]] = {}

        for path in paths:
            df = pd.read_parquet(path)
            df = normalize_candles(df, str(df["symbol"].iloc[0]) if "symbol" in df.columns and not df.empty else "SPY")
            symbol = str(df["symbol"].iloc[0]) if "symbol" in df.columns and not df.empty else "SPY"
            state = symbol_state.setdefault(symbol, {"previous_close": None, "closes": []})
            for session_date, session_df in df.groupby(df["timestamp"].dt.strftime("%Y-%m-%d"), sort=True):
                if len(session_df) != REGULAR_SESSION_BARS:
                    continue
                first = session_df.iloc[0]
                last = session_df.iloc[-1]
                open_price = float(first["open"])
                close_price = float(last["close"])
                high = float(session_df["high"].max())
                low = float(session_df["low"].min())
                volume = int(session_df["volume"].sum())
                previous_close = state["previous_close"]
                prior_closes = state["closes"]
                gap_pct = None if previous_close is None else ((open_price / previous_close) - 1) * 100
                daily_sma_200_at_open = (sum(prior_closes[-199:]) + open_price) / 200 if len(prior_closes) >= 199 else None
                above_200_sma = None if daily_sma_200_at_open is None else open_price > daily_sma_200_at_open
                rows.append(
                    {
                        "symbol": str(first["symbol"]),
                        "date": session_date,
                        "asset_class": SYMBOL_ASSET_CLASS.get(str(first["symbol"]), "Equity"),
                        "rows": len(session_df),
                        "start_ts": session_df["timestamp"].min().isoformat(),
                        "end_ts": session_df["timestamp"].max().isoformat(),
                        "parquet_path": str(path),
                        "open_price": open_price,
                        "close_price": close_price,
                        "daily_return": ((close_price / open_price) - 1) * 100,
                        "gap_pct": gap_pct,
                        "daily_sma_200_at_open": daily_sma_200_at_open,
                        "above_200_sma": above_200_sma,
                        "volatility_score": ((high - low) / open_price) * 100,
                        "volume_score": volume,
                        "complete_session": True,
                    }
                )
                state["previous_close"] = close_price
                prior_closes.append(close_price)

        with duckdb.connect(str(self.catalog_path)) as con:
            con.execute("DROP TABLE IF EXISTS sessions")
            con.execute(
                """
                CREATE TABLE sessions (
                    symbol VARCHAR,
                    date VARCHAR,
                    asset_class VARCHAR,
                    rows INTEGER,
                    start_ts VARCHAR,
                    end_ts VARCHAR,
                    parquet_path VARCHAR,
                    open_price DOUBLE,
                    close_price DOUBLE,
                    daily_return DOUBLE,
                    gap_pct DOUBLE,
                    daily_sma_200_at_open DOUBLE,
                    above_200_sma BOOLEAN,
                    volatility_score DOUBLE,
                    volume_score BIGINT,
                    complete_session BOOLEAN
                )
                """
            )
            if rows:
                con.register("session_rows", pd.DataFrame(rows))
                con.execute("INSERT INTO sessions SELECT * FROM session_rows")
            con.execute("CREATE INDEX IF NOT EXISTS idx_sessions_symbol_date ON sessions(symbol, date)")
            con.execute("CREATE INDEX IF NOT EXISTS idx_sessions_complete ON sessions(complete_session)")

    def session_refs(self) -> list[SessionRef]:
        with duckdb.connect(str(self.catalog_path), read_only=True) as con:
            columns = {row[1] for row in con.execute("PRAGMA table_info('sessions')").fetchall()}
            has_daily_sma = {"open_price", "close_price", "daily_sma_200_at_open", "above_200_sma"}.issubset(columns)
            extra_columns = ", open_price, close_price, daily_sma_200_at_open, above_200_sma" if has_daily_sma else ""
            rows = con.execute(
                f"""
                SELECT symbol, date, parquet_path, asset_class, daily_return, gap_pct, volatility_score, volume_score{extra_columns}
                FROM sessions
                WHERE complete_session = true
                ORDER BY symbol, date
                """
            ).fetchall()
        return [
            SessionRef(
                symbol=row[0],
                date=row[1],
                parquet_path=row[2],
                asset_class=row[3],
                daily_return=float(row[4]),
                gap_pct=None if row[5] is None else float(row[5]),
                volatility_score=float(row[6]),
                volume_score=int(row[7]),
                open_price=None if len(row) <= 8 or row[8] is None else float(row[8]),
                close_price=None if len(row) <= 9 or row[9] is None else float(row[9]),
                daily_sma_200_at_open=None if len(row) <= 10 or row[10] is None else float(row[10]),
                above_200_sma=None if len(row) <= 11 or row[11] is None else bool(row[11]),
            )
            for row in rows
        ]

    def load_session(self, symbol: str, session_date: str) -> pd.DataFrame:
        with duckdb.connect(str(self.catalog_path), read_only=True) as con:
            row = con.execute(
                """
                SELECT parquet_path
                FROM sessions
                WHERE symbol = ? AND date = ? AND complete_session = true
                LIMIT 1
                """,
                [symbol, session_date],
            ).fetchone()
        if not row:
            raise KeyError(f"No session for {symbol} {session_date}")
        parquet_path = self.resolve_parquet_path(str(row[0]), symbol, session_date)
        with duckdb.connect() as con:
            df = con.execute(
                """
                SELECT *
                FROM read_parquet(?)
                WHERE CAST(timestamp AS DATE) = CAST(? AS DATE)
                ORDER BY timestamp
                """,
                [str(parquet_path), session_date],
            ).df()
        df = normalize_candles(df, symbol)
        return df.sort_values("timestamp").reset_index(drop=True)

    def resolve_parquet_path(self, stored_path: str, symbol: str, session_date: str) -> Path:
        path = Path(stored_path)
        if path.exists():
            return path

        year = session_date[:4]
        partition_path = self.candle_dir / f"symbol={symbol}" / f"year={year}" / "candles.parquet"
        if partition_path.exists():
            return partition_path

        normalized = stored_path.replace("\\", "/")
        marker = "/data/candles/"
        if marker in normalized:
            candidate = self.candle_dir / normalized.split(marker, 1)[1]
            if candidate.exists():
                return candidate

        raise FileNotFoundError(f"Could not resolve parquet path for {symbol} {session_date}: {stored_path}")


def normalize_candles(df: pd.DataFrame, symbol: str) -> pd.DataFrame:
    missing = set(REQUIRED_COLUMNS).difference(df.columns)
    if missing:
        raise ValueError(f"Missing required columns: {sorted(missing)}")
    df = df.copy()
    df["timestamp"] = pd.to_datetime(df["timestamp"])
    df["symbol"] = df.get("symbol", df.get("ticker", symbol))
    df = df.dropna(subset=REQUIRED_COLUMNS)
    df = df[df["timestamp"].dt.time.between(pd.Timestamp("09:30").time(), pd.Timestamp("15:59").time())]
    for column in ["open", "high", "low", "close", "volume"]:
        df[column] = pd.to_numeric(df[column], errors="raise")
    df = sanitize_ohlc_outliers(df)
    df["volume"] = df["volume"].astype("int64")
    return df.drop_duplicates(subset=["symbol", "timestamp"]).sort_values(["symbol", "timestamp"]).reset_index(drop=True)
