from __future__ import annotations

from datetime import datetime, time, timedelta, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal
from uuid import uuid4
import hashlib
import random

import pandas as pd
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field


ROOT_DIR = Path(__file__).resolve().parents[1]
DATA_PATH = ROOT_DIR / "spy_1min_candles.parquet"

ASSET_CLASSES = [
    "Random",
    "Equity",
    "Bond",
    "Commodity",
    "Currency",
    "Volatility",
    "Leveraged",
    "Inverse",
]
SCENARIOS = [
    "Random",
    "Above 200 SMA",
    "Below 200 SMA",
    "Gap Up",
    "Gap Down",
    "High Volatility",
    "Low Volatility",
    "Trend Day",
    "Chop Day",
    "Large Volume Day",
]
TIMEFRAMES = ["1m", "5m", "15m", "30m", "1h"]
STARTING_CAPITAL = [10_000, 25_000, 100_000]
REPLAY_SPEEDS = ["Slow", "Normal", "Fast", "Manual"]
SPEED_SECONDS = {"Slow": 1.0, "Normal": 0.5, "Fast": 0.25, "Manual": None}
REPLAY_TICKS_PER_CANDLE = 8
RANDOM_TICKS_PER_CANDLE = 4


class StartSessionRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    asset_class: str = Field(default="Random", alias="assetClass")
    scenario: str = "Random"
    timeframe: str = "1m"
    starting_capital: float = Field(default=25_000, alias="startingCapital")
    replay_speed: str = Field(default="Normal", alias="replaySpeed")
    practice_date: str | None = Field(default=None, alias="practiceDate")


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


app = FastAPI(title="Trading Replay Game API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
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
    return df.reset_index(drop=True)


def session_dates() -> list[str]:
    df = load_spy_data()
    return [str(value) for value in sorted(df["timestamp"].dt.date.unique())]


def df_for_date(session_date: str) -> pd.DataFrame:
    df = load_spy_data()
    date_values = df["timestamp"].dt.strftime("%Y-%m-%d")
    session_df = df[date_values == session_date].copy()
    if session_df.empty:
        raise HTTPException(status_code=404, detail=f"No SPY data for {session_date}")
    return session_df.sort_values("timestamp").reset_index(drop=True)


def build_metadata() -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    previous_close: float | None = None

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
                "dailyReturn": ((close_price / open_price) - 1) * 100,
                "gapPct": gap_pct,
                "volatilityScore": ((high - low) / open_price) * 100,
                "volumeScore": volume,
            }
        )
        previous_close = close_price

    if not rows:
        return []

    volatility_median = pd.Series([row["volatilityScore"] for row in rows]).median()
    volume_median = pd.Series([row["volumeScore"] for row in rows]).median()
    trend_median = pd.Series([abs(row["dailyReturn"]) for row in rows]).median()

    for row in rows:
        row["scenarioFlags"] = {
            "Random": True,
            "Above 200 SMA": False,
            "Below 200 SMA": False,
            "Gap Up": row["gapPct"] is not None and row["gapPct"] > 0,
            "Gap Down": row["gapPct"] is not None and row["gapPct"] < 0,
            "High Volatility": row["volatilityScore"] >= volatility_median,
            "Low Volatility": row["volatilityScore"] <= volatility_median,
            "Trend Day": abs(row["dailyReturn"]) >= trend_median,
            "Chop Day": abs(row["dailyReturn"]) <= trend_median,
            "Large Volume Day": row["volumeScore"] >= volume_median,
        }
    return rows


def asset_matches(row: dict[str, Any], asset_class: str) -> bool:
    if asset_class == "Random":
        return True
    return row["assetClass"] == asset_class


def scenario_matches(row: dict[str, Any], scenario: str) -> bool:
    return bool(row["scenarioFlags"].get(scenario, False))


def matching_metadata(asset_class: str, scenario: str) -> list[dict[str, Any]]:
    return [
        row
        for row in build_metadata()
        if asset_matches(row, asset_class) and scenario_matches(row, scenario)
    ]


def resample_session(session_df: pd.DataFrame, timeframe: str) -> pd.DataFrame:
    if timeframe == "1m":
        return session_df.copy()

    rules = {"5m": "5min", "15m": "15min", "30m": "30min", "1h": "60min"}
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


def serialize_candles(session_df: pd.DataFrame) -> list[dict[str, Any]]:
    candles = []
    for row in session_df.itertuples(index=False):
        candles.append(
            {
                "timestamp": row.timestamp.isoformat(),
                "open": float(row.open),
                "high": float(row.high),
                "low": float(row.low),
                "close": float(row.close),
                "volume": int(row.volume),
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


def choose_extreme_positions(rng: random.Random) -> tuple[int, int]:
    candidates = [
        (high_position, low_position)
        for high_position in range(1, REPLAY_TICKS_PER_CANDLE - 1)
        for low_position in range(1, REPLAY_TICKS_PER_CANDLE - 1)
        if high_position != low_position and abs(high_position - low_position) > 1
    ]
    return rng.choice(candidates)


def synthetic_price(row: Any, tick_position: int, rng: random.Random) -> float:
    open_price = float(row.open)
    high_price = float(row.high)
    low_price = float(row.low)
    close_price = float(row.close)
    candle_range = max(high_price - low_price, 0.0)
    if candle_range == 0:
        return close_price

    progress = tick_position / (REPLAY_TICKS_PER_CANDLE - 1)
    smooth_price = open_price + ((close_price - open_price) * progress)
    random_price = low_price + (rng.random() * candle_range)
    range_pct = candle_range / max(abs(open_price), 1e-9)
    volatility_score = min(1.0, range_pct / 0.0015)
    random_weight = 0.18 + (0.67 * volatility_score)
    price = (smooth_price * (1 - random_weight)) + (random_price * random_weight)
    return max(low_price, min(high_price, price))


def build_intracandle_path(row: Any, candle_index: int) -> list[tuple[str, float]]:
    rng = seeded_candle_rng(row, candle_index)
    high_position, low_position = choose_extreme_positions(rng)
    path: list[tuple[str, float]] = []

    for tick_position in range(REPLAY_TICKS_PER_CANDLE):
        if tick_position == 0:
            path.append(("open", float(row.open)))
        elif tick_position == REPLAY_TICKS_PER_CANDLE - 1:
            path.append(("close", float(row.close)))
        elif tick_position == high_position:
            path.append(("high", float(row.high)))
        elif tick_position == low_position:
            path.append(("low", float(row.low)))
        else:
            path.append(("random", synthetic_price(row, tick_position, rng)))

    random_count = sum(1 for phase, _ in path if phase == "random")
    if random_count != RANDOM_TICKS_PER_CANDLE:
        raise RuntimeError(f"Expected {RANDOM_TICKS_PER_CANDLE} random ticks, found {random_count}")
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


def build_replay_ticks(session_df: pd.DataFrame) -> list[dict[str, Any]]:
    ticks: list[dict[str, Any]] = []
    tick_index = 0
    for candle_index, row in enumerate(session_df.itertuples(index=False)):
        path = build_intracandle_path(row, candle_index)
        volume_deltas = allocate_volume_deltas(path, int(row.volume))
        cumulative_volume = 0

        for phase_index, (phase, price) in enumerate(path):
            tick_time = row.timestamp + timedelta(seconds=phase_index * (60 / REPLAY_TICKS_PER_CANDLE))
            volume_delta = volume_deltas[phase_index]
            cumulative_volume += volume_delta
            ticks.append(
                {
                    "tickIndex": tick_index,
                    "candleIndex": candle_index,
                    "sequenceInCandle": phase_index,
                    "ticksInCandle": REPLAY_TICKS_PER_CANDLE,
                    "phase": phase,
                    "timestamp": tick_time.isoformat(),
                    "candleTimestamp": row.timestamp.isoformat(),
                    "price": float(price),
                    "volume": cumulative_volume,
                    "volumeDelta": volume_delta,
                    "candleVolume": int(row.volume),
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


def calculate_score(session: dict[str, Any], request: ScoreRequest) -> dict[str, Any]:
    session_df = df_for_date(session["date"])
    replay_ticks = build_replay_ticks(session_df)
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

    metadata = next(row for row in build_metadata() if row["date"] == session["date"])
    return {
        "ticker": "SPY",
        "date": session["date"],
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
        "score": round(score, 2),
        "realizedPnl": round(realized_pnl, 2),
        "endingCash": round(cash, 2),
        "endingShares": round(position, 6),
        "finalPrice": round(final_price, 4),
    }


@app.get("/api/health")
def health() -> dict[str, Any]:
    df = load_spy_data()
    return {
        "status": "ok",
        "rows": len(df),
        "ticker": "SPY",
        "dates": session_dates(),
        "dataFile": str(DATA_PATH),
    }


@app.get("/api/sessions/options")
def session_options() -> dict[str, Any]:
    metadata = build_metadata()
    asset_options = []
    for asset_class in ASSET_CLASSES:
        count = sum(1 for row in metadata if asset_matches(row, asset_class))
        asset_options.append({"label": asset_class, "availableCount": count, "enabled": count > 0})

    scenario_options = []
    for scenario in SCENARIOS:
        count = sum(1 for row in metadata if scenario_matches(row, scenario))
        scenario_options.append({"label": scenario, "availableCount": count, "enabled": count > 0})

    return {
        "tickers": ["SPY"],
        "dates": session_dates(),
        "assetClasses": asset_options,
        "scenarios": scenario_options,
        "timeframes": TIMEFRAMES,
        "startingCapital": STARTING_CAPITAL,
        "replaySpeeds": [{"label": speed, "secondsPerTick": SPEED_SECONDS[speed]} for speed in REPLAY_SPEEDS],
        "metadata": metadata,
    }


@app.post("/api/sessions/start")
def start_session(request: StartSessionRequest) -> dict[str, Any]:
    if request.timeframe not in TIMEFRAMES:
        raise HTTPException(status_code=400, detail=f"Unsupported timeframe: {request.timeframe}")
    if request.replay_speed not in REPLAY_SPEEDS:
        raise HTTPException(status_code=400, detail=f"Unsupported replay speed: {request.replay_speed}")
    if request.asset_class not in ASSET_CLASSES:
        raise HTTPException(status_code=400, detail=f"Unsupported asset class: {request.asset_class}")
    if request.scenario not in SCENARIOS:
        raise HTTPException(status_code=400, detail=f"Unsupported scenario: {request.scenario}")

    matches = matching_metadata(request.asset_class, request.scenario)
    if request.practice_date:
        matches = [row for row in matches if row["date"] == request.practice_date]

    if not matches:
        raise HTTPException(status_code=404, detail="No SPY prototype sessions match those filters.")

    selected = random.choice(matches)
    session_id = uuid4().hex
    SESSION_STORE[session_id] = {
        "date": selected["date"],
        "assetClass": selected["assetClass"],
        "scenario": request.scenario,
        "timeframe": request.timeframe,
        "startingCapital": request.starting_capital,
        "replaySpeed": request.replay_speed,
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }
    return {
        "sessionId": session_id,
        "label": {
            "assetClass": request.asset_class if request.asset_class != "Random" else selected["assetClass"],
            "scenario": request.scenario,
        },
        "timeframe": request.timeframe,
        "startingCapital": request.starting_capital,
        "replaySpeed": request.replay_speed,
        "availableCandles": len(df_for_date(selected["date"])),
    }


def get_session_or_404(session_id: str) -> dict[str, Any]:
    session = SESSION_STORE.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return session


@app.get("/api/sessions/{session_id}/candles")
def session_candles(session_id: str, timeframe: str = Query(default="1m")) -> dict[str, Any]:
    session = get_session_or_404(session_id)
    session_df = df_for_date(session["date"])
    candles = serialize_candles(resample_session(session_df, timeframe))
    return {"sessionId": session_id, "timeframe": timeframe, "candles": candles}


@app.get("/api/sessions/{session_id}/replay")
def session_replay(session_id: str) -> dict[str, Any]:
    session = get_session_or_404(session_id)
    session_df = df_for_date(session["date"])
    return {"sessionId": session_id, "ticks": build_replay_ticks(session_df)}


@app.post("/api/sessions/{session_id}/score")
def session_score(session_id: str, request: ScoreRequest) -> dict[str, Any]:
    session = get_session_or_404(session_id)
    return calculate_score(session, request)
