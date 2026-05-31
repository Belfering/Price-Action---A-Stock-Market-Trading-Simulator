# Price Action Trading Simulator

A localhost browser game for practicing historical price-action trading. The current MVP replays two complete SPY sessions from 1-minute OHLCV data, hides the ticker/date during play, lets you trade the animated tape, then reveals a scorecard.

## Current Dataset
- File: `spy_1min_candles.parquet`
- Ticker: `SPY`
- Dates: `2026-05-22`, `2026-05-26`
- Rows: 780
- Each session has 390 complete regular-session 1-minute candles.

## Features
- FastAPI backend with Parquet loading, session selection, resampling, replay ticks, and scoring.
- React/TypeScript frontend with TradingView Lightweight Charts.
- Replay synthesizes 16 ticks per 1-minute candle: open, high, low, close, plus 12 deterministic synthetic ticks.
- Synthetic volume builds across ticks and weights larger price moves more heavily.
- On-screen trading buttons, keyboard hotkeys, Xbox/PlayStation controller support, and stick-driven in-app cursor.
- Settings for defaults, P&L/volume visibility, controller profile, controller remapping, and cursor speed.

## Run Locally
Install frontend dependencies once:

```powershell
cd frontend
npm install
cd ..
```

Start the backend:

```powershell
.\.venv\Scripts\python.exe -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

Start the frontend:

```powershell
cd frontend
npm run dev -- --host 127.0.0.1 --port 5173
```

Open:

```text
http://127.0.0.1:5173
```

## Verify
```powershell
.\.venv\Scripts\python.exe -m pytest backend
cd frontend
npm run build
```

## Downloading More Data
The downloader reads the Financial Modeling Prep key from the environment:

```powershell
$env:FMP_API_KEY="your_key_here"
.\.venv\Scripts\python.exe ".\Data Download.py"
```

You can also create a gitignored `.env` file:

```text
FMP_API_KEY=your_key_here
```

Longer ranges are split into 30-calendar-day requests by default. Use `--chunk-days 7` if FMP rejects larger ranges. Restart the backend after replacing `spy_1min_candles.parquet` so the cached dataset reloads.

To request every SPY 1-minute session FMP will return, use all-history mode:

```powershell
.\.venv\Scripts\python.exe ".\Data Download.py"
```

FMP may not provide true SPY intraday data back to 1993 on every plan. Empty historical chunks are skipped by default, and the final row/date count shows what FMP actually returned.

For large universes, the app uses `data/catalog.duckdb` plus partitioned Parquet under `data/candles/` when that catalog exists. Build or rebuild it from the current root parquet with:

```powershell
.\.venv\Scripts\python.exe .\build_market_data_store.py
```

Do not hardcode or commit API keys.

## Documentation
- Full product FRD: `docs/full-product-frd.md`
- 2-day SPY prototype FRD: `docs/spy-prototype-frd.md`
- Hetzner IP-only staging deploy: `docs/hetzner-staging-deploy.md`
- Agent instructions: `AGENTS.md`
