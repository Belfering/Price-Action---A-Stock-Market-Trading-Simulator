"""
Download 1-minute SPY candles from Financial Modeling Prep, save them as Parquet,
and print the first 10 bars.

Install dependencies:
    pip install -r requirements.txt

Run:
    python download_spy_1m_fmp.py
"""

from __future__ import annotations

import sys
import os
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
import json

import pandas as pd


# =========================
# Credentials
# =========================
FMP_API_KEY = os.getenv("FMP_API_KEY", "")


# =========================
# Settings
# =========================
SYMBOL = "SPY"
INTERVAL = "1min"
OUTPUT_FILE = f"{SYMBOL.lower()}_{INTERVAL}_candles.parquet"

# Optional date range. Leave as None to use FMP's default returned range.
# Use "YYYY-MM-DD" if you want a specific slice.
FROM_DATE = None
TO_DATE = None


FMP_BASE_URL = "https://financialmodelingprep.com/stable/historical-chart"
REQUIRED_COLUMNS = ["timestamp", "open", "high", "low", "close", "volume"]


def build_url() -> str:
    params = {
        "symbol": SYMBOL,
        "apikey": FMP_API_KEY,
    }

    if FROM_DATE:
        params["from"] = FROM_DATE
    if TO_DATE:
        params["to"] = TO_DATE

    return f"{FMP_BASE_URL}/{INTERVAL}?{urlencode(params)}"


def fetch_candles() -> list[dict[str, Any]]:
    if not FMP_API_KEY or FMP_API_KEY == "PASTE_YOUR_FMP_API_KEY_HERE":
        raise ValueError("Set your FMP API key in the FMP_API_KEY environment variable.")

    request = Request(build_url(), headers={"User-Agent": "spy-1m-parquet-downloader/1.0"})

    try:
        with urlopen(request, timeout=60) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"FMP request failed with HTTP {exc.code}: {detail}") from exc
    except URLError as exc:
        raise RuntimeError(f"FMP request failed: {exc.reason}") from exc

    if isinstance(payload, dict):
        message = payload.get("Error Message") or payload.get("error") or payload.get("message") or payload
        raise RuntimeError(f"FMP returned an error response: {message}")

    if not isinstance(payload, list):
        raise RuntimeError(f"Unexpected FMP response type: {type(payload).__name__}")

    if not payload:
        raise RuntimeError("FMP returned no candles for the requested symbol/date range.")

    return payload


def normalize_candles(candles: list[dict[str, Any]]) -> pd.DataFrame:
    df = pd.DataFrame(candles)

    if "date" not in df.columns:
        raise RuntimeError(f"FMP response did not include a 'date' column. Columns received: {list(df.columns)}")

    df = df.rename(columns={"date": "timestamp"})

    missing_columns = [column for column in REQUIRED_COLUMNS if column not in df.columns]
    if missing_columns:
        raise RuntimeError(f"FMP response is missing required columns: {missing_columns}")

    df = df[REQUIRED_COLUMNS].copy()
    df["timestamp"] = pd.to_datetime(df["timestamp"])

    for column in ["open", "high", "low", "close"]:
        df[column] = pd.to_numeric(df[column], errors="raise")
    df["volume"] = pd.to_numeric(df["volume"], errors="raise").astype("int64")

    return df.sort_values("timestamp").reset_index(drop=True)


def main() -> int:
    candles = fetch_candles()
    df = normalize_candles(candles)

    df.to_parquet(OUTPUT_FILE, index=False, engine="pyarrow")

    print(f"Saved {len(df):,} {INTERVAL} {SYMBOL} candles to {OUTPUT_FILE}")
    print()
    print(df[REQUIRED_COLUMNS].head(10).to_string(index=False))

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        raise SystemExit(1)
