"""
Download 1-minute market candles from Financial Modeling Prep and save them as Parquet.

Install dependencies:
    pip install -r requirements.txt

Run:
    python "Data Download.py"
"""

from __future__ import annotations

import argparse
import shutil
import sys
import os
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
import json

import pandas as pd

from backend.market_data import ASSET_CLASS_TICKERS, MarketDataStore


def load_dotenv_value(key: str) -> str:
    for env_path in (Path(".env"), Path(".env.local")):
        if not env_path.exists():
            continue
        for raw_line in env_path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            name, value = line.split("=", 1)
            if name.strip() == key:
                return value.strip().strip('"').strip("'")
    return ""


def load_api_key() -> str:
    return os.getenv("FMP_API_KEY", "").strip() or load_dotenv_value("FMP_API_KEY")


# =========================
# Credentials
# =========================
# Optional paste-in key for local use. Leave blank to read FMP_API_KEY from
# PowerShell, .env, or .env.local.
FMP_API_KEY_OVERRIDE = ""
FMP_API_KEY = FMP_API_KEY_OVERRIDE.strip() or load_api_key()


# =========================
# Settings
# =========================
INTERVAL = "1min"
DEFAULT_SYMBOLS = tuple(dict.fromkeys(symbol for symbols in ASSET_CLASS_TICKERS.values() for symbol in symbols))
OUTPUT_FILE_TEMPLATE = "{symbol_lower}_{interval}_candles.parquet"

FMP_BASE_URL = "https://financialmodelingprep.com/stable/historical-chart"
REQUIRED_COLUMNS = ["timestamp", "open", "high", "low", "close", "volume"]
REGULAR_SESSION_BARS = 390
EARLIEST_DOWNLOAD_DATE = date(1993, 1, 29)
INTRADAY_DISCOVERY_DAYS = 365
DOWNLOAD_CUTOFF_DATE = date(2023, 12, 31)


def parse_date(value: str) -> date:
    return datetime.strptime(value, "%Y-%m-%d").date()


def build_url(symbol: str, interval: str, from_date: str | None, to_date: str | None) -> str:
    params = {
        "symbol": symbol,
        "apikey": FMP_API_KEY,
    }

    if from_date:
        params["from"] = from_date
    if to_date:
        params["to"] = to_date

    return f"{FMP_BASE_URL}/{interval}?{urlencode(params)}"


def fetch_candles(symbol: str, interval: str, from_date: str | None, to_date: str | None) -> list[dict[str, Any]]:
    if not FMP_API_KEY or FMP_API_KEY in {"PASTE_YOUR_FMP_API_KEY_HERE", "replace_me", "your_key_here"}:
        raise ValueError("Set your FMP API key in the FMP_API_KEY environment variable.")

    request = Request(build_url(symbol, interval, from_date, to_date), headers={"User-Agent": "spy-1m-parquet-downloader/2.0"})

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
        raise RuntimeError(f"FMP returned no candles for {symbol} {from_date or ''} {to_date or ''}.")

    return payload


def candle_dates(candles: list[dict[str, Any]]) -> list[date]:
    dates = {
        pd.to_datetime(candle["date"]).date()
        for candle in candles
        if isinstance(candle, dict) and candle.get("date")
    }
    return sorted(dates)


def discover_first_intraday_date(symbol: str, interval: str, start: date, end: date, days_per_probe: int) -> date | None:
    cursor = start
    probe_days = max(1, days_per_probe)
    probes = 0

    while cursor <= end:
        probe_end = min(end, cursor + timedelta(days=probe_days - 1))
        probes += 1
        print(f"Checking {symbol} {interval} availability {cursor} to {probe_end}...")
        try:
            candles = fetch_candles(symbol, interval, cursor.isoformat(), probe_end.isoformat())
        except RuntimeError as exc:
            if "returned no candles" in str(exc):
                cursor = probe_end + timedelta(days=1)
                continue
            raise

        dates = candle_dates(candles)
        if dates:
            first_date = dates[0]
            print(f"First available {symbol} {interval} date found: {first_date} after {probes:,} checks.")
            return first_date

        cursor = probe_end + timedelta(days=1)

    return None


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


def empty_candles_frame() -> pd.DataFrame:
    return pd.DataFrame(
        {
            "timestamp": pd.Series(dtype="datetime64[ns]"),
            "open": pd.Series(dtype="float64"),
            "high": pd.Series(dtype="float64"),
            "low": pd.Series(dtype="float64"),
            "close": pd.Series(dtype="float64"),
            "volume": pd.Series(dtype="int64"),
        }
    )


def read_existing(path: Path) -> pd.DataFrame:
    if not path.exists():
        return empty_candles_frame()
    df = pd.read_parquet(path)
    missing_columns = [column for column in REQUIRED_COLUMNS if column not in df.columns]
    if missing_columns:
        raise RuntimeError(f"Existing parquet is missing required columns: {missing_columns}")
    df = df[REQUIRED_COLUMNS].copy()
    df["timestamp"] = pd.to_datetime(df["timestamp"])
    return cutoff_recent_dates(df)


def cutoff_recent_dates(df: pd.DataFrame) -> pd.DataFrame:
    if df.empty:
        return df.copy()
    cutoff = pd.Timestamp.combine(DOWNLOAD_CUTOFF_DATE, datetime.max.time())
    return df[pd.to_datetime(df["timestamp"]) <= cutoff].copy()


def regular_session_only(df: pd.DataFrame) -> pd.DataFrame:
    return df[df["timestamp"].dt.time.between(datetime.strptime("09:30", "%H:%M").time(), datetime.strptime("15:59", "%H:%M").time())].copy()


def complete_sessions_only(df: pd.DataFrame) -> pd.DataFrame:
    df = regular_session_only(df)
    counts = df.groupby(df["timestamp"].dt.date)["timestamp"].count()
    complete_dates = set(counts[counts == REGULAR_SESSION_BARS].index)
    return df[df["timestamp"].dt.date.isin(complete_dates)].copy()


def summarize(df: pd.DataFrame) -> str:
    if df.empty:
        return "0 rows, 0 complete sessions"
    counts = df.groupby(df["timestamp"].dt.date)["timestamp"].count()
    complete = counts[counts == REGULAR_SESSION_BARS]
    return (
        f"{len(df):,} rows, {len(counts):,} dates, {len(complete):,} complete regular sessions, "
        f"range {min(counts.index)} to {max(counts.index)}"
    )


def saved_date_count(df: pd.DataFrame) -> int:
    if df.empty:
        return 0
    return int(df["timestamp"].dt.date.nunique())


def chunk_ranges(start: date, end: date, days_per_request: int) -> list[tuple[date, date]]:
    ranges = []
    cursor = start
    while cursor <= end:
        chunk_end = min(end, cursor + timedelta(days=days_per_request - 1))
        ranges.append((cursor, chunk_end))
        cursor = chunk_end + timedelta(days=1)
    return ranges


def reverse_chunk_ranges(start: date, end: date, days_per_request: int) -> list[tuple[date, date]]:
    ranges = []
    cursor = end
    days = max(1, days_per_request)
    while cursor >= start:
        chunk_start = max(start, cursor - timedelta(days=days - 1))
        ranges.append((chunk_start, cursor))
        cursor = chunk_start - timedelta(days=1)
    return ranges


def weekdays_in_range(start: date, end: date) -> set[date]:
    days = set()
    cursor = start
    while cursor <= end:
        if cursor.weekday() < 5:
            days.add(cursor)
        cursor += timedelta(days=1)
    return days


def normalize_symbol(symbol: str) -> str:
    return symbol.strip().upper()


def unique_symbols(symbols: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for symbol in symbols:
        normalized = normalize_symbol(symbol)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        result.append(normalized)
    return result


def resolve_symbols(args: argparse.Namespace) -> list[str]:
    symbols: list[str] = []
    for asset_class in args.asset_class or []:
        symbols.extend(ASSET_CLASS_TICKERS[asset_class])
    for symbol_value in args.symbol or []:
        symbols.append(symbol_value)
    if args.symbols:
        symbols.extend(args.symbols.split(","))
    return unique_symbols(symbols) or list(DEFAULT_SYMBOLS)


def output_path_for_symbol(output_pattern: str | None, symbol: str, interval: str, multi_symbol: bool) -> Path:
    values = {
        "symbol": symbol,
        "symbol_lower": symbol.lower(),
        "interval": interval,
    }
    if not output_pattern:
        return Path(OUTPUT_FILE_TEMPLATE.format(**values))
    if multi_symbol and "{symbol" not in output_pattern:
        raise ValueError("For multiple symbols, --output must include {symbol} or {symbol_lower}, or be omitted.")
    return Path(output_pattern.format(**values))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Download 1-minute market candles from FMP into simulator parquet files.")
    parser.add_argument("--symbol", action="append", help="Ticker to download. Can be repeated. Defaults to the reviewed market universe.")
    parser.add_argument("--symbols", help="Comma-separated ticker list. Defaults to the reviewed market universe.")
    parser.add_argument("--asset-class", action="append", choices=sorted(ASSET_CLASS_TICKERS), help="Download every ticker in an asset class. Can be repeated.")
    parser.add_argument("--interval", default=INTERVAL)
    parser.add_argument("--all", action="store_true", help=f"Download all possible history from inception through --to, capped at {DOWNLOAD_CUTOFF_DATE}.")
    parser.add_argument("--from", dest="from_date", help="Start date, YYYY-MM-DD")
    parser.add_argument("--to", dest="to_date", help=f"End date, YYYY-MM-DD. Values after {DOWNLOAD_CUTOFF_DATE} are capped.")
    parser.add_argument("--output", help="Output parquet path. For multiple symbols, include {symbol} or {symbol_lower}.")
    parser.add_argument("--merge", action="store_true", help="Merge downloaded rows with an existing output parquet.")
    parser.add_argument("--backup", action="store_true", help="Write a .bak copy of the existing output before replacing it.")
    parser.add_argument("--build-store", action="store_true", help="Rebuild data/candles partitioned parquet and data/catalog.duckdb after saving.")
    parser.add_argument("--regular-hours-only", action="store_true", default=True, help="Keep only 09:30-15:59 bars.")
    parser.add_argument("--complete-only", action="store_true", help="Keep only dates with exactly 390 regular-session bars.")
    parser.add_argument("--chunk-days", type=int, default=30, help="Split long ranges into N-calendar-day FMP requests.")
    parser.add_argument("--discover-intraday", action="store_true", help="Probe the intraday endpoint first and skip dates before FMP has minute data.")
    parser.add_argument("--no-discover-intraday", action="store_true", help="Do not probe for the first available minute-data date.")
    parser.add_argument("--probe-days", type=int, default=INTRADAY_DISCOVERY_DAYS, help="Calendar days per intraday availability probe.")
    parser.add_argument("--oldest-first", action="store_true", help="Download from oldest to newest instead of newest to oldest.")
    parser.add_argument("--no-stop-at-empty-history", action="store_true", help="Keep going after an empty chunk during newest-first all-history downloads.")
    parser.add_argument("--no-skip-existing", action="store_true", help="Fetch dates even if they already exist in the output parquet.")
    parser.add_argument("--strict", action="store_true", help="Stop on empty/failed chunks instead of continuing.")
    parser.add_argument("--dry-run", action="store_true", help="Print the planned request ranges without downloading.")
    args = parser.parse_args()
    if not args.all and not args.from_date and not args.to_date:
        args.all = True
        args.merge = True
        args.complete_only = True
        args.backup = True
        args.build_store = True
        args.chunk_days = 7
        args.discover_intraday = False
        args.used_default_backfill = True
    else:
        args.used_default_backfill = False
    if args.no_discover_intraday:
        args.discover_intraday = False
    args.newest_first = args.all and not args.oldest_first
    args.stop_at_empty_history = args.newest_first and not args.no_stop_at_empty_history
    args.skip_existing = not args.no_skip_existing
    return args


def planned_ranges(args: argparse.Namespace, symbol: str) -> list[tuple[date | None, date | None]]:
    if args.all:
        start = EARLIEST_DOWNLOAD_DATE
        requested_end = parse_date(args.to_date) if args.to_date else DOWNLOAD_CUTOFF_DATE
        end = min(requested_end, DOWNLOAD_CUTOFF_DATE)
        if requested_end > DOWNLOAD_CUTOFF_DATE:
            print(f"Capping {symbol} end date from {requested_end} to {DOWNLOAD_CUTOFF_DATE}.")
        if args.discover_intraday and not args.dry_run:
            discovered_start = discover_first_intraday_date(symbol, args.interval, start, end, args.probe_days)
            if not discovered_start:
                raise RuntimeError(f"No {args.interval} candles found for {symbol} between {start} and {end}.")
            if discovered_start > start:
                print(f"Skipping {start} to {discovered_start - timedelta(days=1)} because FMP returned no {args.interval} candles there.")
                start = discovered_start
        if args.newest_first:
            ranges = reverse_chunk_ranges(start, end, max(1, args.chunk_days))
            direction = "newest to oldest"
        else:
            ranges = chunk_ranges(start, end, max(1, args.chunk_days))
            direction = "oldest to newest"
        print(f"All-history mode: {symbol} {args.interval} {start} to {end} in {len(ranges):,} chunks, {direction}.")
        return ranges

    if args.from_date and args.to_date:
        start = parse_date(args.from_date)
        requested_end = parse_date(args.to_date)
        end = min(requested_end, DOWNLOAD_CUTOFF_DATE)
        if requested_end > DOWNLOAD_CUTOFF_DATE:
            print(f"Capping {symbol} end date from {requested_end} to {DOWNLOAD_CUTOFF_DATE}.")
        if start > end:
            raise ValueError(f"No downloadable range remains after the {DOWNLOAD_CUTOFF_DATE} cutoff.")
        return chunk_ranges(start, end, max(1, args.chunk_days))

    return [(None, None)]


def download_symbol(args: argparse.Namespace, symbol: str, output: Path) -> int:
    ranges = planned_ranges(args, symbol)

    if args.dry_run:
        print("Dry run only. No data will be downloaded.")
        for start, end in ranges[:10]:
            from_text = start.isoformat() if start else "(default)"
            to_text = end.isoformat() if end else "(default)"
            print(f"Would fetch {symbol} {args.interval} {from_text} to {to_text}")
        if len(ranges) > 10:
            print(f"...and {len(ranges) - 10:,} more chunks")
        return 0

    existing = read_existing(output) if output.exists() else empty_candles_frame()
    existing_dates = set(existing["timestamp"].dt.date.unique()) if not existing.empty else set()
    if args.skip_existing and existing_dates:
        print(f"Already have {len(existing_dates):,} saved dates for {symbol}; fetched chunks will skip those dates.")

    frames = []
    empty_chunks = 0
    failed_chunks = 0
    skipped_existing_chunks = 0
    skipped_existing_dates = 0
    for start, end in ranges:
        from_text = start.isoformat() if start else None
        to_text = end.isoformat() if end else None
        if args.skip_existing and start and end:
            possible_dates = weekdays_in_range(start, end)
            if possible_dates and possible_dates.issubset(existing_dates):
                skipped_existing_chunks += 1
                skipped_existing_dates += len(possible_dates)
                print(f"Skipping existing chunk: {from_text} to {to_text}")
                continue
        print(f"Fetching {symbol} {args.interval} {from_text or '(default)'} to {to_text or '(default)'}...")
        try:
            candles = fetch_candles(symbol, args.interval, from_text, to_text)
        except RuntimeError as exc:
            if "returned no candles" in str(exc) and not args.strict:
                empty_chunks += 1
                print(f"Skipping empty chunk: {from_text} to {to_text}")
                if args.stop_at_empty_history:
                    print(f"Stopping {symbol}: reached empty older {args.interval} history at {from_text} to {to_text}.")
                    break
                continue
            failed_chunks += 1
            if args.strict:
                raise
            print(f"Skipping failed chunk: {from_text} to {to_text}: {exc}")
            continue
        chunk_df = cutoff_recent_dates(normalize_candles(candles))
        if args.skip_existing and existing_dates:
            before_rows = len(chunk_df)
            chunk_df = chunk_df[~chunk_df["timestamp"].dt.date.isin(existing_dates)].copy()
            skipped_rows = before_rows - len(chunk_df)
            if skipped_rows:
                print(f"Skipped {skipped_rows:,} rows from dates already saved.")
        if chunk_df.empty:
            continue
        existing_dates.update(chunk_df["timestamp"].dt.date.unique())
        frames.append(chunk_df)

    df = pd.concat(frames, ignore_index=True) if frames else empty_candles_frame()
    if args.merge:
        print(f"Existing: {summarize(existing)}")
        df = pd.concat([existing, df], ignore_index=True)

    df = cutoff_recent_dates(df)
    df = df.drop_duplicates(subset=["timestamp"]).sort_values("timestamp").reset_index(drop=True)
    if args.regular_hours_only:
        df = regular_session_only(df)
    if args.complete_only:
        before_dates = df["timestamp"].dt.date.nunique() if not df.empty else 0
        df = complete_sessions_only(df)
        after_dates = df["timestamp"].dt.date.nunique() if not df.empty else 0
        print(f"Complete-session filter kept {after_dates:,}/{before_dates:,} dates.")

    if args.backup and output.exists():
        backup_path = output.with_suffix(output.suffix + ".bak")
        shutil.copy2(output, backup_path)
        print(f"Backed up existing output to {backup_path}")

    df.to_parquet(output, index=False, engine="pyarrow")

    print(f"Ticker {symbol} complete, {saved_date_count(df):,} dates saved to {output}")
    print(f"Saved {summarize(df)}")
    if empty_chunks or failed_chunks:
        print(f"Skipped {empty_chunks:,} empty chunks and {failed_chunks:,} failed chunks.")
    if skipped_existing_chunks:
        print(f"Skipped {skipped_existing_chunks:,} fully existing chunks covering {skipped_existing_dates:,} weekday dates.")
    if args.build_store:
        root = Path(__file__).resolve().parent
        store = MarketDataStore(root)
        store.build_from_parquet(output, symbol)
        print(f"Market data store rebuilt, {len(store.session_refs()):,} complete sessions indexed")
    return saved_date_count(df)


def main() -> int:
    args = parse_args()
    symbols = resolve_symbols(args)
    multi_symbol = len(symbols) > 1

    if args.used_default_backfill:
        print(
            "No date range supplied; running full market universe backfill with merge, "
            f"complete-session filtering, backup, store rebuild, and {DOWNLOAD_CUTOFF_DATE} cutoff."
        )

    if args.all and args.from_date:
        raise ValueError("Use --all without --from. It always starts at the configured inception date.")

    if not args.all and bool(args.from_date) != bool(args.to_date):
        raise ValueError("Use --from and --to together, or omit both to use FMP's default range.")

    print(f"Ticker universe: {', '.join(symbols)}")
    completed = 0
    failed = 0
    total_dates = 0
    zero_date_tickers: list[str] = []
    failed_tickers: list[str] = []
    for index, symbol in enumerate(symbols, start=1):
        output = output_path_for_symbol(args.output, symbol, args.interval, multi_symbol)
        print(f"[{index}/{len(symbols)}] Starting {symbol} -> {output}")
        try:
            saved_dates = download_symbol(args, symbol, output)
            total_dates += saved_dates
            completed += 1
            if saved_dates == 0 and not args.dry_run:
                zero_date_tickers.append(symbol)
        except Exception as exc:
            failed += 1
            failed_tickers.append(symbol)
            if args.strict or not multi_symbol:
                raise
            print(f"Ticker {symbol} failed: {exc}", file=sys.stderr)

    print(f"Data download complete: {completed:,}/{len(symbols):,} tickers complete, {total_dates:,} dates saved")
    missing_tickers = unique_symbols([*zero_date_tickers, *failed_tickers])
    if missing_tickers:
        print(f"Missing/no-data tickers ({len(missing_tickers):,}): {', '.join(missing_tickers)}")
    else:
        print("Missing/no-data tickers: none")
    if failed:
        print(f"Failed tickers: {', '.join(failed_tickers)}", file=sys.stderr)
        print(f"{failed:,} tickers failed. Re-run with --strict to stop at the first failure.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        raise SystemExit(1)
