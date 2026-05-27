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
- Replay synthesizes 8 ticks per 1-minute candle: open, high, low, close, plus 4 deterministic synthetic ticks.
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
.\.venv\Scripts\python.exe .\download_spy_1m_fmp.py
```

Do not hardcode or commit API keys.

## Documentation
- Full product FRD: `docs/full-product-frd.md`
- 2-day SPY prototype FRD: `docs/spy-prototype-frd.md`
- Agent instructions: `AGENTS.md`
