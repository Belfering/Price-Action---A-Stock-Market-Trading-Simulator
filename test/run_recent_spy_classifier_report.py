from __future__ import annotations

import html
import sys
from pathlib import Path
from typing import Any

import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.main import build_metadata, classifier_thresholds, df_for_date, previous_session_df  # noqa: E402
from backend.scenario_classifier import hidden_day_tags  # noqa: E402


OUT_DIR = Path(__file__).resolve().parent
SYMBOL = "SPY"
SESSION_LIMIT = 20


def scale(value: float, low: float, high: float, top: float, bottom: float) -> float:
    if high <= low:
        return (top + bottom) / 2
    return bottom - ((value - low) / (high - low)) * (bottom - top)


def polyline(points: list[tuple[float, float]], color: str, width: float = 2.0, dash: str | None = None) -> str:
    if not points:
        return ""
    encoded = " ".join(f"{x:.2f},{y:.2f}" for x, y in points)
    dash_attr = f' stroke-dasharray="{dash}"' if dash else ""
    return f'<polyline points="{encoded}" fill="none" stroke="{color}" stroke-width="{width}"{dash_attr} />'


def draw_candles(df: pd.DataFrame, x: float, y: float, width: float, height: float) -> str:
    high = float(df["high"].max())
    low = float(df["low"].min())
    body_width = max(1.8, width / max(len(df), 1) * 0.55)
    step = width / max(len(df) - 1, 1)
    pieces = [
        f'<rect x="{x}" y="{y}" width="{width}" height="{height}" fill="#111" stroke="#3a342b" />',
        f'<text x="{x + 8}" y="{y + 18}" fill="#f4c34f" font-size="12" font-weight="700">1m OHLC</text>',
    ]
    for idx, row in enumerate(df.itertuples(index=False)):
        cx = x + idx * step
        open_y = scale(float(row.open), low, high, y + 10, y + height - 18)
        close_y = scale(float(row.close), low, high, y + 10, y + height - 18)
        high_y = scale(float(row.high), low, high, y + 10, y + height - 18)
        low_y = scale(float(row.low), low, high, y + 10, y + height - 18)
        color = "#38c172" if float(row.close) >= float(row.open) else "#e45649"
        pieces.append(f'<line x1="{cx:.2f}" y1="{high_y:.2f}" x2="{cx:.2f}" y2="{low_y:.2f}" stroke="{color}" stroke-width="1" opacity="0.75" />')
        pieces.append(
            f'<rect x="{cx - body_width / 2:.2f}" y="{min(open_y, close_y):.2f}" width="{body_width:.2f}" height="{max(abs(close_y - open_y), 1):.2f}" fill="{color}" />'
        )
    for label, index in [("09:30", 0), ("11:00", 90), ("12:30", 180), ("14:00", 270), ("15:59", len(df) - 1)]:
        tx = x + min(index, len(df) - 1) * step
        pieces.append(f'<text x="{tx:.2f}" y="{y + height - 4}" fill="#afa697" font-size="10" text-anchor="middle">{label}</text>')
    pieces.append(f'<text x="{x + width - 8}" y="{y + 18}" fill="#afa697" font-size="10" text-anchor="end">H {high:.2f} / L {low:.2f}</text>')
    return "\n".join(pieces)


def draw_distribution_panel(features: dict[str, Any], x: float, y: float, width: float, height: float) -> str:
    hourly = features.get("hourlyDistribution", [])
    pieces = [
        f'<rect x="{x}" y="{y}" width="{width}" height="{height}" fill="#111" stroke="#3a342b" />',
        f'<text x="{x + 8}" y="{y + 18}" fill="#f4c34f" font-size="12" font-weight="700">Rolling 60m Distribution Curves</text>',
        f'<line x1="{x + 34}" y1="{y + height - 26}" x2="{x + width - 14}" y2="{y + height - 26}" stroke="#3a342b" />',
        f'<line x1="{x + 34}" y1="{y + 28}" x2="{x + 34}" y2="{y + height - 26}" stroke="#3a342b" />',
    ]
    if not hourly:
        return "\n".join(pieces)

    max_value = max(
        0.01,
        max(float(row.get("absReturnShare", 0)) for row in hourly),
        max(float(row.get("positiveReturnShare", 0)) for row in hourly),
        max(float(row.get("negativeReturnShare", 0)) for row in hourly),
        max(float(row.get("volumeShare", 0)) for row in hourly),
    )
    step = (width - 58) / max(len(hourly) - 1, 1)
    abs_return_points: list[tuple[float, float]] = []
    positive_points: list[tuple[float, float]] = []
    negative_points: list[tuple[float, float]] = []
    volume_points: list[tuple[float, float]] = []
    for idx, row in enumerate(hourly):
        px = x + 34 + idx * step
        return_share = float(row.get("absReturnShare", 0))
        positive_share = float(row.get("positiveReturnShare", 0))
        negative_share = float(row.get("negativeReturnShare", 0))
        volume_share = float(row.get("volumeShare", 0))
        abs_return_points.append((px, scale(return_share, 0, max_value, y + 30, y + height - 28)))
        positive_points.append((px, scale(positive_share, 0, max_value, y + 30, y + height - 28)))
        negative_points.append((px, scale(negative_share, 0, max_value, y + 30, y + height - 28)))
        volume_points.append((px, scale(volume_share, 0, max_value, y + 30, y + height - 28)))
        pieces.append(f'<text x="{px:.2f}" y="{y + height - 8}" fill="#afa697" font-size="9" text-anchor="middle">{html.escape(str(row.get("label", "")))}</text>')
    pieces.append(polyline(abs_return_points, "#f4c34f", 1.6, "4 4"))
    pieces.append(polyline(positive_points, "#38c172", 2.3))
    pieces.append(polyline(negative_points, "#e45649", 2.3))
    pieces.append(polyline(volume_points, "#4f78ff", 2.2))
    pieces.append(f'<text x="{x + width - 148}" y="{y + 18}" fill="#38c172" font-size="10">positive pressure</text>')
    pieces.append(f'<text x="{x + width - 148}" y="{y + 34}" fill="#e45649" font-size="10">negative pressure</text>')
    pieces.append(f'<text x="{x + width - 148}" y="{y + 50}" fill="#4f78ff" font-size="10">volume share</text>')
    pieces.append(f'<text x="{x + width - 148}" y="{y + 66}" fill="#f4c34f" font-size="10">abs return</text>')
    largest = features.get("largestHour", {})
    largest_positive = features.get("largestPositiveHour", {})
    largest_negative = features.get("largestNegativeHour", {})
    pieces.append(
        f'<text x="{x + 8}" y="{y + height - 60}" fill="#d8d3c8" font-size="11">largest abs: {html.escape(str(largest.get("label", "-")))} '
        f'({float(largest.get("absReturnShare", 0)):.1%} abs return)</text>'
    )
    pieces.append(
        f'<text x="{x + 8}" y="{y + height - 44}" fill="#38c172" font-size="11">largest up: {html.escape(str(largest_positive.get("label", "-")))} '
        f'({float(largest_positive.get("positiveReturnShare", 0)):.1%})</text>'
    )
    pieces.append(
        f'<text x="{x + 8}" y="{y + height - 28}" fill="#e45649" font-size="11">largest down: {html.escape(str(largest_negative.get("label", "-")))} '
        f'({float(largest_negative.get("negativeReturnShare", 0)):.1%})</text>'
    )
    return "\n".join(pieces)


def draw_close_location_panel(df: pd.DataFrame, features: dict[str, Any], x: float, y: float, width: float, height: float) -> str:
    low = float(df["low"].min())
    high = float(df["high"].max())
    value_area_low = float(features.get("valueAreaLow", low))
    value_area_high = float(features.get("valueAreaHigh", high))
    band_top = scale((value_area_high - low) / max(high - low, 1e-9), 0, 1, y + 18, y + height - 18)
    band_bottom = scale((value_area_low - low) / max(high - low, 1e-9), 0, 1, y + 18, y + height - 18)
    step = width / max(len(df) - 1, 1)
    points: list[tuple[float, float]] = []
    for idx, close in enumerate(df["close"].astype(float)):
        location = (float(close) - low) / max(high - low, 1e-9)
        points.append((x + idx * step, scale(location, 0, 1, y + 18, y + height - 18)))
    pieces = [
        f'<rect x="{x}" y="{y}" width="{width}" height="{height}" fill="#111" stroke="#3a342b" />',
        f'<text x="{x + 8}" y="{y + 18}" fill="#f4c34f" font-size="12" font-weight="700">Close Location In Daily Range</text>',
        f'<rect x="{x}" y="{band_top:.2f}" width="{width}" height="{max(band_bottom - band_top, 1):.2f}" fill="#f4c34f" opacity="0.08" />',
        f'<line x1="{x}" y1="{scale(0.8, 0, 1, y + 18, y + height - 18):.2f}" x2="{x + width}" y2="{scale(0.8, 0, 1, y + 18, y + height - 18):.2f}" stroke="#38c172" stroke-dasharray="4 4" opacity="0.65" />',
        f'<line x1="{x}" y1="{scale(0.2, 0, 1, y + 18, y + height - 18):.2f}" x2="{x + width}" y2="{scale(0.2, 0, 1, y + 18, y + height - 18):.2f}" stroke="#e45649" stroke-dasharray="4 4" opacity="0.65" />',
        polyline(points, "#d8d3c8", 1.7),
        f'<text x="{x + width - 8}" y="{y + 18}" fill="#afa697" font-size="10" text-anchor="end">close location {float(features.get("closeLocation", 0)):.1%}</text>',
        f'<text x="{x + width - 8}" y="{y + 34}" fill="#afa697" font-size="10" text-anchor="end">time in value area {float(features.get("timeInValueAreaPct", 0)):.1%}</text>',
    ]
    return "\n".join(pieces)


def render_svg(date: str, tags: list[str], features: dict[str, Any], df: pd.DataFrame) -> str:
    tag_label = ", ".join(tags) if tags else "no major hidden tags"
    phase_label = ", ".join(features.get("phaseTags", [])) if features.get("phaseTags") else "none"
    title = f"{SYMBOL} {date} - {tag_label}"
    width = 1280
    height = 820
    escaped_title = html.escape(title)
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">
<rect width="100%" height="100%" fill="#171612" />
<text x="24" y="34" fill="#f4efe4" font-size="22" font-weight="800">{escaped_title}</text>
<text x="24" y="58" fill="#afa697" font-size="12">daily return {float(features.get("dailyReturnPct", 0)):.2f}% | gap {float(features.get("gapPct", 0)):.2f}% | trend efficiency {float(features.get("trendEfficiency", 0)):.2f} | VWAP crosses {int(features.get("vwapCrosses", 0))} | value time {float(features.get("timeInValueAreaPct", 0)):.1%} | center crosses {int(features.get("centerlineCrosses", 0))} | start loc {float(features.get("startLocation", 0)):.1%} -> end loc {float(features.get("endLocation", 0)):.1%}</text>
<text x="24" y="74" fill="#afa697" font-size="12">phase tags: {html.escape(phase_label)}</text>
{draw_candles(df, 24, 82, 1232, 360)}
{draw_distribution_panel(features, 24, 466, 608, 250)}
{draw_close_location_panel(df, features, 648, 466, 608, 250)}
<text x="24" y="758" fill="#f4c34f" font-size="13" font-weight="800">Tags</text>
<text x="24" y="782" fill="#f4efe4" font-size="13">{html.escape(tag_label)}</text>
</svg>
"""


def latest_spy_dates() -> list[str]:
    metadata = [row for row in build_metadata() if row["ticker"] == SYMBOL]
    return sorted({row["date"] for row in metadata})[-SESSION_LIMIT:]


def main() -> int:
    metadata = [row for row in build_metadata() if row["ticker"] == SYMBOL]
    thresholds = classifier_thresholds(metadata)
    dates = latest_spy_dates()
    if not dates:
        raise RuntimeError("No SPY dates found. Build/download market data first.")

    print(f"Running classifier report for {len(dates)} most recent {SYMBOL} dates")
    for date in dates:
        df = df_for_date(date, SYMBOL)
        previous = previous_session_df(date, SYMBOL)
        tags, features = hidden_day_tags(df, previous, thresholds)
        tag_label = ", ".join(tags) if tags else "no major hidden tags"
        print(f"{date}: {tag_label}")
        output_path = OUT_DIR / f"spy_classifier_{date}.svg"
        output_path.write_text(render_svg(date, tags, features, df), encoding="utf-8")
    print(f"Graphics saved to {OUT_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
