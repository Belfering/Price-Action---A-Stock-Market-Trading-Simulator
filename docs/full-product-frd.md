# Full Product FRD: Browser Trading Replay Game

## Summary
Build a replay-based trading practice game where the player trades hidden historical market sessions in a localhost browser app. The app uses 1-minute OHLCV as the base data, generates replay ticks, supports scenario filters, accepts on-screen/keyboard/controller input, and reveals a comparative scorecard after each session.

## Functional Requirements
- The system stores raw 1-minute OHLCV data as partitioned Parquet under `/data/intraday/ticker=SPY/year=2024/month=01/SPY_2024_01.parquet`.
- Required candle fields are `timestamp`, `open`, `high`, `low`, `close`, `volume`, and `ticker`.
- Starter tickers are `SPY`, `QQQ`, `IWM`, `XLF`, `XLE`, `XLV`, `TLT`, `GLD`, `UUP`, and `VIXY`.
- The backend derives `5m`, `15m`, `30m`, `1h`, and daily candles from 1-minute data.
- MVP indicators are SMA 20, SMA 50, SMA 200, VWAP, and RSI 14.
- Metadata includes ticker, date, asset class, above/below 200 SMA, daily return, gap %, volatility score, and volume score.
- Scenario filters include Random, asset class, above/below 200 SMA, gap up/down, high/low volatility, trend day, chop day, and large volume day.

## User Experience
- Main menu contains Start Session, Practice Mode, Settings, View Past Sessions, and Quit.
- Session setup allows asset class, scenario, chart timeframe, starting capital, and replay speed.
- Gameplay shows a candlestick chart, volume, current price, current position, cash, unrealized P&L, realized P&L, current session time, replay speed, and hidden category label.
- Scorecard reveals ticker, date, asset class, scenario type, final P&L, return %, max drawdown, trade count, win/loss, buy-and-hold return, SPY return, best possible long-only return, entry timing score, and exit timing score.

## Gameplay Rules
- Replay uses 1-minute candles internally.
- Each 1-minute candle creates 8 replay ticks.
- Every candle includes anchored open, high, low, and close ticks plus 4 deterministic synthetic ticks inside the candle range.
- High and low ticks cannot be adjacent; synthetic ticks are smoother in low-volatility candles and more varied in high-volatility candles.
- Volume builds across all replay ticks and reaches full candle volume on the close tick; larger price moves receive more synthetic volume than smaller moves.
- Replay speeds are Slow = 1.00s/tick, Normal = 0.50s/tick, Fast = 0.25s/tick, and Manual = one input per tick.
- Trades fill at the current animated price.
- MVP has no spread, commissions, or slippage.
- Score is user return minus buy-and-hold return.

## Controls And Settings
- On-screen controls: Buy $1,000, Buy $5,000, Sell Half, Sell All, Pause, Speed -, Speed +, End Session.
- Keyboard defaults: `1`, `2`, `Q`, `E`, `Space`, `-`, `+`, `Esc`, `Enter`.
- Controller defaults support Xbox and PlayStation label profiles.
- Settings allow remapping keyboard/controller bindings, including Menu, End Session, cursor click, and cursor back; clicking a controller binding slot enters capture mode and pressing a physical controller button assigns it while clearing duplicate assignments.
- Controller sticks drive an in-app virtual cursor for menu and settings interaction; mouse movement and stick movement share the same cursor position, and the native cursor is hidden while controller cursor mode is active.
- Settings allow choosing default replay speed, chart timeframe, starting capital, controller cursor speed, sound, volume visibility, and P&L visibility.

## Acceptance Criteria
- A user can start a hidden session from the menu.
- Replay animates the required tick path from 1-minute candles.
- Trades update position, cash, realized P&L, and unrealized P&L.
- Scorecard reveals the hidden session and calculates all MVP metrics.
- On-screen and keyboard controls work without a controller.
- Scenario filters never select sessions outside their criteria.
