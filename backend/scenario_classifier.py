from __future__ import annotations

from typing import Any

import pandas as pd


SAFE_SCENARIOS = [
    "Random",
    "Above 200 SMA",
    "Below 200 SMA",
    "Gap Up",
    "Gap Down",
    "Large Premarket Volume Increase",
    "Large Premarket Volume Decrease",
    "High Volatility",
    "Low Volatility",
]

HIDDEN_TAGS = [
    "trend_day",
    "chop_day",
    "range_chop",
    "breakout",
    "upside_breakout",
    "downside_flush",
    "late_breakout",
    "late_breakdown",
    "gap_and_go",
    "gap_fill",
    "failed_breakout",
    "failed_extension",
    "midday_reversal",
    "v_reversal",
    "early_bull_run",
    "early_bear_run",
    "midday_bull_run",
    "midday_bear_run",
    "end_of_day_bull_run",
    "end_of_day_bear_run",
    "early_chop",
    "midday_chop",
    "end_of_day_chop",
    "early_v_reversal",
    "midday_v_reversal",
    "end_of_day_v_reversal",
    "early_inverted_v_reversal",
    "midday_inverted_v_reversal",
    "end_of_day_inverted_v_reversal",
    "bullish_range_reclaim",
    "bearish_range_rejection",
    "grinding_higher",
    "grinding_lower",
    "bull_run_and_settle",
    "bear_run_and_settle",
    "bullish_continuation",
    "bearish_continuation",
    "opening_drive_continuation",
    "opening_drive_reversal",
    "trend_pause_continue",
    "morning_range_afternoon_trend",
    "trend_into_late_chop",
    "bull_trap",
    "bear_trap",
    "morning_drive_reversal",
    "midday_continuation",
    "late_day_continuation",
    "late_day_reversal",
    "range_expansion",
    "range_contraction",
    "trend_then_chop",
    "chop_then_trend",
    "v_day",
    "inverted_v_day",
    "double_distribution",
    "failed_continuation",
    "late_squeeze",
    "late_flush",
    "gap_hold",
    "gap_reversal",
    "opening_drive_hold",
    "opening_drive_fail",
    "afternoon_takeover",
    "balanced_day",
    "rotational_day",
    "one_timeframe_up",
    "one_timeframe_down",
    "rally_into_settle",
    "selloff_into_settle",
    "short_squeeze_like",
    "panic_selloff",
    "range_bound",
    "vwap_reclaim",
    "vwap_rejection",
    "close_near_high",
    "close_near_low",
]


def safe_percentile(values: list[float], percentile: float, fallback: float = 0.0) -> float:
    clean = [value for value in values if pd.notna(value)]
    if not clean:
        return fallback
    return float(pd.Series(clean).quantile(percentile))


def count_crosses(values: pd.Series, center: float) -> int:
    crosses = 0
    previous_side = 0
    for value in values:
        side = 1 if float(value) > center else -1 if float(value) < center else 0
        if side == 0:
            continue
        if previous_side and side != previous_side:
            crosses += 1
        previous_side = side
    return crosses


def count_failed_value_extensions(inside_value_area: pd.Series, max_minutes: int = 30) -> int:
    failed_extensions = 0
    outside_start: int | None = None
    for index, inside in enumerate(inside_value_area.astype(bool)):
        if not inside and outside_start is None:
            outside_start = index
        elif inside and outside_start is not None:
            if index - outside_start <= max_minutes:
                failed_extensions += 1
            outside_start = None
    return failed_extensions


def longest_stalled_value_area_run(location_series: pd.Series, inside_value_area: pd.Series, low_extreme = 0.25, high_extreme = 0.75) -> int:
    longest = 0
    current = 0
    for location, inside in zip(location_series, inside_value_area):
        in_middle = low_extreme < float(location) < high_extreme
        if bool(inside) and in_middle:
            current += 1
            longest = max(longest, current)
        else:
            current = 0
    return longest


def stalled_value_area_minutes(location_series: pd.Series, inside_value_area: pd.Series, low_extreme = 0.25, high_extreme = 0.75) -> int:
    return sum(1 for location, inside in zip(location_series, inside_value_area) if bool(inside) and low_extreme < float(location) < high_extreme)


def segment_behavior_tags(
    df: pd.DataFrame,
    close: pd.Series,
    location_series: pd.Series,
    inside_value_area: pd.Series,
) -> list[str]:
    segments = [
        ("early", 0, 120),
        ("midday", 120, 270),
        ("end_of_day", 270, len(df)),
    ]
    tags: list[str] = []
    for name, start, end in segments:
        segment_close = close.iloc[start:end]
        if len(segment_close) < 45:
            continue
        segment_high = float(df.iloc[start:end]["high"].max())
        segment_low = float(df.iloc[start:end]["low"].min())
        segment_range = max(segment_high - segment_low, 1e-9)
        segment_locations = (segment_close - segment_low) / segment_range
        segment_value_low = float(segment_close.quantile(0.15))
        segment_value_high = float(segment_close.quantile(0.85))
        segment_inside = segment_close.between(segment_value_low, segment_value_high)
        location_change = float(segment_locations.iloc[-1] - segment_locations.iloc[0])
        segment_return = ((float(segment_close.iloc[-1]) / max(float(segment_close.iloc[0]), 1e-9)) - 1) * 100
        segment_center = (segment_value_low + segment_value_high) / 2
        segment_crosses = count_crosses(segment_close, segment_center)
        segment_stall = stalled_value_area_minutes(segment_locations.reset_index(drop=True), segment_inside.reset_index(drop=True), 0.20, 0.80)
        segment_value_time = float(segment_inside.mean())
        segment_returns = segment_close.pct_change().fillna(0.0)
        positive_pressure = float(segment_returns.clip(lower=0.0).sum())
        negative_pressure = float(segment_returns.clip(upper=0.0).abs().sum())
        pressure_total = max(positive_pressure + negative_pressure, 1e-9)
        positive_share = positive_pressure / pressure_total
        negative_share = negative_pressure / pressure_total
        min_index = int(segment_close.reset_index(drop=True).idxmin())
        max_index = int(segment_close.reset_index(drop=True).idxmax())
        first_price = float(segment_close.iloc[0])
        last_price = float(segment_close.iloc[-1])
        min_price = float(segment_close.min())
        max_price = float(segment_close.max())
        drop_to_low_pct = ((min_price / max(first_price, 1e-9)) - 1) * 100
        rebound_from_low_pct = ((last_price / max(min_price, 1e-9)) - 1) * 100
        rally_to_high_pct = ((max_price / max(first_price, 1e-9)) - 1) * 100
        rejection_from_high_pct = ((last_price / max(max_price, 1e-9)) - 1) * 100
        min_location = float(segment_locations.min())
        max_location = float(segment_locations.max())
        recovery_from_low = float(segment_locations.iloc[-1] - min_location)
        rejection_from_high = float(max_location - segment_locations.iloc[-1])
        run_return_threshold = 0.42 if name in {"early", "end_of_day"} else 0.35
        run_location_threshold = 0.38 if name in {"early", "end_of_day"} else 0.34
        if location_change >= run_location_threshold and segment_return >= run_return_threshold and positive_share >= 0.58:
            tags.append(f"{name}_bull_run")
        if location_change <= -run_location_threshold and segment_return <= -run_return_threshold and negative_share >= 0.58:
            tags.append(f"{name}_bear_run")
        if segment_value_time >= 0.58 and segment_stall >= max(35, len(segment_close) // 3) and segment_crosses >= 4 and abs(location_change) <= 0.24:
            tags.append(f"{name}_chop")
        if (
            10 <= min_index <= len(segment_close) * 0.70
            and min_location <= 0.25
            and recovery_from_low >= 0.48
            and segment_locations.iloc[-1] >= 0.58
            and positive_share >= 0.50
            and drop_to_low_pct <= -0.22
            and rebound_from_low_pct >= 0.28
        ):
            tags.append(f"{name}_v_reversal")
        if (
            10 <= max_index <= len(segment_close) * 0.70
            and max_location >= 0.75
            and rejection_from_high >= 0.48
            and segment_locations.iloc[-1] <= 0.42
            and negative_share >= 0.50
            and rally_to_high_pct >= 0.22
            and rejection_from_high_pct <= -0.28
        ):
            tags.append(f"{name}_inverted_v_reversal")
    return tags


def classify_safe_scenarios(
    session_df: pd.DataFrame,
    previous_df: pd.DataFrame | None,
    premarket_df: pd.DataFrame | None,
    spawn_index: int,
    thresholds: dict[str, float],
) -> dict[str, bool]:
    if session_df.empty:
        return {scenario: scenario == "Random" for scenario in SAFE_SCENARIOS}

    spawn_index = max(0, min(spawn_index, len(session_df) - 1))
    elapsed = session_df.iloc[: spawn_index + 1]
    first = session_df.iloc[0]
    previous_close = float(previous_df.iloc[-1]["close"]) if previous_df is not None and not previous_df.empty else float(first["open"])
    open_price = float(first["open"])
    gap_pct = ((open_price / max(previous_close, 1e-9)) - 1) * 100
    elapsed_range_pct = ((float(elapsed["high"].max()) - float(elapsed["low"].min())) / max(open_price, 1e-9)) * 100
    premarket_volume = int(premarket_df["volume"].sum()) if premarket_df is not None and not premarket_df.empty else 0
    session_volume = int(session_df["volume"].sum())
    premarket_volume_ratio = premarket_volume / max(session_volume, 1)
    daily_sma_200_at_open = thresholds.get("daily_sma_200_at_open")
    volatility_median = thresholds.get("volatility_median", 0.0)
    premarket_high = thresholds.get("premarket_volume_high", 0.025)
    premarket_low = thresholds.get("premarket_volume_low", 0.012)

    flags = {scenario: False for scenario in SAFE_SCENARIOS}
    flags["Random"] = True
    flags["Gap Up"] = gap_pct >= 0.25
    flags["Gap Down"] = gap_pct <= -0.25
    flags["Large Premarket Volume Increase"] = premarket_volume_ratio >= premarket_high
    flags["Large Premarket Volume Decrease"] = premarket_volume_ratio <= premarket_low
    flags["High Volatility"] = elapsed_range_pct >= volatility_median
    flags["Low Volatility"] = elapsed_range_pct <= max(0.01, volatility_median * 0.55)
    flags["Above 200 SMA"] = bool(daily_sma_200_at_open is not None and open_price > daily_sma_200_at_open)
    flags["Below 200 SMA"] = bool(daily_sma_200_at_open is not None and open_price < daily_sma_200_at_open)
    return flags


def hidden_day_tags(session_df: pd.DataFrame, previous_df: pd.DataFrame | None, thresholds: dict[str, float] | None = None) -> tuple[list[str], dict[str, Any]]:
    thresholds = thresholds or {}
    if session_df.empty:
        return [], {}

    df = session_df.copy().reset_index(drop=True)
    close = df["close"].astype(float)
    open_price = float(df.iloc[0]["open"])
    close_price = float(df.iloc[-1]["close"])
    day_high = float(df["high"].max())
    day_low = float(df["low"].min())
    day_range = max(day_high - day_low, 1e-9)
    daily_return = ((close_price / max(open_price, 1e-9)) - 1) * 100
    trend_efficiency = abs(close_price - open_price) / day_range
    close_location = (close_price - day_low) / day_range
    value_area_low = float(close.quantile(0.15))
    value_area_high = float(close.quantile(0.85))
    value_area_center = (value_area_low + value_area_high) / 2
    value_area_width_pct = ((value_area_high - value_area_low) / max(open_price, 1e-9)) * 100
    inside_value_area = close.between(value_area_low, value_area_high)
    time_in_value_area_pct = float(inside_value_area.mean())
    centerline_crosses = count_crosses(close, value_area_center)
    failed_extension_count = count_failed_value_extensions(inside_value_area)
    location_series = (close - day_low) / day_range
    longest_stalled_run_minutes = longest_stalled_value_area_run(location_series, inside_value_area)
    total_stalled_value_area_minutes = stalled_value_area_minutes(location_series, inside_value_area)
    start_location = float(location_series.iloc[0])
    end_location = float(location_series.iloc[-1])
    first_above_value_high = next((index for index, value in enumerate(close) if float(value) >= value_area_high), None)
    first_below_value_low = next((index for index, value in enumerate(close) if float(value) <= value_area_low), None)
    starts_below_value = start_location <= 0.25 or float(close.iloc[0]) < value_area_low
    starts_above_value = start_location >= 0.75 or float(close.iloc[0]) > value_area_high
    finishes_above_value = end_location >= 0.65 or close_price >= value_area_high
    finishes_below_value = end_location <= 0.35 or close_price <= value_area_low
    previous_close = float(previous_df.iloc[-1]["close"]) if previous_df is not None and not previous_df.empty else open_price
    gap_pct = ((open_price / max(previous_close, 1e-9)) - 1) * 100
    volume = int(df["volume"].sum())
    volume_median = thresholds.get("volume_median", volume)
    returns = close.pct_change().fillna(0.0)
    abs_returns = returns.abs()
    positive_returns = returns.clip(lower=0.0)
    negative_returns = returns.clip(upper=0.0).abs()
    direction_changes = int((returns.rolling(5).sum().dropna().apply(lambda value: 1 if value > 0 else -1 if value < 0 else 0).diff().abs() > 0).sum())

    typical = (df["high"].astype(float) + df["low"].astype(float) + close) / 3
    cum_volume = df["volume"].astype(float).cumsum()
    vwap = (typical * df["volume"].astype(float)).cumsum() / cum_volume.replace(0, pd.NA)
    vwap_side = (close > vwap).astype(int)
    vwap_crosses = int((vwap_side.diff().abs() == 1).sum())

    first_hour = df.iloc[:60]
    first_hour_high = float(first_hour["high"].max())
    first_hour_low = float(first_hour["low"].min())
    broke_first_hour_high = bool((df.iloc[60:]["high"] > first_hour_high).any()) if len(df) > 60 else False
    broke_first_hour_low = bool((df.iloc[60:]["low"] < first_hour_low).any()) if len(df) > 60 else False
    closed_inside_first_hour = first_hour_low <= close_price <= first_hour_high
    range_bound_share = float(((close >= first_hour_low) & (close <= first_hour_high)).mean())

    hourly_rows: list[dict[str, Any]] = []
    session_open = pd.Timestamp("2024-01-01 09:30")
    for start in range(0, max(len(df) - 59, 1), 30):
        end = min(start + 60, len(df))
        label = (session_open + pd.Timedelta(minutes=start)).strftime("%H:%M")
        part = df.iloc[start:end]
        if len(part) < 30:
            continue
        share = float(abs_returns.iloc[start:end].sum() / max(abs_returns.sum(), 1e-9))
        positive_share = float(positive_returns.iloc[start:end].sum() / max(positive_returns.sum(), 1e-9))
        negative_share = float(negative_returns.iloc[start:end].sum() / max(negative_returns.sum(), 1e-9))
        signed_return = ((float(part.iloc[-1]["close"]) / max(float(part.iloc[0]["open"]), 1e-9)) - 1) * 100
        window_start_location = (float(part.iloc[0]["open"]) - day_low) / day_range
        window_end_location = (float(part.iloc[-1]["close"]) - day_low) / day_range
        hourly_rows.append({
            "label": label,
            "startMinute": start,
            "endMinute": end,
            "absReturnShare": share,
            "positiveReturnShare": positive_share,
            "negativeReturnShare": negative_share,
            "signedReturnPct": signed_return,
            "startLocation": window_start_location,
            "endLocation": window_end_location,
            "locationChange": window_end_location - window_start_location,
            "volumeShare": int(part["volume"].sum()) / max(volume, 1),
        })
    largest_hour = max(hourly_rows, key=lambda row: row["absReturnShare"]) if hourly_rows else {"label": "", "startMinute": 0, "absReturnShare": 0.0, "signedReturnPct": 0.0}
    largest_positive_hour = max(hourly_rows, key=lambda row: row["positiveReturnShare"]) if hourly_rows else {"label": "", "startMinute": 0, "positiveReturnShare": 0.0, "signedReturnPct": 0.0, "startLocation": 0.0, "endLocation": 0.0, "locationChange": 0.0, "volumeShare": 0.0}
    largest_negative_hour = max(hourly_rows, key=lambda row: row["negativeReturnShare"]) if hourly_rows else {"label": "", "startMinute": 0, "negativeReturnShare": 0.0, "signedReturnPct": 0.0, "startLocation": 0.0, "endLocation": 0.0, "locationChange": 0.0, "volumeShare": 0.0}

    morning_return = ((float(df.iloc[min(194, len(df) - 1)]["close"]) / max(open_price, 1e-9)) - 1) * 100
    afternoon_return = ((close_price / max(float(df.iloc[min(195, len(df) - 1)]["open"]), 1e-9)) - 1) * 100
    gap_filled = (gap_pct > 0.25 and day_low <= previous_close) or (gap_pct < -0.25 and day_high >= previous_close)
    major_positive_burst = (
        largest_positive_hour["positiveReturnShare"] >= 0.28
        and largest_positive_hour["locationChange"] >= 0.30
        and largest_positive_hour["signedReturnPct"] >= 0.30
    )
    major_negative_burst = (
        largest_negative_hour["negativeReturnShare"] >= 0.28
        and largest_negative_hour["locationChange"] <= -0.30
        and largest_negative_hour["signedReturnPct"] <= -0.30
    )
    directional_burst = major_positive_burst or major_negative_burst
    completed_transition = (
        (start_location <= 0.35 and end_location >= 0.65)
        or (start_location >= 0.65 and end_location <= 0.35)
        or any(abs(float(row.get("locationChange", 0))) >= 0.45 for row in hourly_rows)
    )
    recovery_from_low = close_location - ((float(close.min()) - day_low) / day_range)
    tags: list[str] = []

    if trend_efficiency >= 0.65 and vwap_crosses <= 4:
        tags.append("trend_day")
    if (
        time_in_value_area_pct >= 0.58
        and total_stalled_value_area_minutes >= 120
        and centerline_crosses >= 6
        and trend_efficiency <= 0.40
        and not completed_transition
        and not directional_burst
    ):
        tags.append("chop_day")
        tags.append("range_chop")
    if largest_hour["absReturnShare"] >= 0.45 and not closed_inside_first_hour:
        tags.append("breakout")
    if major_positive_burst:
        tags.append("upside_breakout")
        tags.append("breakout")
    if major_negative_burst:
        tags.append("downside_flush")
    if largest_hour["startMinute"] >= 240 and largest_hour["absReturnShare"] >= 0.35 and largest_hour["signedReturnPct"] > 0:
        tags.append("late_breakout")
    if largest_hour["startMinute"] >= 240 and largest_hour["absReturnShare"] >= 0.35 and largest_hour["signedReturnPct"] < 0:
        tags.append("late_breakdown")
    if abs(gap_pct) >= 0.25 and not gap_filled and (daily_return > 0) == (gap_pct > 0):
        tags.append("gap_and_go")
    if gap_filled:
        tags.append("gap_fill")
    if (broke_first_hour_high or broke_first_hour_low) and closed_inside_first_hour:
        tags.append("failed_breakout")
    if failed_extension_count >= 4 and time_in_value_area_pct >= 0.60 and trend_efficiency <= 0.55 and not directional_burst:
        tags.append("failed_extension")
    if morning_return * afternoon_return < 0 and min(abs(morning_return), abs(afternoon_return)) >= 0.35:
        tags.append("midday_reversal")
    if major_negative_burst and recovery_from_low >= 0.30:
        tags.append("v_reversal")
    if starts_below_value and finishes_above_value and first_above_value_high is not None:
        if first_above_value_high <= 240:
            tags.append("bullish_range_reclaim")
        else:
            tags.append("grinding_higher")
    if starts_above_value and finishes_below_value and first_below_value_low is not None:
        if first_below_value_low <= 240:
            tags.append("bearish_range_rejection")
        else:
            tags.append("grinding_lower")
    if start_location < 0.45 and end_location >= 0.65 and daily_return > 0.25 and not major_positive_burst:
        tags.append("grinding_higher")
    if start_location > 0.55 and end_location <= 0.35 and daily_return < -0.25 and not major_negative_burst:
        tags.append("grinding_lower")
    if location_series.iloc[-90:].mean() >= 0.62 and end_location >= 0.60 and daily_return > 0.20:
        tags.append("rally_into_settle")
    if location_series.iloc[-90:].mean() <= 0.38 and end_location <= 0.40 and daily_return < -0.20:
        tags.append("selloff_into_settle")
    phase_tags = segment_behavior_tags(df, close, location_series, inside_value_area)
    tags.extend(phase_tags)
    if (
        ("early_bull_run" in phase_tags or "midday_bull_run" in phase_tags)
        and ("midday_chop" in phase_tags or "end_of_day_chop" in phase_tags or "rally_into_settle" in tags)
        and not major_negative_burst
    ):
        tags.append("bull_run_and_settle")
    if (
        ("early_bear_run" in phase_tags or "midday_bear_run" in phase_tags)
        and ("midday_chop" in phase_tags or "end_of_day_chop" in phase_tags or "selloff_into_settle" in tags)
        and not major_positive_burst
    ):
        tags.append("bear_run_and_settle")
    bullish_segments = [tag for tag in phase_tags if tag.endswith("_bull_run")]
    bearish_segments = [tag for tag in phase_tags if tag.endswith("_bear_run")]
    chop_segments = [tag for tag in phase_tags if tag.endswith("_chop")]
    has_early_bull = "early_bull_run" in phase_tags
    has_midday_bull = "midday_bull_run" in phase_tags
    has_eod_bull = "end_of_day_bull_run" in phase_tags
    has_early_bear = "early_bear_run" in phase_tags
    has_midday_bear = "midday_bear_run" in phase_tags
    has_eod_bear = "end_of_day_bear_run" in phase_tags
    has_early_chop = "early_chop" in phase_tags
    has_midday_chop = "midday_chop" in phase_tags
    has_eod_chop = "end_of_day_chop" in phase_tags

    if has_early_bull and (has_midday_bull or "rally_into_settle" in tags) and end_location >= 0.60:
        tags.append("bullish_continuation")
    if has_early_bear and (has_midday_bear or "selloff_into_settle" in tags) and end_location <= 0.40:
        tags.append("bearish_continuation")
    if (
        (has_early_bull and (has_midday_bull or has_eod_bull or "rally_into_settle" in tags) and end_location >= 0.60)
        or (has_early_bear and (has_midday_bear or has_eod_bear or "selloff_into_settle" in tags) and end_location <= 0.40)
    ):
        tags.append("opening_drive_continuation")
    if (
        (has_early_bull and (has_midday_bear or has_eod_bear) and end_location <= 0.50)
        or (has_early_bear and (has_midday_bull or has_eod_bull) and end_location >= 0.50)
    ):
        tags.append("opening_drive_reversal")
    if (
        (has_early_bull and has_midday_chop and (has_eod_bull or end_location >= 0.62))
        or (has_early_bear and has_midday_chop and (has_eod_bear or end_location <= 0.38))
    ):
        tags.append("trend_pause_continue")
    if has_early_chop and (has_midday_bull or has_midday_bear or has_eod_bull or has_eod_bear):
        tags.append("morning_range_afternoon_trend")
    if (has_early_bull or has_early_bear or has_midday_bull or has_midday_bear) and has_eod_chop:
        tags.append("trend_into_late_chop")
    if has_early_bull and (has_midday_bear or has_eod_bear or "failed_breakout" in tags) and end_location <= 0.55:
        tags.append("bull_trap")
    if has_early_bear and (has_midday_bull or has_eod_bull or "failed_breakout" in tags) and end_location >= 0.45:
        tags.append("bear_trap")
    if (has_early_bull and (has_midday_bear or has_eod_bear)) or (has_early_bear and (has_midday_bull or has_eod_bull)):
        tags.append("morning_drive_reversal")
    if (has_early_chop or has_midday_chop) and (has_midday_bull or has_midday_bear):
        tags.append("midday_continuation")
    if (has_early_bull or has_midday_bull) and has_eod_bull:
        tags.append("late_day_continuation")
    if (has_early_bear or has_midday_bear) and has_eod_bear:
        tags.append("late_day_continuation")
    if ((has_early_bull or has_midday_bull) and has_eod_bear) or ((has_early_bear or has_midday_bear) and has_eod_bull):
        tags.append("late_day_reversal")
    if (has_early_chop or has_midday_chop) and ("breakout" in tags or "upside_breakout" in tags or "downside_flush" in tags):
        tags.append("range_expansion")
    if (has_early_bull or has_early_bear or has_midday_bull or has_midday_bear) and (has_midday_chop or has_eod_chop):
        tags.append("range_contraction")
        tags.append("trend_then_chop")
    if (has_early_chop or has_midday_chop) and (has_midday_bull or has_midday_bear or has_eod_bull or has_eod_bear):
        tags.append("chop_then_trend")
    has_phase_v = any(tag.endswith("_v_reversal") and "inverted" not in tag for tag in phase_tags)
    has_phase_inverted_v = any(tag.endswith("_inverted_v_reversal") for tag in phase_tags)
    if "v_reversal" in tags or (has_phase_v and (completed_transition or abs(daily_return) >= 0.30)):
        tags.append("v_day")
    if has_phase_inverted_v and (completed_transition or abs(daily_return) >= 0.30):
        tags.append("inverted_v_day")
    if completed_transition and time_in_value_area_pct >= 0.55 and abs(end_location - start_location) >= 0.25:
        tags.append("double_distribution")
    if (has_early_bull and largest_positive_hour["positiveReturnShare"] >= 0.24 and end_location < 0.60) or (has_early_bear and largest_negative_hour["negativeReturnShare"] >= 0.24 and end_location > 0.40):
        tags.append("failed_continuation")
    if has_eod_bull and largest_positive_hour["startMinute"] >= 240 and largest_positive_hour["positiveReturnShare"] >= 0.22:
        tags.append("late_squeeze")
    if has_eod_bear and largest_negative_hour["startMinute"] >= 240 and largest_negative_hour["negativeReturnShare"] >= 0.22:
        tags.append("late_flush")
    if abs(gap_pct) >= 0.25 and not gap_filled and (daily_return > 0) == (gap_pct > 0):
        tags.append("gap_hold")
    if abs(gap_pct) >= 0.25 and gap_filled and (daily_return > 0) != (gap_pct > 0):
        tags.append("gap_reversal")
    if has_early_bull and not has_midday_bear and not has_eod_bear and end_location >= 0.60:
        tags.append("opening_drive_hold")
    if has_early_bear and not has_midday_bull and not has_eod_bull and end_location <= 0.40:
        tags.append("opening_drive_hold")
    if has_early_bull and (has_midday_bear or has_eod_bear or end_location <= 0.45):
        tags.append("opening_drive_fail")
    if has_early_bear and (has_midday_bull or has_eod_bull or end_location >= 0.55):
        tags.append("opening_drive_fail")
    if (has_early_chop or has_midday_chop) and (has_eod_bull or has_eod_bear):
        tags.append("afternoon_takeover")
    if (
        not bullish_segments
        and not bearish_segments
        and not has_phase_v
        and not has_phase_inverted_v
        and time_in_value_area_pct >= 0.68
        and 0.35 <= end_location <= 0.65
        and abs(daily_return) <= 0.35
        and trend_efficiency <= 0.45
        and not directional_burst
    ):
        tags.append("balanced_day")
    if len(chop_segments) >= 2 or (centerline_crosses >= 12 and time_in_value_area_pct >= 0.62 and not directional_burst):
        tags.append("rotational_day")
    if len(bullish_segments) >= 2 and not bearish_segments and trend_efficiency >= 0.55:
        tags.append("one_timeframe_up")
    if len(bearish_segments) >= 2 and not bullish_segments and trend_efficiency >= 0.55:
        tags.append("one_timeframe_down")
    if volume >= volume_median and daily_return >= 0.8 and close_location >= 0.75 and largest_hour["absReturnShare"] >= 0.30:
        tags.append("short_squeeze_like")
    if (
        volume >= volume_median and daily_return <= -0.8 and close_location <= 0.25 and largest_hour["absReturnShare"] >= 0.30
    ) or (
        major_negative_burst and largest_negative_hour["volumeShare"] >= 0.16 and largest_negative_hour["negativeReturnShare"] >= 0.34
    ):
        tags.append("panic_selloff")
    if range_bound_share >= 0.78 and total_stalled_value_area_minutes >= 140 and trend_efficiency <= 0.45 and not completed_transition and not directional_burst:
        tags.append("range_bound")
    if vwap_side.iloc[0] == 0 and vwap_side.iloc[-1] == 1 and close_location >= 0.55:
        tags.append("vwap_reclaim")
    if vwap_crosses >= 1 and vwap_side.iloc[-1] == 0 and close_location <= 0.45:
        tags.append("vwap_rejection")
    if close_location >= 0.80:
        tags.append("close_near_high")
    if close_location <= 0.20:
        tags.append("close_near_low")

    ordered_tags = [tag for tag in HIDDEN_TAGS if tag in set(tags)]
    features = {
        "gapPct": round(gap_pct, 4),
        "dailyReturnPct": round(daily_return, 4),
        "trendEfficiency": round(trend_efficiency, 4),
        "vwapCrosses": vwap_crosses,
        "directionChanges": direction_changes,
        "closeLocation": round(close_location, 4),
        "startLocation": round(start_location, 4),
        "endLocation": round(end_location, 4),
        "firstAboveValueHighMinute": first_above_value_high,
        "firstBelowValueLowMinute": first_below_value_low,
        "valueAreaLow": round(value_area_low, 4),
        "valueAreaHigh": round(value_area_high, 4),
        "valueAreaWidthPct": round(value_area_width_pct, 4),
        "timeInValueAreaPct": round(time_in_value_area_pct, 4),
        "centerlineCrosses": centerline_crosses,
        "failedExtensionCount": failed_extension_count,
        "stalledValueAreaMinutes": total_stalled_value_area_minutes,
        "longestStalledValueAreaRunMinutes": longest_stalled_run_minutes,
        "completedTransition": completed_transition,
        "largestHour": largest_hour,
        "largestPositiveHour": largest_positive_hour,
        "largestNegativeHour": largest_negative_hour,
        "phaseTags": [tag for tag in phase_tags if tag in set(ordered_tags)],
        "hourlyDistribution": hourly_rows,
    }
    return ordered_tags, features
