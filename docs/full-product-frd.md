# FRD Roadmap: Trading Replay Training Platform

## Summary
Build the current working prototype into a full discretionary trading training app focused on realistic replay, configurable charting, multiple input methods, hardcore accountability, and post-session feedback.

Current baseline: charts, replay, buy/sell execution, P&L tracking, Level 2, keyboard/controller support, Chart Setup, and scorecard flow already exist. This roadmap documents what exists, what must be hardened, and what comes next.

## Product Requirements

### Main Menu
- Use the hybrid current menu structure:
  - Quick Play
  - Practice Scenario
  - Charting Setup
  - Settings
  - Scoreboard
  - Quit
- Quick Play opens a speed/mode picker, then launches directly into a hidden random ticker/date session.
- Practice Scenario opens configurable setup for asset class, scenario, ticker/time period, chart timeframe, starting capital, replay speed, and hardcore mode.

### Session Setup
- Asset Class: Random, Equity, Bond, Commodity, Currency, Volatility, Leveraged, Inverse.
- Scenario: Random, Above 200 SMA, Below 200 SMA, Gap Up, Gap Down, High Volatility, Low Volatility, Trend Day, Chop Day.
- Add custom scenario selection: sector, ticker, and time period.
- Chart Timeframe: 1m, 5m, 15m, 30m, 1h.
- Starting Capital: $10,000, $25,000, $100,000, Custom.
- Replay Speed options everywhere: Real Time, 3x Speed, 5x Speed.
- Hardcore Mode toggle:
  - Disables trading while paused.
  - Disables pause-time chart, indicator, and timeframe changes.
  - Disables rewind, future scrolling, and other lookahead behavior.
  - Only Hardcore sessions populate Scoreboard.

### Gameplay
- Show a replay chart with exactly 6 hours of 1-minute candle context when data allows.
- Randomize replay start time instead of always starting at open.
- Preload prior candles and indicator state so the player can read context before unpausing.
- Support hidden ticker/date/time mode for price-action training.
- Keep all controller actions available as visible buttons and keyboard shortcuts.
- On-screen buttons:
  - Buy $1,000
  - Buy $5,000
  - Sell Half
  - Sell All
  - Pause
  - Speed -
  - Speed +
  - End Session
- Default keyboard:
  - 1 = Buy $1,000
  - 2 = Buy $5,000
  - Q = Sell Half
  - E = Sell All
  - Space = Pause/Resume
  - - = Slow Down
  - + = Speed Up
  - Esc = Menu
  - Enter = End Session
- Default controller:
  - A = Buy $1,000
  - B = Sell Half
  - X = Sell All
  - Y = Pause/Resume
  - LB = Slow Down
  - RB = Speed Up
  - Start = Menu
  - Select = End Session

### Charting And Training Tools
- Charting Setup manages indicator templates, indicator settings, thresholds, colors, manual levels, and saved templates.
- In-game chart tools:
  - Add/remove indicators.
  - Trendline drawings.
  - Alerts.
  - Drawing persistence across timeframe changes.
  - Optional multi-timeframe panels.
  - Playback scrubber outside Hardcore mode.
- Market realism:
  - Spread simulation.
  - Slippage by asset volatility/liquidity.
  - Replay volatility scaling.
  - Replay ghost candle/forming candle.
- Training feedback:
  - Trade journal with entries, exits, indicators used, and outcome.
  - Replay review mode after session.
  - Session grading: patience, overtrading, risk management, entry quality, exit quality, trend alignment.
  - Replay categories: trend day, mean reversion, bear/bull market, crash day, Fed day, panic day, low-volume grind, high-volatility chop.
  - Optional "What happens next?" mode: Long, Short, Flat prompts.

## Implementation Goals And Checkpoints

### 1. Baseline Navigation
- Confirm menu labels and routing.
- Confirm Quick Play and Practice Scenario flows.
- Checkpoint: user can reach every main screen with mouse, keyboard, or controller.

### 2. Session Setup And Modes
- Unify replay speed options to Real Time, 3x Speed, 5x Speed everywhere.
- Add Hardcore Mode to Quick Play and Practice Scenario.
- Add custom sector/ticker/time-period scenario selection.
- Checkpoint: session start payload contains selected mode, filters, capital, timeframe, speed, and hardcore flag.

### 3. Replay And Chart Context
- Enforce 6-hour chart context target.
- Preserve random mid-session starts.
- Preload historical candles and indicator values before replay begins.
- Checkpoint: player enters paused gameplay with readable prior context and no setup menu in Quick Play.

### 4. Controls And Accessibility
- Ensure every gameplay action has a visible button, keyboard shortcut, and optional controller binding.
- Keep controller fully optional.
- Expand Settings remapping where needed.
- Checkpoint: all trading actions work with mouse-only, keyboard-only, and controller-only flows.

### 5. Hardcore Rules
- Block trade execution during pause.
- Block indicator/timeframe/lookahead changes during pause.
- Block scoreboard submission for non-hardcore sessions.
- Checkpoint: non-hardcore sessions can be reviewed freely but do not write to Scoreboard.

### 6. Charting Tools
- Add in-game indicator add/remove/edit.
- Add trendlines, alerts, and drawing persistence.
- Integrate chart setup templates into gameplay.
- Checkpoint: chart modifications persist correctly where allowed and are restricted in Hardcore pause state.

### 7. Realism Layer
- Add spread and slippage.
- Add volatility scaling and ghost candle behavior.
- Tune by asset class/ticker profile.
- Checkpoint: fills reflect bid/ask/slippage and overtrading becomes naturally costly.

### 8. Scoring And Review
- Expand final scorecard beyond P&L.
- Add trade journal and replay review.
- Add training categories and psychological metrics.
- Checkpoint: completed Hardcore sessions generate a useful post-session review and populate Scoreboard.

## MVP Build Order
1. Create start menu.
2. Create session setup screen.
3. Load one hidden ticker/date.
4. Display replay chart.
5. Add on-screen buttons.
6. Add keyboard hotkeys.
7. Add controller support.
8. Add pause/speed/end controls.
9. Add trade execution.
10. Add final scorecard.

## Test Plan
- Menu navigation works from all input types.
- Quick Play starts directly after speed selection.
- Practice Scenario applies selected filters.
- All replay speed options are accepted by frontend and backend.
- Hardcore blocks paused trading and lookahead actions.
- Non-hardcore sessions do not populate Scoreboard.
- Visible buttons, keyboard shortcuts, and controller bindings trigger identical actions.
- Chart context preloads correctly before replay starts.
- Indicator, trendline, and alert changes persist according to mode rules.
- Scorecard and journal match submitted trades and final account state.

## Assumptions
- "6 hours of candles" means the visible chart context target, not necessarily the total playable session length.
- Replay speed options are standardized as Real Time, 3x Speed, and 5x Speed across Quick Play, Practice, and Settings.
- Scoreboard is reserved for Hardcore sessions only.
- Controller support remains optional; the app must remain fully playable with mouse and keyboard.
