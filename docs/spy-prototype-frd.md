# 2-Day SPY Prototype FRD: Localhost Browser Game

## Summary
Build the first working localhost browser prototype using the current local `spy_1min_candles.parquet` file. The prototype keeps the full game structure but constrains all available sessions to SPY on `2026-05-22` and `2026-05-26`.

## Data Constraints
- Ticker is always `SPY`.
- Available sessions are `2026-05-22` and `2026-05-26`.
- Each session has 390 regular-session candles.
- Total available rows are 780.
- The local dataset has no missing expected minutes, duplicate timestamps, or extra regular-session minutes.
- Regular session candles run from `09:30` through `15:59`.

## Prototype Requirements
- The app provides Main Menu, Session Setup, Replay Screen, Settings, Past Sessions, and Scorecard.
- Xbox and PlayStation controllers are supported through the browser Gamepad API.
- Controller settings include remappable gameplay/menu buttons, press-to-capture binding slots, analog-stick virtual cursor speed, and shared mouse/controller cursor position.
- Asset class filters are shown, but only Random and Equity have available sessions.
- Scenario filters are shown with unavailable states when the two-day dataset cannot satisfy them.
- Hidden ticker is always SPY.
- Hidden date is randomly selected from available matching sessions unless Practice Mode selects a specific date.
- SPY return equals buy-and-hold return because the only session ticker is SPY.

## Localhost Architecture
- Backend is FastAPI.
- Frontend is React and TypeScript.
- Charting uses TradingView Lightweight Charts.
- Storage reads the local Parquet file first.
- Past sessions and settings are persisted in browser local storage.

## API Requirements
- `GET /api/health` confirms backend status and dataset size.
- `GET /api/sessions/options` returns available filters, dates, timeframes, starting capital choices, replay speeds, and local metadata.
- `POST /api/sessions/start` creates a hidden session and returns a session id plus display labels.
- `GET /api/sessions/{id}/candles?timeframe=1m|5m|15m|30m|1h` returns resampled candles.
- `GET /api/sessions/{id}/replay` returns 8 replay ticks for every 1-minute candle.
- `POST /api/sessions/{id}/score` returns the final scorecard for submitted fills.

## Acceptance Criteria
- Backend loads exactly 780 SPY rows.
- Both available dates produce 390 replay candles.
- A full session produces 3,120 replay ticks.
- Buy and sell controls update account state.
- Keyboard controls match defaults.
- Unsupported filters are handled gracefully.
- Scorecard calculations work for both available dates.
