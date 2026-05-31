from __future__ import annotations

import argparse
from pathlib import Path

from backend.market_data import MarketDataStore


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build partitioned Parquet candles and DuckDB session catalog.")
    parser.add_argument("--source", default="spy_1min_candles.parquet")
    parser.add_argument("--symbol", default="SPY")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    root = Path(__file__).resolve().parent
    source = root / args.source
    if not source.exists():
        raise FileNotFoundError(f"Missing source parquet: {source}")
    store = MarketDataStore(root)
    store.build_from_parquet(source, args.symbol)
    refs = store.session_refs()
    symbols = sorted({ref.symbol for ref in refs})
    print(f"Market data store complete, {len(symbols):,} tickers, {len(refs):,} complete sessions indexed")
    print(f"Catalog: {store.catalog_path}")
    print(f"Candles: {store.candle_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
