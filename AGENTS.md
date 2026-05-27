# Agent Instructions

## Project Context
- This repo is a localhost browser trading replay game.
- Backend: Python, FastAPI, pandas, pyarrow.
- Frontend: React, TypeScript, Vite, TradingView Lightweight Charts.
- Current prototype data source: `spy_1min_candles.parquet`, containing complete 1-minute SPY OHLCV for `2026-05-22` and `2026-05-26`.
- Replay currently synthesizes 8 ticks per 1-minute candle from OHLCV anchors plus deterministic synthetic ticks.

## Working Rules
- Keep `README.md`, `AGENTS.md`, and docs in `docs/` updated whenever behavior, setup, architecture, controls, data assumptions, or operational context changes.
- Auto-pushes are allowed when the user asks to sync/upload/push this repo or when continuing an explicitly requested GitHub workflow.
- Do not commit secrets. API keys must come from environment variables such as `FMP_API_KEY`.
- Do not commit generated artifacts, logs, virtual environments, `node_modules`, or large future data drops under `data/`.
- Preserve the small root-level `spy_1min_candles.parquet` unless the user asks to replace the prototype dataset.
- Prefer targeted changes and verify with `python -m pytest backend` and `npm run build` when backend/frontend behavior changes.

## Local Run Commands
```powershell
.\.venv\Scripts\python.exe -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
cd frontend
npm run dev -- --host 127.0.0.1 --port 5173
```

## Current Controls
- Keyboard and on-screen controls always work.
- Xbox and PlayStation controllers are supported through the browser Gamepad API.
- Controller settings include profiles, press-to-capture remappable action slots, menu/end buttons, cursor click/back, and stick-driven in-app cursor movement that shares position with mouse movement.
