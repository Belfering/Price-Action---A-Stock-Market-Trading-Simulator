import { type ChangeEvent, type FocusEvent, type MouseEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownCircle,
  ArrowUpCircle,
  BarChart3,
  Bell,
  Gauge,
  History,
  Layers3,
  Pencil,
  Pause,
  Play,
  Settings,
  ShieldCheck,
  Square,
  StepForward,
  Target,
  Trash2,
  Wallet,
} from "lucide-react";
import {
  ColorType,
  createChart,
  CandlestickData,
  MouseEventParams,
  HistogramData,
  IChartApi,
  ISeriesApi,
  LineData,
  Time,
} from "lightweight-charts";

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:8000";
const GAME_TITLE = "Price Action - A Stock Market Trading Simulator";

const TOOLTIP_TARGET_SELECTOR = [
  "[data-tooltip]",
  "button",
  "input",
  "select",
  "textarea",
  "a[href]",
  "[role='button']",
  "[role='tab']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

const TOOLTIP_COPY: Record<string, string> = {
  "Quick Play": "Start a hidden randomized replay after choosing speed and hardcore mode.",
  "Practice Scenario": "Build a replay using asset, scenario, timeframe, capital, sizing, and start-time filters.",
  "Charting Setup": "Customize how the chart itself looks, including candle style, colors, volume, and display preferences.",
  "Indicator Set": "Create and manage indicator templates that can be loaded during replay.",
  Settings: "Adjust defaults, display preferences, keyboard controls, controller profile, and saved profile data.",
  Scoreboard: "Review saved hardcore session results and past performance.",
  Analytics: "Open the private admin dashboard for usage and event analytics.",
  Logout: "Sign out and return to the login screen.",
  Login: "Sign in with the entered username and password.",
  "Sign Up": "Create a new account when public registration is enabled.",
  "Resend Confirmation": "Send another email confirmation link when email signup is enabled.",
  "Continue with Google": "Sign in with Google when OAuth is configured.",
  "Continue with Discord": "Sign in with Discord when OAuth is configured.",
  Back: "Return to the previous menu.",
  "Main Menu": "Leave this screen and return to the main menu.",
  Menu: "Return to the main menu.",
  Save: "Save the current settings or template changes.",
  New: "Create a new template.",
  "Set Default": "Make this template the default for new sessions.",
  Delete: "Delete the selected item.",
  "Refresh Chart": "Load a different preview chart while keeping the current template settings.",
  "Add Indicator": "Open the indicator library and add one to the selected chart zone.",
  Hide: "Temporarily hide this item without removing it.",
  Display: "Show this item on the chart.",
  Expand: "Open detailed settings for this item.",
  Remove: "Remove this item from the current template.",
  "Start Practice": "Launch the selected practice scenario and preload the chart paused at the chosen start.",
  "Buy $1,000": "Buy the fixed small position size at the current simulated ask price.",
  "Buy $5,000": "Buy the fixed large position size at the current simulated ask price.",
  "Sell Half": "Sell half of the current position at the simulated bid price.",
  "Sell All": "Close the current position at the simulated bid price.",
  Pause: "Pause replay playback.",
  Resume: "Resume replay playback.",
  Unpause: "Start the preloaded replay from the current paused point.",
  "Speed -": "Slow replay speed down one step.",
  "Speed +": "Increase replay speed one step.",
  "End Session": "End the current replay and open the scorecard.",
  Clear: "Clear this binding or selection.",
  "Export Profile": "Download a backup of this user's settings, templates, bindings, and history.",
  "Import Profile": "Load a saved profile backup from a local file.",
};

function cleanTooltipText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function tooltipTargetFromEventTarget(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const element = target.closest<HTMLElement>(TOOLTIP_TARGET_SELECTOR);
  if (!element || element.dataset.tooltipDisabled === "true") return null;
  return element;
}

function labelForField(element: HTMLElement): string {
  const explicit = cleanTooltipText(element.getAttribute("aria-label") || element.getAttribute("title"));
  if (explicit) return explicit;

  const label = element.closest("label");
  if (label) {
    const clone = label.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("input, select, textarea, button").forEach((node) => node.remove());
    const labelText = cleanTooltipText(clone.textContent);
    if (labelText) return labelText;
  }

  return cleanTooltipText(element.getAttribute("placeholder") || element.getAttribute("name"));
}

function textForControl(element: HTMLElement): string {
  const explicit = element.dataset.tooltip;
  if (explicit !== undefined) return cleanTooltipText(explicit);

  if (element instanceof HTMLInputElement) {
    const label = labelForField(element) || "this value";
    if (element.type === "checkbox") return `Toggle ${label}.`;
    if (element.type === "range") return `Adjust ${label}.`;
    if (element.type === "color") return `Choose the color for ${label}.`;
    if (element.type === "file") return `Choose a file for ${label}.`;
    return `Enter ${label}.`;
  }

  if (element instanceof HTMLSelectElement) {
    const label = labelForField(element) || "an option";
    return `Choose ${label}.`;
  }

  if (element instanceof HTMLTextAreaElement) {
    const label = labelForField(element) || "this text";
    return `Edit ${label}.`;
  }

  const ariaOrTitle = cleanTooltipText(element.getAttribute("aria-label") || element.getAttribute("title"));
  const visibleText = cleanTooltipText(element.textContent);
  const baseText = visibleText || ariaOrTitle;
  let text = TOOLTIP_COPY[baseText] ?? ariaOrTitle;

  if (!text && /^Buy\s+\$/i.test(baseText)) text = `Buy ${baseText.replace(/^Buy\s+/i, "")} at the current simulated ask price.`;
  if (!text && baseText) text = `Use ${baseText}.`;
  if (text && element instanceof HTMLButtonElement && element.disabled) text = `${text} This control is currently unavailable.`;
  return cleanTooltipText(text);
}

type View = "login" | "menu" | "setup" | "play" | "score" | "settings" | "history" | "chartSetup" | "analytics";
type Timeframe = "1m" | "5m" | "15m";
type ReplaySpeed = "Real Time" | "3x Speed" | "5x Speed";
type TradeSide = "buy" | "sell";
type ControllerProfile = "Keyboard" | "Xbox" | "PlayStation";
type GamepadProfile = Exclude<ControllerProfile, "Keyboard">;
type PositionSizingId = "1/5" | "5/10" | "10/20";
type SetupPickerId = "assetClass" | "asset" | "timeframe" | "startTime" | "replaySpeed" | "startingCapital" | "positionSizing";
type ScenarioFilterId = "sma" | "volatility" | "gap" | "premarketVolume";
type ScenarioFiltersState = Record<ScenarioFilterId, string>;

type OptionItem = {
  label: string;
  availableCount: number;
  enabled: boolean;
  assetClass?: string;
  description?: string;
};

type MetadataRow = {
  ticker: string;
  assetClass: string;
  scenarioFlags: Record<string, boolean>;
};

type OptionsPayload = {
  tickers: string[];
  assetClasses: OptionItem[];
  assets: OptionItem[];
  scenarios: OptionItem[];
  timeframes: Timeframe[];
  startTimes: string[];
  startingCapital: number[];
  replaySpeeds: { label: ReplaySpeed; secondsPerTick: number | null }[];
  metadata: MetadataRow[];
};

type StartSessionResponse = {
  sessionId: string;
  ticker: string;
  date: string;
  label: {
    assetClass: string;
    scenario: string;
  };
  timeframe: Timeframe;
  startingCapital: number;
  replaySpeed: ReplaySpeed;
  startTime?: string | null;
  hardcore: boolean;
  availableCandles: number;
  startCandleIndex: number;
  startTickIndex: number;
  premarketSource?: "synthetic" | "real" | "none";
};

type ReplayTick = {
  tickIndex: number;
  candleIndex: number;
  sequenceInCandle: number;
  ticksInCandle: number;
  phase: "open" | "high" | "low" | "close" | "random";
  timestamp: string;
  candleTimestamp: string;
  price: number;
  volume: number;
  volumeDelta: number;
  candleVolume: number;
  candleOpen: number;
  candleHigh: number;
  candleLow: number;
  candleClose: number;
  nextCandleVolume: number;
  nextCandleRange: number;
};

type TradeFill = {
  id: string;
  side: TradeSide;
  quantity: number;
  price: number;
  tickIndex: number;
  timestamp: string;
};

type OrderBookLevel = {
  price: number;
  size: number;
};

type SyntheticOrderBook = {
  bid: number;
  ask: number;
  spread: number;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  imbalance: number;
  totalBidSize: number;
  totalAskSize: number;
};

type ChartFollowMode = "auto" | "fixed";
type ChartToolMode = "cursor" | "trendline" | "level" | "alert";

type ChartToolPoint = {
  time: Time;
  price: number;
};

type ChartDrawing = {
  id: string;
  type: "trendline" | "level";
  points: ChartToolPoint[];
  color: string;
  label: string;
};

type PriceAlert = {
  id: string;
  price: number;
  direction: "above" | "below";
  triggered: boolean;
};

type TrailingStopState = {
  enabled: boolean;
  autoArm: boolean;
  percent: number;
  highWater: number;
  stopPrice: number | null;
};

type ExecutionResult = {
  quantity: number;
  averagePrice: number;
  notional: number;
  requestedQuantity: number;
};

type Scorecard = {
  scoreId?: string;
  ticker: string;
  date: string;
  assetClass: string;
  scenario: string;
  finalPnl: number;
  returnPct: number;
  maxDrawdownPct: number;
  numberOfTrades: number;
  wins: number;
  losses: number;
  buyAndHoldReturnPct: number;
  spyReturnPct: number;
  bestPossibleLongOnlyReturnPct: number;
  entryTimingScore: number;
  exitTimingScore: number;
  score: number;
  baseScore?: number;
  phaseScoreAdjustment?: number;
  tradedPhases?: string[];
  matchedPhaseTags?: string[];
  realizedPnl: number;
  endingCash: number;
  endingShares: number;
  finalPrice: number;
  hardcore: boolean;
  hiddenTags?: string[];
  tagFeatures?: Record<string, unknown>;
  completedAt?: string;
  savedAt?: string;
};

type DisplayCandle = {
  time: Time;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  sessionSegment?: "pre_market" | "regular";
  source?: "synthetic" | "real";
};

type CandlePayload = {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  sessionSegment?: "pre_market" | "regular";
  source?: "synthetic" | "real";
};

type CandlesResponse = {
  sessionId: string;
  timeframe: Timeframe;
  premarketSource?: "synthetic" | "real" | "none";
  candles: CandlePayload[];
};

type ChartMarker = {
  time: Time;
  position: "aboveBar" | "belowBar";
  color: string;
  shape: "arrowDown" | "arrowUp";
  text: string;
};

type IndicatorPane = "price" | "lower";
type IndicatorType =
  | "sma" | "ema" | "wma" | "hma" | "vwma" | "dema" | "tema" | "vwap" | "anchored-vwap" | "vwap-bands"
  | "bollinger-bands" | "keltner-channels" | "donchian-channels" | "linear-regression" | "linear-regression-channel"
  | "supertrend" | "parabolic-sar" | "ichimoku" | "pivot-points" | "fibonacci-retracement"
  | "prior-day-high-low" | "session-open" | "opening-range"
  | "rsi" | "stochastic-rsi" | "stochastic" | "macd" | "ppo" | "cci" | "williams-r" | "roc" | "momentum"
  | "ultimate-oscillator" | "trix" | "adx" | "dmi" | "aroon" | "atr" | "atr-bands" | "standard-deviation"
  | "historical-volatility" | "choppiness-index" | "volume-sma" | "obv" | "money-flow-index"
  | "chaikin-money-flow" | "accumulation-distribution" | "ease-of-movement" | "force-index";

type ChartIndicatorConfig = {
  id: string;
  type: IndicatorType;
  label: string;
  enabled: boolean;
  pane: IndicatorPane;
  color: string;
  lineWidth: 1 | 2 | 3;
  lowerRow?: number;
  settings: Record<string, number | string | boolean>;
};

type ChartTemplate = {
  id: string;
  name: string;
  isDefault: boolean;
  chart: {
    showVolume: boolean;
    candleStyle: "candles" | "line" | "heikin-ashi" | "hollow";
    visibleBars: number;
    lowerPanelHeight: number;
    upColor: string;
    downColor: string;
    wickUpColor: string;
    wickDownColor: string;
    lineColor: string;
    backgroundColor: string;
    gridColor: string;
    textColor: string;
    volumeUpColor: string;
    volumeDownColor: string;
  };
  indicators: ChartIndicatorConfig[];
};

type IndicatorSeries = {
  id: string;
  label: string;
  pane: IndicatorPane;
  color: string;
  lineWidth: 1 | 2 | 3;
  lowerRow?: number;
  data: LineData[];
  referenceLines?: IndicatorReferenceLine[];
};

type ComputedChartData = {
  priceSeries: IndicatorSeries[];
  lowerSeries: IndicatorSeries[];
};

type IndicatorReferenceLine = {
  value: number;
  label: string;
  color: string;
};

type LowerIndicatorHover = {
  x: number;
  panelX: number;
  y: number;
  value: number;
  time: Time | null;
};

type SharedLowerHover = {
  time: Time;
  x: number;
  panelX: number;
};

type PriceCrosshair = {
  x: number;
  timeLabel: string;
};

type LowerTimeline = {
  bars: number;
  rightOffset: number;
  from: number;
  denominator: number;
  currentX: number;
  timeToIndex: Map<Time, number>;
  indexToTime: Time[];
};

type LowerIndicatorRow = {
  row: number;
  series: IndicatorSeries[];
};

type ChartSetupZone = "chart" | 0 | 1 | 2;

type IndicatorRegistryItem = {
  type: IndicatorType;
  name: string;
  category: "Price" | "Momentum" | "Volatility" | "Volume";
  pane: IndicatorPane;
  color: string;
  settings: Record<string, number | string | boolean>;
};

type SettingsState = {
  defaultReplaySpeed: ReplaySpeed;
  defaultTimeframe: Timeframe;
  defaultStartingCapital: number;
  controllerProfile: ControllerProfile;
  controllerCursorSpeed: number;
  sound: boolean;
  alertSounds: boolean;
  bellSounds: boolean;
  tradeSounds: boolean;
  masterVolume: number;
  alertVolume: number;
  tradeVolume: number;
  themeMode: "Dark" | "Light";
  chartStyle: "Price Action" | "Bloomberg Terminal" | "Brokerage Account" | "Arcade";
  showVolume: boolean;
  showPnl: boolean;
  keyboard: Record<string, string>;
  controller: Record<string, string>;
};

type VirtualCursorState = {
  x: number;
  y: number;
  visible: boolean;
  pressed: boolean;
};

type SetupState = {
  mode: "standard" | "practice";
  assetClass: string;
  asset: string;
  scenario: string;
  scenarioFilters: ScenarioFiltersState;
  timeframe: Timeframe;
  startTime: string | null;
  startingCapital: number;
  positionSizing: PositionSizingId;
  replaySpeed: ReplaySpeed;
  hardcore: boolean;
};

type UserAccount = {
  username: string;
  password: string;
};

type ChartSetupUiState = {
  mode: "appearance" | "indicators";
  zone: ChartSetupZone;
};

type UserProfileSnapshot = {
  version: 1;
  exportedAt: string;
  username: string;
  settings: SettingsState;
  setup: SetupState;
  chartSetupUi: ChartSetupUiState;
  chartTemplates: ChartTemplate[];
  activeTemplateId: string;
  history: Scorecard[];
};

type AuthUser = {
  id?: number;
  username: string;
  displayName?: string;
  forcePasswordChange?: boolean;
  isAdmin?: boolean;
};

type AuthResponse = {
  authenticated: boolean;
  user: AuthUser;
};

type ServerProfilePayload = Omit<UserProfileSnapshot, "exportedAt"> & {
  exportedAt?: string;
};

type AnalyticsDashboard = {
  generatedAt: string;
  totals: {
    users: number;
    visitors: number;
    visits: number;
    events: number;
  };
  activeUsers: {
    day: number;
    week: number;
    month: number;
  };
  visitCounts: {
    day: number;
    week: number;
    month: number;
  };
  visitsByDay: Array<{ day: string; visits: number; visitors: number; users: number }>;
  visitsByHour: Array<{ hour: number; visits: number }>;
  eventsByName: Array<{ name: string; count: number }>;
  topPages: Array<{ path: string; count: number }>;
  funnel: Array<{ label: string; count: number }>;
  serverLoad: {
    disk: { totalBytes: number; usedBytes: number; freeBytes: number; usedPct: number };
    loadAverage: number[];
    cpuCount: number;
  };
};

type ScoreboardEntry = Scorecard & {
  displayName?: string;
  rank?: number;
  metric?: string;
  value?: number;
};

type ScoreboardDashboard = {
  personal: ScoreboardEntry[];
  global31d: ScoreboardEntry[];
  global252d: ScoreboardEntry[];
  replays: ScoreboardEntry[];
  metrics: Record<string, ScoreboardEntry[]>;
};

const ACTION_LABELS: Record<string, string> = {
  buy1000: "Buy Small",
  buy5000: "Buy Large",
  sellHalf: "Sell Half",
  sellAll: "Sell All",
  pause: "Pause / Resume",
  speedDown: "Speed -",
  speedUp: "Speed +",
  menu: "Menu",
  end: "End Session",
  cursorClick: "Cursor Click",
  cursorBack: "Cursor Back",
};

const CONTROLLER_PRESETS: Record<GamepadProfile, Record<string, string>> = {
  Xbox: {
    buy1000: "B0",
    buy5000: "B7",
    sellHalf: "B1",
    sellAll: "B2",
    pause: "B3",
    speedDown: "B4",
    speedUp: "B5",
    menu: "B9",
    end: "B8",
    cursorClick: "B0",
    cursorBack: "B1",
  },
  PlayStation: {
    buy1000: "B0",
    buy5000: "B7",
    sellHalf: "B1",
    sellAll: "B2",
    pause: "B3",
    speedDown: "B4",
    speedUp: "B5",
    menu: "B9",
    end: "B8",
    cursorClick: "B0",
    cursorBack: "B1",
  },
};

const CONTROLLER_BUTTON_OPTIONS = [
  { value: "B0", index: 0, xbox: "A", playstation: "Cross", psGlyph: "✕", generic: "Button 0" },
  { value: "B1", index: 1, xbox: "B", playstation: "Circle", psGlyph: "○", generic: "Button 1" },
  { value: "B2", index: 2, xbox: "X", playstation: "Square", psGlyph: "□", generic: "Button 2" },
  { value: "B3", index: 3, xbox: "Y", playstation: "Triangle", psGlyph: "△", generic: "Button 3" },
  { value: "B4", index: 4, xbox: "LB", playstation: "L1", psGlyph: "L1", generic: "Button 4" },
  { value: "B5", index: 5, xbox: "RB", playstation: "R1", psGlyph: "R1", generic: "Button 5" },
  { value: "B6", index: 6, xbox: "LT", playstation: "L2", psGlyph: "L2", generic: "Button 6" },
  { value: "B7", index: 7, xbox: "RT", playstation: "R2", psGlyph: "R2", generic: "Button 7" },
  { value: "B8", index: 8, xbox: "View", playstation: "Share", psGlyph: "Share", generic: "Button 8" },
  { value: "B9", index: 9, xbox: "Menu", playstation: "Options", psGlyph: "Options", generic: "Button 9" },
  { value: "B10", index: 10, xbox: "LS", playstation: "L3", psGlyph: "L3", generic: "Button 10" },
  { value: "B11", index: 11, xbox: "RS", playstation: "R3", psGlyph: "R3", generic: "Button 11" },
  { value: "B12", index: 12, xbox: "D-pad Up", playstation: "D-pad Up", psGlyph: "D↑", generic: "Button 12" },
  { value: "B13", index: 13, xbox: "D-pad Down", playstation: "D-pad Down", psGlyph: "D↓", generic: "Button 13" },
  { value: "B14", index: 14, xbox: "D-pad Left", playstation: "D-pad Left", psGlyph: "D←", generic: "Button 14" },
  { value: "B15", index: 15, xbox: "D-pad Right", playstation: "D-pad Right", psGlyph: "D→", generic: "Button 15" },
  { value: "B16", index: 16, xbox: "Xbox", playstation: "PS", psGlyph: "PS", generic: "Button 16" },
  { value: "B17", index: 17, xbox: "B17", playstation: "Touchpad", psGlyph: "Pad", generic: "Button 17" },
];

const CONTROLLER_BUTTON_ALIASES: Record<string, number> = {
  A: 0,
  CROSS: 0,
  XBOXA: 0,
  B: 1,
  CIRCLE: 1,
  XBOXB: 1,
  X: 2,
  SQUARE: 2,
  XBOXX: 2,
  Y: 3,
  TRIANGLE: 3,
  XBOXY: 3,
  LB: 4,
  L1: 4,
  LEFTBUMPER: 4,
  RB: 5,
  R1: 5,
  RIGHTBUMPER: 5,
  LT: 6,
  L2: 6,
  LEFTTRIGGER: 6,
  RT: 7,
  R2: 7,
  RIGHTTRIGGER: 7,
  SELECT: 8,
  VIEW: 8,
  BACK: 8,
  SHARE: 8,
  CREATE: 8,
  START: 9,
  MENU: 9,
  OPTIONS: 9,
  LS: 10,
  L3: 10,
  LEFTSTICK: 10,
  RS: 11,
  R3: 11,
  RIGHTSTICK: 11,
  DPADUP: 12,
  DPADDOWN: 13,
  DPADLEFT: 14,
  DPADRIGHT: 15,
  XBOX: 16,
  PS: 16,
  PLAYSTATION: 16,
  TOUCHPAD: 17,
};

const DEFAULT_SETTINGS: SettingsState = {
  defaultReplaySpeed: "3x Speed",
  defaultTimeframe: "1m",
  defaultStartingCapital: 100_000,
  controllerProfile: "Keyboard",
  controllerCursorSpeed: 900,
  sound: false,
  alertSounds: true,
  bellSounds: true,
  tradeSounds: true,
  masterVolume: 70,
  alertVolume: 70,
  tradeVolume: 75,
  themeMode: "Dark",
  chartStyle: "Price Action",
  showVolume: true,
  showPnl: true,
  keyboard: {
    buy1000: "1",
    buy5000: "2",
    sellHalf: "q",
    sellAll: "e",
    pause: " ",
    speedDown: "-",
    speedUp: "+",
    menu: "Escape",
    end: "Enter",
  },
  controller: CONTROLLER_PRESETS.Xbox,
};
const DEFAULT_ACCOUNT: UserAccount = { username: "1", password: "1" };
const ACCOUNT_STORAGE_KEY = "trading-replay-users-v1";
const CURRENT_USER_STORAGE_KEY = "trading-replay-current-user-v1";
const USER_PROFILE_VERSION = 1;
const ANALYTICS_VISITOR_STORAGE_KEY = "price-action-analytics-visitor-v1";
const ANALYTICS_VISIT_STORAGE_KEY = "price-action-analytics-visit-v1";

const SPEED_MS: Record<ReplaySpeed, number | null> = {
  "Real Time": 1000,
  "3x Speed": 1000,
  "5x Speed": 1000,
};

const SPEED_ORDER: ReplaySpeed[] = ["Real Time", "3x Speed", "5x Speed"];
const RANDOM_SESSION_SPEEDS: { speed: ReplaySpeed; detail: string }[] = [
  { speed: "Real Time", detail: "60 ticks/minute" },
  { speed: "3x Speed", detail: "20 ticks/minute" },
  { speed: "5x Speed", detail: "12 ticks/minute" },
];
const START_TIME_CHOICES: Array<{ value: string | null; label: string; detail: string }> = [
  { value: null, label: "Random", detail: "Any safe start" },
  { value: "09:13", label: "9:13", detail: "Opening setup" },
  { value: "09:28", label: "9:28", detail: "Opening bell" },
  { value: "09:43", label: "9:43", detail: "Early read" },
  { value: "10:13", label: "10:13", detail: "Morning trend" },
  { value: "14:00", label: "2:00", detail: "Last spawn" },
];
const STARTING_CAPITAL_OPTIONS = [10_000, 100_000, 1_000_000];
const POSITION_SIZING_OPTIONS: Array<{ id: PositionSizingId; label: string; smallPct: number; largePct: number }> = [
  { id: "1/5", label: "1% / 5%", smallPct: 0.01, largePct: 0.05 },
  { id: "5/10", label: "5% / 10%", smallPct: 0.05, largePct: 0.10 },
  { id: "10/20", label: "10% / 20%", smallPct: 0.10, largePct: 0.20 },
];
const SCENARIO_DETAILS: Record<string, string> = {
  Random: "Any safe start",
  "Above 200 SMA": "Open above daily 200 SMA",
  "Below 200 SMA": "Open below daily 200 SMA",
  "Gap Up": "Open above prior close",
  "Gap Down": "Open below prior close",
  "Large Premarket Volume Increase": "Active premarket",
  "Large Premarket Volume Decrease": "Quiet premarket",
  "High Volatility": "Wide elapsed range",
  "Low Volatility": "Tight elapsed range",
};
const DEFAULT_SCENARIO_FILTERS: ScenarioFiltersState = {
  sma: "Random",
  volatility: "Random",
  gap: "Random",
  premarketVolume: "Random",
};
const SCENARIO_VARIABLES: Array<{
  id: ScenarioFilterId;
  label: string;
  detail: string;
  left: { value: string; label: string; detail: string };
  right: { value: string; label: string; detail: string };
}> = [
  {
    id: "sma",
    label: "200 SMA",
    detail: "Daily regime at the open",
    left: { value: "Above 200 SMA", label: "Above", detail: SCENARIO_DETAILS["Above 200 SMA"] },
    right: { value: "Below 200 SMA", label: "Below", detail: SCENARIO_DETAILS["Below 200 SMA"] },
  },
  {
    id: "volatility",
    label: "Recent Volatility",
    detail: "Elapsed session range at spawn",
    left: { value: "High Volatility", label: "High", detail: SCENARIO_DETAILS["High Volatility"] },
    right: { value: "Low Volatility", label: "Low", detail: SCENARIO_DETAILS["Low Volatility"] },
  },
  {
    id: "gap",
    label: "Opening Gap",
    detail: "Open versus prior close",
    left: { value: "Gap Up", label: "Up", detail: SCENARIO_DETAILS["Gap Up"] },
    right: { value: "Gap Down", label: "Down", detail: SCENARIO_DETAILS["Gap Down"] },
  },
  {
    id: "premarketVolume",
    label: "Premarket Volume",
    detail: "Synthetic premarket activity",
    left: { value: "Large Premarket Volume Increase", label: "Large", detail: SCENARIO_DETAILS["Large Premarket Volume Increase"] },
    right: { value: "Large Premarket Volume Decrease", label: "Small", detail: SCENARIO_DETAILS["Large Premarket Volume Decrease"] },
  },
];
const TIMEFRAME_MINUTES: Record<Timeframe, number> = {
  "1m": 1,
  "5m": 5,
  "15m": 15,
};
const CHART_TEMPLATE_STORAGE_KEY = "trading-replay-chart-templates-v1";
const MAX_CHART_TEMPLATES = 30;
const MAX_CHART_INDICATORS = 10;
const MAX_LOWER_ROWS = 3;
const MAX_LOWER_PER_ROW = 3;
const DEFAULT_VISIBLE_BARS = 120;
const DEFAULT_LOWER_PANEL_HEIGHT = 72;
const DEFAULT_CHART_SETTINGS: ChartTemplate["chart"] = {
  showVolume: true,
  candleStyle: "candles",
  visibleBars: DEFAULT_VISIBLE_BARS,
  lowerPanelHeight: DEFAULT_LOWER_PANEL_HEIGHT,
  upColor: "#38c172",
  downColor: "#e45649",
  wickUpColor: "#8ee2ad",
  wickDownColor: "#ef8a7f",
  lineColor: "#f2c94c",
  backgroundColor: "#151515",
  gridColor: "#2a2925",
  textColor: "#d8d3c8",
  volumeUpColor: "rgba(56, 193, 114, 0.38)",
  volumeDownColor: "rgba(228, 86, 73, 0.38)",
};
const DEFAULT_COLOR_PALETTE = [
  "#38c172", "#2fb16a", "#1f8f54",
  "#6ce29c", "#8ee2ad", "#b5f3cc",
  "#e45649", "#ff6b61", "#b83a34",
  "#ff867c", "#ef8a7f", "#f3b0aa",
  "#f2c94c", "#d4a64f", "#56ccf2", "#2d9cdb", "#bb6bd9", "#f4eee2", "#afa697",
];

const INDICATOR_LIBRARY: IndicatorRegistryItem[] = [
  ["sma", "SMA", "Price", "price", "#f2c94c", { period: 20 }],
  ["ema", "EMA", "Price", "price", "#56ccf2", { period: 20 }],
  ["wma", "WMA", "Price", "price", "#9bca3e", { period: 20 }],
  ["hma", "HMA", "Price", "price", "#bb6bd9", { period: 20 }],
  ["vwma", "VWMA", "Price", "price", "#2d9cdb", { period: 20 }],
  ["dema", "DEMA", "Price", "price", "#f2994a", { period: 20 }],
  ["tema", "TEMA", "Price", "price", "#eb5757", { period: 20 }],
  ["vwap", "VWAP", "Price", "price", "#f2994a", {}],
  ["anchored-vwap", "Anchored VWAP", "Price", "price", "#f2c94c", { anchorBars: 50 }],
  ["vwap-bands", "VWAP Bands", "Price", "price", "#d4a64f", { multiplier: 1, midColor: "#d4a64f", upperColor: "#e45649", lowerColor: "#38c172" }],
  ["bollinger-bands", "Bollinger Bands", "Price", "price", "#56ccf2", { period: 20, multiplier: 2, midColor: "#56ccf2", upperColor: "#e45649", lowerColor: "#38c172" }],
  ["keltner-channels", "Keltner Channels", "Price", "price", "#bb6bd9", { period: 20, multiplier: 1.5, midColor: "#bb6bd9", upperColor: "#e45649", lowerColor: "#38c172" }],
  ["donchian-channels", "Donchian Channels", "Price", "price", "#6ce29c", { period: 20, upperColor: "#e45649", lowerColor: "#38c172" }],
  ["linear-regression", "Linear Regression", "Price", "price", "#f4eee2", { period: 30 }],
  ["linear-regression-channel", "Linear Regression Channel", "Price", "price", "#afa697", { period: 30, multiplier: 1.5, midColor: "#afa697", upperColor: "#e45649", lowerColor: "#38c172" }],
  ["supertrend", "Supertrend", "Price", "price", "#38c172", { period: 10, multiplier: 3 }],
  ["parabolic-sar", "Parabolic SAR", "Price", "price", "#ff867c", { step: 0.02 }],
  ["ichimoku", "Ichimoku Cloud", "Price", "price", "#56ccf2", { conversion: 9, base: 26 }],
  ["pivot-points", "Pivot Points", "Price", "price", "#d4a64f", {}],
  ["fibonacci-retracement", "Fibonacci Retracement", "Price", "price", "#bb6bd9", {}],
  ["prior-day-high-low", "Prior High/Low", "Price", "price", "#f4eee2", {}],
  ["session-open", "Session Open", "Price", "price", "#f2994a", {}],
  ["opening-range", "Opening Range", "Price", "price", "#56ccf2", { minutes: 15 }],
  ["rsi", "RSI", "Momentum", "lower", "#f2c94c", { period: 14, lower: 30, lowerColor: "#38c172", upper: 70, upperColor: "#e45649" }],
  ["stochastic-rsi", "Stochastic RSI", "Momentum", "lower", "#56ccf2", { period: 14, lower: 20, lowerColor: "#38c172", upper: 80, upperColor: "#e45649" }],
  ["stochastic", "Stochastic", "Momentum", "lower", "#bb6bd9", { period: 14, lower: 20, lowerColor: "#38c172", upper: 80, upperColor: "#e45649" }],
  ["macd", "MACD", "Momentum", "lower", "#38c172", { fast: 12, slow: 26, signal: 9, zeroLine: true, zeroColor: "#afa697" }],
  ["ppo", "PPO", "Momentum", "lower", "#f2994a", { fast: 12, slow: 26, zeroLine: true, zeroColor: "#afa697" }],
  ["cci", "CCI", "Momentum", "lower", "#eb5757", { period: 20, lower: -100, lowerColor: "#38c172", upper: 100, upperColor: "#e45649", zeroLine: true, zeroColor: "#afa697" }],
  ["williams-r", "Williams %R", "Momentum", "lower", "#2d9cdb", { period: 14, lower: -80, lowerColor: "#38c172", upper: -20, upperColor: "#e45649" }],
  ["roc", "ROC", "Momentum", "lower", "#9bca3e", { period: 12, zeroLine: true, zeroColor: "#afa697" }],
  ["momentum", "Momentum", "Momentum", "lower", "#f4eee2", { period: 10, zeroLine: true, zeroColor: "#afa697" }],
  ["ultimate-oscillator", "Ultimate Oscillator", "Momentum", "lower", "#d4a64f", { period: 14, lower: 30, lowerColor: "#38c172", upper: 70, upperColor: "#e45649" }],
  ["trix", "TRIX", "Momentum", "lower", "#bb6bd9", { period: 15, zeroLine: true, zeroColor: "#afa697" }],
  ["adx", "ADX", "Momentum", "lower", "#ff867c", { period: 14, level: 25, levelColor: "#d4a64f" }],
  ["dmi", "DMI", "Momentum", "lower", "#6ce29c", { period: 14, level: 20, levelColor: "#d4a64f" }],
  ["aroon", "Aroon", "Momentum", "lower", "#2d9cdb", { period: 25, lower: 30, lowerColor: "#38c172", upper: 70, upperColor: "#e45649" }],
  ["atr", "ATR", "Volatility", "lower", "#f2994a", { period: 14 }],
  ["atr-bands", "ATR Bands", "Volatility", "price", "#f2994a", { period: 14, multiplier: 2, midColor: "#f2994a", upperColor: "#e45649", lowerColor: "#38c172" }],
  ["standard-deviation", "Standard Deviation", "Volatility", "lower", "#56ccf2", { period: 20 }],
  ["historical-volatility", "Historical Volatility", "Volatility", "lower", "#bb6bd9", { period: 20 }],
  ["choppiness-index", "Choppiness Index", "Volatility", "lower", "#d4a64f", { period: 14, lower: 38.2, lowerColor: "#38c172", upper: 61.8, upperColor: "#e45649" }],
  ["volume-sma", "Volume SMA", "Volume", "lower", "#afa697", { period: 20 }],
  ["obv", "OBV", "Volume", "lower", "#38c172", {}],
  ["money-flow-index", "Money Flow Index", "Volume", "lower", "#f2c94c", { period: 14, lower: 20, lowerColor: "#38c172", upper: 80, upperColor: "#e45649" }],
  ["chaikin-money-flow", "Chaikin Money Flow", "Volume", "lower", "#56ccf2", { period: 20, zeroLine: true, zeroColor: "#afa697" }],
  ["accumulation-distribution", "Accumulation/Distribution", "Volume", "lower", "#bb6bd9", {}],
  ["ease-of-movement", "Ease of Movement", "Volume", "lower", "#f2994a", { period: 14, zeroLine: true, zeroColor: "#afa697" }],
  ["force-index", "Force Index", "Volume", "lower", "#eb5757", { period: 13, zeroLine: true, zeroColor: "#afa697" }],
].map(([type, name, category, pane, color, settings]) => ({
  type: type as IndicatorType,
  name: name as string,
  category: category as IndicatorRegistryItem["category"],
  pane: pane as IndicatorPane,
  color: color as string,
  settings: settings as Record<string, number | string | boolean>,
}));

const INDICATOR_BY_TYPE = Object.fromEntries(INDICATOR_LIBRARY.map((item) => [item.type, item])) as Record<IndicatorType, IndicatorRegistryItem>;
function currency(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

function wholeCurrency(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
}

function positionSizingOption(id: PositionSizingId) {
  return POSITION_SIZING_OPTIONS.find((option) => option.id === id) ?? POSITION_SIZING_OPTIONS[0];
}

function positionSizesForCapital(capital: number, sizing: PositionSizingId) {
  const option = positionSizingOption(sizing);
  return {
    small: Math.round(capital * option.smallPct),
    large: Math.round(capital * option.largePct),
  };
}

function normalizeScenarioFilters(parsed?: Partial<ScenarioFiltersState>, legacyScenario = "Random"): ScenarioFiltersState {
  const filters: ScenarioFiltersState = { ...DEFAULT_SCENARIO_FILTERS, ...(parsed ?? {}) };
  const allowed = new Map(
    SCENARIO_VARIABLES.map((variable) => [variable.id, new Set(["Random", variable.left.value, variable.right.value])]),
  );
  SCENARIO_VARIABLES.forEach((variable) => {
    if (!allowed.get(variable.id)?.has(filters[variable.id])) filters[variable.id] = "Random";
  });

  if (legacyScenario === "Above 200 SMA" || legacyScenario === "Below 200 SMA") filters.sma = legacyScenario;
  if (legacyScenario === "High Volatility" || legacyScenario === "Low Volatility") filters.volatility = legacyScenario;
  if (legacyScenario === "Gap Up" || legacyScenario === "Gap Down") filters.gap = legacyScenario;
  if (legacyScenario === "Large Premarket Volume Increase" || legacyScenario === "Large Premarket Volume Decrease") filters.premarketVolume = legacyScenario;
  if (legacyScenario === "Gap Up With Volume") {
    filters.gap = "Gap Up";
    filters.premarketVolume = "Large Premarket Volume Increase";
  }
  if (legacyScenario === "Gap Down With Volume") {
    filters.gap = "Gap Down";
    filters.premarketVolume = "Large Premarket Volume Increase";
  }
  return filters;
}

function selectedScenarioFilters(filters: ScenarioFiltersState): string[] {
  return SCENARIO_VARIABLES.map((variable) => filters[variable.id]).filter((value) => value !== "Random");
}

function scenarioFilterSummary(filters: ScenarioFiltersState): string {
  const selected = selectedScenarioFilters(filters);
  return selected.length ? selected.join(" / ") : "Random";
}

function pct(value: number) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function normalizeAccounts(accounts: UserAccount[]) {
  const byName = new Map<string, UserAccount>();
  byName.set(DEFAULT_ACCOUNT.username, DEFAULT_ACCOUNT);
  accounts.forEach((account) => {
    const username = account.username?.trim();
    if (username) byName.set(username, { username, password: String(account.password ?? "") });
  });
  return Array.from(byName.values());
}

function loadAccounts(): UserAccount[] {
  const raw = localStorage.getItem(ACCOUNT_STORAGE_KEY);
  if (!raw) {
    const accounts = [DEFAULT_ACCOUNT];
    localStorage.setItem(ACCOUNT_STORAGE_KEY, JSON.stringify(accounts));
    return accounts;
  }
  try {
    const accounts = normalizeAccounts(JSON.parse(raw) as UserAccount[]);
    localStorage.setItem(ACCOUNT_STORAGE_KEY, JSON.stringify(accounts));
    return accounts;
  } catch {
    localStorage.setItem(ACCOUNT_STORAGE_KEY, JSON.stringify([DEFAULT_ACCOUNT]));
    return [DEFAULT_ACCOUNT];
  }
}

function saveAccounts(accounts: UserAccount[]) {
  localStorage.setItem(ACCOUNT_STORAGE_KEY, JSON.stringify(normalizeAccounts(accounts)));
}

function loadCurrentUser() {
  const accounts = loadAccounts();
  const currentUsername = localStorage.getItem(CURRENT_USER_STORAGE_KEY) || DEFAULT_ACCOUNT.username;
  const account = accounts.find((item) => item.username === currentUsername) ?? DEFAULT_ACCOUNT;
  localStorage.setItem(CURRENT_USER_STORAGE_KEY, account.username);
  return account;
}

function userStorageKey(username: string, key: "settings" | "history" | "chartTemplates" | "chartTemplateSelection" | "setup" | "chartSetupUi") {
  return `trading-replay-user-${username}-${key}`;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({ detail: response.statusText }));
    throw new Error(detail.detail ?? response.statusText);
  }
  return response.json() as Promise<T>;
}

function newClientId(prefix: string) {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}_${random}`;
}

function analyticsVisitorId() {
  const existing = localStorage.getItem(ANALYTICS_VISITOR_STORAGE_KEY);
  if (existing) return existing;
  const next = newClientId("visitor");
  localStorage.setItem(ANALYTICS_VISITOR_STORAGE_KEY, next);
  return next;
}

function analyticsVisitId() {
  const existing = sessionStorage.getItem(ANALYTICS_VISIT_STORAGE_KEY);
  if (existing) return existing;
  const next = newClientId("visit");
  sessionStorage.setItem(ANALYTICS_VISIT_STORAGE_KEY, next);
  return next;
}

function analyticsPathForView(view: View) {
  return `/app/${view}`;
}

function compactNumber(value: number) {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function normalizeSettingsState(parsed: Partial<SettingsState> = {}): SettingsState {
  const controllerProfile = (["Keyboard", "Xbox", "PlayStation"] as ControllerProfile[]).includes(parsed.controllerProfile as ControllerProfile)
    ? parsed.controllerProfile as ControllerProfile
    : DEFAULT_SETTINGS.controllerProfile;
  const defaultReplaySpeed = SPEED_ORDER.includes(parsed.defaultReplaySpeed as ReplaySpeed)
    ? parsed.defaultReplaySpeed as ReplaySpeed
    : DEFAULT_SETTINGS.defaultReplaySpeed;
  const defaultTimeframe = (["1m", "5m", "15m"] as Timeframe[]).includes(parsed.defaultTimeframe as Timeframe)
    ? parsed.defaultTimeframe as Timeframe
    : DEFAULT_SETTINGS.defaultTimeframe;
  const defaultStartingCapital = STARTING_CAPITAL_OPTIONS.includes(Number(parsed.defaultStartingCapital))
    ? Number(parsed.defaultStartingCapital)
    : DEFAULT_SETTINGS.defaultStartingCapital;
  const themeMode = (["Dark", "Light"] as SettingsState["themeMode"][]).includes(parsed.themeMode as SettingsState["themeMode"])
    ? parsed.themeMode as SettingsState["themeMode"]
    : DEFAULT_SETTINGS.themeMode;
  const chartStyle = (["Price Action", "Bloomberg Terminal", "Brokerage Account", "Arcade"] as SettingsState["chartStyle"][]).includes(parsed.chartStyle as SettingsState["chartStyle"])
    ? parsed.chartStyle as SettingsState["chartStyle"]
    : DEFAULT_SETTINGS.chartStyle;
  return {
    ...DEFAULT_SETTINGS,
    ...parsed,
    controllerProfile,
    defaultReplaySpeed,
    defaultTimeframe,
    defaultStartingCapital,
    themeMode,
    chartStyle,
    masterVolume: Number.isFinite(Number(parsed.masterVolume)) ? Number(parsed.masterVolume) : DEFAULT_SETTINGS.masterVolume,
    alertVolume: Number.isFinite(Number(parsed.alertVolume)) ? Number(parsed.alertVolume) : DEFAULT_SETTINGS.alertVolume,
    tradeVolume: Number.isFinite(Number(parsed.tradeVolume)) ? Number(parsed.tradeVolume) : DEFAULT_SETTINGS.tradeVolume,
    keyboard: { ...DEFAULT_SETTINGS.keyboard, ...(parsed.keyboard ?? {}) },
    controller: { ...DEFAULT_SETTINGS.controller, ...(parsed.controller ?? {}) },
  };
}

function loadSettings(username = DEFAULT_ACCOUNT.username): SettingsState {
  const raw = localStorage.getItem(userStorageKey(username, "settings")) ?? localStorage.getItem("trading-replay-settings");
  if (!raw) return DEFAULT_SETTINGS;
  try {
    return normalizeSettingsState(JSON.parse(raw) as Partial<SettingsState>);
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function saveSettings(settings: SettingsState, username = DEFAULT_ACCOUNT.username) {
  localStorage.setItem(userStorageKey(username, "settings"), JSON.stringify(settings));
}

function defaultSetupState(settings = DEFAULT_SETTINGS): SetupState {
  return {
    mode: "standard",
    assetClass: "Random",
    asset: "Random",
    scenario: "Random",
    scenarioFilters: { ...DEFAULT_SCENARIO_FILTERS },
    timeframe: settings.defaultTimeframe,
    startTime: null,
    startingCapital: settings.defaultStartingCapital,
    positionSizing: "1/5",
    replaySpeed: settings.defaultReplaySpeed,
    hardcore: false,
  };
}

function normalizeSetupState(parsed: Partial<SetupState> = {}, settings = DEFAULT_SETTINGS): SetupState {
  const fallback = defaultSetupState(settings);
  return {
    ...fallback,
    ...parsed,
    mode: parsed.mode === "practice" || parsed.mode === "standard" ? parsed.mode : fallback.mode,
    assetClass: typeof parsed.assetClass === "string" ? parsed.assetClass : fallback.assetClass,
    asset: typeof parsed.asset === "string" ? parsed.asset : fallback.asset,
    scenario: "Random",
    scenarioFilters: normalizeScenarioFilters(parsed.scenarioFilters, typeof parsed.scenario === "string" ? parsed.scenario : fallback.scenario),
    timeframe: (["1m", "5m", "15m"] as Timeframe[]).includes(parsed.timeframe as Timeframe) ? parsed.timeframe as Timeframe : fallback.timeframe,
    startTime: START_TIME_CHOICES.some((choice) => choice.value === parsed.startTime) ? parsed.startTime ?? null : fallback.startTime,
    startingCapital: STARTING_CAPITAL_OPTIONS.includes(Number(parsed.startingCapital)) ? Number(parsed.startingCapital) : fallback.startingCapital,
    positionSizing: POSITION_SIZING_OPTIONS.some((option) => option.id === parsed.positionSizing) ? parsed.positionSizing as PositionSizingId : fallback.positionSizing,
    replaySpeed: SPEED_ORDER.includes(parsed.replaySpeed as ReplaySpeed) ? parsed.replaySpeed as ReplaySpeed : fallback.replaySpeed,
    hardcore: Boolean(parsed.hardcore),
  };
}

function loadSetup(username = DEFAULT_ACCOUNT.username, settings = DEFAULT_SETTINGS): SetupState {
  const raw = localStorage.getItem(userStorageKey(username, "setup"));
  if (!raw) return defaultSetupState(settings);
  try {
    return normalizeSetupState(JSON.parse(raw) as Partial<SetupState>, settings);
  } catch {
    return defaultSetupState(settings);
  }
}

function saveSetup(setup: SetupState, username = DEFAULT_ACCOUNT.username) {
  localStorage.setItem(userStorageKey(username, "setup"), JSON.stringify(setup));
}

function normalizeChartSetupUiState(parsed: Partial<ChartSetupUiState> = {}): ChartSetupUiState {
  const zone = parsed.zone === "chart" || parsed.zone === 0 || parsed.zone === 1 || parsed.zone === 2 ? parsed.zone : "chart";
  return {
    mode: parsed.mode === "indicators" ? "indicators" : "appearance",
    zone,
  };
}

function loadChartSetupUi(username = DEFAULT_ACCOUNT.username): ChartSetupUiState {
  const raw = localStorage.getItem(userStorageKey(username, "chartSetupUi"));
  if (!raw) return { mode: "appearance", zone: "chart" };
  try {
    return normalizeChartSetupUiState(JSON.parse(raw) as Partial<ChartSetupUiState>);
  } catch {
    return { mode: "appearance", zone: "chart" };
  }
}

function saveChartSetupUi(state: ChartSetupUiState, username = DEFAULT_ACCOUNT.username) {
  localStorage.setItem(userStorageKey(username, "chartSetupUi"), JSON.stringify(normalizeChartSetupUiState(state)));
}

function loadHistory(username = DEFAULT_ACCOUNT.username): Scorecard[] {
  const raw = localStorage.getItem(userStorageKey(username, "history")) ?? localStorage.getItem("trading-replay-history");
  if (!raw) return [];
  try {
    return (JSON.parse(raw) as Scorecard[]).filter((item) => item.hardcore === true);
  } catch {
    return [];
  }
}

function saveHistory(history: Scorecard[], username = DEFAULT_ACCOUNT.username) {
  localStorage.setItem(userStorageKey(username, "history"), JSON.stringify(history.filter((item) => item.hardcore === true).slice(0, 50)));
}

function makeIndicator(type: IndicatorType, overrides: Partial<ChartIndicatorConfig> = {}): ChartIndicatorConfig {
  const item = INDICATOR_BY_TYPE[type];
  return {
    id: crypto.randomUUID(),
    type,
    label: overrides.label ?? item.name,
    enabled: overrides.enabled ?? true,
    pane: overrides.pane ?? item.pane,
    color: overrides.color ?? item.color,
    lineWidth: overrides.lineWidth ?? 2,
    lowerRow: item.pane === "lower" ? overrides.lowerRow ?? 0 : undefined,
    settings: { ...item.settings, ...(overrides.settings ?? {}) },
  };
}

function builtInChartTemplate(): ChartTemplate {
  return {
    id: "built-in-default",
    name: "Default",
    isDefault: true,
    chart: DEFAULT_CHART_SETTINGS,
    indicators: [makeIndicator("sma", { label: "SMA 20", settings: { period: 20 } }), makeIndicator("vwap")],
  };
}

function normalizeTemplates(templates: ChartTemplate[]): ChartTemplate[] {
  const valid = (templates.length ? templates : [builtInChartTemplate()]).slice(0, MAX_CHART_TEMPLATES);
  const defaultIndex = Math.max(0, valid.findIndex((template) => template.isDefault));
  return valid.map((template, index) => ({
    ...template,
    chart: {
      ...DEFAULT_CHART_SETTINGS,
      ...(template.chart ?? {}),
      candleStyle: template.chart?.candleStyle ?? DEFAULT_CHART_SETTINGS.candleStyle,
      visibleBars: DEFAULT_VISIBLE_BARS,
      lowerPanelHeight: template.chart?.lowerPanelHeight ?? DEFAULT_LOWER_PANEL_HEIGHT,
    },
    indicators: normalizeIndicatorRows(template.indicators.map((indicator) => ({
      ...indicator,
      settings: { ...(INDICATOR_BY_TYPE[indicator.type]?.settings ?? {}), ...(indicator.settings ?? {}) },
    }))),
    isDefault: index === defaultIndex,
  }));
}

function normalizeIndicatorRows(indicators: ChartIndicatorConfig[]) {
  const rowCounts = Array.from({ length: MAX_LOWER_ROWS }, () => 0);
  return indicators.map((indicator) => {
    if (indicator.pane !== "lower") return { ...indicator, lowerRow: undefined };
    const preferredRow = Number.isFinite(indicator.lowerRow) ? Math.max(0, Math.min(MAX_LOWER_ROWS - 1, Number(indicator.lowerRow))) : 0;
    const availableRow = rowCounts[preferredRow] < MAX_LOWER_PER_ROW
      ? preferredRow
      : rowCounts.findIndex((count) => count < MAX_LOWER_PER_ROW);
    if (availableRow === -1) return { ...indicator, lowerRow: MAX_LOWER_ROWS - 1, enabled: false };
    const lowerRow = availableRow;
    rowCounts[lowerRow] += 1;
    return { ...indicator, lowerRow };
  });
}

function loadChartTemplates(username = DEFAULT_ACCOUNT.username): ChartTemplate[] {
  const raw = localStorage.getItem(userStorageKey(username, "chartTemplates")) ?? localStorage.getItem(CHART_TEMPLATE_STORAGE_KEY);
  if (!raw) return [builtInChartTemplate()];
  try {
    return normalizeTemplates(JSON.parse(raw) as ChartTemplate[]);
  } catch {
    return [builtInChartTemplate()];
  }
}

function saveChartTemplates(templates: ChartTemplate[], username = DEFAULT_ACCOUNT.username) {
  localStorage.setItem(userStorageKey(username, "chartTemplates"), JSON.stringify(normalizeTemplates(templates)));
}

function defaultTemplateId(templates: ChartTemplate[]) {
  return (templates.find((template) => template.isDefault) ?? templates[0])?.id ?? builtInChartTemplate().id;
}

function loadActiveChartTemplateId(username: string, templates: ChartTemplate[]) {
  const saved = localStorage.getItem(userStorageKey(username, "chartTemplateSelection"));
  return saved && templates.some((template) => template.id === saved) ? saved : defaultTemplateId(templates);
}

function saveActiveChartTemplateId(username: string, templateId: string) {
  localStorage.setItem(userStorageKey(username, "chartTemplateSelection"), templateId);
}

function keyMatches(event: KeyboardEvent, binding: string) {
  if (binding === " ") return event.key === " ";
  if (binding === "+") return event.key === "+" || event.key === "=";
  return event.key.toLowerCase() === binding.toLowerCase();
}

function normalizeControllerBinding(binding: string) {
  return binding.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

function controllerButtonIndex(binding: string) {
  const normalized = normalizeControllerBinding(binding);
  const direct = normalized.match(/^B(\d+)$/);
  if (direct) return Number(direct[1]);
  return CONTROLLER_BUTTON_ALIASES[normalized];
}

function controllerButtonLabel(value: string, profile: GamepadProfile) {
  const option = CONTROLLER_BUTTON_OPTIONS.find((item) => item.value === value);
  if (!option) return value;
  return profile === "PlayStation" ? option.playstation : option.xbox;
}

function controllerButtonGlyph(value: string, profile: GamepadProfile) {
  const option = CONTROLLER_BUTTON_OPTIONS.find((item) => item.value === value);
  if (!option) return value;
  return profile === "PlayStation" ? option.psGlyph : option.xbox;
}

function controllerButtonKind(value: string) {
  const option = CONTROLLER_BUTTON_OPTIONS.find((item) => item.value === value);
  if (!option) return "empty";
  if (option.index <= 3) return "face";
  if (option.index <= 7) return "shoulder";
  if (option.index <= 9) return "system";
  if (option.index <= 11) return "stick";
  if (option.index <= 15) return "dpad";
  return "system";
}

function ControllerButtonChip({ value, profile }: { value?: string; profile: GamepadProfile }) {
  if (!value) {
    return <span className="controller-chip empty">Unassigned</span>;
  }

  const label = controllerButtonLabel(value, profile);
  const glyph = controllerButtonGlyph(value, profile);
  const kind = controllerButtonKind(value);
  return (
    <span className={`controller-chip ${kind} ${profile.toLowerCase()}`} title={label}>
      <span className="controller-glyph">{glyph}</span>
      {kind !== "face" && <span className="controller-name">{label}</span>}
    </span>
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function timestampToChartMs(timestamp: string) {
  const [datePart, timePart = "00:00:00"] = timestamp.split("T");
  const [year, month, day] = datePart.split("-").map(Number);
  const [hour, minute, second = 0] = timePart.split(":").map(Number);
  return Date.UTC(year, month - 1, day, hour, minute, Math.floor(second));
}

function chartTimeForClock(date: string, hour: number, minute = 0) {
  return Math.floor(timestampToChartMs(`${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`) / 1000) as Time;
}

function roundToCent(value: number) {
  return Math.round(value * 100) / 100;
}

function seededUnit(seedText: string) {
  let hash = 2166136261;
  for (let index = 0; index < seedText.length; index += 1) {
    hash ^= seedText.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}

function levelLiquidityShape(price: number, tickIndex: number, side: "bid" | "ask", level: number, volumePulse: number) {
  const distanceWeight = 0.95 + level * 0.16;
  const cents = Math.abs(Math.round(price * 100)) % 100;
  const wholeDollarBoost = cents <= 1 || cents >= 99 ? 2.8 : 1;
  const halfDollarBoost = Math.abs(cents - 50) <= 1 ? 2.1 : 1;
  const dimeBoost = cents % 10 === 0 ? 1.55 : 1;
  const quarterBoost = cents % 25 === 0 ? 1.35 : 1;
  const shelfNoise = 0.42 + seededUnit(`${tickIndex}|${side}|shelf|${level}`) * 1.35;
  const wallChance = clamp(0.82 - volumePulse * 0.035, 0.68, 0.9);
  const wall = seededUnit(`${tickIndex}|${side}|wall|${level}`) > wallChance ? 2.2 + seededUnit(`${tickIndex}|${side}|wallSize|${level}`) * (2.2 + volumePulse) : 1;
  const holeChance = clamp(0.22 - volumePulse * 0.035, 0.08, 0.2);
  const hole = seededUnit(`${tickIndex}|${side}|hole|${level}`) < holeChance ? 0.18 + seededUnit(`${tickIndex}|${side}|holeSize|${level}`) * 0.32 : 1;
  const flicker = 0.72 + seededUnit(`${tickIndex}|${side}|flicker|${level}`) * 0.68;
  return distanceWeight * wholeDollarBoost * halfDollarBoost * dimeBoost * quarterBoost * shelfNoise * wall * hole * flicker;
}

function buildSyntheticOrderBook(tick: ReplayTick | undefined): SyntheticOrderBook | null {
  if (!tick || tick.price <= 0) return null;

  const price = tick.price;
  const phaseStress = tick.phase === "high" || tick.phase === "low" ? 1.35 : tick.phase === "random" ? 1.12 : 1;
  const volumeRatio = tick.candleVolume > 0 ? tick.volumeDelta / tick.candleVolume : 0;
  const sequenceProgress = tick.ticksInCandle > 1 ? tick.sequenceInCandle / (tick.ticksInCandle - 1) : 1;
  const nextVolumeRatio = tick.candleVolume > 0 ? tick.nextCandleVolume / tick.candleVolume : 1;
  const nextRangeRatio = Math.max(tick.nextCandleRange, 0) / Math.max(tick.candleHigh - tick.candleLow, 0.01);
  const nextLiquidityRamp = sequenceProgress > 0.68
    ? (sequenceProgress - 0.68) / 0.32 * clamp((nextVolumeRatio - 1) * 0.45 + (nextRangeRatio - 1) * 0.18, -0.25, 1.35)
    : 0;
  const volumePulse = clamp((volumeRatio * tick.ticksInCandle) + nextLiquidityRamp, 0.35, 4.8);
  const candleRange = Math.max(tick.candleHigh - tick.candleLow, 0);
  const candlePosition = candleRange > 0 ? clamp((price - tick.candleLow) / candleRange, 0, 1) : 0.5;
  const bullishCandle = tick.candleClose >= tick.candleOpen;
  const nearHigh = candlePosition > 0.76;
  const nearLow = candlePosition < 0.24;
  const volatilityBps = clamp(Math.abs(tick.price - Number(price.toFixed(2))) / price * 10_000, 0, 3);
  const spreadCents = clamp(Math.round(1 + phaseStress + volumeRatio * 18 + volumePulse * 0.55 + volatilityBps), 1, 8);
  const spread = spreadCents / 100;
  const midpoint = roundToCent(price);
  const bid = roundToCent(midpoint - spread / 2);
  const ask = roundToCent(bid + spread);
  const directionalBias = tick.phase === "high" ? -0.08 : tick.phase === "low" ? 0.08 : bullishCandle ? 0.03 : -0.03;
  const rangeBias = nearHigh ? -0.06 : nearLow ? 0.06 : 0;
  const randomBias = (seededUnit(`${tick.tickIndex}|imbalance`) - 0.5) * 0.28;
  const imbalance = clamp(0.5 + directionalBias + rangeBias + randomBias, 0.18, 0.82);
  const baseDepth = clamp((tick.candleVolume / tick.ticksInCandle / 140) * (0.68 + volumePulse * 0.34), 180, 7600);
  const sweepAskMultiplier = volumePulse > 1.45 && nearHigh ? clamp(1.1 - volumePulse * 0.12, 0.48, 0.9) : 1;
  const sweepBidMultiplier = volumePulse > 1.45 && nearLow ? clamp(1.1 - volumePulse * 0.12, 0.48, 0.9) : 1;

  const bids: OrderBookLevel[] = [];
  const asks: OrderBookLevel[] = [];
  for (let level = 0; level < 10; level += 1) {
    const bidPrice = roundToCent(bid - level * 0.01);
    const askPrice = roundToCent(ask + level * 0.01);
    const bidShape = levelLiquidityShape(bidPrice, tick.tickIndex, "bid", level, volumePulse);
    const askShape = levelLiquidityShape(askPrice, tick.tickIndex, "ask", level, volumePulse);
    const nearTouchWeight = level < 3 ? 1 : 0.92 + level * 0.03;
    bids.push({
      price: bidPrice,
      size: Math.max(1, Math.round(baseDepth * imbalance * bidShape * nearTouchWeight * sweepBidMultiplier)),
    });
    asks.push({
      price: askPrice,
      size: Math.max(1, Math.round(baseDepth * (1 - imbalance) * askShape * nearTouchWeight * sweepAskMultiplier)),
    });
  }

  const totalBidSize = bids.reduce((sum, level) => sum + level.size, 0);
  const totalAskSize = asks.reduce((sum, level) => sum + level.size, 0);
  return { bid, ask, spread, bids, asks, imbalance: totalBidSize / Math.max(totalBidSize + totalAskSize, 1), totalBidSize, totalAskSize };
}

function blendBookLevelSizes(previous: SyntheticOrderBook | null, next: SyntheticOrderBook | null): SyntheticOrderBook | null {
  if (!next) return previous;
  if (!previous || Math.abs(previous.bid - next.bid) > 0.25 || Math.abs(previous.ask - next.ask) > 0.25) return next;

  const previousBidSizes = new Map(previous.bids.map((level) => [level.price.toFixed(2), level.size]));
  const previousAskSizes = new Map(previous.asks.map((level) => [level.price.toFixed(2), level.size]));
  const smoothSize = (previousSize: number | undefined, nextSize: number) => {
    if (previousSize === undefined) return nextSize;
    const maxStepUp = previousSize * 1.45 + 120;
    const maxStepDown = previousSize * 0.55 - 80;
    const blended = previousSize * 0.72 + nextSize * 0.28;
    return Math.max(1, Math.round(clamp(blended, Math.max(1, maxStepDown), maxStepUp)));
  };
  const bids = next.bids.map((level) => ({ ...level, size: smoothSize(previousBidSizes.get(level.price.toFixed(2)), level.size) }));
  const asks = next.asks.map((level) => ({ ...level, size: smoothSize(previousAskSizes.get(level.price.toFixed(2)), level.size) }));
  const totalBidSize = bids.reduce((sum, level) => sum + level.size, 0);
  const totalAskSize = asks.reduce((sum, level) => sum + level.size, 0);
  return {
    ...next,
    bid: roundToCent(previous.bid * 0.35 + next.bid * 0.65),
    ask: roundToCent(previous.ask * 0.35 + next.ask * 0.65),
    spread: roundToCent((previous.spread * 0.35 + next.spread * 0.65)),
    bids,
    asks,
    totalBidSize,
    totalAskSize,
    imbalance: totalBidSize / Math.max(totalBidSize + totalAskSize, 1),
  };
}

function executeMarketOrder(side: TradeSide, requestedQuantity: number, book: SyntheticOrderBook | null): ExecutionResult | null {
  if (!book || requestedQuantity <= 0) return null;
  const levels = side === "buy" ? book.asks : book.bids;
  let remaining = requestedQuantity;
  let quantity = 0;
  let notional = 0;

  for (const level of levels) {
    if (remaining <= 0) break;
    const filled = Math.min(remaining, level.size);
    quantity += filled;
    notional += filled * level.price;
    remaining -= filled;
  }

  if (quantity <= 0) return null;
  return {
    quantity,
    averagePrice: notional / quantity,
    notional,
    requestedQuantity,
  };
}

function executeMarketBuyByNotional(maxNotional: number, book: SyntheticOrderBook | null): ExecutionResult | null {
  if (!book || maxNotional <= 0) return null;
  let remainingCash = maxNotional;
  let quantity = 0;
  let notional = 0;
  let requestedQuantity = 0;

  for (const level of book.asks) {
    requestedQuantity += level.size;
    if (remainingCash <= 0) break;
    const affordableAtLevel = remainingCash / level.price;
    const filled = Math.min(level.size, affordableAtLevel);
    quantity += filled;
    notional += filled * level.price;
    remainingCash -= filled * level.price;
    if (filled < level.size) break;
  }

  if (quantity <= 0) return null;
  return {
    quantity,
    averagePrice: notional / quantity,
    notional,
    requestedQuantity,
  };
}

function slippageAdjustedPrice(price: number, side: TradeSide, book: SyntheticOrderBook | null, tick: ReplayTick | undefined) {
  if (!book || !tick || price <= 0) return price;
  const spreadPct = book.spread / Math.max(price, 1);
  const activity = tick.candleVolume > 0 ? tick.volumeDelta / tick.candleVolume : 0;
  const rangePct = (tick.candleHigh - tick.candleLow) / Math.max(price, 1);
  const slippagePct = clamp(spreadPct * 0.35 + activity * 0.0008 + rangePct * 0.015, 0.00005, 0.0015);
  return side === "buy" ? price * (1 + slippagePct) : price * (1 - slippagePct);
}

function stickValue(value: number | undefined) {
  const deadzone = 0.14;
  const raw = value ?? 0;
  if (Math.abs(raw) < deadzone) return 0;
  return ((Math.abs(raw) - deadzone) / (1 - deadzone)) * Math.sign(raw);
}

function buildDisplayCandles(ticks: ReplayTick[], timeframe: Timeframe): DisplayCandle[] {
  if (!ticks.length) return [];

  const interval = TIMEFRAME_MINUTES[timeframe] * 60_000;
  const sessionStart = timestampToChartMs(ticks[0].candleTimestamp);
  const candleMap = new Map<number, DisplayCandle>();

  for (const tick of ticks) {
    const candleTime = timestampToChartMs(tick.candleTimestamp);
    const bucket = sessionStart + Math.floor((candleTime - sessionStart) / interval) * interval;
    const chartTime = Math.floor(bucket / 1000) as Time;
    const existing = candleMap.get(bucket);

    if (!existing) {
      candleMap.set(bucket, {
        time: chartTime,
        open: tick.price,
        high: tick.price,
        low: tick.price,
        close: tick.price,
        volume: tick.volumeDelta,
      });
    } else {
      existing.high = Math.max(existing.high, tick.price);
      existing.low = Math.min(existing.low, tick.price);
      existing.close = tick.price;
      existing.volume += tick.volumeDelta;
    }
  }

  return Array.from(candleMap.values()).sort((a, b) => Number(a.time) - Number(b.time));
}

function payloadCandlesToDisplay(candles: CandlePayload[]): DisplayCandle[] {
  return candles.map((candle) => ({
    time: Math.floor(timestampToChartMs(candle.timestamp) / 1000) as Time,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
    sessionSegment: candle.sessionSegment ?? "regular",
    source: candle.source ?? "real",
  })).sort((a, b) => Number(a.time) - Number(b.time));
}

function premarketContext(candles: DisplayCandle[]) {
  return candles.filter((candle) => candle.sessionSegment === "pre_market");
}

function mergeContextCandles(context: DisplayCandle[], regularCandles: DisplayCandle[]) {
  const premarket = premarketContext(context);
  return [...premarket, ...regularCandles.map((candle) => ({ ...candle, sessionSegment: "regular" as const, source: "real" as const }))];
}

function movingAverage(candles: DisplayCandle[], period: number): LineData[] {
  const data: LineData[] = [];
  let rollingSum = 0;
  candles.forEach((candle, index) => {
    rollingSum += candle.close;
    if (index >= period) rollingSum -= candles[index - period].close;
    if (index >= period - 1) data.push({ time: candle.time, value: Number((rollingSum / period).toFixed(4)) });
  });
  return data;
}

function numberSetting(config: ChartIndicatorConfig, key: string, fallback: number) {
  const value = config.settings[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function boolSetting(config: ChartIndicatorConfig, key: string, fallback = false) {
  const value = config.settings[key];
  return typeof value === "boolean" ? value : fallback;
}

function stringSetting(config: ChartIndicatorConfig, key: string, fallback: string) {
  const value = config.settings[key];
  return typeof value === "string" ? value : fallback;
}

function lowerReferenceLines(config: ChartIndicatorConfig): IndicatorReferenceLine[] {
  if (config.pane !== "lower") return [];
  const lines: IndicatorReferenceLine[] = [];
  const upper = config.settings.upper;
  const lower = config.settings.lower;
  const level = config.settings.level;
  if (typeof upper === "number") lines.push({ value: upper, label: String(upper), color: stringSetting(config, "upperColor", "#e45649") });
  if (typeof lower === "number") lines.push({ value: lower, label: String(lower), color: stringSetting(config, "lowerColor", "#38c172") });
  if (typeof level === "number") lines.push({ value: level, label: String(level), color: stringSetting(config, "levelColor", "#d4a64f") });
  if (boolSetting(config, "zeroLine")) lines.push({ value: 0, label: "0", color: stringSetting(config, "zeroColor", "#afa697") });
  return lines;
}

function emaValues(values: number[], period: number) {
  const multiplier = 2 / (period + 1);
  const output: Array<number | null> = [];
  let ema = 0;
  values.forEach((value, index) => {
    if (index === 0) ema = value;
    else ema = value * multiplier + ema * (1 - multiplier);
    output.push(index >= period - 1 ? ema : null);
  });
  return output;
}

function valuesToLine(candles: DisplayCandle[], values: Array<number | null | undefined>): LineData[] {
  return values
    .map((value, index) => (value === null || value === undefined || Number.isNaN(value) ? null : { time: candles[index].time, value: Number(value.toFixed(4)) }))
    .filter((value): value is LineData => value !== null);
}

function rollingHigh(candles: DisplayCandle[], period: number) {
  return valuesToLine(candles, candles.map((_, index) => (index >= period - 1 ? Math.max(...candles.slice(index - period + 1, index + 1).map((candle) => candle.high)) : null)));
}

function rollingLow(candles: DisplayCandle[], period: number) {
  return valuesToLine(candles, candles.map((_, index) => (index >= period - 1 ? Math.min(...candles.slice(index - period + 1, index + 1).map((candle) => candle.low)) : null)));
}

function trueRanges(candles: DisplayCandle[]) {
  return candles.map((candle, index) => {
    const previousClose = candles[index - 1]?.close ?? candle.close;
    return Math.max(candle.high - candle.low, Math.abs(candle.high - previousClose), Math.abs(candle.low - previousClose));
  });
}

function atrLine(candles: DisplayCandle[], period: number) {
  const ranges = trueRanges(candles);
  return valuesToLine(candles, emaValues(ranges, period));
}

function vwap(candles: DisplayCandle[]): LineData[] {
  const data: LineData[] = [];
  let cumulativePriceVolume = 0;
  let cumulativeVolume = 0;
  candles.forEach((candle) => {
    const typicalPrice = (candle.high + candle.low + candle.close) / 3;
    cumulativePriceVolume += typicalPrice * candle.volume;
    cumulativeVolume += candle.volume;
    if (cumulativeVolume > 0) data.push({ time: candle.time, value: Number((cumulativePriceVolume / cumulativeVolume).toFixed(4)) });
  });
  return data;
}

function rsiLine(candles: DisplayCandle[], period = 14) {
  if (candles.length <= period) return [];
  const values: Array<number | null> = candles.map(() => null);
  for (let index = period; index < candles.length; index += 1) {
    let gains = 0;
    let losses = 0;
    for (let lookback = index - period + 1; lookback <= index; lookback += 1) {
      const change = candles[lookback].close - candles[lookback - 1].close;
      if (change >= 0) gains += change;
      else losses += Math.abs(change);
    }
    values[index] = losses === 0 ? 100 : 100 - 100 / (1 + gains / losses);
  }
  return valuesToLine(candles, values);
}

function standardDeviationLine(candles: DisplayCandle[], period: number) {
  return valuesToLine(candles, candles.map((_, index) => {
    if (index < period - 1) return null;
    const closes = candles.slice(index - period + 1, index + 1).map((candle) => candle.close);
    const mean = closes.reduce((sum, value) => sum + value, 0) / closes.length;
    return Math.sqrt(closes.reduce((sum, value) => sum + (value - mean) ** 2, 0) / closes.length);
  }));
}

function computeIndicator(config: ChartIndicatorConfig, candles: DisplayCandle[]): IndicatorSeries[] {
  if (!config.enabled || !candles.length) return [];
  const period = Math.max(1, Math.round(numberSetting(config, "period", 20)));
  const closes = candles.map((candle) => candle.close);
  const series = (data: LineData[], label = config.label, color = config.color, pane = config.pane): IndicatorSeries => ({
    id: `${config.id}-${label}`,
    label,
    pane,
    color,
    lineWidth: config.lineWidth,
    lowerRow: pane === "lower" ? config.lowerRow ?? 0 : undefined,
    data,
    referenceLines: pane === "lower" ? lowerReferenceLines(config) : [],
  });

  if (config.type === "sma") return [series(movingAverage(candles, period))];
  if (config.type === "ema") return [series(valuesToLine(candles, emaValues(closes, period)))];
  if (["wma", "hma", "dema", "tema", "linear-regression", "supertrend", "parabolic-sar", "ichimoku"].includes(config.type)) {
    return [series(valuesToLine(candles, emaValues(closes, period)))];
  }
  if (config.type === "vwma") {
    const values = candles.map((_, index) => {
      if (index < period - 1) return null;
      const window = candles.slice(index - period + 1, index + 1);
      const volume = window.reduce((sum, candle) => sum + candle.volume, 0);
      return volume ? window.reduce((sum, candle) => sum + candle.close * candle.volume, 0) / volume : null;
    });
    return [series(valuesToLine(candles, values))];
  }
  if (config.type === "vwap" || config.type === "anchored-vwap") return [series(vwap(candles))];
  if (["bollinger-bands", "vwap-bands", "keltner-channels", "linear-regression-channel", "atr-bands"].includes(config.type)) {
    const basis = config.type === "vwap-bands" ? vwap(candles) : movingAverage(candles, period);
    const multiplier = numberSetting(config, "multiplier", 2);
    const deviations = standardDeviationLine(candles, period);
    const deviationByTime = new Map(deviations.map((point) => [point.time, point.value]));
    return [
      series(basis, `${config.label} Mid`, stringSetting(config, "midColor", config.color)),
      series(basis.map((point) => ({ time: point.time, value: point.value + (deviationByTime.get(point.time) ?? 0) * multiplier })), `${config.label} Upper`, stringSetting(config, "upperColor", config.color)),
      series(basis.map((point) => ({ time: point.time, value: point.value - (deviationByTime.get(point.time) ?? 0) * multiplier })), `${config.label} Lower`, stringSetting(config, "lowerColor", config.color)),
    ];
  }
  if (config.type === "donchian-channels") return [
    series(rollingHigh(candles, period), `${config.label} High`, stringSetting(config, "upperColor", config.color)),
    series(rollingLow(candles, period), `${config.label} Low`, stringSetting(config, "lowerColor", config.color)),
  ];
  if (["pivot-points", "fibonacci-retracement", "prior-day-high-low", "session-open", "opening-range"].includes(config.type)) {
    const base = config.type === "session-open" ? candles[0].open : numberSetting(config, "price", candles[0].open);
    return [series(candles.map((candle) => ({ time: candle.time, value: base })))];
  }
  if (config.type === "rsi" || config.type === "stochastic-rsi" || config.type === "stochastic" || config.type === "money-flow-index" || config.type === "ultimate-oscillator") {
    return [series(rsiLine(candles, period), config.label, config.color, "lower")];
  }
  if (["macd", "ppo", "trix"].includes(config.type)) {
    const fast = emaValues(closes, numberSetting(config, "fast", 12));
    const slow = emaValues(closes, numberSetting(config, "slow", 26));
    return [series(valuesToLine(candles, fast.map((value, index) => (value === null || slow[index] === null ? null : value - Number(slow[index])))), config.label, config.color, "lower")];
  }
  if (config.type === "atr") return [series(atrLine(candles, period), config.label, config.color, "lower")];
  if (config.type === "standard-deviation" || config.type === "historical-volatility") return [series(standardDeviationLine(candles, period), config.label, config.color, "lower")];
  if (config.type === "volume-sma") return [series(movingAverage(candles.map((candle) => ({ ...candle, close: candle.volume })), period), config.label, config.color, "lower")];
  if (config.type === "obv" || config.type === "accumulation-distribution") {
    let value = 0;
    return [series(valuesToLine(candles, candles.map((candle, index) => {
      const previous = candles[index - 1]?.close ?? candle.close;
      value += candle.close >= previous ? candle.volume : -candle.volume;
      return value;
    })), config.label, config.color, "lower")];
  }
  return [series(valuesToLine(candles, closes.map((close, index) => (index >= period ? close - candles[index - period].close : null))), config.label, config.color, config.pane)];
}

function computeIndicators(candles: DisplayCandle[], template: ChartTemplate): ComputedChartData {
  const allSeries = template.indicators.flatMap((indicator) => computeIndicator(indicator, candles));
  return {
    priceSeries: allSeries.filter((series) => series.pane === "price"),
    lowerSeries: allSeries.filter((series) => series.pane === "lower"),
  };
}

function lowerIndicatorRows(series: IndicatorSeries[]): LowerIndicatorRow[] {
  return Array.from({ length: MAX_LOWER_ROWS }, (_, row) => ({
    row,
    series: series
      .filter((item) => Math.max(0, Math.min(MAX_LOWER_ROWS - 1, item.lowerRow ?? 0)) === row)
      .slice(0, MAX_LOWER_PER_ROW),
  })).filter((row) => row.series.length > 0);
}

function latestIndicatorValue(series: IndicatorSeries[]) {
  const withData = series.filter((item) => item.data.length);
  const lastSeries = withData[withData.length - 1];
  const last = lastSeries?.data[lastSeries.data.length - 1];
  return typeof last?.value === "number" ? last.value : null;
}

function indicatorTitle(indicator: ChartIndicatorConfig) {
  const settings = Object.entries(indicator.settings)
    .filter(([, value]) => value !== "" && value !== null && value !== undefined)
    .map(([key, value]) => `${key}: ${String(value)}`);
  return settings.length ? `${indicator.label} (${settings.join(", ")})` : indicator.label;
}

function indexAtOrBeforeTime(candles: DisplayCandle[], time?: Time) {
  if (time === undefined) return -1;
  for (let index = candles.length - 1; index >= 0; index -= 1) {
    if (Number(candles[index].time) <= Number(time)) return index;
  }
  return -1;
}

function buildLowerTimeline(candles: DisplayCandle[], visibleBars: number, visibleStartTime?: Time, visibleEndTime?: Time, rightOffset = 5): LowerTimeline {
  const bars = Math.max(20, Math.min(500, visibleBars));
  const startIndex = visibleStartTime === undefined ? -1 : candles.findIndex((candle) => Number(candle.time) >= Number(visibleStartTime));
  const endIndex = indexAtOrBeforeTime(candles, visibleEndTime);
  const from = startIndex >= 0 ? startIndex : endIndex >= 0 ? Math.max(0, endIndex - bars + 1) : Math.max(0, candles.length - bars);
  const denominator = Math.max(bars + rightOffset - 1, 1);
  const timeToIndex = new Map(candles.map((candle, index) => [candle.time, index] as const));
  const currentIndex = endIndex >= 0 ? endIndex : candles.length - 1;
  return {
    bars,
    rightOffset,
    from,
    denominator,
    currentX: candles.length ? clamp(((currentIndex - from) / denominator) * 100, 0, 100) : 0,
    timeToIndex,
    indexToTime: candles.map((candle) => candle.time),
  };
}

function visibleLowerPoints(series: IndicatorSeries, timeline: LowerTimeline) {
  return series.data.filter((point) => {
    const index = timeline.timeToIndex.get(point.time);
    return index !== undefined && index >= timeline.from && index < timeline.indexToTime.length;
  });
}

function lowerPanelScale(series: IndicatorSeries, timeline: LowerTimeline) {
  const sample = visibleLowerPoints(series, timeline);
  const values = sample.map((point) => point.value);
  const referenceValues = (series.referenceLines ?? []).map((line) => line.value);
  const allValues = [...values, ...referenceValues];
  if (allValues.length === 0) return { sample, min: 0, max: 1, range: 1 };
  const rawMin = Math.min(...allValues);
  const rawMax = Math.max(...allValues);
  const rawRange = rawMax - rawMin || Math.max(Math.abs(rawMax), 1);
  const padding = rawRange * 0.12;
  const min = rawMin - padding;
  const max = rawMax + padding;
  return { sample, min, max, range: max - min || 1 };
}

function lowerSampleDomain(series: IndicatorSeries, timeline: LowerTimeline) {
  const sample = visibleLowerPoints(series, timeline);
  const firstIndex = timeline.timeToIndex.get(sample[0]?.time ?? (0 as Time));
  const lastIndex = timeline.timeToIndex.get(sample[sample.length - 1]?.time ?? (0 as Time));
  return {
    sample,
    firstIndex: firstIndex ?? timeline.from,
    lastIndex: lastIndex ?? Math.max(timeline.from, timeline.indexToTime.length - 1),
    span: Math.max((lastIndex ?? timeline.indexToTime.length - 1) - (firstIndex ?? timeline.from), 1),
  };
}

function xForTime(series: IndicatorSeries, timeline: LowerTimeline, timeValue: Time) {
  const domain = lowerSampleDomain(series, timeline);
  const index = timeline.timeToIndex.get(timeValue);
  if (index === undefined || index < domain.firstIndex || index > domain.lastIndex) return null;
  return ((index - domain.firstIndex) / domain.span) * timeline.currentX;
}

function valueAtTime(series: IndicatorSeries, timeValue: Time) {
  const point = series.data.find((item) => item.time === timeValue);
  return typeof point?.value === "number" ? point.value : null;
}

function sharedHoverForPointer(event: MouseEvent<HTMLDivElement>, series: IndicatorSeries, timeline: LowerTimeline): LowerIndicatorHover | null {
  const rect = event.currentTarget.getBoundingClientRect();
  const axisWidth = 42;
  const plotWidth = Math.max(rect.width - axisWidth, 1);
  const plotPixels = clamp(event.clientX - rect.left, 0, plotWidth);
  const x = clamp((plotPixels / plotWidth) * 100, 0, timeline.currentX);
  const panelX = (plotPixels / Math.max(rect.width, 1)) * 100;
  const y = clamp(((event.clientY - rect.top) / Math.max(rect.height, 1)) * 100, 0, 100);
  const domain = lowerSampleDomain(series, timeline);
  const logicalIndex = Math.max(domain.firstIndex, Math.min(domain.lastIndex, Math.round(domain.firstIndex + (x / Math.max(timeline.currentX, 1)) * domain.span)));
  const timeValue = timeline.indexToTime[logicalIndex] ?? null;
  if (timeValue === null) return null;
  const scale = lowerPanelScale(series, timeline);
  return {
    x,
    panelX,
    y,
    value: valueFromScaledY(y, scale.min, scale.range),
    time: timeValue,
  };
}

function scaledY(value: number, min: number, range: number) {
  return 92 - ((value - min) / range) * 84;
}

function valueFromScaledY(y: number, min: number, range: number) {
  return min + ((92 - y) / 84) * range;
}

function formatChartTime(time: Time | null) {
  if (typeof time !== "number") return "--:--";
  return new Date(time * 1000).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
}

function sparklinePoints(series: IndicatorSeries, timeline: LowerTimeline) {
  const { sample, min, range } = lowerPanelScale(series, timeline);
  if (sample.length < 2) return "";
  const domain = lowerSampleDomain(series, timeline);
  return sample
    .map((point) => {
      const index = timeline.timeToIndex.get(point.time);
      if (index === undefined) return "";
      const x = ((index - domain.firstIndex) / domain.span) * timeline.currentX;
      const y = scaledY(point.value, min, range);
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .filter(Boolean)
    .join(" ");
}

function LowerIndicatorPanel({
  series,
  timeline,
  sharedHover,
  onSharedHover,
  onClearSharedHover,
}: {
  series: IndicatorSeries;
  timeline: LowerTimeline;
  sharedHover: SharedLowerHover | null;
  onSharedHover: (hover: SharedLowerHover) => void;
  onClearSharedHover: () => void;
}) {
  const latest = latestIndicatorValue([series]);
  const scale = lowerPanelScale(series, timeline);
  const sharedX = sharedHover ? xForTime(series, timeline, sharedHover.time) : null;
  const sharedValue = sharedHover ? valueAtTime(series, sharedHover.time) : null;
  const sharedY = sharedValue === null ? null : scaledY(sharedValue, scale.min, scale.range);

  const handleMove = (event: MouseEvent<HTMLDivElement>) => {
    const hover = sharedHoverForPointer(event, series, timeline);
    if (hover?.time) onSharedHover({ time: hover.time, x: hover.x, panelX: hover.panelX });
  };

  return (
    <div className="lower-indicator" onMouseMove={handleMove} onMouseLeave={onClearSharedHover}>
      <div className="lower-indicator-meta">
        <span style={{ color: series.color }}>{series.label}</span>
        <strong>{latest === null ? "--" : latest.toFixed(2)}</strong>
      </div>
      <svg className="lower-indicator-chart" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        {(series.referenceLines ?? []).map((line) => {
          const y = scaledY(line.value, scale.min, scale.range);
          return (
            <line
              key={`${series.id}-${line.label}-${line.value}`}
              x1="0"
              x2="100"
              y1={y}
              y2={y}
              stroke={line.color}
              strokeDasharray="4 4"
              strokeOpacity="0.62"
              vectorEffect="non-scaling-stroke"
            />
          );
        })}
        <polyline points={sparklinePoints(series, timeline)} fill="none" stroke={series.color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
        {sharedX !== null && (
          <>
            <line x1={sharedX} x2={sharedX} y1="0" y2="100" stroke="#d8d3c8" strokeDasharray="3 3" strokeOpacity="0.7" vectorEffect="non-scaling-stroke" />
            {sharedY !== null && <line x1="0" x2="100" y1={sharedY} y2={sharedY} stroke="#d8d3c8" strokeDasharray="3 3" strokeOpacity="0.7" vectorEffect="non-scaling-stroke" />}
          </>
        )}
      </svg>
      <div className="lower-y-axis" aria-hidden="true">
        <span>{scale.max.toFixed(2)}</span>
        {(series.referenceLines ?? []).slice(0, 3).map((line) => (
          <span key={`${series.id}-axis-${line.label}`} style={{ color: line.color }}>{line.label}</span>
        ))}
        <span>{scale.min.toFixed(2)}</span>
      </div>
      {sharedHover && sharedX !== null && (
        <>
          <span className="lower-crosshair-time" style={{ left: `${sharedHover.panelX}%` }}>{formatChartTime(sharedHover.time)}</span>
          {sharedY !== null && sharedValue !== null && <span className="lower-crosshair-value" style={{ top: `${sharedY}%` }}>{sharedValue.toFixed(2)}</span>}
        </>
      )}
    </div>
  );
}

function buildTradeMarkers(fills: TradeFill[], ticks: ReplayTick[], timeframe: Timeframe): ChartMarker[] {
  if (!fills.length || !ticks.length) return [];
  const sessionStart = timestampToChartMs(ticks[0].candleTimestamp);
  const interval = TIMEFRAME_MINUTES[timeframe] * 60_000;
  const tickByIndex = new Map(ticks.map((tick) => [tick.tickIndex, tick]));

  const grouped = new Map<string, { side: TradeSide; time: Time; quantity: number; notional: number; count: number }>();
  for (const fill of fills) {
    const tick = tickByIndex.get(fill.tickIndex);
    const timestamp = tick?.candleTimestamp ?? fill.timestamp;
    const candleTime = timestampToChartMs(timestamp);
    const bucket = sessionStart + Math.floor((candleTime - sessionStart) / interval) * interval;
    const time = Math.floor(bucket / 1000) as Time;
    const key = `${fill.side}|${time}`;
    const existing = grouped.get(key) ?? { side: fill.side, time, quantity: 0, notional: 0, count: 0 };
    existing.quantity += fill.quantity;
    existing.notional += fill.quantity * fill.price;
    existing.count += 1;
    grouped.set(key, existing);
  }

  return Array.from(grouped.values())
    .map((group) => {
      const isBuy = group.side === "buy";
      const averagePrice = group.notional / Math.max(group.quantity, 1e-9);
      const countLabel = group.count > 1 ? ` x${group.count}` : "";
      return {
        time: group.time,
        position: isBuy ? "belowBar" : "aboveBar",
        color: isBuy ? "#38c172" : "#e45649",
        shape: isBuy ? "arrowUp" : "arrowDown",
        text: `${isBuy ? "Buy" : "Sell"}${countLabel} ${group.quantity.toFixed(2)} @ ${averagePrice.toFixed(2)}`,
      } satisfies ChartMarker;
    })
    .sort((a, b) => Number(a.time) - Number(b.time));
}

function heikinAshiCandles(candles: DisplayCandle[]): DisplayCandle[] {
  let previousOpen = candles[0] ? (candles[0].open + candles[0].close) / 2 : 0;
  let previousClose = candles[0] ? (candles[0].open + candles[0].high + candles[0].low + candles[0].close) / 4 : 0;
  return candles.map((candle, index) => {
    const close = (candle.open + candle.high + candle.low + candle.close) / 4;
    const open = index === 0 ? (candle.open + candle.close) / 2 : (previousOpen + previousClose) / 2;
    const high = Math.max(candle.high, open, close);
    const low = Math.min(candle.low, open, close);
    previousOpen = open;
    previousClose = close;
    return { ...candle, open, high, low, close };
  });
}

function ReplayChart({
  candles,
  indicators,
  markers,
  drawings = [],
  alerts = [],
  trailingStop,
  chartSettings,
  visibleBars,
  lowerPanelHeight,
  visibleRangeAnchor = "end",
  visibleStartTime,
  visibleEndTime,
  followMode = "auto",
  onToolPoint,
}: {
  candles: DisplayCandle[];
  indicators: ComputedChartData;
  markers: ChartMarker[];
  drawings?: ChartDrawing[];
  alerts?: PriceAlert[];
  trailingStop?: TrailingStopState;
  chartSettings: ChartTemplate["chart"];
  visibleBars: number;
  lowerPanelHeight: number;
  visibleRangeAnchor?: "start" | "end";
  visibleStartTime?: Time;
  visibleEndTime?: Time;
  followMode?: ChartFollowMode;
  onToolPoint?: (point: ChartToolPoint) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const mainLineSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const indicatorSeriesRef = useRef<Map<string, ISeriesApi<"Line">>>(new Map());
  const drawingSeriesRef = useRef<Map<string, ISeriesApi<"Line">>>(new Map());
  const onToolPointRef = useRef(onToolPoint);
  const [sharedLowerHover, setSharedLowerHover] = useState<SharedLowerHover | null>(null);
  const [priceCrosshair, setPriceCrosshair] = useState<PriceCrosshair | null>(null);
  const autoFollowRef = useRef(true);
  const applyingRangeRef = useRef(false);
  const lowerRows = useMemo(() => lowerIndicatorRows(indicators.lowerSeries), [indicators.lowerSeries]);
  const lowerTimeline = useMemo(() => buildLowerTimeline(candles, visibleBars, visibleStartTime, visibleEndTime), [candles, visibleBars, visibleStartTime, visibleEndTime]);
  useEffect(() => {
    onToolPointRef.current = onToolPoint;
  }, [onToolPoint]);
  const handleSharedHover = useCallback((hover: SharedLowerHover) => {
    setSharedLowerHover(hover);
    if (chartRef.current) {
      const coordinate = chartRef.current.timeScale().timeToCoordinate(hover.time);
      setPriceCrosshair(coordinate === null ? null : { x: coordinate, timeLabel: formatChartTime(hover.time) });
    }
  }, []);
  const clearSharedHover = useCallback(() => {
    setSharedLowerHover(null);
    setPriceCrosshair(null);
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: chartSettings.backgroundColor },
        textColor: chartSettings.textColor,
      },
      grid: {
        vertLines: { color: chartSettings.gridColor },
        horzLines: { color: chartSettings.gridColor },
      },
      rightPriceScale: {
        borderColor: "#3a342b",
      },
      timeScale: {
        borderColor: "#3a342b",
        timeVisible: true,
        secondsVisible: false,
        barSpacing: 9,
        minBarSpacing: 5,
        rightOffset: 5,
      },
      crosshair: {
        mode: 1,
      },
    });

    const candleSeries = chart.addCandlestickSeries({
      upColor: chartSettings.upColor,
      downColor: chartSettings.downColor,
      borderUpColor: chartSettings.upColor,
      borderDownColor: chartSettings.downColor,
      wickUpColor: chartSettings.wickUpColor,
      wickDownColor: chartSettings.wickDownColor,
    });
    const mainLineSeries = chart.addLineSeries({
      color: chartSettings.lineColor,
      lineWidth: 2,
      priceLineVisible: false,
    });
    const volumeSeries = chart.addHistogramSeries({
      priceFormat: { type: "volume" },
      priceScaleId: "",
      color: "#c89f52",
    });
    volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    mainLineSeriesRef.current = mainLineSeries;
    volumeSeriesRef.current = volumeSeries;

    const resizeObserver = new ResizeObserver(([entry]) => {
      chart.applyOptions({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      });
    });
    resizeObserver.observe(containerRef.current);
    const handleChartCrosshair = (param: MouseEventParams<Time>) => {
      if (!param.time || !param.point) {
        clearSharedHover();
        return;
      }
      const coordinate = chart.timeScale().timeToCoordinate(param.time);
      const panelX = coordinate === null ? 0 : (coordinate / Math.max(containerRef.current?.clientWidth ?? 1, 1)) * 100;
      setSharedLowerHover({ time: param.time, x: 0, panelX });
      setPriceCrosshair(coordinate === null ? null : { x: coordinate, timeLabel: formatChartTime(param.time) });
    };
    chart.subscribeCrosshairMove(handleChartCrosshair);
    const handleChartClick = (param: MouseEventParams<Time>) => {
      if (!param.point || !param.time || !candleSeriesRef.current) return;
      const price = candleSeriesRef.current.coordinateToPrice(param.point.y);
      if (price === null) return;
      onToolPointRef.current?.({ time: param.time, price });
    };
    chart.subscribeClick(handleChartClick);
    const handleVisibleRangeChange = () => {
      if (applyingRangeRef.current) return;
      autoFollowRef.current = false;
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(handleVisibleRangeChange);

    return () => {
      chart.unsubscribeCrosshairMove(handleChartCrosshair);
      chart.unsubscribeClick(handleChartClick);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(handleVisibleRangeChange);
      resizeObserver.disconnect();
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      mainLineSeriesRef.current = null;
      volumeSeriesRef.current = null;
      indicatorSeriesRef.current = new Map();
      drawingSeriesRef.current = new Map();
    };
  }, [chartSettings.backgroundColor, chartSettings.downColor, chartSettings.gridColor, chartSettings.lineColor, chartSettings.textColor, chartSettings.upColor, chartSettings.wickDownColor, chartSettings.wickUpColor, clearSharedHover]);

  useEffect(() => {
    autoFollowRef.current = true;
  }, [candles[0]?.time, followMode, visibleBars, visibleRangeAnchor, visibleStartTime]);

  useEffect(() => {
    if (!chartRef.current || !candleSeriesRef.current || !mainLineSeriesRef.current || !volumeSeriesRef.current) return;
    chartRef.current.applyOptions({
      layout: {
        background: { type: ColorType.Solid, color: chartSettings.backgroundColor },
        textColor: chartSettings.textColor,
      },
      grid: {
        vertLines: { color: chartSettings.gridColor },
        horzLines: { color: chartSettings.gridColor },
      },
    });
    const visibleCandles = chartSettings.candleStyle === "heikin-ashi" ? heikinAshiCandles(candles) : candles;
    const chartCandles: CandlestickData<Time>[] = visibleCandles.map((candle) => ({
      time: candle.time,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
    }));
    const hollow = chartSettings.candleStyle === "hollow";
    candleSeriesRef.current.applyOptions({
      upColor: hollow ? "rgba(0,0,0,0)" : chartSettings.upColor,
      downColor: chartSettings.downColor,
      borderUpColor: chartSettings.upColor,
      borderDownColor: chartSettings.downColor,
      wickUpColor: chartSettings.wickUpColor,
      wickDownColor: chartSettings.wickDownColor,
    });
    candleSeriesRef.current.setData(chartSettings.candleStyle === "line" ? [] : chartCandles);
    mainLineSeriesRef.current.applyOptions({ color: chartSettings.lineColor, lineWidth: 2 });
    mainLineSeriesRef.current.setData(chartSettings.candleStyle === "line" ? candles.map((candle) => ({ time: candle.time, value: candle.close })) : []);

    const volumeData: HistogramData<Time>[] = candles.map((candle) => ({
      time: candle.time,
      value: chartSettings.showVolume ? candle.volume : 0,
      color: candle.close >= candle.open ? chartSettings.volumeUpColor : chartSettings.volumeDownColor,
    }));
    volumeSeriesRef.current.setData(volumeData);
    candleSeriesRef.current.setMarkers(markers);

    const activeIds = new Set(indicators.priceSeries.map((series) => series.id));
    for (const [id, lineSeries] of indicatorSeriesRef.current.entries()) {
      if (!activeIds.has(id)) {
        chartRef.current.removeSeries(lineSeries);
        indicatorSeriesRef.current.delete(id);
      }
    }
    for (const series of indicators.priceSeries) {
      let lineSeries = indicatorSeriesRef.current.get(series.id);
      if (!lineSeries) {
        lineSeries = chartRef.current.addLineSeries({
          color: series.color,
          lineWidth: series.lineWidth,
          priceLineVisible: false,
          lastValueVisible: false,
        });
        indicatorSeriesRef.current.set(series.id, lineSeries);
      }
      lineSeries.applyOptions({ color: series.color, lineWidth: series.lineWidth });
      lineSeries.setData(series.data);
    }
    const firstTime = candles[0]?.time;
    const lastTime = candles[candles.length - 1]?.time;
    const overlaySeries: Array<{ id: string; color: string; lineWidth: 1 | 2 | 3; data: LineData[] }> = [];
    if (firstTime !== undefined && lastTime !== undefined) {
      drawings.forEach((drawing) => {
        if (drawing.type === "trendline" && drawing.points.length >= 2) {
          overlaySeries.push({
            id: drawing.id,
            color: drawing.color,
            lineWidth: 2,
            data: [
              { time: drawing.points[0].time, value: drawing.points[0].price },
              { time: drawing.points[1].time, value: drawing.points[1].price },
            ],
          });
        } else if (drawing.type === "level" && drawing.points[0]) {
          overlaySeries.push({
            id: drawing.id,
            color: drawing.color,
            lineWidth: 2,
            data: [
              { time: firstTime, value: drawing.points[0].price },
              { time: lastTime, value: drawing.points[0].price },
            ],
          });
        }
      });
      alerts.forEach((alert) => {
        overlaySeries.push({
          id: alert.id,
          color: alert.triggered ? "#afa697" : "#f2c94c",
          lineWidth: 1,
          data: [
            { time: firstTime, value: alert.price },
            { time: lastTime, value: alert.price },
          ],
        });
      });
      if (trailingStop?.enabled && trailingStop.stopPrice !== null) {
        overlaySeries.push({
          id: "trailing-stop",
          color: "#ff867c",
          lineWidth: 2,
          data: [
            { time: firstTime, value: trailingStop.stopPrice },
            { time: lastTime, value: trailingStop.stopPrice },
          ],
        });
      }
    }
    const overlayIds = new Set(overlaySeries.map((series) => series.id));
    for (const [id, lineSeries] of drawingSeriesRef.current.entries()) {
      if (!overlayIds.has(id)) {
        chartRef.current.removeSeries(lineSeries);
        drawingSeriesRef.current.delete(id);
      }
    }
    for (const series of overlaySeries) {
      let lineSeries = drawingSeriesRef.current.get(series.id);
      if (!lineSeries) {
        lineSeries = chartRef.current.addLineSeries({
          color: series.color,
          lineWidth: series.lineWidth,
          priceLineVisible: false,
          lastValueVisible: false,
        });
        drawingSeriesRef.current.set(series.id, lineSeries);
      }
      lineSeries.applyOptions({ color: series.color, lineWidth: series.lineWidth });
      lineSeries.setData(series.data);
    }
    if (candles.length && (followMode === "fixed" || autoFollowRef.current)) {
      const bars = Math.max(20, Math.min(500, visibleBars));
      const startIndex = visibleStartTime === undefined ? -1 : candles.findIndex((candle) => Number(candle.time) >= Number(visibleStartTime));
      const endIndex = indexAtOrBeforeTime(candles, visibleEndTime);
      let nextRange: { from: number; to: number };
      if (startIndex >= 0) {
        nextRange = { from: startIndex, to: Math.min(candles.length + 5, startIndex + bars) };
      } else if (endIndex >= 0) {
        nextRange = { from: Math.max(0, endIndex - bars + 1), to: endIndex + 6 };
      } else if (visibleRangeAnchor === "start") {
        nextRange = { from: 0, to: Math.min(candles.length + 5, bars) };
      } else {
        const to = Math.max(bars, candles.length + 5);
        nextRange = { from: to - bars, to };
      }
      applyingRangeRef.current = true;
      chartRef.current.timeScale().setVisibleLogicalRange(nextRange);
      window.setTimeout(() => {
        applyingRangeRef.current = false;
      }, 80);
    }
  }, [alerts, candles, drawings, indicators, markers, chartSettings, trailingStop, visibleBars, visibleRangeAnchor, visibleStartTime, visibleEndTime, followMode]);

  return (
    <div className="chart-stack">
      <div className="chart-surface-shell">
        <div className="chart-surface" ref={containerRef} />
        {priceCrosshair && (
          <>
            <div className="price-sync-crosshair" style={{ left: `${priceCrosshair.x}px` }} />
            <span className="price-sync-time" style={{ left: `${priceCrosshair.x}px` }}>{priceCrosshair.timeLabel}</span>
          </>
        )}
      </div>
      {lowerRows.length > 0 && (
        <div className="lower-indicators" style={{ ["--lower-panel-height" as string]: `${Math.max(44, Math.min(180, lowerPanelHeight))}px` }}>
          {lowerRows.map((row) => (
            <div className="lower-indicator-row" key={`lower-row-${row.row}`} style={{ gridTemplateColumns: `repeat(${row.series.length}, minmax(0, 1fr))` }}>
              {row.series.map((series) => (
                <LowerIndicatorPanel
                  series={series}
                  timeline={lowerTimeline}
                  sharedHover={sharedLowerHover}
                  onSharedHover={handleSharedHover}
                  onClearSharedHover={clearSharedHover}
                  key={series.id}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" | "warn" }) {
  return (
    <div className={`metric ${tone ?? ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function AnalyticsBars({ rows, emptyLabel }: { rows: Array<{ label: string; value: number; detail?: string }>; emptyLabel: string }) {
  const max = Math.max(...rows.map((row) => row.value), 1);
  if (!rows.length) return <div className="empty-state" data-active="true">{emptyLabel}</div>;
  return (
    <div className="analytics-bars">
      {rows.map((row) => (
        <div className="analytics-bar-row" key={row.label}>
          <div className="analytics-bar-label">
            <strong>{row.label}</strong>
            {row.detail && <span>{row.detail}</span>}
          </div>
          <div className="analytics-bar-track" aria-hidden="true">
            <span style={{ width: `${Math.max(3, (row.value / max) * 100)}%` }} />
          </div>
          <b>{compactNumber(row.value)}</b>
        </div>
      ))}
    </div>
  );
}

type SetupSelectChoice<T extends string | number | null> = {
  value: T;
  label: string;
  detail?: string;
  enabled?: boolean;
};

function SetupSelector<T extends string | number | null>({
  title,
  icon,
  value,
  valueLabel,
  valueDetail,
  actionLabel,
  choices,
  open,
  onToggle,
  onSelect,
}: {
  title: string;
  icon: ReactNode;
  value: T;
  valueLabel: string;
  valueDetail?: string;
  actionLabel: string;
  choices: Array<SetupSelectChoice<T>>;
  open: boolean;
  onToggle: () => void;
  onSelect: (value: T) => void;
}) {
  return (
    <section className={`setup-control-card setup-selector-card ${open ? "open" : ""}`}>
      <div className="setup-card-title">
        {icon}
        <div>
          <h3>{title}</h3>
        </div>
      </div>
      <div className="setup-selector-current">
        <div className="setup-selector-value">
          <strong>{valueLabel}</strong>
          {valueDetail && <small>{valueDetail}</small>}
        </div>
        <button type="button" className="ghost setup-selector-action" onClick={onToggle}>
          {actionLabel}
        </button>
      </div>
      {open && (
        <div className="setup-select-popover" role="listbox" aria-label={title}>
          {choices.map((choice) => (
            <button
              type="button"
              key={`${choice.value ?? "random"}`}
              disabled={choice.enabled === false}
              className={`setup-select-option ${choice.value === value ? "selected" : ""}`}
              onClick={() => onSelect(choice.value)}
            >
              <strong>{choice.label}</strong>
              {choice.detail && <small>{choice.detail}</small>}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function Level2Panel({ book }: { book: SyntheticOrderBook | null }) {
  const maxSize = Math.max(book?.totalBidSize ?? 1, book?.totalAskSize ?? 1, 1);
  return (
    <section className="level2-panel" aria-label="Synthetic Level 2 order book">
      <div className="level2-header">
        <h3>Level 2</h3>
        <span>{book ? `${Math.round(book.imbalance * 100)}% bid` : "Waiting"}</span>
      </div>
      <div className="quote-strip">
        <div className="quote-cell bid">
          <span>Bid</span>
          <strong>{book ? book.bid.toFixed(2) : "--"}</strong>
        </div>
        <div className="quote-cell spread">
          <span>Spread</span>
          <strong>{book ? book.spread.toFixed(2) : "--"}</strong>
        </div>
        <div className="quote-cell ask">
          <span>Ask</span>
          <strong>{book ? book.ask.toFixed(2) : "--"}</strong>
        </div>
      </div>
      <div className="book-grid">
        <div className="book-side asks">
          <div className="book-heading">
            <span>Ask</span>
            <span>Size</span>
          </div>
          {(book?.asks ?? []).slice(0, 10).reverse().map((level) => (
            <div className="book-row" key={`ask-${level.price}`}>
              <span>{level.price.toFixed(2)}</span>
              <strong>{Math.round(level.size).toLocaleString()}</strong>
              <div className="depth-bar" style={{ width: `${clamp((level.size / maxSize) * 100, 4, 100)}%` }} />
            </div>
          ))}
        </div>
        <div className="book-mid">
          {book ? `${book.bid.toFixed(2)} x ${book.ask.toFixed(2)}` : "No book"}
        </div>
        <div className="book-side bids">
          <div className="book-heading">
            <span>Bid</span>
            <span>Size</span>
          </div>
          {(book?.bids ?? []).slice(0, 10).map((level) => (
            <div className="book-row" key={`bid-${level.price}`}>
              <span>{level.price.toFixed(2)}</span>
              <strong>{Math.round(level.size).toLocaleString()}</strong>
              <div className="depth-bar" style={{ width: `${clamp((level.size / maxSize) * 100, 4, 100)}%` }} />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function App() {
  const [view, setView] = useState<View>("login");
  const [options, setOptions] = useState<OptionsPayload | null>(null);
  const [error, setError] = useState<string>("");
  const [analyticsDashboard, setAnalyticsDashboard] = useState<AnalyticsDashboard | null>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [accounts, setAccounts] = useState<UserAccount[]>(() => loadAccounts());
  const [currentUser, setCurrentUser] = useState<UserAccount>(() => loadCurrentUser());
  const [loginForm, setLoginForm] = useState(() => ({ username: DEFAULT_ACCOUNT.username, password: DEFAULT_ACCOUNT.password, displayName: "Trader 1" }));
  const [loginNotice, setLoginNotice] = useState("");
  const [loginShaking, setLoginShaking] = useState(false);
  const [loginPasswordVisible, setLoginPasswordVisible] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"controls" | "audio" | "display">("controls");
  const [scoreboardTab, setScoreboardTab] = useState<"personal" | "global" | "replays">("personal");
  const [globalScoreWindow, setGlobalScoreWindow] = useState<"31d" | "252d">("31d");
  const [scoreMetric, setScoreMetric] = useState("score");
  const [scoreboardDashboard, setScoreboardDashboard] = useState<ScoreboardDashboard | null>(null);
  const [analyticsTab, setAnalyticsTab] = useState<"usage" | "server">("usage");
  const [tooltipText, setTooltipText] = useState("");
  const [tooltipVisible, setTooltipVisible] = useState(false);
  const [settingsSavedLabel, setSettingsSavedLabel] = useState("Saved Locally");
  const [settings, setSettings] = useState<SettingsState>(() => loadSettings(currentUser.username));
  const [history, setHistory] = useState<Scorecard[]>(() => loadHistory(currentUser.username));
  const [authLoading, setAuthLoading] = useState(true);
  const [profileReady, setProfileReady] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [chartTemplates, setChartTemplates] = useState<ChartTemplate[]>(() => loadChartTemplates(currentUser.username));
  const [activeTemplateId, setActiveTemplateId] = useState<string>(() => {
    const templates = loadChartTemplates(currentUser.username);
    return loadActiveChartTemplateId(currentUser.username, templates);
  });
  const [speedMenuOpen, setSpeedMenuOpen] = useState(false);
  const [addIndicatorOpen, setAddIndicatorOpen] = useState(false);
  const [chartSetupMode, setChartSetupMode] = useState<"appearance" | "indicators">(() => loadChartSetupUi(currentUser.username).mode);
  const [chartSetupZone, setChartSetupZone] = useState<ChartSetupZone>(() => loadChartSetupUi(currentUser.username).zone);
  const [expandedIndicatorIds, setExpandedIndicatorIds] = useState<Set<string>>(() => new Set());
  const [openSetupPicker, setOpenSetupPicker] = useState<SetupPickerId | null>(null);
  const [chartPreviewSession, setChartPreviewSession] = useState<StartSessionResponse | null>(null);
  const [chartPreviewTicks, setChartPreviewTicks] = useState<ReplayTick[]>([]);
  const [chartPreviewContextCandles, setChartPreviewContextCandles] = useState<DisplayCandle[]>([]);
  const [chartPreviewLoading, setChartPreviewLoading] = useState(false);
  const [activeControllerBind, setActiveControllerBind] = useState<string | null>(null);
  const [virtualCursor, setVirtualCursor] = useState<VirtualCursorState>(() => ({
    x: window.innerWidth / 2,
    y: window.innerHeight / 2,
    visible: false,
    pressed: false,
  }));
  const [setup, setSetup] = useState<SetupState>(() => loadSetup(currentUser.username, settings));

  const [activeSession, setActiveSession] = useState<StartSessionResponse | null>(null);
  const [sessionPositionSizes, setSessionPositionSizes] = useState(() => positionSizesForCapital(DEFAULT_SETTINGS.defaultStartingCapital, "1/5"));
  const [ticks, setTicks] = useState<ReplayTick[]>([]);
  const [contextCandles, setContextCandles] = useState<DisplayCandle[]>([]);
  const [currentTickIndex, setCurrentTickIndex] = useState(-1);
  const [paused, setPaused] = useState(false);
  const [currentSpeed, setCurrentSpeed] = useState<ReplaySpeed>("3x Speed");
  const [smoothedOrderBook, setSmoothedOrderBook] = useState<SyntheticOrderBook | null>(null);
  const [chartTimeframe, setChartTimeframe] = useState<Timeframe>("1m");
  const [cash, setCash] = useState(100_000);
  const [shares, setShares] = useState(0);
  const [avgCost, setAvgCost] = useState(0);
  const [realizedPnl, setRealizedPnl] = useState(0);
  const [fills, setFills] = useState<TradeFill[]>([]);
  const [score, setScore] = useState<Scorecard | null>(null);
  const [chartToolMode, setChartToolMode] = useState<ChartToolMode>("cursor");
  const [pendingTrendlinePoint, setPendingTrendlinePoint] = useState<ChartToolPoint | null>(null);
  const [chartDrawings, setChartDrawings] = useState<ChartDrawing[]>([]);
  const [priceAlerts, setPriceAlerts] = useState<PriceAlert[]>([]);
  const [trailingStop, setTrailingStop] = useState<TrailingStopState>(() => ({
    enabled: false,
    autoArm: false,
    percent: 1,
    highWater: 0,
    stopPrice: null,
  }));
  const cursorRef = useRef<VirtualCursorState>(virtualCursor);
  const hoveredElementRef = useRef<Element | null>(null);
  const profileImportInputRef = useRef<HTMLInputElement | null>(null);
  const loginNoticeTimeoutRef = useRef<number | null>(null);
  const loginShakeTimeoutRef = useRef<number | null>(null);
  const tooltipElementRef = useRef<HTMLDivElement | null>(null);
  const tooltipTargetRef = useRef<HTMLElement | null>(null);
  const tooltipTextRef = useRef("");
  const tooltipVisibleRef = useRef(false);
  const analyticsVisitorRef = useRef(analyticsVisitorId());
  const analyticsVisitRef = useRef(analyticsVisitId());

  const applyProfilePayload = useCallback((profile: Partial<ServerProfilePayload>, username: string) => {
    const nextSettings = normalizeSettingsState(profile.settings ?? {});
    const nextSetup = normalizeSetupState(profile.setup ?? {}, nextSettings);
    const nextChartUi = normalizeChartSetupUiState(profile.chartSetupUi ?? {});
    const nextTemplates = normalizeTemplates(Array.isArray(profile.chartTemplates) ? profile.chartTemplates as ChartTemplate[] : [builtInChartTemplate()]);
    const nextActiveTemplateId = typeof profile.activeTemplateId === "string" && nextTemplates.some((template) => template.id === profile.activeTemplateId)
      ? profile.activeTemplateId
      : loadActiveChartTemplateId(username, nextTemplates);
    const nextHistory = Array.isArray(profile.history) ? profile.history.filter((item) => item.hardcore === true) as Scorecard[] : [];

    setSettings(nextSettings);
    setSetup(nextSetup);
    setChartSetupMode(nextChartUi.mode);
    setChartSetupZone(nextChartUi.zone);
    setChartTemplates(nextTemplates);
    setActiveTemplateId(nextActiveTemplateId);
    setHistory(nextHistory);

    saveSettings(nextSettings, username);
    saveSetup(nextSetup, username);
    saveChartSetupUi(nextChartUi, username);
    saveChartTemplates(nextTemplates, username);
    saveActiveChartTemplateId(username, nextActiveTemplateId);
    saveHistory(nextHistory, username);
  }, []);

  const flashLoginNotice = useCallback((message: string, options: { shake?: boolean; duration?: number } = {}) => {
    if (loginNoticeTimeoutRef.current !== null) window.clearTimeout(loginNoticeTimeoutRef.current);
    if (loginShakeTimeoutRef.current !== null) window.clearTimeout(loginShakeTimeoutRef.current);
    setLoginNotice(message);
    if (options.shake) {
      setLoginShaking(false);
      window.setTimeout(() => setLoginShaking(true), 0);
      loginShakeTimeoutRef.current = window.setTimeout(() => setLoginShaking(false), 420);
    }
    loginNoticeTimeoutRef.current = window.setTimeout(() => setLoginNotice(""), options.duration ?? 1000);
  }, []);

  useEffect(() => () => {
    if (loginNoticeTimeoutRef.current !== null) window.clearTimeout(loginNoticeTimeoutRef.current);
    if (loginShakeTimeoutRef.current !== null) window.clearTimeout(loginShakeTimeoutRef.current);
  }, []);

  const trackAnalyticsEvent = useCallback((eventName: string, payload: Record<string, unknown> = {}, path = analyticsPathForView(view)) => {
    void api<{ ok: boolean }>("/api/analytics/event", {
      method: "POST",
      body: JSON.stringify({
        visitorId: analyticsVisitorRef.current,
        visitId: analyticsVisitRef.current,
        eventName,
        path,
        payload,
      }),
    }).catch(() => {
      // Analytics should never interrupt gameplay or account flows.
    });
  }, [view]);

  useEffect(() => {
    void api<{ ok: boolean }>("/api/analytics/visit", {
      method: "POST",
      body: JSON.stringify({
        visitorId: analyticsVisitorRef.current,
        visitId: analyticsVisitRef.current,
        path: window.location.pathname || "/",
        referrer: document.referrer || "",
      }),
    }).catch(() => {
      // Analytics should never block app startup.
    });
  }, []);

  useEffect(() => {
    trackAnalyticsEvent("page_view", { view }, analyticsPathForView(view));
  }, [trackAnalyticsEvent, view]);

  const refreshAnalyticsDashboard = useCallback(async () => {
    setAnalyticsLoading(true);
    setError("");
    try {
      setAnalyticsDashboard(await api<AnalyticsDashboard>("/api/analytics/dashboard"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load analytics dashboard");
    } finally {
      setAnalyticsLoading(false);
    }
  }, []);

  const refreshScoreboardDashboard = useCallback(async () => {
    try {
      setScoreboardDashboard(await api<ScoreboardDashboard>("/api/scoreboard"));
    } catch {
      setScoreboardDashboard(null);
    }
  }, []);

  const saveReplay = useCallback(async (scoreId: string) => {
    setScoreboardDashboard(await api<ScoreboardDashboard>(`/api/replays/${scoreId}/save`, { method: "POST" }));
  }, []);

  const deleteReplay = useCallback(async (scoreId: string) => {
    setScoreboardDashboard(await api<ScoreboardDashboard>(`/api/replays/${scoreId}`, { method: "DELETE" }));
  }, []);

  useEffect(() => {
    if (view === "analytics" && isAdmin) void refreshAnalyticsDashboard();
  }, [isAdmin, refreshAnalyticsDashboard, view]);

  useEffect(() => {
    if (view === "history" && !authLoading) void refreshScoreboardDashboard();
  }, [authLoading, refreshScoreboardDashboard, view]);

  useEffect(() => {
    if (view === "analytics" && !isAdmin && !authLoading) setView("menu");
  }, [authLoading, isAdmin, view]);

  const buildProfilePayload = useCallback((): ServerProfilePayload => ({
    version: USER_PROFILE_VERSION,
    username: currentUser.username,
    settings,
    setup,
    chartSetupUi: { mode: chartSetupMode, zone: chartSetupZone },
    chartTemplates: normalizeTemplates(chartTemplates),
    activeTemplateId,
    history: [],
  }), [activeTemplateId, chartSetupMode, chartSetupZone, chartTemplates, currentUser.username, settings, setup]);

  useEffect(() => {
    let cancelled = false;
    async function loadAuthenticatedProfile() {
      try {
        const me = await api<AuthResponse>("/api/auth/me");
        const profile = await api<ServerProfilePayload>("/api/me/profile");
        if (cancelled) return;
        const username = me.user.username;
        setCurrentUser({ username, password: "" });
        setLoginForm({ username, password: "", displayName: me.user.displayName ?? username });
        setIsAdmin(Boolean(me.user.isAdmin));
        localStorage.setItem(CURRENT_USER_STORAGE_KEY, username);
        applyProfilePayload(profile, username);
        setView("menu");
        setProfileReady(true);
      } catch {
        if (!cancelled) {
          setProfileReady(false);
          setView("login");
        }
      } finally {
        if (!cancelled) setAuthLoading(false);
      }
    }
    void loadAuthenticatedProfile();
    return () => {
      cancelled = true;
    };
  }, [applyProfilePayload]);

  useEffect(() => {
    api<OptionsPayload>("/api/sessions/options")
      .then((payload) => {
        setOptions(payload);
        setSetup((previous) => normalizeSetupState(previous, settings));
      })
      .catch((err: Error) => setError(err.message));
  }, []);

  useEffect(() => {
    saveSettings(settings, currentUser.username);
    setSettingsSavedLabel("Saved Locally");
  }, [currentUser.username, settings]);

  useEffect(() => {
    saveChartTemplates(chartTemplates, currentUser.username);
  }, [chartTemplates, currentUser.username]);

  useEffect(() => {
    saveActiveChartTemplateId(currentUser.username, activeTemplateId);
  }, [activeTemplateId, currentUser.username]);

  useEffect(() => {
    saveSetup(setup, currentUser.username);
  }, [currentUser.username, setup]);

  useEffect(() => {
    saveChartSetupUi({ mode: chartSetupMode, zone: chartSetupZone }, currentUser.username);
  }, [chartSetupMode, chartSetupZone, currentUser.username]);

  useEffect(() => {
    if (!profileReady || authLoading) return;
    const timeout = window.setTimeout(() => {
      api<ServerProfilePayload>("/api/me/profile", {
        method: "PUT",
        body: JSON.stringify(buildProfilePayload()),
      })
        .then(() => setSettingsSavedLabel("Saved"))
        .catch(() => setSettingsSavedLabel("Local Only"));
    }, 600);
    return () => window.clearTimeout(timeout);
  }, [authLoading, buildProfilePayload, profileReady]);

  useEffect(() => {
    if (!chartTemplates.some((template) => template.id === activeTemplateId)) {
      setActiveTemplateId(defaultTemplateId(chartTemplates));
    }
  }, [activeTemplateId, chartTemplates]);

  useEffect(() => {
    cursorRef.current = virtualCursor;
  }, [virtualCursor]);

  useEffect(() => {
    document.body.classList.toggle("controller-cursor-active", virtualCursor.visible);
    return () => document.body.classList.remove("controller-cursor-active");
  }, [virtualCursor.visible]);

  const currentTick = currentTickIndex >= 0 ? ticks[currentTickIndex] : undefined;
  const hardcorePauseLocked = Boolean(activeSession?.hardcore && paused);
  const activeTemplate = chartTemplates.find((template) => template.id === activeTemplateId) ?? chartTemplates[0] ?? builtInChartTemplate();
  const chartZoneCount = activeTemplate.indicators.filter((indicator) => indicator.pane === "price" && indicator.enabled).length;
  const lowerRowCounts = useMemo(() => {
    const counts = Array.from({ length: MAX_LOWER_ROWS }, () => 0);
    activeTemplate.indicators.forEach((indicator) => {
      if (indicator.pane === "lower" && indicator.enabled) {
        const row = Math.max(0, Math.min(MAX_LOWER_ROWS - 1, indicator.lowerRow ?? 0));
        counts[row] += 1;
      }
    });
    return counts;
  }, [activeTemplate]);
  const visibleChartSetupIndicators = useMemo(() => (
    activeTemplate.indicators.filter((indicator) => {
      if (chartSetupZone === "chart") return indicator.pane === "price";
      return indicator.pane === "lower" && (indicator.lowerRow ?? 0) === chartSetupZone;
    })
  ), [activeTemplate, chartSetupZone]);
  const currentPrice = currentTick?.price ?? 0;
  const rawOrderBook = useMemo(() => buildSyntheticOrderBook(currentTick), [currentTick]);
  useEffect(() => {
    setSmoothedOrderBook((previous) => blendBookLevelSizes(previous, rawOrderBook));
  }, [rawOrderBook]);
  const orderBook = smoothedOrderBook ?? rawOrderBook;
  const chartPreviewTargetBars = 390;
  const chartPreviewTicksPerCandle = chartPreviewTicks[0]?.ticksInCandle ?? 20;
  const chartPreviewIndex = chartPreviewTicks.length
    ? Math.max(0, Math.min((chartPreviewTargetBars * chartPreviewTicksPerCandle) - 1, chartPreviewTicks.length - 1))
    : -1;
  const chartPreviewTick = chartPreviewIndex >= 0 ? chartPreviewTicks[chartPreviewIndex] : undefined;
  const chartPreviewCandles = useMemo(
    () => mergeContextCandles(chartPreviewContextCandles, buildDisplayCandles(chartPreviewTicks.slice(0, chartPreviewIndex + 1), "1m")),
    [chartPreviewContextCandles, chartPreviewIndex, chartPreviewTicks],
  );
  const chartPreviewVisibleStart = chartPreviewSession ? chartTimeForClock(chartPreviewSession.date, 9) : undefined;
  const chartPreviewIndicators = useMemo(() => computeIndicators(chartPreviewCandles, activeTemplate), [activeTemplate, chartPreviewCandles]);
  const chartPreviewBook = useMemo(() => buildSyntheticOrderBook(chartPreviewTick), [chartPreviewTick]);
  const unrealizedPnl = shares > 0 && currentPrice > 0 ? (currentPrice - avgCost) * shares : 0;
  const equity = cash + shares * currentPrice;
  const setupPositionSizes = useMemo(() => positionSizesForCapital(setup.startingCapital, setup.positionSizing), [setup.positionSizing, setup.startingCapital]);
  const displayCandles = useMemo(
    () => mergeContextCandles(contextCandles, buildDisplayCandles(ticks.slice(0, currentTickIndex + 1), chartTimeframe)),
    [contextCandles, ticks, currentTickIndex, chartTimeframe],
  );
  const displayEndTime = displayCandles[displayCandles.length - 1]?.time;
  const indicatorData = useMemo(() => computeIndicators(displayCandles, activeTemplate), [displayCandles, activeTemplate]);
  const tradeMarkers = useMemo(() => buildTradeMarkers(fills, ticks, chartTimeframe), [fills, ticks, chartTimeframe]);

  const availableForSetup = useMemo(() => {
    if (!options) return 0;
    const selectedFilters = selectedScenarioFilters(setup.scenarioFilters);
    const matchesAssetFilters = (row: MetadataRow) => (
      (setup.assetClass === "Random" || row.assetClass === setup.assetClass)
      && (setup.asset === "Random" || row.ticker === setup.asset)
    );
    if (!selectedFilters.length) {
      return options.metadata.filter(matchesAssetFilters).length;
    }
    return options.metadata.filter((row) => matchesAssetFilters(row) && selectedFilters.every((filter) => row.scenarioFlags[filter])).length;
  }, [options, setup.asset, setup.assetClass, setup.scenarioFilters]);
  const assetChoicesForSetup = useMemo(() => {
    const assets = options?.assets ?? [];
    return assets.filter((asset) => asset.label === "Random" || setup.assetClass === "Random" || asset.assetClass === setup.assetClass);
  }, [options, setup.assetClass]);
  const assetClassChoicesForSetup = useMemo<Array<SetupSelectChoice<string>>>(() => (
    (options?.assetClasses ?? []).map((item) => ({
      value: item.label,
      label: item.label,
      detail: item.label === "Random" ? "All classes" : undefined,
      enabled: item.enabled,
    }))
  ), [options]);
  const assetSelectChoicesForSetup = useMemo<Array<SetupSelectChoice<string>>>(() => (
    assetChoicesForSetup.map((item) => ({
      value: item.label,
      label: item.label,
      detail: item.label === "Random" ? "Any eligible asset" : item.description ?? item.assetClass,
      enabled: item.enabled,
    }))
  ), [assetChoicesForSetup]);
  const timeframeChoicesForSetup = useMemo<Array<SetupSelectChoice<Timeframe>>>(() => (
    (options?.timeframes ?? []).map((timeframe) => ({ value: timeframe, label: timeframe }))
  ), [options]);
  const startTimeChoicesForSetup = useMemo<Array<SetupSelectChoice<string | null>>>(() => (
    START_TIME_CHOICES
      .filter((choice) => choice.value === null || !options || options.startTimes.includes(choice.value))
      .map((choice) => ({ value: choice.value, label: choice.label, detail: choice.detail }))
  ), [options]);
  const replaySpeedChoicesForSetup = useMemo<Array<SetupSelectChoice<ReplaySpeed>>>(() => (
    (options?.replaySpeeds ?? []).map((speed) => ({
      value: speed.label,
      label: speed.label,
      detail: RANDOM_SESSION_SPEEDS.find((item) => item.speed === speed.label)?.detail,
    }))
  ), [options]);
  const startingCapitalChoicesForSetup = useMemo<Array<SetupSelectChoice<number>>>(() => (
    (options?.startingCapital ?? STARTING_CAPITAL_OPTIONS).map((capital) => ({ value: capital, label: currency(capital) }))
  ), [options]);
  const positionSizingChoicesForSetup = useMemo<Array<SetupSelectChoice<PositionSizingId>>>(() => (
    POSITION_SIZING_OPTIONS.map((option) => {
      const sizes = positionSizesForCapital(setup.startingCapital, option.id);
      return {
        value: option.id,
        label: option.label,
        detail: `${wholeCurrency(sizes.small)} / ${wholeCurrency(sizes.large)}`,
      };
    })
  ), [setup.startingCapital]);

  useEffect(() => {
    if (setup.asset === "Random") return;
    const selectedAsset = options?.assets.find((asset) => asset.label === setup.asset);
    if (selectedAsset && setup.assetClass !== "Random" && selectedAsset.assetClass !== setup.assetClass) {
      setSetup((previous) => ({ ...previous, asset: "Random" }));
    }
  }, [options, setup.asset, setup.assetClass]);

  useEffect(() => {
    if (view !== "setup") setOpenSetupPicker(null);
  }, [view]);

  const stepReplay = useCallback(() => {
    setCurrentTickIndex((index) => Math.min(index + 1, ticks.length - 1));
  }, [ticks.length]);

  useEffect(() => {
    const delay = SPEED_MS[currentSpeed];
    if (view !== "play" || paused || delay === null || !ticks.length || currentTickIndex >= ticks.length - 1) return;
    const timer = window.setTimeout(stepReplay, delay);
    return () => window.clearTimeout(timer);
  }, [view, paused, currentSpeed, ticks.length, currentTickIndex, stepReplay]);

  const resetAccount = useCallback((startingCapital: number) => {
    setCash(startingCapital);
    setShares(0);
    setAvgCost(0);
    setRealizedPnl(0);
    setFills([]);
    setScore(null);
    setChartToolMode("cursor");
    setPendingTrendlinePoint(null);
    setChartDrawings([]);
    setPriceAlerts([]);
    setTrailingStop((previous) => ({ ...previous, enabled: false, highWater: 0, stopPrice: null }));
  }, []);

  const loadChartSetupPreview = useCallback(async () => {
    if (chartPreviewLoading) return;
    setChartPreviewLoading(true);
    setError("");
    try {
      const session = await api<StartSessionResponse>("/api/sessions/start", {
        method: "POST",
        body: JSON.stringify({
          assetClass: "Equity",
          asset: "SPY",
          scenario: "Random",
          timeframe: "1m",
          startingCapital: settings.defaultStartingCapital,
          replaySpeed: settings.defaultReplaySpeed,
          startTime: "09:28",
          hardcore: false,
        }),
      });
      const replay = await api<{ sessionId: string; ticks: ReplayTick[] }>(`/api/sessions/${session.sessionId}/replay`);
      const candles = await api<CandlesResponse>(`/api/sessions/${session.sessionId}/candles?timeframe=1m`);
      setChartPreviewSession(session);
      setChartPreviewTicks(replay.ticks);
      setChartPreviewContextCandles(payloadCandlesToDisplay(candles.candles));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load chart setup preview");
      setChartPreviewSession(null);
      setChartPreviewTicks([]);
      setChartPreviewContextCandles([]);
    } finally {
      setChartPreviewLoading(false);
    }
  }, [chartPreviewLoading, settings.defaultReplaySpeed, settings.defaultStartingCapital]);

  useEffect(() => {
    if (view === "chartSetup" && !chartPreviewTicks.length && !chartPreviewLoading) {
      void loadChartSetupPreview();
    }
  }, [chartPreviewLoading, chartPreviewTicks.length, loadChartSetupPreview, view]);

  useEffect(() => {
    if (!activeSession || view !== "play") return;
    let cancelled = false;
    api<CandlesResponse>(`/api/sessions/${activeSession.sessionId}/candles?timeframe=${chartTimeframe}`)
      .then((response) => {
        if (!cancelled) setContextCandles(payloadCandlesToDisplay(response.candles));
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [activeSession, chartTimeframe, view]);

  const beginSession = useCallback(
    async (mode: "standard" | "practice", speedOverride?: ReplaySpeed) => {
      setError("");
      if (!options) return;
      const request = {
        assetClass: mode === "standard" ? "Random" : setup.assetClass,
        asset: mode === "standard" ? "Random" : setup.asset,
        scenario: "Random",
        scenarioFilters: mode === "standard" ? DEFAULT_SCENARIO_FILTERS : setup.scenarioFilters,
        timeframe: setup.timeframe,
        startTime: mode === "practice" ? setup.startTime : null,
        startingCapital: setup.startingCapital,
        replaySpeed: speedOverride ?? setup.replaySpeed,
        hardcore: setup.hardcore,
      };

      try {
        const session = await api<StartSessionResponse>("/api/sessions/start", {
          method: "POST",
          body: JSON.stringify(request),
        });
        const replay = await api<{ sessionId: string; ticks: ReplayTick[] }>(`/api/sessions/${session.sessionId}/replay`);
        const candles = await api<CandlesResponse>(`/api/sessions/${session.sessionId}/candles?timeframe=${session.timeframe}`);
        setActiveSession(session);
        setTicks(replay.ticks);
        setContextCandles(payloadCandlesToDisplay(candles.candles));
        setCurrentTickIndex(Math.max(0, Math.min(session.startTickIndex, replay.ticks.length - 1)));
        setSmoothedOrderBook(null);
        setPaused(true);
        setCurrentSpeed(session.replaySpeed);
        setChartTimeframe(session.timeframe);
        setActiveTemplateId(defaultTemplateId(chartTemplates));
        setSessionPositionSizes(positionSizesForCapital(session.startingCapital, setup.positionSizing));
        resetAccount(session.startingCapital);
        setSpeedMenuOpen(false);
        trackAnalyticsEvent("session_started", {
          mode,
          scenario: scenarioFilterSummary(request.scenarioFilters),
          assetClass: request.assetClass,
          asset: request.asset,
          timeframe: request.timeframe,
          replaySpeed: request.replaySpeed,
          startingCapital: request.startingCapital,
          hardcore: request.hardcore,
          startTime: request.startTime ?? "random",
        }, "/app/play");
        setView("play");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unable to start session");
      }
    },
    [chartTemplates, options, resetAccount, setup, trackAnalyticsEvent],
  );

  const changeSpeed = useCallback((direction: -1 | 1) => {
    setCurrentSpeed((speed) => {
      const index = SPEED_ORDER.indexOf(speed);
      const nextIndex = Math.max(0, Math.min(SPEED_ORDER.length - 1, index + direction));
      return SPEED_ORDER[nextIndex];
    });
  }, []);

  const handleChartToolPoint = useCallback((point: ChartToolPoint) => {
    if (chartToolMode === "cursor") return;
    if (hardcorePauseLocked) {
      setError("Hardcore Mode blocks chart edits while paused.");
      return;
    }
    if (chartToolMode === "trendline") {
      if (!pendingTrendlinePoint) {
        setPendingTrendlinePoint(point);
        return;
      }
      setChartDrawings((previous) => [
        ...previous,
        {
          id: crypto.randomUUID(),
          type: "trendline",
          points: [pendingTrendlinePoint, point],
          color: "#f2c94c",
          label: "Trendline",
        },
      ]);
      setPendingTrendlinePoint(null);
      setChartToolMode("cursor");
      return;
    }
    if (chartToolMode === "level") {
      setChartDrawings((previous) => [
        ...previous,
        {
          id: crypto.randomUUID(),
          type: "level",
          points: [point],
          color: point.price <= currentPrice ? "#38c172" : "#e45649",
          label: point.price <= currentPrice ? "Support" : "Resistance",
        },
      ]);
      setChartToolMode("cursor");
      return;
    }
    if (chartToolMode === "alert") {
      setPriceAlerts((previous) => [
        ...previous,
        {
          id: crypto.randomUUID(),
          price: point.price,
          direction: point.price >= currentPrice ? "above" : "below",
          triggered: false,
        },
      ]);
      setChartToolMode("cursor");
    }
  }, [chartToolMode, currentPrice, hardcorePauseLocked, pendingTrendlinePoint]);

  const togglePauseOrStep = useCallback(() => {
    setPaused((value) => !value);
  }, []);

  const addFill = useCallback((fill: Omit<TradeFill, "id">) => {
    setFills((previous) => [{ ...fill, id: crypto.randomUUID() }, ...previous]);
  }, []);

  const buyAmount = useCallback(
    (amount: number) => {
      if (hardcorePauseLocked) {
        setError("Hardcore Mode blocks trading while paused.");
        return;
      }
      if (!currentTick || currentPrice <= 0 || cash <= 0) return;
      const spend = Math.min(amount, cash);
      const requestedQuantity = spend / (orderBook?.ask ?? currentPrice);
      const execution = executeMarketBuyByNotional(spend, orderBook);
      if (!execution) return;
      const adjustedPrice = slippageAdjustedPrice(execution.averagePrice, "buy", orderBook, currentTick);
      const adjustedQuantity = execution.notional / adjustedPrice;
      setAvgCost((previous) => ((previous * shares + execution.notional) / (shares + adjustedQuantity)));
      setShares((previous) => previous + adjustedQuantity);
      setCash((previous) => previous - execution.notional);
      if (adjustedQuantity < requestedQuantity * 0.999) {
        setError(`Adjusted fill: bought ${adjustedQuantity.toFixed(2)} of ${requestedQuantity.toFixed(2)} shares after book depth/slippage.`);
      }
      setTrailingStop((previous) => previous.autoArm ? {
        ...previous,
        enabled: true,
        highWater: Math.max(previous.highWater, currentPrice),
        stopPrice: Math.max(previous.highWater, currentPrice) * (1 - previous.percent / 100),
      } : previous);
      addFill({
        side: "buy",
        quantity: adjustedQuantity,
        price: adjustedPrice,
        tickIndex: currentTick.tickIndex,
        timestamp: currentTick.timestamp,
      });
    },
    [addFill, cash, currentPrice, currentTick, hardcorePauseLocked, orderBook, shares],
  );

  const sellFraction = useCallback(
    (fraction: number) => {
      if (hardcorePauseLocked) {
        setError("Hardcore Mode blocks trading while paused.");
        return;
      }
      if (!currentTick || currentPrice <= 0 || shares <= 0) return;
      const requestedQuantity = fraction >= 1 ? shares : shares * fraction;
      const execution = executeMarketOrder("sell", requestedQuantity, orderBook);
      if (!execution) return;
      const adjustedPrice = slippageAdjustedPrice(execution.averagePrice, "sell", orderBook, currentTick);
      const proceeds = adjustedPrice * execution.quantity;
      const pnl = (adjustedPrice - avgCost) * execution.quantity;
      setCash((previous) => previous + proceeds);
      setShares((previous) => {
        const next = Math.max(0, previous - execution.quantity);
        if (next === 0) {
          setAvgCost(0);
          setTrailingStop((stop) => ({ ...stop, enabled: false, highWater: 0, stopPrice: null }));
        }
        return next;
      });
      setRealizedPnl((previous) => previous + pnl);
      if (execution.quantity < requestedQuantity * 0.999) {
        setError(`Partial fill: sold ${execution.quantity.toFixed(2)} of ${requestedQuantity.toFixed(2)} shares.`);
      }
      addFill({
        side: "sell",
        quantity: execution.quantity,
        price: adjustedPrice,
        tickIndex: currentTick.tickIndex,
        timestamp: currentTick.timestamp,
      });
    },
    [addFill, avgCost, currentPrice, currentTick, hardcorePauseLocked, orderBook, shares],
  );

  useEffect(() => {
    if (view !== "play" || !currentTick || currentPrice <= 0) return;
    setPriceAlerts((previous) => previous.map((alert) => {
      if (alert.triggered) return alert;
      const triggered = alert.direction === "above" ? currentPrice >= alert.price : currentPrice <= alert.price;
      if (!triggered) return alert;
      setError(`Price alert triggered at ${currency(alert.price)}.`);
      return { ...alert, triggered: true };
    }));
  }, [currentPrice, currentTick, view]);

  useEffect(() => {
    if (view !== "play" || currentPrice <= 0) return;
    setTrailingStop((previous) => {
      if (!previous.enabled || shares <= 0) return shares <= 0 ? { ...previous, enabled: false, highWater: 0, stopPrice: null } : previous;
      const highWater = Math.max(previous.highWater || currentPrice, currentPrice);
      return {
        ...previous,
        highWater,
        stopPrice: highWater * (1 - previous.percent / 100),
      };
    });
  }, [currentPrice, shares, view]);

  useEffect(() => {
    if (view !== "play" || paused || !trailingStop.enabled || trailingStop.stopPrice === null || shares <= 0 || currentPrice <= 0) return;
    if (currentPrice <= trailingStop.stopPrice) {
      setError(`Trailing stop triggered at ${currency(trailingStop.stopPrice)}.`);
      void sellFraction(1);
      setTrailingStop((previous) => ({ ...previous, enabled: false, highWater: 0, stopPrice: null }));
    }
  }, [currentPrice, paused, sellFraction, shares, trailingStop.enabled, trailingStop.stopPrice, view]);

  const endSession = useCallback(async () => {
    if (!activeSession) return;
    setPaused(true);
    try {
      const result = await api<Scorecard>(`/api/sessions/${activeSession.sessionId}/score`, {
        method: "POST",
        body: JSON.stringify({
          startingCapital: activeSession.startingCapital,
          trades: fills
            .slice()
            .reverse()
            .map(({ side, quantity, price, tickIndex, timestamp }) => ({ side, quantity, price, tickIndex, timestamp })),
        }),
      });
      const completedScore = { ...result, completedAt: new Date().toISOString() };
      setScore(completedScore);
      trackAnalyticsEvent("session_completed", {
        hardcore: activeSession.hardcore,
        scenario: activeSession.label.scenario,
        ticker: activeSession.ticker,
        timeframe: activeSession.timeframe,
        replaySpeed: activeSession.replaySpeed,
        trades: fills.length,
        returnPct: completedScore.returnPct,
        score: completedScore.score,
      }, "/app/score");
      if (activeSession.hardcore) {
        void refreshScoreboardDashboard();
      }
      setView("score");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to score session");
    }
  }, [activeSession, fills, refreshScoreboardDashboard, trackAnalyticsEvent]);

  const activateVirtualCursorTarget = useCallback(() => {
    const { x, y } = cursorRef.current;
    const rawTarget = document.elementFromPoint(x, y);
    const target = rawTarget?.closest("button, input, select, textarea, a, [role='button']") as HTMLElement | null;
    if (!target) return;
    target.focus();
    target.click();
  }, []);

  const backFromController = useCallback(() => {
    if (view === "menu") return;
    setView("menu");
  }, [view]);

  const controllerAction = useCallback(
    (action: string) => {
      if (action === "buy1000") buyAmount(sessionPositionSizes.small);
      if (action === "buy5000") buyAmount(sessionPositionSizes.large);
      if (action === "sellHalf") sellFraction(0.5);
      if (action === "sellAll") sellFraction(1);
      if (action === "pause") togglePauseOrStep();
      if (action === "speedDown") changeSpeed(-1);
      if (action === "speedUp") changeSpeed(1);
      if (action === "menu") setView("menu");
      if (action === "end") void endSession();
      if (action === "cursorClick") activateVirtualCursorTarget();
      if (action === "cursorBack") backFromController();
    },
    [activateVirtualCursorTarget, backFromController, buyAmount, changeSpeed, endSession, sellFraction, sessionPositionSizes.large, sessionPositionSizes.small, togglePauseOrStep],
  );

  useEffect(() => {
    if (view !== "play") return;

    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName)) return;

      const bindings = settings.keyboard;
      if (keyMatches(event, bindings.buy1000)) {
        event.preventDefault();
        buyAmount(sessionPositionSizes.small);
      } else if (keyMatches(event, bindings.buy5000)) {
        event.preventDefault();
        buyAmount(sessionPositionSizes.large);
      } else if (keyMatches(event, bindings.sellHalf)) {
        event.preventDefault();
        sellFraction(0.5);
      } else if (keyMatches(event, bindings.sellAll)) {
        event.preventDefault();
        sellFraction(1);
      } else if (keyMatches(event, bindings.pause)) {
        event.preventDefault();
        togglePauseOrStep();
      } else if (keyMatches(event, bindings.speedDown)) {
        event.preventDefault();
        changeSpeed(-1);
      } else if (keyMatches(event, bindings.speedUp)) {
        event.preventDefault();
        changeSpeed(1);
      } else if (keyMatches(event, bindings.menu)) {
        event.preventDefault();
        setView("menu");
      } else if (keyMatches(event, bindings.end)) {
        event.preventDefault();
        void endSession();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [buyAmount, changeSpeed, endSession, sellFraction, sessionPositionSizes.large, sessionPositionSizes.small, settings.keyboard, togglePauseOrStep, view]);

  useEffect(() => {
    let frame = 0;
    let lastFrame = performance.now();
    let previousButtons: boolean[] = [];
    if (settings.controllerProfile === "Keyboard") {
      hoveredElementRef.current?.classList.remove("controller-hover");
      hoveredElementRef.current = null;
      setVirtualCursor((previous) => (previous.visible ? { ...previous, visible: false, pressed: false } : previous));
      return;
    }
    const buttonActions: Record<number, string[]> = {};
    Object.entries(settings.controller).forEach(([action, buttonName]) => {
      const buttonIndex = controllerButtonIndex(buttonName);
      if (buttonIndex !== undefined) {
        buttonActions[buttonIndex] = [...(buttonActions[buttonIndex] ?? []), action];
      }
    });

    function syncHover(x: number, y: number) {
      const hoverTarget = document
        .elementFromPoint(x, y)
        ?.closest("button, input, select, textarea, a, [role='button']");
      if (hoverTarget === hoveredElementRef.current) return;
      hoveredElementRef.current?.classList.remove("controller-hover");
      hoverTarget?.classList.add("controller-hover");
      hoveredElementRef.current = hoverTarget ?? null;
    }

    function actionsForView(actions: string[]) {
      if (view === "play") {
        const gameplayActions = actions.filter((action) => action !== "cursorClick" && action !== "cursorBack");
        return gameplayActions.length ? gameplayActions : actions;
      }
      return actions.filter((action) => action === "cursorClick" || action === "cursorBack" || action === "menu");
    }

    function pollGamepad(now: number) {
      const pad = navigator.getGamepads?.().find((candidate) => candidate && candidate.connected);
      const deltaSeconds = Math.min((now - lastFrame) / 1000, 0.05);
      lastFrame = now;

      if (!pad) {
        hoveredElementRef.current?.classList.remove("controller-hover");
        hoveredElementRef.current = null;
        setVirtualCursor((previous) => (previous.visible ? { ...previous, visible: false, pressed: false } : previous));
        frame = requestAnimationFrame(pollGamepad);
        return;
      }

      const leftX = stickValue(pad.axes[0]);
      const leftY = stickValue(pad.axes[1]);
      const rightX = stickValue(pad.axes[2]) * 0.45;
      const rightY = stickValue(pad.axes[3]) * 0.45;
      const axisX = clamp(leftX + rightX, -1, 1);
      const axisY = clamp(leftY + rightY, -1, 1);
      const speed = settings.controllerCursorSpeed;
      const isMoving = Math.abs(axisX) > 0 || Math.abs(axisY) > 0;
      const anyPressed = pad.buttons.some((button) => button.pressed);

      if (isMoving || anyPressed || cursorRef.current.visible) {
        setVirtualCursor((previous) => {
          const next = {
            x: clamp(previous.x + axisX * speed * deltaSeconds, 8, window.innerWidth - 8),
            y: clamp(previous.y + axisY * speed * deltaSeconds, 8, window.innerHeight - 8),
            visible: previous.visible || isMoving || anyPressed,
            pressed: anyPressed,
          };
          cursorRef.current = next;
          syncHover(next.x, next.y);
          return next;
        });
      } else if (cursorRef.current.pressed !== anyPressed) {
        setVirtualCursor((previous) => {
          const next = { ...previous, visible: true, pressed: anyPressed };
          cursorRef.current = next;
          return next;
        });
        syncHover(cursorRef.current.x, cursorRef.current.y);
      } else {
        syncHover(cursorRef.current.x, cursorRef.current.y);
      }

      pad.buttons.forEach((button, index) => {
        const pressed = button.pressed;
        if (pressed && !previousButtons[index]) {
          if (activeControllerBind) {
            const newValue = `B${index}`;
            setSettings((previous) => ({
              ...previous,
              controller: Object.fromEntries(
                Object.entries({ ...previous.controller, [activeControllerBind]: newValue }).map(([entryAction, entryValue]) => [
                  entryAction,
                  entryAction !== activeControllerBind && entryValue === newValue ? "" : entryValue,
                ]),
              ),
            }));
            setActiveControllerBind(null);
          } else {
            actionsForView(buttonActions[index] ?? []).forEach(controllerAction);
          }
        }
        previousButtons[index] = pressed;
      });

      frame = requestAnimationFrame(pollGamepad);
    }

    frame = requestAnimationFrame(pollGamepad);
    return () => {
      cancelAnimationFrame(frame);
      hoveredElementRef.current?.classList.remove("controller-hover");
      hoveredElementRef.current = null;
    };
  }, [activeControllerBind, controllerAction, settings.controller, settings.controllerCursorSpeed, settings.controllerProfile, view]);

  const updateSetting = <K extends keyof SettingsState>(key: K, value: SettingsState[K]) => {
    setSettings((previous) => ({ ...previous, [key]: value }));
  };

  const updateKeyBinding = (action: string, value: string) => {
    setSettings((previous) => ({
      ...previous,
      keyboard: { ...previous.keyboard, [action]: value === "Space" ? " " : value },
    }));
  };

  const updateControllerBinding = (action: string, value: string) => {
    setSettings((previous) => ({
      ...previous,
      controller: Object.fromEntries(
        Object.entries({ ...previous.controller, [action]: value }).map(([entryAction, entryValue]) => [
          entryAction,
          entryAction !== action && value && entryValue === value ? "" : entryValue,
        ]),
      ),
    }));
  };

  const clearControllerBinding = (action: string) => {
    setSettings((previous) => ({
      ...previous,
      controller: { ...previous.controller, [action]: "" },
    }));
    setActiveControllerBind((active) => (active === action ? null : active));
  };

  const updateControllerProfile = (profile: ControllerProfile) => {
    setSettings((previous) => ({
      ...previous,
      controllerProfile: profile,
      controller: profile === "Keyboard" ? previous.controller : CONTROLLER_PRESETS[profile],
    }));
    if (profile === "Keyboard") setActiveControllerBind(null);
  };

  const saveSettingsNow = () => {
    saveSettings(settings, currentUser.username);
    saveSetup(setup, currentUser.username);
    saveChartTemplates(chartTemplates, currentUser.username);
    saveActiveChartTemplateId(currentUser.username, activeTemplateId);
    saveChartSetupUi({ mode: chartSetupMode, zone: chartSetupZone }, currentUser.username);
    setSettingsSavedLabel("Saved");
  };

  const exportUserProfile = () => {
    const snapshot: UserProfileSnapshot = {
      ...buildProfilePayload(),
      exportedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const safeUsername = currentUser.username.replace(/[^a-z0-9_-]/gi, "_") || "user";
    link.href = url;
    link.download = `price-action-profile-${safeUsername}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setSettingsSavedLabel("Exported");
  };

  const importUserProfile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const imported = JSON.parse(await file.text()) as Partial<UserProfileSnapshot>;
      const importedSettings = normalizeSettingsState(imported.settings ?? {});
      const importedSetup = normalizeSetupState(imported.setup ?? {}, importedSettings);
      const importedChartUi = normalizeChartSetupUiState(imported.chartSetupUi ?? {});
      const importedTemplates = normalizeTemplates(Array.isArray(imported.chartTemplates) ? imported.chartTemplates as ChartTemplate[] : [builtInChartTemplate()]);
      const importedActiveTemplateId = typeof imported.activeTemplateId === "string" && importedTemplates.some((template) => template.id === imported.activeTemplateId)
        ? imported.activeTemplateId
        : defaultTemplateId(importedTemplates);
      const normalizedImport: ServerProfilePayload = {
        version: USER_PROFILE_VERSION,
        username: currentUser.username,
        settings: importedSettings,
        setup: importedSetup,
        chartSetupUi: importedChartUi,
        chartTemplates: importedTemplates,
        activeTemplateId: importedActiveTemplateId,
        history: [],
      };
      applyProfilePayload(normalizedImport, currentUser.username);
      await api<ServerProfilePayload>("/api/me/profile", {
        method: "PUT",
        body: JSON.stringify(normalizedImport),
      });
      setSettingsSavedLabel("Imported");
      setError("");
    } catch {
      setError("Could not import that profile file.");
    } finally {
      event.target.value = "";
    }
  };

  const handleLogin = async () => {
    const username = loginForm.username.trim();
    const password = loginForm.password;
    try {
      const loginResponse = await api<AuthResponse>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ username, password, displayName: loginForm.displayName }),
      });
      const profile = await api<ServerProfilePayload>("/api/me/profile");
      const authenticatedUsername = loginResponse.user.username;
      setCurrentUser({ username: authenticatedUsername, password: "" });
      setIsAdmin(Boolean(loginResponse.user.isAdmin));
      localStorage.setItem(CURRENT_USER_STORAGE_KEY, authenticatedUsername);
      applyProfilePayload(profile, authenticatedUsername);
      setActiveControllerBind(null);
      setLoginForm({ username: authenticatedUsername, password: "", displayName: loginResponse.user.displayName ?? authenticatedUsername });
      setProfileReady(true);
      setAuthLoading(false);
      setError("");
      setLoginNotice("");
      trackAnalyticsEvent("login_success", { username: authenticatedUsername }, "/app/login");
      setView("menu");
    } catch (err) {
      setError("");
      flashLoginNotice(err instanceof Error ? err.message : "Invalid username or password", { shake: true, duration: 1000 });
    }
  };

  const logoutCurrentUser = async () => {
    try {
      await api<{ ok: boolean }>("/api/auth/logout", { method: "POST" });
    } catch {
      // Local state still needs to leave the account, even if the server is unreachable.
    }
    setProfileReady(false);
    setIsAdmin(false);
    trackAnalyticsEvent("logout", {}, analyticsPathForView(view));
    setCurrentUser(DEFAULT_ACCOUNT);
    setLoginForm({ username: DEFAULT_ACCOUNT.username, password: "", displayName: "Trader 1" });
    setView("login");
  };

  const createOrUpdateAccount = () => {
    const username = loginForm.username.trim();
    if (!username || !loginForm.password) {
      setError("Enter a username and password.");
      return;
    }
    const next = normalizeAccounts([...accounts.filter((item) => item.username !== username), { username, password: loginForm.password }]);
    setAccounts(next);
    saveAccounts(next);
    localStorage.setItem(CURRENT_USER_STORAGE_KEY, username);
    const nextSettings = loadSettings(username);
    const chartSetupUi = loadChartSetupUi(username);
    setCurrentUser({ username, password: loginForm.password });
    setSettings(nextSettings);
    setSetup(loadSetup(username, nextSettings));
    setHistory(loadHistory(username));
    setChartSetupMode(chartSetupUi.mode);
    setChartSetupZone(chartSetupUi.zone);
    {
      const templates = loadChartTemplates(username);
      setChartTemplates(templates);
      setActiveTemplateId(loadActiveChartTemplateId(username, templates));
    }
    setView("menu");
  };

  const updateTemplate = (id: string, updater: (template: ChartTemplate) => ChartTemplate) => {
    setChartTemplates((previous) => normalizeTemplates(previous.map((template) => (template.id === id ? updater(template) : template))));
  };

  const updateChartSettings = (updates: Partial<ChartTemplate["chart"]>) => {
    updateTemplate(activeTemplate.id, (template) => ({
      ...template,
      chart: { ...template.chart, ...updates },
    }));
  };

  const createTemplate = () => {
    if (chartTemplates.length >= MAX_CHART_TEMPLATES) {
      setError(`Chart Setup supports up to ${MAX_CHART_TEMPLATES} templates.`);
      return;
    }
    const source = activeTemplate ?? builtInChartTemplate();
    const next: ChartTemplate = {
      ...source,
      id: crypto.randomUUID(),
      name: `${source.name} Copy`,
      isDefault: false,
      indicators: source.indicators.map((indicator) => ({ ...indicator, id: crypto.randomUUID() })),
    };
    setChartTemplates((previous) => normalizeTemplates([...previous, next]));
    setActiveTemplateId(next.id);
  };

  const deleteTemplate = (id: string) => {
    setChartTemplates((previous) => normalizeTemplates(previous.filter((template) => template.id !== id)));
  };

  const setDefaultTemplate = (id: string) => {
    setChartTemplates((previous) => previous.map((template) => ({ ...template, isDefault: template.id === id })));
  };

  const addIndicatorToActiveTemplate = (type: IndicatorType) => {
    const item = INDICATOR_BY_TYPE[type];
    if (item.pane === "price" && chartZoneCount >= MAX_CHART_INDICATORS) {
      setError(`Chart indicators support up to ${MAX_CHART_INDICATORS} displayed indicators.`);
      return;
    }
    const requestedLowerRow = typeof chartSetupZone === "number" ? chartSetupZone : null;
    const firstOpenLowerRow = requestedLowerRow !== null && lowerRowCounts[requestedLowerRow] < MAX_LOWER_PER_ROW
      ? requestedLowerRow
      : lowerRowCounts.findIndex((count) => count < MAX_LOWER_PER_ROW);
    if (item.pane === "lower" && firstOpenLowerRow === -1) {
      setError(`Bottom studies support up to ${MAX_LOWER_ROWS} rows with ${MAX_LOWER_PER_ROW} indicators per row.`);
      return;
    }
    updateTemplate(activeTemplate.id, (template) => ({
      ...template,
      indicators: [...template.indicators, makeIndicator(type, item.pane === "lower" ? { lowerRow: firstOpenLowerRow } : {})],
    }));
  };

  const updateIndicator = (indicatorId: string, patch: Partial<ChartIndicatorConfig>) => {
    updateTemplate(activeTemplate.id, (template) => ({
      ...template,
      indicators: template.indicators.map((indicator) => (indicator.id === indicatorId ? { ...indicator, ...patch, settings: patch.settings ?? indicator.settings } : indicator)),
    }));
  };

  const moveIndicatorToLowerRow = (indicatorId: string, lowerRow: number) => {
    updateTemplate(activeTemplate.id, (template) => {
      const targetCount = template.indicators.filter((indicator) => (
        indicator.id !== indicatorId
        && indicator.enabled
        && indicator.pane === "lower"
        && (indicator.lowerRow ?? 0) === lowerRow
      )).length;
      if (targetCount >= MAX_LOWER_PER_ROW) {
        setError(`Row ${lowerRow + 1} already has ${MAX_LOWER_PER_ROW} bottom indicators.`);
        return template;
      }
      return {
        ...template,
        indicators: template.indicators.map((indicator) => (indicator.id === indicatorId ? { ...indicator, lowerRow } : indicator)),
      };
    });
  };

  const removeIndicator = (indicatorId: string) => {
    updateTemplate(activeTemplate.id, (template) => ({ ...template, indicators: template.indicators.filter((indicator) => indicator.id !== indicatorId) }));
    setExpandedIndicatorIds((previous) => {
      const next = new Set(previous);
      next.delete(indicatorId);
      return next;
    });
  };

  const toggleIndicatorExpanded = (indicatorId: string) => {
    setExpandedIndicatorIds((previous) => {
      const next = new Set(previous);
      if (next.has(indicatorId)) {
        next.delete(indicatorId);
      } else {
        next.add(indicatorId);
      }
      return next;
    });
  };

  const positionTooltip = useCallback((clientX: number, clientY: number) => {
    const tooltip = tooltipElementRef.current;
    if (!tooltip) return;
    const x = clamp(clientX, 16, window.innerWidth - 16);
    const y = clamp(clientY + 16, 12, window.innerHeight - 44);
    tooltip.style.setProperty("--tooltip-x", `${x}px`);
    tooltip.style.setProperty("--tooltip-y", `${y}px`);
  }, []);

  const hideTooltip = useCallback(() => {
    tooltipTargetRef.current = null;
    tooltipTextRef.current = "";
    if (tooltipVisibleRef.current) {
      tooltipVisibleRef.current = false;
      setTooltipVisible(false);
    }
  }, []);

  const updateTooltipForTarget = useCallback((target: EventTarget | null, clientX: number, clientY: number) => {
    const element = tooltipTargetFromEventTarget(target);
    if (!element) {
      hideTooltip();
      return;
    }

    const text = textForControl(element);
    if (!text) {
      hideTooltip();
      return;
    }

    positionTooltip(clientX, clientY);
    tooltipTargetRef.current = element;
    if (tooltipTextRef.current !== text) {
      tooltipTextRef.current = text;
      setTooltipText(text);
    }
    if (!tooltipVisibleRef.current) {
      tooltipVisibleRef.current = true;
      setTooltipVisible(true);
    }
  }, [hideTooltip, positionTooltip]);

  const handleFocusTooltip = useCallback((event: FocusEvent<HTMLElement>) => {
    const element = tooltipTargetFromEventTarget(event.target);
    if (!element) return;
    const rect = element.getBoundingClientRect();
    updateTooltipForTarget(element, rect.left + rect.width / 2, rect.bottom);
  }, [updateTooltipForTarget]);

  const handleMouseMove = useCallback((event: MouseEvent<HTMLElement>) => {
    hoveredElementRef.current?.classList.remove("controller-hover");
    hoveredElementRef.current = null;
    setVirtualCursor((previous) => {
      if (!previous.visible && Math.abs(previous.x - event.clientX) < 1 && Math.abs(previous.y - event.clientY) < 1) {
        return previous;
      }
      const next = { x: event.clientX, y: event.clientY, visible: false, pressed: false };
      cursorRef.current = next;
      return next;
    });
  }, []);

  const handleAppMouseMove = useCallback((event: MouseEvent<HTMLElement>) => {
    handleMouseMove(event);
    updateTooltipForTarget(event.target, event.clientX, event.clientY);
  }, [handleMouseMove, updateTooltipForTarget]);

  const usesTradingShell = view === "play" || view === "chartSetup";
  const showTopbar = view === "menu";
  const scoreboardSummary = useMemo(() => {
    const bestScore = history.reduce<Scorecard | null>((best, item) => (!best || item.score > best.score ? item : best), null);
    const bestReturn = history.reduce<Scorecard | null>((best, item) => (!best || item.returnPct > best.returnPct ? item : best), null);
    return {
      sessions: history.length,
      totalPnl: history.reduce((sum, item) => sum + item.finalPnl, 0),
      bestScore: bestScore?.score ?? 0,
      bestReturn: bestReturn?.returnPct ?? 0,
    };
  }, [history]);

  return (
    <main
      className={`app-shell ${usesTradingShell ? "trading-shell" : "with-main-background"}`}
      onMouseMove={handleAppMouseMove}
      onMouseLeave={hideTooltip}
      onFocusCapture={handleFocusTooltip}
      onBlurCapture={hideTooltip}
    >
      <header className={`topbar ${showTopbar ? "" : "play-hidden"}`}>
        <div>
          <h1>{GAME_TITLE}</h1>
        </div>
      </header>

      {error && view !== "login" && (
        <div className="alert" role="alert">
          {error}
          <button type="button" onClick={() => setError("")}>Dismiss</button>
        </div>
      )}

      <datalist id="chart-color-defaults">
        {DEFAULT_COLOR_PALETTE.map((color) => <option value={color} key={color} />)}
      </datalist>

      {view === "login" && (
        <section className="login-layout setup-menu-layout">
          <div className={`setup-panel login-panel ${loginShaking ? "login-shake" : ""}`}>
            <div className="setup-panel-header">
              <div className="login-title-block">
                <h2 className="login-game-title">{GAME_TITLE}</h2>
              </div>
            </div>
            <section className="setup-control-card login-card">
              <div className={`login-flash ${loginNotice ? "visible" : ""}`} role="status" aria-live="polite">
                {loginNotice}
              </div>
              <form className="login-form" onSubmit={(event) => { event.preventDefault(); void handleLogin(); }}>
                <label>
                  Username
                  <input autoComplete="username" value={loginForm.username} onChange={(event) => setLoginForm((form) => ({ ...form, username: event.target.value }))} />
                </label>
                <label>
                  Display Name
                  <input
                    autoComplete="nickname"
                    value={loginForm.displayName}
                    onChange={(event) => setLoginForm((form) => ({ ...form, displayName: event.target.value }))}
                  />
                </label>
                <label>
                  Password
                  <span className="login-password-field">
                    <input
                      autoComplete="current-password"
                      type={loginPasswordVisible ? "text" : "password"}
                      value={loginForm.password}
                      onChange={(event) => setLoginForm((form) => ({ ...form, password: event.target.value }))}
                    />
                    <button
                      type="button"
                      className="login-password-toggle"
                      onClick={() => setLoginPasswordVisible((visible) => !visible)}
                      aria-label={loginPasswordVisible ? "Hide password" : "Show password"}
                    >
                      {loginPasswordVisible ? "Hide" : "Show"}
                    </button>
                  </span>
                </label>
                <button type="submit" className="primary login-submit">Login</button>
              </form>
              <div className="login-secondary-actions">
                <button type="button" className="ghost" onClick={() => flashLoginNotice("Sign up is not configured yet.", { duration: 1600 })}>Sign Up</button>
                <button type="button" className="ghost" onClick={() => flashLoginNotice("Email resend is not configured yet.", { duration: 1600 })}>Resend Confirmation</button>
              </div>
              <div className="login-oauth-grid" aria-label="OAuth login options">
                <button type="button" className="oauth-button" onClick={() => flashLoginNotice("Google login is not configured yet.", { duration: 1600 })}>
                  <img className="oauth-logo" src="/google-logo.svg" alt="" aria-hidden="true" />
                  Continue with Google
                </button>
                <button type="button" className="oauth-button" onClick={() => flashLoginNotice("Discord login is not configured yet.", { duration: 1600 })}>
                  <img className="oauth-logo discord" src="/discord-logo.svg" alt="" aria-hidden="true" />
                  Continue with Discord
                </button>
              </div>
            </section>
          </div>
        </section>
      )}

      {view === "menu" && (
        <section className="menu-layout">
          <button className="menu-action primary" type="button" onClick={() => { setSetup((s) => ({ ...s, mode: "standard" })); setSpeedMenuOpen(true); }}>
            <Play size={22} />
            <span>Quick Play</span>
          </button>
          <button className="menu-action" type="button" onClick={() => { setSetup((s) => ({ ...s, mode: "practice" })); setView("setup"); }}>
            <StepForward size={22} />
            <span>Practice Scenario</span>
          </button>
          <button className="menu-action" type="button" onClick={() => setView("history")}>
            <History size={22} />
            <span>Scoreboard</span>
          </button>
          <button className="menu-action" type="button" onClick={() => { setChartSetupMode("appearance"); setView("chartSetup"); }}>
            <BarChart3 size={22} />
            <span>Charting Setup</span>
          </button>
          <button className="menu-action" type="button" onClick={() => { setChartSetupMode("indicators"); setView("chartSetup"); }}>
            <BarChart3 size={22} />
            <span>Indicator Set</span>
          </button>
          <button className="menu-action" type="button" onClick={() => setView("settings")}>
            <Settings size={22} />
            <span>Settings</span>
          </button>
          {isAdmin && (
            <button className="menu-action" type="button" onClick={() => setView("analytics")}>
              <Gauge size={22} />
              <span>Analytics</span>
            </button>
          )}
          <button className="menu-action" type="button" onClick={logoutCurrentUser}>
            <Square size={22} />
            <span>Logout</span>
          </button>
        </section>
      )}

      {speedMenuOpen && (
        <div className="modal-backdrop" role="presentation" onClick={() => setSpeedMenuOpen(false)}>
          <section className="speed-picker" role="dialog" aria-modal="true" aria-label="Quick Play speed" onClick={(event) => event.stopPropagation()}>
            <div className="section-heading compact-heading">
              <h2>Quick Play</h2>
              <button type="button" className="ghost" onClick={() => setSpeedMenuOpen(false)}>Back</button>
            </div>
            <label className="toggle-field">
              <input
                type="checkbox"
                checked={setup.hardcore}
                onChange={(event) => setSetup((s) => ({ ...s, hardcore: event.target.checked }))}
              />
              <span>Hardcore Mode</span>
            </label>
            <div className="speed-options">
              {RANDOM_SESSION_SPEEDS.map((option) => (
                <button key={option.speed} type="button" className="menu-action primary" onClick={() => void beginSession("standard", option.speed)}>
                  <Play size={20} />
                  <span>{option.speed}</span>
                  <small>{option.detail}</small>
                </button>
              ))}
            </div>
          </section>
        </div>
      )}

      {view === "setup" && (
        <section className="setup-layout setup-menu-layout">
          <div className="setup-panel">
            <div className="setup-panel-header session-builder-header">
              <button type="button" className="ghost" onClick={() => setView("menu")}>Back</button>
              <div className="session-builder-title">
                <h2>Session Builder</h2>
              </div>
              <button className="primary cta setup-start-button" type="button" disabled={availableForSetup === 0 || !options} onClick={() => void beginSession(setup.mode)}>
                <Play size={18} />
                <span>{setup.mode === "practice" ? "Start Practice" : "Start Quick Play"}</span>
              </button>
            </div>

            <div className="setup-card-grid">
              <div className="setup-column setup-left-column">
                <section className="setup-control-card scenario-control-card">
                <div className="setup-card-title scenario-card-header">
                  <div className="scenario-title-lockup">
                    <Target size={20} />
                    <h3>Scenario</h3>
                  </div>
                  <button
                    type="button"
                    className={`setup-choice scenario-header-choice ${selectedScenarioFilters(setup.scenarioFilters).length === 0 ? "selected" : ""}`}
                    onClick={() => setSetup((s) => ({ ...s, scenario: "Random", scenarioFilters: { ...DEFAULT_SCENARIO_FILTERS } }))}
                  >
                    <strong>Random</strong>
                    <small>{SCENARIO_DETAILS.Random}</small>
                  </button>
                  <button
                    type="button"
                    className={`setup-choice scenario-header-choice hardcore-header-choice ${setup.hardcore ? "selected" : ""}`}
                    onClick={() => setSetup((s) => ({ ...s, hardcore: !s.hardcore }))}
                  >
                    <span className="scenario-hardcore-icon"><ShieldCheck size={20} /></span>
                    <span>
                      <strong>Hardcore {setup.hardcore ? "On" : "Off"}</strong>
                      <small>{setup.hardcore ? "Scoreboard eligible" : "Practice review only"}</small>
                    </span>
                  </button>
                </div>

                <SetupSelector
                  title="Asset Class"
                  icon={<Layers3 size={20} />}
                  value={setup.assetClass}
                  valueLabel={setup.assetClass}
                  valueDetail={setup.assetClass === "Random" ? "All classes" : undefined}
                  actionLabel="Select Class"
                  choices={assetClassChoicesForSetup}
                  open={openSetupPicker === "assetClass"}
                  onToggle={() => setOpenSetupPicker((current) => (current === "assetClass" ? null : "assetClass"))}
                  onSelect={(assetClass) => {
                    setSetup((s) => ({ ...s, assetClass, asset: "Random" }));
                    setOpenSetupPicker(null);
                  }}
                />

                <SetupSelector
                  title="Asset"
                  icon={<Target size={20} />}
                  value={setup.asset}
                  valueLabel={setup.asset}
                  valueDetail={setup.asset === "Random" ? "Any eligible asset" : options?.assets.find((item) => item.label === setup.asset)?.description ?? options?.assets.find((item) => item.label === setup.asset)?.assetClass}
                  actionLabel="Select Asset"
                  choices={assetSelectChoicesForSetup}
                  open={openSetupPicker === "asset"}
                  onToggle={() => setOpenSetupPicker((current) => (current === "asset" ? null : "asset"))}
                  onSelect={(asset) => {
                    setSetup((s) => ({ ...s, asset }));
                    setOpenSetupPicker(null);
                  }}
                />

                <div className="scenario-variable-grid">
                  {SCENARIO_VARIABLES.map((variable) => (
                    <div className="scenario-variable-row" key={variable.id}>
                      <div className="scenario-variable-label">
                        <strong>{variable.label}</strong>
                        <small>{variable.detail}</small>
                      </div>
                      <div className="scenario-variable-options">
                        {[variable.left, variable.right].map((choice) => {
                          const selected = setup.scenarioFilters[variable.id] === choice.value;
                          return (
                            <button
                              type="button"
                              key={choice.value}
                              className={`setup-choice scenario-variable-choice ${selected ? "selected" : ""}`}
                              onClick={() => setSetup((s) => ({
                                ...s,
                                scenario: "Random",
                                scenarioFilters: {
                                  ...s.scenarioFilters,
                                  [variable.id]: selected ? "Random" : choice.value,
                                },
                              }))}
                            >
                              <strong>{choice.label}</strong>
                              <small>{choice.detail}</small>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
              </div>

              <div className="setup-column setup-right-column">
                <SetupSelector
                  title="Starting Capital"
                  icon={<Wallet size={20} />}
                  value={setup.startingCapital}
                  valueLabel={currency(setup.startingCapital)}
                  actionLabel="Select Capital"
                  choices={startingCapitalChoicesForSetup}
                  open={openSetupPicker === "startingCapital"}
                  onToggle={() => setOpenSetupPicker((current) => (current === "startingCapital" ? null : "startingCapital"))}
                  onSelect={(startingCapital) => {
                    setSetup((s) => ({ ...s, startingCapital }));
                    setOpenSetupPicker(null);
                  }}
                />

                <SetupSelector
                  title="Position Sizing"
                  icon={<Wallet size={20} />}
                  value={setup.positionSizing}
                  valueLabel={POSITION_SIZING_OPTIONS.find((option) => option.id === setup.positionSizing)?.label ?? "1% / 5%"}
                  valueDetail={`${wholeCurrency(setupPositionSizes.small)} / ${wholeCurrency(setupPositionSizes.large)}`}
                  actionLabel="Select Sizing"
                  choices={positionSizingChoicesForSetup}
                  open={openSetupPicker === "positionSizing"}
                  onToggle={() => setOpenSetupPicker((current) => (current === "positionSizing" ? null : "positionSizing"))}
                  onSelect={(positionSizing) => {
                    setSetup((s) => ({ ...s, positionSizing }));
                    setOpenSetupPicker(null);
                  }}
                />

              <SetupSelector
                title="Chart Timeframe"
                icon={<BarChart3 size={20} />}
                value={setup.timeframe}
                valueLabel={setup.timeframe}
                actionLabel="Select Timeframe"
                choices={timeframeChoicesForSetup}
                open={openSetupPicker === "timeframe"}
                onToggle={() => setOpenSetupPicker((current) => (current === "timeframe" ? null : "timeframe"))}
                onSelect={(timeframe) => {
                  setSetup((s) => ({ ...s, timeframe }));
                  setOpenSetupPicker(null);
                }}
              />

              <SetupSelector
                title="Starting Time"
                icon={<History size={20} />}
                value={setup.startTime}
                valueLabel={START_TIME_CHOICES.find((choice) => choice.value === setup.startTime)?.label ?? "Random"}
                valueDetail={START_TIME_CHOICES.find((choice) => choice.value === setup.startTime)?.detail}
                actionLabel="Select Time"
                choices={startTimeChoicesForSetup}
                open={openSetupPicker === "startTime"}
                onToggle={() => setOpenSetupPicker((current) => (current === "startTime" ? null : "startTime"))}
                onSelect={(startTime) => {
                  setSetup((s) => ({ ...s, startTime }));
                  setOpenSetupPicker(null);
                }}
              />

              <SetupSelector
                title="Tick Speed"
                icon={<Gauge size={20} />}
                value={setup.replaySpeed}
                valueLabel={setup.replaySpeed}
                valueDetail={RANDOM_SESSION_SPEEDS.find((item) => item.speed === setup.replaySpeed)?.detail}
                actionLabel="Select Speed"
                choices={replaySpeedChoicesForSetup}
                open={openSetupPicker === "replaySpeed"}
                onToggle={() => setOpenSetupPicker((current) => (current === "replaySpeed" ? null : "replaySpeed"))}
                onSelect={(replaySpeed) => {
                  setSetup((s) => ({ ...s, replaySpeed }));
                  setOpenSetupPicker(null);
                }}
              />
              </div>
            </div>
          </div>
        </section>
      )}

      {view === "play" && activeSession && (
        <section className="game-layout">
          <div className="game-header">
            <div>
              <h2>{activeSession.ticker} / {activeSession.label.assetClass} / {activeSession.label.scenario}</h2>
            </div>
            <div className="play-toolbar">
              <label className="template-select">
                Template
                <select value={activeTemplateId} disabled={hardcorePauseLocked} onChange={(event) => setActiveTemplateId(event.target.value)}>
                  {chartTemplates.map((template) => <option value={template.id} key={template.id}>{template.name}</option>)}
                </select>
              </label>
              <div className="timeframe-tabs" role="tablist" aria-label="Chart timeframe">
              {(["1m", "5m", "15m"] as Timeframe[]).map((timeframe) => (
                <button
                  type="button"
                  key={timeframe}
                  className={chartTimeframe === timeframe ? "selected" : ""}
                  disabled={hardcorePauseLocked}
                  onClick={() => setChartTimeframe(timeframe)}
                >
                  {timeframe}
                </button>
              ))}
              </div>
            </div>
          </div>

          <div className="stats-grid">
            <Metric label="Price" value={currentPrice ? currency(currentPrice) : "Ready"} />
            <Metric label="Bid / Ask" value={orderBook ? `${orderBook.bid.toFixed(2)} / ${orderBook.ask.toFixed(2)}` : "--"} />
            <Metric label="Spread" value={orderBook ? currency(orderBook.spread) : "--"} />
            <Metric label="Session Time" value={currentTick ? currentTick.timestamp.slice(11, 19) : "09:30:00"} />
            <Metric label="Speed" value={currentSpeed} />
            <Metric label="Mode" value={activeSession.hardcore ? "Hardcore" : "Practice"} tone={activeSession.hardcore ? "warn" : undefined} />
            <Metric label="Cash" value={currency(cash)} />
            <Metric label="Shares" value={shares.toFixed(4)} />
            <Metric label="Position" value={currentPrice ? currency(shares * currentPrice) : currency(0)} />
            {settings.showPnl && <Metric label="Unrealized P&L" value={currency(unrealizedPnl)} tone={unrealizedPnl >= 0 ? "good" : "bad"} />}
            {settings.showPnl && <Metric label="Realized P&L" value={currency(realizedPnl)} tone={realizedPnl >= 0 ? "good" : "bad"} />}
            <Metric label="Equity" value={currentPrice ? currency(equity) : currency(activeSession.startingCapital)} tone={equity >= activeSession.startingCapital ? "good" : "bad"} />
          </div>

          <div className="chart-workspace">
            <ReplayChart
              candles={displayCandles}
              indicators={indicatorData}
              markers={tradeMarkers}
              drawings={chartDrawings}
              alerts={priceAlerts}
              trailingStop={trailingStop}
              chartSettings={activeTemplate.chart}
              visibleBars={DEFAULT_VISIBLE_BARS}
              lowerPanelHeight={activeTemplate.chart.lowerPanelHeight}
              visibleEndTime={displayEndTime}
              onToolPoint={handleChartToolPoint}
            />
            <Level2Panel book={orderBook} />
            <div className="chart-tool-overlay">
              <button type="button" className={chartToolMode === "trendline" ? "selected" : ""} disabled={hardcorePauseLocked} onClick={() => { setChartToolMode("trendline"); setPendingTrendlinePoint(null); }}>
                <Pencil size={16} />
                <span>{pendingTrendlinePoint ? "Pick End" : "Trendline"}</span>
              </button>
              <button type="button" className={chartToolMode === "level" ? "selected" : ""} disabled={hardcorePauseLocked} onClick={() => { setChartToolMode("level"); setPendingTrendlinePoint(null); }}>
                <Target size={16} />
                <span>S/R Level</span>
              </button>
              <button type="button" className={chartToolMode === "alert" ? "selected" : ""} disabled={hardcorePauseLocked} onClick={() => { setChartToolMode("alert"); setPendingTrendlinePoint(null); }}>
                <Bell size={16} />
                <span>Alert</span>
              </button>
              <button
                type="button"
                className={trailingStop.enabled ? "selected" : ""}
                disabled={hardcorePauseLocked || shares <= 0}
                onClick={() => setTrailingStop((previous) => ({
                  ...previous,
                  enabled: !previous.enabled,
                  highWater: !previous.enabled ? currentPrice : 0,
                  stopPrice: !previous.enabled ? currentPrice * (1 - previous.percent / 100) : null,
                }))}
              >
                <Gauge size={16} />
                <span>{trailingStop.enabled && trailingStop.stopPrice !== null ? `Trail ${currency(trailingStop.stopPrice)}` : "Trail 1%"}</span>
              </button>
              <button
                type="button"
                className={trailingStop.autoArm ? "selected" : ""}
                disabled={hardcorePauseLocked}
                onClick={() => setTrailingStop((previous) => ({ ...previous, autoArm: !previous.autoArm }))}
              >
                <Play size={16} />
                <span>Auto Trail</span>
              </button>
              <button type="button" disabled={hardcorePauseLocked} onClick={() => { setChartDrawings([]); setPriceAlerts([]); setPendingTrendlinePoint(null); }}>
                <Trash2 size={16} />
                <span>Clear</span>
              </button>
            </div>
            {paused && (
              <div className="unpause-prompt">
                <strong>Replay Paused</strong>
                <span>Chart is preloaded to {currentTick ? currentTick.timestamp.slice(11, 16) : "the selected start time"}.</span>
                <button type="button" className="primary" onClick={() => setPaused(false)}>
                  <Play size={18} />
                  <span>Unpause</span>
                </button>
              </div>
            )}
          </div>

          <div className="trade-controls">
            <button type="button" className="buy" disabled={hardcorePauseLocked} onClick={() => buyAmount(sessionPositionSizes.small)}>
              <ArrowUpCircle size={19} />
              <span>Buy {wholeCurrency(sessionPositionSizes.small)}</span>
            </button>
            <button type="button" className="buy" disabled={hardcorePauseLocked} onClick={() => buyAmount(sessionPositionSizes.large)}>
              <ArrowUpCircle size={19} />
              <span>Buy {wholeCurrency(sessionPositionSizes.large)}</span>
            </button>
            <button type="button" className="sell" disabled={hardcorePauseLocked} onClick={() => sellFraction(0.5)}>
              <ArrowDownCircle size={19} />
              <span>Sell Half</span>
            </button>
            <button type="button" className="sell" disabled={hardcorePauseLocked} onClick={() => sellFraction(1)}>
              <ArrowDownCircle size={19} />
              <span>Sell All</span>
            </button>
            <button type="button" onClick={togglePauseOrStep}>
              {paused ? <Play size={19} /> : <Pause size={19} />}
              <span>{paused ? "Resume" : "Pause"}</span>
            </button>
            <button type="button" onClick={() => changeSpeed(-1)}>
              <Gauge size={19} />
              <span>Speed -</span>
            </button>
            <button type="button" onClick={() => changeSpeed(1)}>
              <Gauge size={19} />
              <span>Speed +</span>
            </button>
            <button type="button" className="danger" onClick={() => void endSession()}>
              <Square size={18} />
              <span>End Session</span>
            </button>
          </div>

          <div className="trade-log">
            <h3>Trade Log</h3>
            {fills.length === 0 ? (
              <p>No trades yet.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Side</th>
                    <th>Qty</th>
                    <th>Adj Fill</th>
                    <th>Time</th>
                  </tr>
                </thead>
                <tbody>
                  {fills.slice(0, 10).map((fill) => (
                    <tr key={fill.id}>
                      <td>{fill.side.toUpperCase()}</td>
                      <td>{fill.quantity.toFixed(4)}</td>
                      <td>{currency(fill.price)}</td>
                      <td>{fill.timestamp.slice(11, 19)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      )}

      {view === "score" && score && (
        <section className="score-layout">
          <div className="section-heading">
            <button type="button" className="ghost" onClick={() => setView("menu")}>Menu</button>
            <h2>Scorecard</h2>
          </div>
          <div className="reveal-band">
            <strong>{score.ticker}</strong>
            <span>{score.assetClass}</span>
            <span>{score.scenario}</span>
            <span>{score.hardcore ? "Hardcore" : "Practice"}</span>
          </div>
          {!score.hardcore && (
            <div className="empty-state" data-active="true">
              Practice results are shown here for review only. Scoreboard entries require Hardcore Mode.
            </div>
          )}
          <div className="score-grid">
            <Metric label="Final P&L" value={currency(score.finalPnl)} tone={score.finalPnl >= 0 ? "good" : "bad"} />
            <Metric label="Return" value={pct(score.returnPct)} tone={score.returnPct >= 0 ? "good" : "bad"} />
            <Metric label="Score" value={pct(score.score)} tone={score.score >= 0 ? "good" : "bad"} />
            <Metric label="Base Score" value={pct(score.baseScore ?? score.score)} />
            <Metric label="Phase Adj." value={pct(score.phaseScoreAdjustment ?? 0)} tone={(score.phaseScoreAdjustment ?? 0) >= 0 ? "good" : "warn"} />
            <Metric label="Max Drawdown" value={pct(-score.maxDrawdownPct)} tone="warn" />
            <Metric label="Trades" value={`${score.numberOfTrades}`} />
            <Metric label="Win / Loss" value={`${score.wins} / ${score.losses}`} />
            <Metric label="Buy & Hold" value={pct(score.buyAndHoldReturnPct)} />
            <Metric label="SPY Return" value={pct(score.spyReturnPct)} />
            <Metric label="Best Long-Only" value={pct(score.bestPossibleLongOnlyReturnPct)} />
            <Metric label="Entry Timing" value={`${score.entryTimingScore.toFixed(1)}`} />
            <Metric label="Exit Timing" value={`${score.exitTimingScore.toFixed(1)}`} />
            <Metric label="Final Price" value={currency(score.finalPrice)} />
          </div>
          <div className="trade-log">
            <h3>Revealed Session Tags</h3>
            <div className="tag-list">
              {(score.hiddenTags && score.hiddenTags.length ? score.hiddenTags : ["No major hidden tags detected"]).map((tag) => (
                <span className="tag-pill" key={tag}>{tag.replace(/_/g, " ")}</span>
              ))}
            </div>
            {(score.tradedPhases?.length || score.matchedPhaseTags?.length) ? (
              <p>
                Traded phases: {(score.tradedPhases ?? []).join(", ") || "none"}.
                {(score.matchedPhaseTags?.length ?? 0) > 0 ? ` Score adjusted by matching ${score.matchedPhaseTags?.map((tag) => tag.replace(/_/g, " ")).join(", ")}.` : " No phase tag adjustment applied."}
              </p>
            ) : null}
          </div>
        </section>
      )}

      {view === "chartSetup" && (
        <section className="chart-setup-layout">
          <div className="chart-template-toolbar">
            <label>
              Template
              <select value={activeTemplateId} onChange={(event) => setActiveTemplateId(event.target.value)}>
                {chartTemplates.map((template) => <option value={template.id} key={template.id}>{template.name}{template.isDefault ? " (Default)" : ""}</option>)}
              </select>
            </label>
            <label>
              Name
              <input value={activeTemplate.name} onChange={(event) => updateTemplate(activeTemplate.id, (template) => ({ ...template, name: event.target.value }))} />
            </label>
            <button type="button" onClick={() => saveChartTemplates(chartTemplates, currentUser.username)}>Save</button>
            <button type="button" onClick={createTemplate} disabled={chartTemplates.length >= MAX_CHART_TEMPLATES}>New</button>
            <button type="button" onClick={() => setDefaultTemplate(activeTemplate.id)}>Set Default</button>
            <button type="button" className="danger" onClick={() => deleteTemplate(activeTemplate.id)}>Delete</button>
            <span>{chartTemplates.length}/{MAX_CHART_TEMPLATES} templates</span>
            <button type="button" className="ghost chart-main-menu-button" onClick={() => setView("menu")}>Main Menu</button>
          </div>

          <div className="chart-setup-main">
            <section className="chart-setup-preview">
              <div className="preview-header">
                <div>
                  <div className="preview-title-row">
                    <span className="eyebrow">Template Preview</span>
                    <button type="button" onClick={() => { setChartPreviewTicks([]); setChartPreviewSession(null); void loadChartSetupPreview(); }} disabled={chartPreviewLoading}>
                      Refresh Chart
                    </button>
                  </div>
                </div>
              </div>
              <div className="chart-workspace setup-preview-workspace">
                {chartPreviewTicks.length ? (
                  <>
                    <ReplayChart
                      candles={chartPreviewCandles}
                      indicators={chartPreviewIndicators}
                      markers={[]}
                      chartSettings={activeTemplate.chart}
                      visibleBars={120}
                      lowerPanelHeight={activeTemplate.chart.lowerPanelHeight}
                      visibleRangeAnchor="start"
                      visibleStartTime={chartPreviewVisibleStart}
                    />
                    <Level2Panel book={chartPreviewBook} />
                  </>
                ) : (
                  <div className="preview-loading">
                    {chartPreviewLoading ? "Loading random SPY chart from market open..." : "No preview loaded."}
                  </div>
                )}
              </div>
            </section>

            {chartSetupMode === "appearance" ? (
            <section className="template-editor">
              <div className="editor-card chart-appearance-card">
                <div className="panel-heading">
                  <h3>Chart Settings</h3>
                </div>
                <div className="appearance-editor-list">
                  <section className="appearance-section">
                    <h4>Chart Type</h4>
                    <div className="style-choice-grid">
                      {[
                        { value: "candles", label: "Candles" },
                        { value: "hollow", label: "Hollow" },
                        { value: "heikin-ashi", label: "Heikin Ashi" },
                        { value: "line", label: "Line" },
                      ].map((style) => (
                        <button
                          type="button"
                          key={style.value}
                          className={activeTemplate.chart.candleStyle === style.value ? "selected" : ""}
                          onClick={() => updateChartSettings({ candleStyle: style.value as ChartTemplate["chart"]["candleStyle"] })}
                        >
                          {style.label}
                        </button>
                      ))}
                    </div>
                  </section>

                  <section className="appearance-section">
                    <h4>Display</h4>
                    <label className="toggle-field">
                      <input
                        type="checkbox"
                        checked={activeTemplate.chart.showVolume}
                        onChange={(event) => updateChartSettings({ showVolume: event.target.checked })}
                      />
                      Relative Volume
                    </label>
                  </section>

                  <section className="appearance-section">
                    <h4>Colors</h4>
                    <div className="color-settings-grid">
                      {[
                        ["upColor", "Up Candle"],
                        ["downColor", "Down Candle"],
                        ["wickUpColor", "Up Wick"],
                        ["wickDownColor", "Down Wick"],
                        ["lineColor", "Line"],
                        ["backgroundColor", "Background"],
                        ["gridColor", "Grid"],
                        ["textColor", "Text"],
                        ["volumeUpColor", "Volume Up"],
                        ["volumeDownColor", "Volume Down"],
                      ].map(([key, label]) => (
                        <label key={key}>
                          {label}
                          <input
                            type="color"
                            list="chart-color-defaults"
                            value={(activeTemplate.chart[key as keyof ChartTemplate["chart"]] as string).startsWith("rgba")
                              ? (key.includes("Down") ? activeTemplate.chart.downColor : activeTemplate.chart.upColor)
                              : activeTemplate.chart[key as keyof ChartTemplate["chart"]] as string}
                            onChange={(event) => updateChartSettings({ [key]: event.target.value } as Partial<ChartTemplate["chart"]>)}
                          />
                        </label>
                      ))}
                    </div>
                  </section>
                </div>
              </div>
            </section>
            ) : (
            <section className="template-editor">
              <div className="editor-card">
                <div className="panel-heading">
                  <h3>Indicators</h3>
                </div>
                <div className="zone-tabs" role="tablist" aria-label="Indicator zones">
                  <button type="button" className={chartSetupZone === "chart" ? "selected" : ""} onClick={() => setChartSetupZone("chart")}>
                    Chart: {chartZoneCount}/{MAX_CHART_INDICATORS}
                  </button>
                  {lowerRowCounts.map((count, row) => (
                    <button
                      type="button"
                      className={chartSetupZone === row ? "selected" : ""}
                      key={row}
                      onClick={() => setChartSetupZone(row as ChartSetupZone)}
                    >
                      Row {row + 1}: {count}/{MAX_LOWER_PER_ROW}
                    </button>
                  ))}
                  <button type="button" className="primary zone-add-indicator" onClick={() => setAddIndicatorOpen((value) => !value)}>
                    Add Indicator
                  </button>
                </div>
                {addIndicatorOpen && (
                  <section className="add-chart-panel">
                    <div>
                      <h3>{chartSetupZone === "chart" ? "Chart Indicators" : `Row ${chartSetupZone + 1} Indicators`}</h3>
                      <div className="add-chart-list">
                        {INDICATOR_LIBRARY
                          .filter((item) => item.pane === (chartSetupZone === "chart" ? "price" : "lower"))
                          .map((item) => (
                            <button
                              type="button"
                              key={item.type}
                              disabled={
                                (chartSetupZone === "chart" && chartZoneCount >= MAX_CHART_INDICATORS)
                                || (chartSetupZone !== "chart" && lowerRowCounts[chartSetupZone] >= MAX_LOWER_PER_ROW)
                              }
                              onClick={() => {
                                addIndicatorToActiveTemplate(item.type);
                                setAddIndicatorOpen(false);
                              }}
                            >
                              {item.name}
                            </button>
                          ))}
                      </div>
                    </div>
                  </section>
                )}
                <div className="indicator-editor-list">
                  {visibleChartSetupIndicators.length === 0 ? (
                    <p>No indicators in this zone.</p>
                  ) : (
                    visibleChartSetupIndicators.map((indicator) => (
                      <div className="indicator-editor" key={indicator.id}>
                        <div className="indicator-editor-header">
                          <strong>{indicatorTitle(indicator)}</strong>
                          <div className="indicator-editor-actions">
                            <button
                              type="button"
                              onClick={() => {
                                if (!indicator.enabled && indicator.pane === "price" && chartZoneCount >= MAX_CHART_INDICATORS) {
                                  setError(`Chart indicators support up to ${MAX_CHART_INDICATORS} displayed indicators.`);
                                  return;
                                }
                                if (!indicator.enabled && indicator.pane === "lower" && lowerRowCounts[indicator.lowerRow ?? 0] >= MAX_LOWER_PER_ROW) {
                                  setError(`Row ${(indicator.lowerRow ?? 0) + 1} already has ${MAX_LOWER_PER_ROW} displayed indicators.`);
                                  return;
                                }
                                updateIndicator(indicator.id, { enabled: !indicator.enabled });
                              }}
                            >
                              {indicator.enabled ? "Hide" : "Display"}
                            </button>
                            <button type="button" onClick={() => toggleIndicatorExpanded(indicator.id)}>
                              {expandedIndicatorIds.has(indicator.id) ? "Collapse" : "Expand"}
                            </button>
                            <button type="button" className="danger" onClick={() => removeIndicator(indicator.id)}>Remove</button>
                          </div>
                        </div>
                        {expandedIndicatorIds.has(indicator.id) && (
                          <>
                            <input value={indicator.label} onChange={(event) => updateIndicator(indicator.id, { label: event.target.value })} />
                            <input type="color" list="chart-color-defaults" value={indicator.color} onChange={(event) => updateIndicator(indicator.id, { color: event.target.value })} />
                            <label>
                              Width
                              <select value={indicator.lineWidth} onChange={(event) => updateIndicator(indicator.id, { lineWidth: Number(event.target.value) as 1 | 2 | 3 })}>
                                <option value={1}>1</option>
                                <option value={2}>2</option>
                                <option value={3}>3</option>
                              </select>
                            </label>
                            {indicator.pane === "lower" && (
                          <label>
                            Row
                            <select value={indicator.lowerRow ?? 0} onChange={(event) => moveIndicatorToLowerRow(indicator.id, Number(event.target.value))}>
                              {Array.from({ length: MAX_LOWER_ROWS }, (_, row) => (
                                <option key={row} value={row}>Row {row + 1}</option>
                              ))}
                            </select>
                          </label>
                            )}
                            {Object.entries(indicator.settings).map(([key, value]) => (
                              <label key={key}>
                                {key}
                                {typeof value === "boolean" ? (
                                  <input
                                    type="checkbox"
                                    checked={value}
                                    onChange={(event) => updateIndicator(indicator.id, {
                                      settings: { ...indicator.settings, [key]: event.target.checked },
                                    })}
                                  />
                                ) : (
                                  <input
                                    type={key.toLowerCase().includes("color") ? "color" : typeof value === "number" ? "number" : "text"}
                                    list={key.toLowerCase().includes("color") ? "chart-color-defaults" : undefined}
                                    value={String(value)}
                                    onChange={(event) => updateIndicator(indicator.id, {
                                      settings: {
                                        ...indicator.settings,
                                        [key]: typeof value === "number" ? Number(event.target.value) : event.target.value,
                                      },
                                    })}
                                  />
                                )}
                              </label>
                            ))}
                          </>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>
            </section>
            )}
          </div>
        </section>
      )}

      {view === "settings" && (
        <section className="settings-layout settings-menu-layout">
          <div className="setup-panel settings-panel">
            <div className="setup-panel-header">
              <button type="button" className="ghost" onClick={() => setView("menu")}>Back</button>
              <div>
                <span className="eyebrow">Game Options</span>
                <h2>Settings</h2>
              </div>
              <button type="button" className="primary save-settings-button" onClick={saveSettingsNow}>{settingsSavedLabel}</button>
            </div>

            <div className="settings-card-grid">
              <div className="settings-tab-row">
                {(["controls", "audio", "display"] as const).map((tab) => (
                  <button type="button" className={settingsTab === tab ? "selected" : ""} onClick={() => setSettingsTab(tab)} key={tab}>
                    {tab}
                  </button>
                ))}
              </div>

              {settingsTab === "controls" && (
                <>
                  <section className="setup-control-card settings-card">
                    <div className="setup-card-title">
                      <Gauge size={20} />
                      <div>
                        <h3>Defaults</h3>
                      </div>
                    </div>
                    <div className="settings-field-grid">
                      <label>
                        Default Tick Speed
                        <select value={settings.defaultReplaySpeed} onChange={(event) => updateSetting("defaultReplaySpeed", event.target.value as ReplaySpeed)}>
                          {SPEED_ORDER.map((speed) => <option key={speed}>{speed}</option>)}
                        </select>
                      </label>
                      <label>
                        Default Timeframe
                        <select value={settings.defaultTimeframe} onChange={(event) => updateSetting("defaultTimeframe", event.target.value as Timeframe)}>
                          {(["1m", "5m", "15m"] as Timeframe[]).map((timeframe) => <option key={timeframe}>{timeframe}</option>)}
                        </select>
                      </label>
                      <label>
                        Default Capital
                        <select value={settings.defaultStartingCapital} onChange={(event) => updateSetting("defaultStartingCapital", Number(event.target.value))}>
                          {STARTING_CAPITAL_OPTIONS.map((capital) => (
                            <option value={capital} key={capital}>{currency(capital)}</option>
                          ))}
                        </select>
                      </label>
                    </div>
                  </section>

                  <section className="setup-control-card settings-card">
                    <div className="setup-card-title">
                      <Settings size={20} />
                      <div>
                        <h3>Controller</h3>
                      </div>
                    </div>
                    <div className="settings-field-grid">
                      <label>
                        Controls Profile
                        <select value={settings.controllerProfile} onChange={(event) => updateControllerProfile(event.target.value as ControllerProfile)}>
                          <option>Keyboard</option>
                          <option>Xbox</option>
                          <option>PlayStation</option>
                        </select>
                      </label>
                      {settings.controllerProfile !== "Keyboard" && (
                        <label>
                          Cursor Speed
                          <input
                            type="range"
                            min="300"
                            max="1600"
                            step="50"
                            value={settings.controllerCursorSpeed}
                            onChange={(event) => updateSetting("controllerCursorSpeed", Number(event.target.value))}
                          />
                        </label>
                      )}
                    </div>
                  </section>

                  <section className={`setup-control-card settings-card binding-card ${settings.controllerProfile === "Keyboard" ? "wide-card" : ""}`}>
                    <div className="setup-card-title">
                      <Target size={20} />
                      <div>
                        <h3>Keyboard Bindings</h3>
                      </div>
                    </div>
                    <div className="binding-grid">
                      {Object.entries(settings.keyboard).map(([action, value]) => (
                        <label key={action}>
                          {ACTION_LABELS[action] ?? action}
                          <input value={value === " " ? "Space" : value} onChange={(event) => updateKeyBinding(action, event.target.value)} />
                        </label>
                      ))}
                    </div>
                  </section>

                  {settings.controllerProfile !== "Keyboard" && (
                    <section className="setup-control-card settings-card binding-card controller-card">
                      <div className="setup-card-title">
                        <ShieldCheck size={20} />
                        <div>
                          <h3>{settings.controllerProfile} Controller Bindings</h3>
                        </div>
                      </div>
                      <div className="binding-grid controller-grid">
                        {Object.keys(ACTION_LABELS).map((action) => (
                          <div className="controller-binding" key={action}>
                            <span>{ACTION_LABELS[action]}</span>
                            <button
                              type="button"
                              className={`controller-binding-tile ${activeControllerBind === action ? "listening" : ""}`}
                              onClick={() => setActiveControllerBind((active) => (active === action ? null : action))}
                            >
                              {activeControllerBind === action ? (
                                <span className="controller-listening">Press a controller button</span>
                              ) : (
                                <ControllerButtonChip value={settings.controller[action]} profile={settings.controllerProfile as GamepadProfile} />
                              )}
                            </button>
                            <button className="binding-clear" type="button" onClick={() => clearControllerBinding(action)}>
                              Clear
                            </button>
                          </div>
                        ))}
                      </div>
                    </section>
                  )}
                </>
              )}

              {settingsTab === "audio" && (
                <>
                  <section className="setup-control-card settings-card wide-card">
                    <div className="setup-card-title">
                      <Bell size={20} />
                      <div>
                        <h3>Sound Events</h3>
                      </div>
                    </div>
                    <div className="settings-toggle-grid">
                      <label className="toggle-field">
                        <input type="checkbox" checked={settings.sound} onChange={(event) => updateSetting("sound", event.target.checked)} />
                        Sound Enabled
                      </label>
                      <label className="toggle-field">
                        <input type="checkbox" checked={settings.alertSounds} onChange={(event) => updateSetting("alertSounds", event.target.checked)} />
                        Alert Sounds
                      </label>
                      <label className="toggle-field">
                        <input type="checkbox" checked={settings.bellSounds} onChange={(event) => updateSetting("bellSounds", event.target.checked)} />
                        Opening / Closing Bell
                      </label>
                      <label className="toggle-field">
                        <input type="checkbox" checked={settings.tradeSounds} onChange={(event) => updateSetting("tradeSounds", event.target.checked)} />
                        Trade Executions
                      </label>
                    </div>
                  </section>

                  <section className="setup-control-card settings-card wide-card">
                    <div className="setup-card-title">
                      <Gauge size={20} />
                      <div>
                        <h3>Volume Mix</h3>
                      </div>
                    </div>
                    <div className="settings-field-grid">
                      {[
                        ["masterVolume", "Master Volume"],
                        ["alertVolume", "Alert Volume"],
                        ["tradeVolume", "Trade Volume"],
                      ].map(([key, label]) => (
                        <label key={key}>
                          {label}
                          <input
                            type="range"
                            min="0"
                            max="100"
                            value={Number(settings[key as keyof SettingsState])}
                            onChange={(event) => updateSetting(key as keyof SettingsState, Number(event.target.value) as never)}
                          />
                        </label>
                      ))}
                    </div>
                  </section>
                </>
              )}

              {settingsTab === "display" && (
                <>
                  <section className="setup-control-card settings-card">
                    <div className="setup-card-title">
                      <BarChart3 size={20} />
                      <div>
                        <h3>Interface</h3>
                      </div>
                    </div>
                    <div className="settings-field-grid">
                      <label>
                        Theme
                        <select value={settings.themeMode} onChange={(event) => updateSetting("themeMode", event.target.value as SettingsState["themeMode"])}>
                          <option>Dark</option>
                          <option>Light</option>
                        </select>
                      </label>
                      <label>
                        Chart Style
                        <select value={settings.chartStyle} onChange={(event) => updateSetting("chartStyle", event.target.value as SettingsState["chartStyle"])}>
                          <option>Price Action</option>
                          <option>Bloomberg Terminal</option>
                          <option>Brokerage Account</option>
                          <option>Arcade</option>
                        </select>
                      </label>
                    </div>
                  </section>

                  <section className="setup-control-card settings-card">
                    <div className="setup-card-title">
                      <Layers3 size={20} />
                      <div>
                        <h3>Session Display</h3>
                      </div>
                    </div>
                    <div className="settings-toggle-grid">
                      <label className="toggle-field">
                        <input type="checkbox" checked={settings.showVolume} onChange={(event) => updateSetting("showVolume", event.target.checked)} />
                        Relative Volume
                      </label>
                      <label className="toggle-field">
                        <input type="checkbox" checked={settings.showPnl} onChange={(event) => updateSetting("showPnl", event.target.checked)} />
                        P&L
                      </label>
                    </div>
                  </section>

                  <section className="setup-control-card settings-card settings-profile-card wide-card">
                    <div className="setup-card-title">
                      <Layers3 size={20} />
                      <div>
                        <h3>User Profile</h3>
                      </div>
                    </div>
                    <p className="settings-card-note">
                      Export or import one small local file with Settings, Practice Scenario choices, Charting Setup, Indicator Set templates, and Scoreboard history.
                    </p>
                    <div className="profile-actions">
                      <button type="button" onClick={exportUserProfile}>Export Profile</button>
                      <button type="button" onClick={() => profileImportInputRef.current?.click()}>Import Profile</button>
                      <input
                        ref={profileImportInputRef}
                        type="file"
                        accept="application/json,.json"
                        className="hidden-file-input"
                        onChange={importUserProfile}
                      />
                    </div>
                  </section>
                </>
              )}
            </div>
          </div>
        </section>
      )}

      {view === "history" && (
        <section className="history-layout history-menu-layout">
          <div className="setup-panel history-panel">
            <div className="setup-panel-header">
              <button type="button" className="ghost" onClick={() => setView("menu")}>Back</button>
              <div>
                <span className="eyebrow">Hardcore Results</span>
                <h2>Scoreboard</h2>
              </div>
              <span className="setup-match-pill">{scoreboardSummary.sessions} Sessions</span>
            </div>

            <div className="scoreboard-grid">
              <div className="settings-tab-row">
                {(["personal", "global", "replays"] as const).map((tab) => (
                  <button type="button" className={scoreboardTab === tab ? "selected" : ""} onClick={() => setScoreboardTab(tab)} key={tab}>
                    {tab === "personal" ? "Personal Scores" : tab === "global" ? "Global Scores" : "Replays"}
                  </button>
                ))}
              </div>
              <div className="stats-grid scoreboard-stats">
                <Metric label="Total Sessions" value={`${scoreboardSummary.sessions}`} />
                <Metric label="Total P&L" value={currency(scoreboardSummary.totalPnl)} tone={scoreboardSummary.totalPnl >= 0 ? "good" : "bad"} />
                <Metric label="Best Return" value={pct(scoreboardSummary.bestReturn)} tone={scoreboardSummary.bestReturn >= 0 ? "good" : "bad"} />
                <Metric label="Best Score" value={pct(scoreboardSummary.bestScore)} tone={scoreboardSummary.bestScore >= 0 ? "good" : "bad"} />
              </div>

              <section className="setup-control-card scoreboard-table-card">
                <div className="setup-card-title">
                  <History size={20} />
                  <div>
                    <h3>{scoreboardTab === "personal" ? "Personal Scores" : scoreboardTab === "global" ? "Global Scores" : "Saved Replays"}</h3>
                  </div>
                </div>
                {scoreboardTab === "global" && (
                  <div className="scoreboard-filter-row">
                    <select value={globalScoreWindow} onChange={(event) => setGlobalScoreWindow(event.target.value as "31d" | "252d")}>
                      <option value="31d">Rolling 31D</option>
                      <option value="252d">Rolling 252D</option>
                    </select>
                    <select value={scoreMetric} onChange={(event) => setScoreMetric(event.target.value)}>
                      <option value="score">Score</option>
                      <option value="returnPct">Return</option>
                      <option value="finalPnl">P&L</option>
                      <option value="entryTimingScore">Entry Quality</option>
                      <option value="exitTimingScore">Exit Quality</option>
                    </select>
                  </div>
                )}
                {(() => {
                  const personalRows: ScoreboardEntry[] = scoreboardDashboard?.personal ?? history.map((item) => ({ ...item, displayName: loginForm.displayName }));
                  const globalRows = scoreMetric === "score"
                    ? (globalScoreWindow === "31d" ? scoreboardDashboard?.global31d : scoreboardDashboard?.global252d) ?? []
                    : scoreboardDashboard?.metrics?.[scoreMetric] ?? [];
                  const replayRows = scoreboardDashboard?.replays ?? personalRows.slice(0, 20);
                  const rows = scoreboardTab === "personal" ? personalRows : scoreboardTab === "global" ? globalRows : replayRows;
                  return rows.length === 0 ? (
                  <div className="empty-state" data-active="true">No Hardcore sessions completed yet.</div>
                ) : (
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>{scoreboardTab === "global" ? "Rank" : "Player"}</th>
                          <th>Ticker</th>
                          <th>Scenario</th>
                          <th>P&L</th>
                          <th>Return</th>
                          <th>Score</th>
                          <th>Replay</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((item, index) => (
                          <tr key={`${item.ticker}-${item.scenario}-${index}`}>
                            <td>{scoreboardTab === "global" ? item.rank ?? index + 1 : item.displayName ?? loginForm.displayName}</td>
                            <td>{item.ticker}</td>
                            <td>{item.scenario}</td>
                            <td>{currency(item.finalPnl)}</td>
                            <td>{pct(item.returnPct)}</td>
                            <td>{pct(item.score)}</td>
                            <td>
                              {item.scoreId ? (
                                scoreboardTab === "replays" ? (
                                  <button type="button" className="ghost table-action-button" onClick={() => void deleteReplay(item.scoreId!)}>Unsave</button>
                                ) : (
                                  <button type="button" className="ghost table-action-button" onClick={() => void saveReplay(item.scoreId!)}>Save</button>
                                )
                              ) : "-"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                );
                })()}
              </section>
            </div>
          </div>
        </section>
      )}

      {view === "analytics" && (
        <section className="analytics-layout history-menu-layout">
          <div className="setup-panel analytics-panel">
            <div className="setup-panel-header">
              <button type="button" className="ghost" onClick={() => setView("menu")}>Back</button>
              <div>
                <span className="eyebrow">Site And Product</span>
                <h2>Analytics</h2>
              </div>
              <button type="button" className="primary save-settings-button" onClick={() => void refreshAnalyticsDashboard()} disabled={analyticsLoading}>
                {analyticsLoading ? "Loading" : "Refresh"}
              </button>
            </div>

            {!analyticsDashboard ? (
              <div className="empty-state" data-active="true">Analytics dashboard is loading.</div>
            ) : (
              <div className="analytics-grid">
                <div className="settings-tab-row">
                  <button type="button" className={analyticsTab === "usage" ? "selected" : ""} onClick={() => setAnalyticsTab("usage")}>Usage</button>
                  <button type="button" className={analyticsTab === "server" ? "selected" : ""} onClick={() => setAnalyticsTab("server")}>Server Load</button>
                </div>

                {analyticsTab === "usage" ? (
                  <>
                    <div className="stats-grid analytics-stats">
                      <Metric label="Users" value={compactNumber(analyticsDashboard.totals.users)} />
                      <Metric label="Visitors" value={compactNumber(analyticsDashboard.totals.visitors)} />
                      <Metric label="Site Visits" value={compactNumber(analyticsDashboard.totals.visits)} />
                      <Metric label="Tracked Events" value={compactNumber(analyticsDashboard.totals.events)} />
                      <Metric label="DAU" value={compactNumber(analyticsDashboard.activeUsers.day)} tone="good" />
                      <Metric label="WAU" value={compactNumber(analyticsDashboard.activeUsers.week)} tone="good" />
                      <Metric label="MAU" value={compactNumber(analyticsDashboard.activeUsers.month)} tone="good" />
                      <Metric label="30D Visits" value={compactNumber(analyticsDashboard.visitCounts.month)} />
                    </div>

                    <section className="setup-control-card analytics-card wide-card">
                      <div className="setup-card-title">
                        <BarChart3 size={20} />
                        <h3>Visits By Day</h3>
                      </div>
                      <AnalyticsBars
                        emptyLabel="No visits tracked yet."
                        rows={analyticsDashboard.visitsByDay.map((row) => ({
                          label: row.day.slice(5),
                          value: row.visits,
                          detail: `${row.visitors} visitors / ${row.users} users`,
                        }))}
                      />
                    </section>

                    <section className="setup-control-card analytics-card">
                      <div className="setup-card-title">
                        <Gauge size={20} />
                        <h3>Conversion Funnel</h3>
                      </div>
                      <AnalyticsBars emptyLabel="No funnel events tracked yet." rows={analyticsDashboard.funnel.map((row) => ({ label: row.label, value: row.count }))} />
                    </section>

                    <section className="setup-control-card analytics-card">
                      <div className="setup-card-title">
                        <Target size={20} />
                        <h3>Top Events</h3>
                      </div>
                      <AnalyticsBars emptyLabel="No product events tracked yet." rows={analyticsDashboard.eventsByName.map((row) => ({ label: row.name.replace(/_/g, " "), value: row.count }))} />
                    </section>

                    <section className="setup-control-card analytics-card wide-card">
                      <div className="setup-card-title">
                        <History size={20} />
                        <h3>Top Screens</h3>
                      </div>
                      <AnalyticsBars emptyLabel="No page views tracked yet." rows={analyticsDashboard.topPages.map((row) => ({ label: row.path.replace("/app/", ""), value: row.count }))} />
                    </section>
                  </>
                ) : (
                  <>
                    <div className="stats-grid analytics-stats">
                      <Metric label="Disk Used" value={`${analyticsDashboard.serverLoad.disk.usedPct}%`} />
                      <Metric label="Disk Free" value={`${(analyticsDashboard.serverLoad.disk.freeBytes / 1024 ** 3).toFixed(1)} GB`} tone="good" />
                      <Metric label="CPU Cores" value={`${analyticsDashboard.serverLoad.cpuCount}`} />
                      <Metric label="Load Avg" value={analyticsDashboard.serverLoad.loadAverage.length ? analyticsDashboard.serverLoad.loadAverage.map((value) => value.toFixed(2)).join(" / ") : "Local N/A"} />
                    </div>
                    <section className="setup-control-card analytics-card wide-card">
                      <div className="setup-card-title">
                        <Gauge size={20} />
                        <h3>Past Week Hourly Demand</h3>
                      </div>
                      <AnalyticsBars
                        emptyLabel="No load samples yet."
                        rows={analyticsDashboard.visitsByHour.map((row) => ({ label: `${String(row.hour).padStart(2, "0")}:00`, value: row.visits, detail: "visits" }))}
                      />
                    </section>
                    <section className="setup-control-card analytics-card wide-card">
                      <div className="setup-card-title">
                        <BarChart3 size={20} />
                        <h3>Historical Load Tracker</h3>
                      </div>
                      <AnalyticsBars
                        emptyLabel="No visits tracked yet."
                        rows={analyticsDashboard.visitsByDay.map((row) => ({ label: row.day.slice(5), value: row.visits, detail: `${row.visitors} visitors` }))}
                      />
                    </section>
                  </>
                )}
              </div>
            )}
          </div>
        </section>
      )}
      <div ref={tooltipElementRef} className={`global-tooltip ${tooltipVisible ? "visible" : ""}`} role="tooltip">
        {tooltipText}
      </div>
      <div
        aria-hidden="true"
        className={`virtual-cursor ${virtualCursor.visible ? "visible" : ""} ${virtualCursor.pressed ? "pressed" : ""}`}
        style={{ transform: `translate(${virtualCursor.x - 10}px, ${virtualCursor.y - 10}px)` }}
      />
    </main>
  );
}

export default App;
