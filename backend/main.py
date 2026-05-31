from __future__ import annotations

from datetime import datetime, time, timedelta, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal
from uuid import uuid4
import hashlib
import os
import random

import pandas as pd
from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field

from backend.market_data import ASSET_CLASS_TICKERS, SYMBOL_DESCRIPTIONS, MarketDataStore, sanitize_ohlc_outliers
from backend.profile_store import ProfileStore, validate_display_name, verify_password
from backend.scenario_classifier import SAFE_SCENARIOS, classify_safe_scenarios, hidden_day_tags


ROOT_DIR = Path(__file__).resolve().parents[1]
DATA_PATH = ROOT_DIR / "spy_1min_candles.parquet"
MARKET_DATA_STORE = MarketDataStore(ROOT_DIR)
PROFILE_STORE = ProfileStore(ROOT_DIR)
PROFILE_STORE.initialize()
SESSION_COOKIE_NAME = "pat_session"
COOKIE_SECURE = os.getenv("COOKIE_SECURE", "false").lower() == "true"
SESSION_DAYS = int(os.getenv("SESSION_DAYS", "30"))

ASSET_CLASSES = ["Random", *ASSET_CLASS_TICKERS.keys()]
KNOWN_ASSETS = sorted({symbol for symbols in ASSET_CLASS_TICKERS.values() for symbol in symbols})
DISPLAY_SESSION_DATE = "2000-01-03"
RELATIVE_VOLUME_BASE = 1000
SCENARIOS = SAFE_SCENARIOS
TIMEFRAMES = ["1m", "5m", "15m"]
STARTING_CAPITAL = [10_000, 100_000, 1_000_000]
REPLAY_SPEEDS = ["Real Time", "3x Speed", "5x Speed"]
SPEED_SECONDS = {"Real Time": 1.0, "3x Speed": 1.0, "5x Speed": 1.0}
REPLAY_TICK_CONFIG = {
    "Real Time": {"ticks": 60, "random": 56},
    "3x Speed": {"ticks": 20, "random": 16},
    "5x Speed": {"ticks": 12, "random": 8},
}
PREMARKET_START = time(4, 0)
PREMARKET_END = time(9, 29)
PREMARKET_MINUTES = 330
REGULAR_START = time(9, 30)
REGULAR_END = time(15, 59)
SPAWN_START = time(9, 28)
SPAWN_END = time(14, 0)
START_TIME_OPTIONS = ["09:13", "09:28", "09:43", "10:13", "14:00"]
SCENARIO_FILTER_VALUES = {
    "sma": {"Random", "Above 200 SMA", "Below 200 SMA"},
    "volatility": {"Random", "High Volatility", "Low Volatility"},
    "gap": {"Random", "Gap Up", "Gap Down"},
    "premarketVolume": {"Random", "Large Premarket Volume Increase", "Large Premarket Volume Decrease"},
}


class ScenarioFilters(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    sma: str = "Random"
    volatility: str = "Random"
    gap: str = "Random"
    premarket_volume: str = Field(default="Random", alias="premarketVolume")


class StartSessionRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    asset_class: str = Field(default="Random", alias="assetClass")
    asset: str = "Random"
    scenario: str = "Random"
    scenario_filters: ScenarioFilters = Field(default_factory=ScenarioFilters, alias="scenarioFilters")
    timeframe: str = "1m"
    starting_capital: float = Field(default=100_000, alias="startingCapital")
    replay_speed: str = Field(default="3x Speed", alias="replaySpeed")
    practice_date: str | None = Field(default=None, alias="practiceDate")
    start_time: str | None = Field(default=None, alias="startTime")
    hardcore: bool = False


class TradeFill(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    side: Literal["buy", "sell"]
    quantity: float
    price: float
    tick_index: int = Field(alias="tickIndex")
    timestamp: str | None = None


class ScoreRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    starting_capital: float = Field(alias="startingCapital")
    trades: list[TradeFill] = Field(default_factory=list)


class LoginRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    username: str
    password: str
    display_name: str | None = Field(default=None, alias="displayName")


class ProfilePayload(BaseModel):
    settings: dict[str, Any] = Field(default_factory=dict)
    setup: dict[str, Any] = Field(default_factory=dict)
    chart_setup_ui: dict[str, Any] = Field(default_factory=dict, alias="chartSetupUi")
    chart_templates: list[Any] = Field(default_factory=list, alias="chartTemplates")
    active_template_id: str = Field(default="", alias="activeTemplateId")
    history: list[Any] = Field(default_factory=list)


class AnalyticsVisitRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    visitor_id: str = Field(alias="visitorId")
    visit_id: str = Field(alias="visitId")
    path: str = "/"
    referrer: str = ""


class AnalyticsEventRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    visitor_id: str = Field(alias="visitorId")
    visit_id: str = Field(alias="visitId")
    event_name: str = Field(alias="eventName")
    path: str = "/"
    payload: dict[str, Any] = Field(default_factory=dict)


app = FastAPI(title="Trading Replay Game API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:5174",
        "http://127.0.0.1:5174",
        "http://localhost:4173",
        "http://127.0.0.1:4173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

SESSION_STORE: dict[str, dict[str, Any]] = {}


@lru_cache(maxsize=1)
def load_spy_data() -> pd.DataFrame:
    if not DATA_PATH.exists():
        raise FileNotFoundError(f"Missing data file: {DATA_PATH}")

    df = pd.read_parquet(DATA_PATH)
    required = {"timestamp", "open", "high", "low", "close", "volume"}
    missing = required.difference(df.columns)
    if missing:
        raise ValueError(f"Data file is missing required columns: {sorted(missing)}")

    df = df.copy()
    df["timestamp"] = pd.to_datetime(df["timestamp"])
    df["ticker"] = df.get("ticker", "SPY")
    df = df.dropna(subset=["timestamp", "open", "high", "low", "close", "volume"])
    df = df[df["timestamp"].dt.time.between(time(9, 30), time(15, 59))]
    df = df.drop_duplicates(subset=["ticker", "timestamp"]).sort_values("timestamp")
    numeric_cols = ["open", "high", "low", "close", "volume"]
    for column in numeric_cols:
        df[column] = pd.to_numeric(df[column], errors="raise")
    df = sanitize_ohlc_outliers(df)
    return df.reset_index(drop=True)


@lru_cache(maxsize=1)
def session_dates() -> list[str]:
    if MARKET_DATA_STORE.available():
        return sorted({ref.date for ref in MARKET_DATA_STORE.session_refs()})
    df = load_spy_data()
    return [str(value) for value in sorted(df["timestamp"].dt.date.unique())]


@lru_cache(maxsize=4096)
def df_for_date(session_date: str, symbol: str = "SPY") -> pd.DataFrame:
    if MARKET_DATA_STORE.available():
        try:
            return MARKET_DATA_STORE.load_session(symbol, session_date)
        except KeyError:
            raise HTTPException(status_code=404, detail=f"No {symbol} data for {session_date}") from None
    df = load_spy_data()
    date_values = df["timestamp"].dt.strftime("%Y-%m-%d")
    session_df = df[(df["ticker"] == symbol) & (date_values == session_date)].copy()
    if session_df.empty:
        raise HTTPException(status_code=404, detail=f"No {symbol} data for {session_date}")
    return session_df.sort_values("timestamp").reset_index(drop=True)


def normalize_session_prices(session_df: pd.DataFrame) -> pd.DataFrame:
    if session_df.empty:
        return session_df.copy()
    normalized = session_df.copy()
    opening_price = float(normalized.iloc[0]["open"])
    if opening_price <= 0:
        return normalized
    factor = 100.0 / opening_price
    for column in ["open", "high", "low", "close"]:
        normalized[column] = pd.to_numeric(normalized[column], errors="raise") * factor
    normalized["normalizationFactor"] = factor
    normalized["rawSessionOpen"] = opening_price
    return normalized


def normalize_volume_units(session_df: pd.DataFrame) -> pd.DataFrame:
    if session_df.empty or "volume" not in session_df.columns:
        return session_df.copy()
    normalized = session_df.copy()
    volume = pd.to_numeric(normalized["volume"], errors="raise").astype(float)
    regular_mask = normalized.get("sessionSegment", "regular") == "regular"
    regular_volume = volume[regular_mask] if hasattr(regular_mask, "__iter__") else volume
    baseline = float(regular_volume[regular_volume > 0].median()) if not regular_volume.empty else float(volume[volume > 0].median())
    if not baseline or baseline <= 0:
        baseline = 1.0
    normalized["volume"] = (volume / baseline * RELATIVE_VOLUME_BASE).round().clip(lower=1).astype("int64")
    return normalized


def mask_timestamp(timestamp: Any) -> str:
    parsed = pd.to_datetime(timestamp)
    return f"{DISPLAY_SESSION_DATE}T{parsed.strftime('%H:%M:%S')}"


@lru_cache(maxsize=4096)
def normalized_df_for_date(session_date: str, symbol: str = "SPY") -> pd.DataFrame:
    return normalize_session_prices(df_for_date(session_date, symbol))


@lru_cache(maxsize=4096)
def previous_session_date(session_date: str, symbol: str = "SPY") -> str | None:
    previous_dates = [
        row["date"]
        for row in build_metadata()
        if row["ticker"] == symbol and row["date"] < session_date
    ]
    return max(previous_dates) if previous_dates else None


@lru_cache(maxsize=4096)
def previous_session_df(session_date: str, symbol: str = "SPY") -> pd.DataFrame | None:
    previous_date = previous_session_date(session_date, symbol)
    if previous_date:
        return df_for_date(previous_date, symbol)
    return None


@lru_cache(maxsize=1)
def build_metadata() -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    previous_close: float | None = None

    if MARKET_DATA_STORE.available():
        for ref in MARKET_DATA_STORE.session_refs():
            rows.append(
                {
                    "ticker": ref.symbol,
                    "date": ref.date,
                    "assetClass": ref.asset_class,
                    "above200Sma": ref.above_200_sma,
                    "dailySma200AtOpen": ref.daily_sma_200_at_open,
                    "openPrice": ref.open_price,
                    "closePrice": ref.close_price,
                    "dailyReturn": ref.daily_return,
                    "gapPct": ref.gap_pct,
                    "volatilityScore": ref.volatility_score,
                    "volumeScore": ref.volume_score,
                }
            )
        return attach_scenario_flags(rows)

    for session_date in session_dates():
        session_df = df_for_date(session_date)
        first = session_df.iloc[0]
        last = session_df.iloc[-1]
        high = float(session_df["high"].max())
        low = float(session_df["low"].min())
        volume = int(session_df["volume"].sum())
        open_price = float(first["open"])
        close_price = float(last["close"])
        gap_pct = None if previous_close is None else ((open_price / previous_close) - 1) * 100

        rows.append(
            {
                "ticker": "SPY",
                "date": session_date,
                "assetClass": "Equity",
                "above200Sma": None,
                "dailySma200AtOpen": None,
                "openPrice": open_price,
                "closePrice": close_price,
                "dailyReturn": ((close_price / open_price) - 1) * 100,
                "gapPct": gap_pct,
                "volatilityScore": ((high - low) / open_price) * 100,
                "volumeScore": volume,
            }
        )
        previous_close = close_price

    attach_daily_sma_flags(rows)
    return attach_scenario_flags(rows)


def attach_daily_sma_flags(rows: list[dict[str, Any]]) -> None:
    by_symbol: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        by_symbol.setdefault(str(row["ticker"]), []).append(row)
    for symbol_rows in by_symbol.values():
        closes: list[float] = []
        for row in sorted(symbol_rows, key=lambda item: item["date"]):
            if row.get("dailySma200AtOpen") is None and row.get("openPrice") is not None and len(closes) >= 199:
                daily_sma_200_at_open = (sum(closes[-199:]) + float(row["openPrice"])) / 200
                row["dailySma200AtOpen"] = daily_sma_200_at_open
                row["above200Sma"] = float(row["openPrice"]) > daily_sma_200_at_open
            if row.get("closePrice") is not None:
                closes.append(float(row["closePrice"]))


def attach_scenario_flags(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not rows:
        return []
    attach_daily_sma_flags(rows)
    volatility_median = pd.Series([row["volatilityScore"] for row in rows]).median()
    volume_median = pd.Series([row["volumeScore"] for row in rows]).median()

    for row in rows:
        gap_up = bool(row["gapPct"] is not None and row["gapPct"] >= 0.25)
        gap_down = bool(row["gapPct"] is not None and row["gapPct"] <= -0.25)
        volume_increase = bool(row["volumeScore"] >= volume_median)
        volume_decrease = bool(row["volumeScore"] < volume_median)
        high_volatility = bool(row["volatilityScore"] >= volatility_median)
        low_volatility = bool(row["volatilityScore"] <= volatility_median)
        row["scenarioFlags"] = {
            "Random": True,
            "Above 200 SMA": bool(row.get("above200Sma") is True),
            "Below 200 SMA": bool(row.get("above200Sma") is False),
            "Gap Up": gap_up,
            "Gap Down": gap_down,
            "Large Premarket Volume Increase": volume_increase,
            "Large Premarket Volume Decrease": volume_decrease,
            "High Volatility": high_volatility,
            "Low Volatility": low_volatility,
        }
    return rows


def asset_matches(row: dict[str, Any], asset_class: str) -> bool:
    if asset_class == "Random":
        return True
    return row["assetClass"] == asset_class


def symbol_matches(row: dict[str, Any], asset: str) -> bool:
    if asset == "Random":
        return True
    return row["ticker"] == asset


def scenario_filter_values(filters: ScenarioFilters | None) -> dict[str, str]:
    raw = filters.model_dump(by_alias=True) if filters else {}
    values: dict[str, str] = {}
    for key, allowed_values in SCENARIO_FILTER_VALUES.items():
        value = str(raw.get(key, "Random"))
        if value not in allowed_values:
            raise HTTPException(status_code=400, detail=f"Unsupported {key} scenario filter: {value}")
        values[key] = value
    return values


def required_scenario_tags(filters: ScenarioFilters | None, legacy_scenario: str = "Random") -> list[str]:
    values = scenario_filter_values(filters)
    tags = [value for value in values.values() if value != "Random"]
    if legacy_scenario != "Random":
        if legacy_scenario not in SCENARIOS:
            raise HTTPException(status_code=400, detail=f"Unsupported scenario: {legacy_scenario}")
        if legacy_scenario not in tags:
            tags.append(legacy_scenario)
    return tags


def scenario_matches(row: dict[str, Any], required_tags: list[str]) -> bool:
    return all(bool(row["scenarioFlags"].get(tag, False)) for tag in required_tags)


SESSION_LEVEL_SCENARIO_TAGS = {
    "Above 200 SMA",
    "Below 200 SMA",
    "Gap Up",
    "Gap Down",
}


def matching_metadata(asset_class: str, asset: str, required_tags: list[str]) -> list[dict[str, Any]]:
    return [
        row
        for row in build_metadata()
        if asset_matches(row, asset_class) and symbol_matches(row, asset) and scenario_matches(row, required_tags)
    ]


def choose_random_session(matches: list[dict[str, Any]]) -> dict[str, Any]:
    by_year: dict[str, list[dict[str, Any]]] = {}
    for row in matches:
        by_year.setdefault(str(row["date"])[:4], []).append(row)
    if not by_year:
        raise HTTPException(status_code=404, detail="No sessions match those filters.")
    year = random.choice(list(by_year))
    return random.choice(by_year[year])


def classifier_thresholds(metadata: list[dict[str, Any]]) -> dict[str, float]:
    volatility_values = [float(row["volatilityScore"]) for row in metadata]
    volume_values = [float(row["volumeScore"]) for row in metadata]
    volatility_median = float(pd.Series(volatility_values).median()) if volatility_values else 0.25
    volume_median = float(pd.Series(volume_values).median()) if volume_values else 0.0
    return {
        "volatility_median": volatility_median,
        "volume_median": volume_median,
        "opening_range_high": volatility_median * 0.9,
        "opening_range_low": volatility_median * 0.35,
        "premarket_volume_high": 0.025,
        "premarket_volume_low": 0.012,
    }


def spawn_indexes(session_df: pd.DataFrame, start_time: str | None = None) -> list[int]:
    if start_time:
        return [choose_start_candle_index(session_df, start_time)]
    return [
        index
        for index, timestamp in enumerate(pd.to_datetime(session_df["timestamp"]))
        if SPAWN_START <= timestamp.time() <= SPAWN_END
    ]


def matching_spawn_candidates(asset_class: str, asset: str, required_tags: list[str], practice_date: str | None = None, start_time: str | None = None) -> list[dict[str, Any]]:
    metadata_rows = [row for row in build_metadata() if asset_matches(row, asset_class) and symbol_matches(row, asset)]
    if practice_date:
        metadata_rows = [row for row in metadata_rows if row["date"] == practice_date]
    session_level_tags = [tag for tag in required_tags if tag in SESSION_LEVEL_SCENARIO_TAGS]
    if session_level_tags:
        metadata_rows = [row for row in metadata_rows if scenario_matches(row, session_level_tags)]
    random.shuffle(metadata_rows)
    thresholds = classifier_thresholds(metadata_rows)
    candidates: list[dict[str, Any]] = []
    for row in metadata_rows:
        session_df = df_for_date(row["date"], row["ticker"])
        previous_df = previous_session_df(row["date"], row["ticker"])
        premarket_df = synthetic_premarket_for_date(row["ticker"], row["date"])
        indexes = spawn_indexes(session_df, start_time)
        random.shuffle(indexes)
        for spawn_index in indexes:
            candidate_thresholds = {
                **thresholds,
                "daily_sma_200_at_open": row.get("dailySma200AtOpen"),
            }
            flags = classify_safe_scenarios(session_df, previous_df, premarket_df, spawn_index, candidate_thresholds)
            if all(flags.get(tag, False) for tag in required_tags):
                candidate = dict(row)
                candidate["startCandleIndex"] = spawn_index
                candidate["scenarioFlags"] = flags
                candidates.append(candidate)
                if len(candidates) >= 250:
                    return candidates
    return candidates


def scenario_availability_counts(metadata_rows: list[dict[str, Any]]) -> dict[str, int]:
    return {
        scenario: sum(1 for row in metadata_rows if row.get("scenarioFlags", {}).get(scenario, False))
        for scenario in SCENARIOS
    }


def resample_session(session_df: pd.DataFrame, timeframe: str) -> pd.DataFrame:
    if timeframe == "1m":
        return session_df.copy()

    session_df = session_df.copy()
    if "ticker" not in session_df.columns:
        session_df["ticker"] = session_df.get("symbol", "SPY")

    rules = {"5m": "5min", "15m": "15min"}
    if timeframe not in rules:
        raise HTTPException(status_code=400, detail=f"Unsupported timeframe: {timeframe}")

    start = session_df["timestamp"].min()
    origin = start.normalize() + pd.Timedelta(hours=9, minutes=30)
    resampled = (
        session_df.set_index("timestamp")
        .resample(rules[timeframe], origin=origin, label="left", closed="left")
        .agg(
            open=("open", "first"),
            high=("high", "max"),
            low=("low", "min"),
            close=("close", "last"),
            volume=("volume", "sum"),
            ticker=("ticker", "first"),
        )
        .dropna(subset=["open", "high", "low", "close"])
        .reset_index()
    )
    return resampled


def deterministic_rng(*parts: Any) -> random.Random:
    seed_text = "|".join(str(part) for part in parts)
    seed = int(hashlib.sha256(seed_text.encode("utf-8")).hexdigest()[:16], 16)
    return random.Random(seed)


def clamp_float(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def allocate_units(weights: list[float], total: int) -> list[int]:
    if total <= 0 or not weights:
        return [0 for _ in weights]
    weight_sum = sum(max(weight, 0.0) for weight in weights)
    if weight_sum <= 0:
        weights = [1.0 for _ in weights]
        weight_sum = float(len(weights))
    units: list[int] = []
    cumulative_units = 0
    cumulative_weight = 0.0
    for index, weight in enumerate(weights):
        cumulative_weight += max(weight, 0.0)
        next_units = total if index == len(weights) - 1 else round(total * cumulative_weight / weight_sum)
        units.append(max(0, next_units - cumulative_units))
        cumulative_units = next_units
    return units


def synthetic_premarket_volume(current_df: pd.DataFrame, previous_df: pd.DataFrame | None, gap_pct: float, rng: random.Random) -> int:
    current_volume = int(current_df["volume"].sum())
    previous_volume = int(previous_df["volume"].sum()) if previous_df is not None and not previous_df.empty else current_volume
    relative_volume = current_volume / max(previous_volume, 1)
    if relative_volume >= 1:
        relative_multiplier = 1.0 + min(0.45, (relative_volume - 1.0) * 0.22)
    else:
        relative_multiplier = 0.55 + (0.45 * relative_volume)

    first_30 = current_df.head(30)
    opening_volume_share = int(first_30["volume"].sum()) / max(current_volume, 1)
    opening_multiplier = 1.0 + min(1.2, opening_volume_share * 7.0)
    gap_multiplier = 1.0 + min(1.35, abs(gap_pct) * 38.0)
    random_multiplier = rng.uniform(0.75, 1.30)
    fraction = 0.015 * relative_multiplier * opening_multiplier * gap_multiplier * random_multiplier
    fraction = clamp_float(fraction, 0.004, 0.09)
    return max(PREMARKET_MINUTES, round(current_volume * fraction))


def synthetic_premarket_candles(session_df: pd.DataFrame, symbol: str, session_date: str) -> pd.DataFrame:
    if session_df.empty:
        return session_df.copy()

    previous_df = previous_session_df(session_date, symbol)
    first = session_df.iloc[0]
    today_open = float(first["open"])
    normalization_factor = float(first.get("normalizationFactor", 1.0))
    previous_close = float(previous_df.iloc[-1]["close"]) * normalization_factor if previous_df is not None and not previous_df.empty else today_open
    previous_open = float(previous_df.iloc[0]["open"]) * normalization_factor if previous_df is not None and not previous_df.empty else previous_close
    previous_high = float(previous_df["high"].max()) * normalization_factor if previous_df is not None and not previous_df.empty else previous_close
    previous_low = float(previous_df["low"].min()) * normalization_factor if previous_df is not None and not previous_df.empty else previous_close
    previous_range_pct = (previous_high - previous_low) / max(abs(previous_open), 1e-9)

    first_30 = session_df.head(30)
    first_30_range_pct = (float(first_30["high"].max()) - float(first_30["low"].min())) / max(today_open, 1e-9)
    gap_pct = (today_open / max(previous_close, 1e-9)) - 1.0
    rng = deterministic_rng("synthetic-premarket", symbol, session_date, f"{previous_close:.8f}", f"{today_open:.8f}")
    total_volume = synthetic_premarket_volume(session_df, previous_df, gap_pct, rng)

    volatility_pct = clamp_float((abs(gap_pct) * 0.45) + (previous_range_pct * 0.20) + (first_30_range_pct * 0.25), 0.00035, 0.025)
    session_day = pd.to_datetime(session_date).normalize()
    timestamps = [session_day + pd.Timedelta(hours=4, minutes=index) for index in range(PREMARKET_MINUTES)]

    bridge_noise = [0.0]
    current_noise = 0.0
    for index in range(1, PREMARKET_MINUTES - 1):
        progress = index / (PREMARKET_MINUTES - 1)
        decay = 0.78 + (0.12 * progress)
        current_noise = (current_noise * decay) + rng.gauss(0, volatility_pct * previous_close * 0.12)
        bridge_noise.append(current_noise)
    bridge_noise.append(0.0)
    for index, value in enumerate(bridge_noise):
        progress = index / (PREMARKET_MINUTES - 1)
        bridge_noise[index] = value * (1 - progress)

    closes: list[float] = []
    for index in range(PREMARKET_MINUTES):
        progress = index / (PREMARKET_MINUTES - 1)
        base = previous_close + ((today_open - previous_close) * progress)
        close = base + bridge_noise[index]
        closes.append(max(0.01, close))
    closes[-1] = today_open

    weights: list[float] = []
    for index in range(PREMARKET_MINUTES):
        minutes_since_4 = index
        if minutes_since_4 < 180:
            time_weight = 0.18
        elif minutes_since_4 < 240:
            time_weight = 0.45
        elif minutes_since_4 < 285:
            time_weight = 0.85
        else:
            time_weight = 1.8
        burst = 1.0 + (rng.random() ** 5) * 4.0
        weights.append(time_weight * rng.uniform(0.55, 1.45) * burst)
    volumes = allocate_units(weights, total_volume)

    rows: list[dict[str, Any]] = []
    previous_price = previous_close
    for index, timestamp in enumerate(timestamps):
        open_price = previous_price
        close_price = closes[index]
        wiggle = max(abs(close_price - open_price), previous_close * volatility_pct * rng.uniform(0.015, 0.09))
        high = max(open_price, close_price) + (wiggle * rng.uniform(0.15, 0.85))
        low = min(open_price, close_price) - (wiggle * rng.uniform(0.15, 0.85))
        rows.append(
            {
                "timestamp": timestamp,
                "open": round(open_price, 4),
                "high": round(max(high, open_price, close_price), 4),
                "low": round(max(0.01, min(low, open_price, close_price)), 4),
                "close": round(close_price, 4),
                "volume": int(volumes[index]),
                "ticker": symbol,
                "sessionSegment": "pre_market",
                "source": "synthetic",
            }
        )
        previous_price = close_price
    rows[0]["open"] = round(previous_close, 4)
    rows[-1]["close"] = round(today_open, 4)
    rows[-1]["high"] = round(max(rows[-1]["high"], rows[-1]["open"], today_open), 4)
    rows[-1]["low"] = round(max(0.01, min(rows[-1]["low"], rows[-1]["open"], today_open)), 4)
    return pd.DataFrame(rows)


@lru_cache(maxsize=4096)
def synthetic_premarket_for_date(symbol: str, session_date: str) -> pd.DataFrame:
    return synthetic_premarket_candles(normalized_df_for_date(session_date, symbol), symbol, session_date)


def session_with_premarket_context(session_df: pd.DataFrame, symbol: str, session_date: str) -> tuple[pd.DataFrame, str]:
    regular_df = session_df.copy()
    regular_df["sessionSegment"] = "regular"
    regular_df["source"] = "real"
    premarket_df = synthetic_premarket_for_date(symbol, session_date)
    context = pd.concat([premarket_df, regular_df], ignore_index=True).sort_values("timestamp").reset_index(drop=True)
    return normalize_volume_units(context), "synthetic"


@lru_cache(maxsize=2048)
def context_df_for_date(session_date: str, symbol: str = "SPY") -> tuple[pd.DataFrame, str]:
    return session_with_premarket_context(normalized_df_for_date(session_date, symbol), symbol, session_date)


def resample_context(context_df: pd.DataFrame, timeframe: str) -> pd.DataFrame:
    if timeframe == "1m":
        return context_df.copy()
    session_date = pd.to_datetime(context_df["timestamp"]).dt.normalize().iloc[0]
    premarket = context_df[context_df["sessionSegment"] == "pre_market"].copy()
    regular = context_df[context_df["sessionSegment"] == "regular"].copy()
    pieces: list[pd.DataFrame] = []
    if not premarket.empty:
        premarket_resampled = resample_session(premarket, timeframe)
        premarket_resampled["sessionSegment"] = "pre_market"
        premarket_resampled["source"] = "synthetic"
        pieces.append(premarket_resampled[premarket_resampled["timestamp"] < session_date + pd.Timedelta(hours=9, minutes=30)])
    if not regular.empty:
        regular_resampled = resample_session(regular, timeframe)
        regular_resampled["sessionSegment"] = "regular"
        regular_resampled["source"] = "real"
        pieces.append(regular_resampled)
    if not pieces:
        return context_df.iloc[0:0].copy()
    return pd.concat(pieces, ignore_index=True).sort_values("timestamp").reset_index(drop=True)


def serialize_candles(session_df: pd.DataFrame) -> list[dict[str, Any]]:
    candles = []
    for row in session_df.itertuples(index=False):
        candles.append(
            {
                "timestamp": mask_timestamp(row.timestamp),
                "open": float(row.open),
                "high": float(row.high),
                "low": float(row.low),
                "close": float(row.close),
                "volume": int(row.volume),
                "sessionSegment": getattr(row, "sessionSegment", "regular"),
                "source": getattr(row, "source", "real"),
            }
        )
    return candles


def seeded_candle_rng(row: Any, candle_index: int) -> random.Random:
    seed_text = "|".join(
        [
            str(candle_index),
            row.timestamp.isoformat(),
            f"{float(row.open):.8f}",
            f"{float(row.high):.8f}",
            f"{float(row.low):.8f}",
            f"{float(row.close):.8f}",
            str(int(row.volume)),
        ]
    )
    seed = int(hashlib.sha256(seed_text.encode("utf-8")).hexdigest()[:16], 16)
    return random.Random(seed)


def replay_ticks_per_candle(replay_speed: str) -> int:
    return int(REPLAY_TICK_CONFIG.get(replay_speed, REPLAY_TICK_CONFIG["3x Speed"])["ticks"])


def random_ticks_per_candle(replay_speed: str) -> int:
    return int(REPLAY_TICK_CONFIG.get(replay_speed, REPLAY_TICK_CONFIG["3x Speed"])["random"])


def choose_extreme_positions(rng: random.Random, tick_count: int, random_count: int) -> tuple[int, int]:
    min_distance = max(2, round(random_count * 0.10))
    max_distance = tick_count - 3
    target_distance = rng.randint(min_distance, max_distance)
    candidates = [
        (high_position, low_position)
        for high_position in range(1, tick_count - 1)
        for low_position in range(1, tick_count - 1)
        if abs(high_position - low_position) == target_distance
    ]
    if not candidates:
        candidates = [
            (high_position, low_position)
            for high_position in range(1, tick_count - 1)
            for low_position in range(1, tick_count - 1)
            if high_position != low_position and abs(high_position - low_position) >= min_distance
        ]
    return rng.choice(candidates)


def synthetic_price(row: Any, tick_position: int, tick_count: int, rng: random.Random) -> float:
    open_price = float(row.open)
    high_price = float(row.high)
    low_price = float(row.low)
    close_price = float(row.close)
    candle_range = max(high_price - low_price, 0.0)
    if candle_range == 0:
        return close_price

    progress = tick_position / (tick_count - 1)
    smooth_price = open_price + ((close_price - open_price) * progress)
    random_price = low_price + (rng.random() * candle_range)
    range_pct = candle_range / max(abs(open_price), 1e-9)
    volatility_score = min(1.0, range_pct / 0.0015)
    random_weight = 0.18 + (0.67 * volatility_score)
    pressure = rng.uniform(-1.0, 1.0)
    if tick_position > 1:
        pressure += 0.25 if close_price >= open_price else -0.25
    liquidity_bias = pressure * candle_range * 0.10
    price = (smooth_price * (1 - random_weight)) + (random_price * random_weight) + liquidity_bias
    return max(low_price, min(high_price, price))


def build_intracandle_path(row: Any, candle_index: int, replay_speed: str) -> list[tuple[str, float]]:
    rng = seeded_candle_rng(row, candle_index)
    tick_count = replay_ticks_per_candle(replay_speed)
    random_count = random_ticks_per_candle(replay_speed)
    high_position, low_position = choose_extreme_positions(rng, tick_count, random_count)
    path: list[tuple[str, float]] = []

    for tick_position in range(tick_count):
        if tick_position == 0:
            path.append(("open", float(row.open)))
        elif tick_position == tick_count - 1:
            path.append(("close", float(row.close)))
        elif tick_position == high_position:
            path.append(("high", float(row.high)))
        elif tick_position == low_position:
            path.append(("low", float(row.low)))
        else:
            path.append(("random", synthetic_price(row, tick_position, tick_count, rng)))

    actual_random_count = sum(1 for phase, _ in path if phase == "random")
    if actual_random_count != random_count:
        raise RuntimeError(f"Expected {random_count} random ticks, found {actual_random_count}")
    return path


def allocate_volume_deltas(path: list[tuple[str, float]], total_volume: int) -> list[int]:
    if total_volume <= 0:
        return [0 for _ in path]

    distances = [0.0]
    for index in range(1, len(path)):
        distances.append(abs(path[index][1] - path[index - 1][1]))

    total_distance = sum(distances)
    tick_count = len(path)
    base_share = 0.35
    distance_share = 0.65
    if total_distance <= 0:
        weights = [1 / tick_count for _ in path]
    else:
        weights = [
            (base_share / tick_count) + (distance_share * (distance / total_distance))
            for distance in distances
        ]

    deltas: list[int] = []
    cumulative_units = 0
    cumulative_weight = 0.0
    for index, weight in enumerate(weights):
        cumulative_weight += weight
        next_cumulative_units = total_volume if index == tick_count - 1 else round(total_volume * cumulative_weight)
        deltas.append(max(0, next_cumulative_units - cumulative_units))
        cumulative_units = next_cumulative_units

    return deltas


def build_replay_ticks(session_df: pd.DataFrame, replay_speed: str = "3x Speed") -> list[dict[str, Any]]:
    ticks: list[dict[str, Any]] = []
    tick_index = 0
    ticks_per_candle = replay_ticks_per_candle(replay_speed)
    rows = list(normalize_volume_units(session_df).itertuples(index=False))
    for candle_index, row in enumerate(rows):
        next_row = rows[candle_index + 1] if candle_index + 1 < len(rows) else None
        path = build_intracandle_path(row, candle_index, replay_speed)
        volume_deltas = allocate_volume_deltas(path, int(row.volume))
        cumulative_volume = 0

        for phase_index, (phase, price) in enumerate(path):
            tick_time = row.timestamp + timedelta(seconds=phase_index * (60 / ticks_per_candle))
            volume_delta = volume_deltas[phase_index]
            cumulative_volume += volume_delta
            ticks.append(
                {
                    "tickIndex": tick_index,
                    "candleIndex": candle_index,
                    "sequenceInCandle": phase_index,
                    "ticksInCandle": ticks_per_candle,
                    "phase": phase,
                    "timestamp": mask_timestamp(tick_time),
                    "candleTimestamp": mask_timestamp(row.timestamp),
                    "price": float(price),
                    "volume": cumulative_volume,
                    "volumeDelta": volume_delta,
                    "candleVolume": int(row.volume),
                    "candleOpen": float(row.open),
                    "candleHigh": float(row.high),
                    "candleLow": float(row.low),
                    "candleClose": float(row.close),
                    "nextCandleVolume": int(next_row.volume) if next_row is not None else int(row.volume),
                    "nextCandleRange": float(next_row.high - next_row.low) if next_row is not None else float(row.high - row.low),
                }
            )
            tick_index += 1
    return ticks


def compute_best_long_only_return(session_df: pd.DataFrame) -> float:
    best_return = 0.0
    min_low = float("inf")
    for row in session_df.itertuples(index=False):
        min_low = min(min_low, float(row.low))
        if min_low > 0:
            best_return = max(best_return, ((float(row.high) / min_low) - 1) * 100)
    return best_return


def choose_start_candle_index(session_df: pd.DataFrame, start_time: str | None = None) -> int:
    if start_time:
        try:
            target_time = datetime.strptime(start_time, "%H:%M").time()
        except ValueError:
            raise HTTPException(status_code=400, detail="startTime must use HH:MM format") from None
        if start_time not in START_TIME_OPTIONS:
            options_text = ", ".join(START_TIME_OPTIONS)
            raise HTTPException(status_code=400, detail=f"startTime must be one of: {options_text}")
        if target_time < REGULAR_START:
            return 0

        timestamps = pd.to_datetime(session_df["timestamp"])
        matching_indexes = [index for index, timestamp in enumerate(timestamps) if timestamp.time() == target_time]
        if not matching_indexes:
            raise HTTPException(status_code=404, detail=f"No candle found at {start_time}")
        return matching_indexes[0]

    eligible = [
        index
        for index, timestamp in enumerate(pd.to_datetime(session_df["timestamp"]))
        if SPAWN_START <= timestamp.time() <= SPAWN_END
    ]
    return random.choice(eligible) if eligible else 0


def phase_for_candle_index(candle_index: int) -> str:
    if candle_index < 120:
        return "early"
    if candle_index < 270:
        return "midday"
    return "end_of_day"


def score_phase_adjustment(fills: list[TradeFill], replay_ticks: list[dict[str, Any]], hidden_tags: list[str]) -> dict[str, Any]:
    if not fills:
        return {"phaseScoreAdjustment": 0.0, "tradedPhases": [], "matchedPhaseTags": []}

    tick_to_candle = {int(tick["tickIndex"]): int(tick["candleIndex"]) for tick in replay_ticks}
    traded_phases = sorted({phase_for_candle_index(tick_to_candle.get(fill.tick_index, 0)) for fill in fills}, key=["early", "midday", "end_of_day"].index)
    phase_tag_weights = {
        "early_bull_run": 1.2,
        "midday_bull_run": 0.9,
        "end_of_day_bull_run": 0.8,
        "early_bear_run": 1.2,
        "midday_bear_run": 0.9,
        "end_of_day_bear_run": 0.8,
        "early_chop": -0.7,
        "midday_chop": -0.6,
        "end_of_day_chop": -0.5,
    }
    matched: list[str] = []
    adjustment = 0.0
    for tag, weight in phase_tag_weights.items():
        tag_phase = "end_of_day" if tag.startswith("end_of_day") else tag.split("_", 1)[0]
        if tag in hidden_tags and tag_phase in traded_phases:
            matched.append(tag)
            adjustment += weight
    return {
        "phaseScoreAdjustment": round(max(-2.0, min(2.0, adjustment)), 2),
        "tradedPhases": traded_phases,
        "matchedPhaseTags": matched,
    }


def calculate_score(session: dict[str, Any], request: ScoreRequest) -> dict[str, Any]:
    session_df = normalized_df_for_date(session["date"], session.get("ticker", "SPY"))
    replay_ticks = build_replay_ticks(session_df, session.get("replaySpeed", "3x Speed"))
    fills = sorted(request.trades, key=lambda fill: fill.tick_index)

    cash = float(request.starting_capital)
    position = 0.0
    avg_cost = 0.0
    realized_pnl = 0.0
    wins = 0
    losses = 0

    buy_notional = 0.0
    buy_quantity = 0.0
    sell_notional = 0.0
    sell_quantity = 0.0

    for fill in fills:
        quantity = max(float(fill.quantity), 0.0)
        price = max(float(fill.price), 0.0)
        if quantity == 0 or price == 0:
            continue

        if fill.side == "buy":
            cost = quantity * price
            cash -= cost
            avg_cost = ((avg_cost * position) + cost) / (position + quantity) if position + quantity else 0
            position += quantity
            buy_notional += cost
            buy_quantity += quantity
        else:
            sell_quantity_actual = min(quantity, position)
            if sell_quantity_actual <= 0:
                continue
            proceeds = sell_quantity_actual * price
            pnl = (price - avg_cost) * sell_quantity_actual
            cash += proceeds
            position -= sell_quantity_actual
            realized_pnl += pnl
            sell_notional += proceeds
            sell_quantity += sell_quantity_actual
            if pnl > 0:
                wins += 1
            elif pnl < 0:
                losses += 1
            if position <= 1e-9:
                position = 0.0
                avg_cost = 0.0

    final_price = float(session_df.iloc[-1]["close"])
    final_equity = cash + (position * final_price)
    total_return = ((final_equity / request.starting_capital) - 1) * 100

    first_open = float(session_df.iloc[0]["open"])
    buy_and_hold_return = ((final_price / first_open) - 1) * 100
    score = total_return - buy_and_hold_return

    trades_by_tick: dict[int, list[TradeFill]] = {}
    for fill in fills:
        trades_by_tick.setdefault(fill.tick_index, []).append(fill)

    curve_cash = float(request.starting_capital)
    curve_position = 0.0
    peak_equity = float(request.starting_capital)
    max_drawdown = 0.0
    for tick in replay_ticks:
        for fill in trades_by_tick.get(tick["tickIndex"], []):
            quantity = max(float(fill.quantity), 0.0)
            price = max(float(fill.price), 0.0)
            if fill.side == "buy":
                curve_cash -= quantity * price
                curve_position += quantity
            else:
                sell_quantity_actual = min(quantity, curve_position)
                curve_cash += sell_quantity_actual * price
                curve_position -= sell_quantity_actual

        equity = curve_cash + (curve_position * float(tick["price"]))
        peak_equity = max(peak_equity, equity)
        if peak_equity > 0:
            max_drawdown = max(max_drawdown, ((peak_equity - equity) / peak_equity) * 100)

    day_low = float(session_df["low"].min())
    day_high = float(session_df["high"].max())
    day_range = max(day_high - day_low, 1e-9)
    avg_buy = buy_notional / buy_quantity if buy_quantity else None
    avg_sell = sell_notional / sell_quantity if sell_quantity else None
    entry_timing_score = 0.0 if avg_buy is None else max(0.0, min(100.0, ((day_high - avg_buy) / day_range) * 100))
    exit_timing_score = 0.0 if avg_sell is None else max(0.0, min(100.0, ((avg_sell - day_low) / day_range) * 100))

    metadata = next(
        row
        for row in build_metadata()
        if row["date"] == session["date"] and row["ticker"] == session.get("ticker", "SPY")
    )
    hidden_tags, tag_features = hidden_day_tags(
        session_df,
        previous_session_df(session["date"], session.get("ticker", "SPY")),
        classifier_thresholds(build_metadata()),
    )
    phase_adjustment = score_phase_adjustment(fills, replay_ticks, hidden_tags)
    adjusted_score = score + phase_adjustment["phaseScoreAdjustment"]
    return {
        "ticker": session.get("ticker", "SPY"),
        "date": "Hidden",
        "assetClass": metadata["assetClass"],
        "scenario": session["scenario"],
        "finalPnl": round(final_equity - request.starting_capital, 2),
        "returnPct": round(total_return, 2),
        "maxDrawdownPct": round(max_drawdown, 2),
        "numberOfTrades": len(fills),
        "wins": wins,
        "losses": losses,
        "buyAndHoldReturnPct": round(buy_and_hold_return, 2),
        "spyReturnPct": round(buy_and_hold_return, 2),
        "bestPossibleLongOnlyReturnPct": round(compute_best_long_only_return(session_df), 2),
        "entryTimingScore": round(entry_timing_score, 1),
        "exitTimingScore": round(exit_timing_score, 1),
        "score": round(adjusted_score, 2),
        "baseScore": round(score, 2),
        **phase_adjustment,
        "realizedPnl": round(realized_pnl, 2),
        "endingCash": round(cash, 2),
        "endingShares": round(position, 6),
        "finalPrice": round(final_price, 4),
        "hardcore": bool(session.get("hardcore", False)),
        "hiddenTags": hidden_tags,
        "tagFeatures": tag_features,
    }


def public_user(user: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": user["id"],
        "username": user["username"],
        "displayName": user.get("displayName", user["username"]),
        "forcePasswordChange": user.get("forcePasswordChange", False),
        "isAdmin": user.get("isAdmin", False),
    }


def current_user(request: Request) -> dict[str, Any]:
    user = PROFILE_STORE.user_for_session(request.cookies.get(SESSION_COOKIE_NAME))
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user


def optional_current_user(request: Request) -> dict[str, Any] | None:
    return PROFILE_STORE.user_for_session(request.cookies.get(SESSION_COOKIE_NAME))


def require_admin(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    if not user.get("isAdmin", False):
        raise HTTPException(status_code=403, detail="Admin access required")
    return user


def profile_response(user: dict[str, Any]) -> dict[str, Any]:
    profile = PROFILE_STORE.get_profile(user["id"])
    return {
        "version": 1,
        "username": user["username"],
        **profile,
    }


@app.post("/api/auth/login")
def login(request: LoginRequest, response: Response) -> dict[str, Any]:
    username = request.username.strip()
    user = PROFILE_STORE.get_user_by_username(username)
    if not user or not verify_password(request.password, user["passwordHash"]):
        raise HTTPException(status_code=401, detail="Invalid username or password")
    if request.display_name is not None and request.display_name.strip():
        try:
            user = PROFILE_STORE.update_display_name(user["id"], request.display_name)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from None
    token = PROFILE_STORE.create_session(user["id"], days=SESSION_DAYS)
    response.set_cookie(
        SESSION_COOKIE_NAME,
        token,
        httponly=True,
        secure=COOKIE_SECURE,
        samesite="lax",
        max_age=SESSION_DAYS * 24 * 60 * 60,
        path="/",
    )
    return {"authenticated": True, "user": public_user(user)}


@app.post("/api/auth/logout")
def logout(request: Request, response: Response) -> dict[str, bool]:
    PROFILE_STORE.delete_session(request.cookies.get(SESSION_COOKIE_NAME))
    response.delete_cookie(SESSION_COOKIE_NAME, path="/")
    return {"ok": True}


@app.get("/api/auth/me")
def auth_me(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return {"authenticated": True, "user": public_user(user)}


@app.get("/api/me/profile")
def get_my_profile(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return profile_response(user)


@app.put("/api/me/profile")
def update_my_profile(payload: ProfilePayload, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    PROFILE_STORE.update_profile(
        user["id"],
        {
            "settings": payload.settings,
            "setup": payload.setup,
            "chartSetupUi": payload.chart_setup_ui,
            "chartTemplates": payload.chart_templates,
            "activeTemplateId": payload.active_template_id,
            "history": payload.history,
        },
    )
    return profile_response(user)


@app.put("/api/me/display-name")
def update_my_display_name(payload: dict[str, str], user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    try:
        updated = PROFILE_STORE.update_display_name(user["id"], validate_display_name(payload.get("displayName", "")))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    return {"user": public_user(updated)}


@app.post("/api/analytics/visit")
def analytics_visit(payload: AnalyticsVisitRequest, request: Request, user: dict[str, Any] | None = Depends(optional_current_user)) -> dict[str, bool]:
    if not payload.visitor_id.strip() or not payload.visit_id.strip():
        raise HTTPException(status_code=400, detail="Missing analytics visitor or visit id")
    PROFILE_STORE.record_visit(
        visitor_id=payload.visitor_id.strip()[:120],
        visit_id=payload.visit_id.strip()[:120],
        path=payload.path,
        referrer=payload.referrer,
        user_agent=request.headers.get("user-agent", ""),
        user_id=user["id"] if user else None,
    )
    return {"ok": True}


@app.post("/api/analytics/event")
def analytics_event(payload: AnalyticsEventRequest, request: Request, user: dict[str, Any] | None = Depends(optional_current_user)) -> dict[str, bool]:
    visitor_id = payload.visitor_id.strip()[:120]
    visit_id = payload.visit_id.strip()[:120]
    event_name = payload.event_name.strip().lower().replace(" ", "_")[:80]
    if not visitor_id or not visit_id or not event_name:
        raise HTTPException(status_code=400, detail="Missing analytics event fields")
    PROFILE_STORE.record_visit(
        visitor_id=visitor_id,
        visit_id=visit_id,
        path=payload.path,
        referrer="",
        user_agent=request.headers.get("user-agent", ""),
        user_id=user["id"] if user else None,
    )
    PROFILE_STORE.record_event(
        visitor_id=visitor_id,
        visit_id=visit_id,
        event_name=event_name,
        path=payload.path,
        payload=payload.payload,
        user_id=user["id"] if user else None,
    )
    return {"ok": True}


@app.get("/api/analytics/dashboard")
def analytics_dashboard(user: dict[str, Any] = Depends(require_admin)) -> dict[str, Any]:
    return PROFILE_STORE.analytics_dashboard()


@app.get("/api/scoreboard")
def scoreboard_dashboard(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return PROFILE_STORE.scoreboard_dashboard(user["id"])


@app.post("/api/replays/{score_id}/save")
def save_replay(score_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    try:
        PROFILE_STORE.save_replay(user["id"], score_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from None
    return PROFILE_STORE.scoreboard_dashboard(user["id"])


@app.delete("/api/replays/{score_id}")
def delete_replay(score_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    PROFILE_STORE.delete_replay(user["id"], score_id)
    return PROFILE_STORE.scoreboard_dashboard(user["id"])


@app.get("/api/health")
def health() -> dict[str, Any]:
    dates = session_dates()
    if MARKET_DATA_STORE.available():
        refs = MARKET_DATA_STORE.session_refs()
        return {
            "status": "ok",
            "rows": len(refs) * 390,
            "ticker": "SPY",
            "sessionCount": len(dates),
            "storage": "duckdb-parquet",
            "catalog": str(MARKET_DATA_STORE.catalog_path),
            "dataDir": str(MARKET_DATA_STORE.candle_dir),
        }
    df = load_spy_data()
    return {
        "status": "ok",
        "rows": len(df),
        "ticker": "SPY",
        "sessionCount": len(dates),
        "storage": "legacy-parquet",
        "dataFile": str(DATA_PATH),
    }


@app.get("/api/sessions/options")
def session_options() -> dict[str, Any]:
    metadata = build_metadata()
    scenario_counts = scenario_availability_counts(metadata)
    asset_options = []
    for asset_class in ASSET_CLASSES:
        count = sum(1 for row in metadata if asset_matches(row, asset_class))
        asset_options.append({"label": asset_class, "availableCount": count, "enabled": count > 0})

    symbol_counts = {symbol: 0 for symbol in KNOWN_ASSETS}
    symbol_asset_class = {symbol: asset_class for asset_class, symbols in ASSET_CLASS_TICKERS.items() for symbol in symbols}
    for row in metadata:
        symbol_counts[row["ticker"]] = symbol_counts.get(row["ticker"], 0) + 1
        symbol_asset_class.setdefault(row["ticker"], row["assetClass"])
    asset_options_by_symbol = [
        {
            "label": "Random",
            "assetClass": "Random",
            "availableCount": len(metadata),
            "enabled": len(metadata) > 0,
        },
        *[
            {
                "label": symbol,
                "assetClass": symbol_asset_class.get(symbol, "Equity"),
                "description": SYMBOL_DESCRIPTIONS.get(symbol, symbol_asset_class.get(symbol, "Equity")),
                "availableCount": symbol_counts.get(symbol, 0),
                "enabled": symbol_counts.get(symbol, 0) > 0,
            }
            for symbol in sorted(symbol_asset_class)
            if symbol_counts.get(symbol, 0) > 0
        ],
    ]

    scenario_options = []
    for scenario in SCENARIOS:
        count = scenario_counts.get(scenario, 0)
        scenario_options.append({"label": scenario, "availableCount": count, "enabled": count > 0})

    return {
        "tickers": sorted(symbol_counts),
        "assetClasses": asset_options,
        "assets": asset_options_by_symbol,
        "scenarios": scenario_options,
        "timeframes": TIMEFRAMES,
        "startTimes": START_TIME_OPTIONS,
        "startingCapital": STARTING_CAPITAL,
        "replaySpeeds": [{"label": speed, "secondsPerTick": SPEED_SECONDS[speed]} for speed in REPLAY_SPEEDS],
        "metadata": [
            {
                "ticker": row["ticker"],
                "assetClass": row["assetClass"],
                "scenarioFlags": row["scenarioFlags"],
            }
            for row in metadata
        ],
    }


@app.post("/api/sessions/start")
def start_session(request: StartSessionRequest) -> dict[str, Any]:
    if request.timeframe not in TIMEFRAMES:
        raise HTTPException(status_code=400, detail=f"Unsupported timeframe: {request.timeframe}")
    if request.replay_speed not in REPLAY_SPEEDS:
        raise HTTPException(status_code=400, detail=f"Unsupported replay speed: {request.replay_speed}")
    if request.asset_class not in ASSET_CLASSES:
        raise HTTPException(status_code=400, detail=f"Unsupported asset class: {request.asset_class}")
    available_symbols = {row["ticker"] for row in build_metadata()}
    if request.asset != "Random" and request.asset not in {*KNOWN_ASSETS, *available_symbols}:
        raise HTTPException(status_code=400, detail=f"Unsupported asset: {request.asset}")
    selected_scenario_tags = required_scenario_tags(request.scenario_filters, request.scenario)
    scenario_label = " / ".join(selected_scenario_tags) if selected_scenario_tags else "Random"
    if int(request.starting_capital) not in STARTING_CAPITAL:
        raise HTTPException(status_code=400, detail=f"Unsupported starting capital: {request.starting_capital}")

    if not selected_scenario_tags or all(tag in SESSION_LEVEL_SCENARIO_TAGS for tag in selected_scenario_tags):
        matches = matching_metadata(request.asset_class, request.asset, selected_scenario_tags)
        if request.practice_date:
            matches = [row for row in matches if row["date"] == request.practice_date]
        if not matches:
            raise HTTPException(status_code=404, detail="No sessions match those filters.")
        selected = choose_random_session(matches)
        selected_df = normalized_df_for_date(selected["date"], selected["ticker"])
        start_candle_index = choose_start_candle_index(selected_df, request.start_time)
    else:
        matches = matching_spawn_candidates(request.asset_class, request.asset, selected_scenario_tags, request.practice_date, request.start_time)
        if not matches:
            raise HTTPException(status_code=404, detail="No sessions match those filters.")
        selected = choose_random_session(matches)
        selected_df = normalized_df_for_date(selected["date"], selected["ticker"])
        start_candle_index = int(selected["startCandleIndex"])
    ticks_per_candle = replay_ticks_per_candle(request.replay_speed)
    session_id = uuid4().hex
    SESSION_STORE[session_id] = {
        "ticker": selected["ticker"],
        "date": selected["date"],
        "assetClass": selected["assetClass"],
        "asset": request.asset,
        "scenario": scenario_label,
        "scenarioFilters": scenario_filter_values(request.scenario_filters),
        "timeframe": request.timeframe,
        "startingCapital": request.starting_capital,
        "replaySpeed": request.replay_speed,
        "hardcore": request.hardcore,
        "startTime": request.start_time,
        "startCandleIndex": start_candle_index,
        "startTickIndex": start_candle_index * ticks_per_candle,
        "premarketSource": "synthetic",
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }
    return {
        "sessionId": session_id,
        "ticker": selected["ticker"],
        "date": DISPLAY_SESSION_DATE,
        "label": {
            "assetClass": request.asset_class if request.asset_class != "Random" else selected["assetClass"],
            "scenario": scenario_label,
        },
        "timeframe": request.timeframe,
        "startingCapital": request.starting_capital,
        "replaySpeed": request.replay_speed,
        "hardcore": request.hardcore,
        "startTime": request.start_time,
        "availableCandles": len(selected_df),
        "startCandleIndex": start_candle_index,
        "startTickIndex": start_candle_index * ticks_per_candle,
        "premarketSource": "synthetic",
    }


def get_session_or_404(session_id: str) -> dict[str, Any]:
    session = SESSION_STORE.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return session


@app.get("/api/sessions/{session_id}/candles")
def session_candles(session_id: str, timeframe: str = Query(default="1m")) -> dict[str, Any]:
    session = get_session_or_404(session_id)
    context_df, premarket_source = context_df_for_date(session["date"], session.get("ticker", "SPY"))
    candles = serialize_candles(resample_context(context_df, timeframe))
    return {"sessionId": session_id, "timeframe": timeframe, "premarketSource": premarket_source, "candles": candles}


@app.get("/api/sessions/{session_id}/replay")
def session_replay(session_id: str) -> dict[str, Any]:
    session = get_session_or_404(session_id)
    session_df = normalized_df_for_date(session["date"], session.get("ticker", "SPY"))
    return {"sessionId": session_id, "ticks": build_replay_ticks(session_df, session.get("replaySpeed", "3x Speed"))}


@app.post("/api/sessions/{session_id}/score")
def session_score(session_id: str, request: ScoreRequest, user: dict[str, Any] | None = Depends(optional_current_user)) -> dict[str, Any]:
    session = get_session_or_404(session_id)
    scorecard = calculate_score(session, request)
    if user and scorecard.get("hardcore") is True:
        scorecard = PROFILE_STORE.insert_score_entry(
            user["id"],
            user.get("displayName", user["username"]),
            scorecard,
            replay_metadata={
                key: session.get(key)
                for key in [
                    "ticker",
                    "date",
                    "assetClass",
                    "asset",
                    "scenario",
                    "scenarioFilters",
                    "timeframe",
                    "startingCapital",
                    "replaySpeed",
                    "hardcore",
                    "startTime",
                    "startCandleIndex",
                    "startTickIndex",
                    "premarketSource",
                ]
            },
            trades=[fill.model_dump(mode="json") for fill in request.trades],
        )
    return scorecard
