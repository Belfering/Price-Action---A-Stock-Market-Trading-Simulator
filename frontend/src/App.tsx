import { type MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownCircle,
  ArrowUpCircle,
  BarChart3,
  Gauge,
  History,
  Pause,
  Play,
  Settings,
  Square,
  StepForward,
  Wallet,
} from "lucide-react";
import {
  ColorType,
  createChart,
  HistogramData,
  IChartApi,
  ISeriesApi,
  LineData,
  Time,
} from "lightweight-charts";

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:8000";

type View = "menu" | "setup" | "play" | "score" | "settings" | "history";
type Timeframe = "1m" | "5m" | "15m" | "30m" | "1h";
type ReplaySpeed = "Slow" | "Normal" | "Fast" | "Manual";
type TradeSide = "buy" | "sell";
type ControllerProfile = "Xbox" | "PlayStation";

type OptionItem = {
  label: string;
  availableCount: number;
  enabled: boolean;
};

type MetadataRow = {
  ticker: string;
  date: string;
  assetClass: string;
  dailyReturn: number;
  gapPct: number | null;
  volatilityScore: number;
  volumeScore: number;
  scenarioFlags: Record<string, boolean>;
};

type OptionsPayload = {
  tickers: string[];
  dates: string[];
  assetClasses: OptionItem[];
  scenarios: OptionItem[];
  timeframes: Timeframe[];
  startingCapital: number[];
  replaySpeeds: { label: ReplaySpeed; secondsPerTick: number | null }[];
  metadata: MetadataRow[];
};

type StartSessionResponse = {
  sessionId: string;
  label: {
    assetClass: string;
    scenario: string;
  };
  timeframe: Timeframe;
  startingCapital: number;
  replaySpeed: ReplaySpeed;
  availableCandles: number;
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
};

type TradeFill = {
  id: string;
  side: TradeSide;
  quantity: number;
  price: number;
  tickIndex: number;
  timestamp: string;
};

type Scorecard = {
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
  realizedPnl: number;
  endingCash: number;
  endingShares: number;
  finalPrice: number;
};

type DisplayCandle = {
  time: Time;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type ChartMarker = {
  time: Time;
  position: "aboveBar" | "belowBar";
  color: string;
  shape: "arrowDown" | "arrowUp";
  text: string;
};

type IndicatorVisibility = {
  sma20: boolean;
  sma50: boolean;
  sma200: boolean;
  vwap: boolean;
  rsi14: boolean;
};

type IndicatorData = {
  sma20: LineData[];
  sma50: LineData[];
  sma200: LineData[];
  vwap: LineData[];
};

type SettingsState = {
  defaultReplaySpeed: ReplaySpeed;
  defaultTimeframe: Timeframe;
  defaultStartingCapital: number;
  controllerProfile: ControllerProfile;
  controllerCursorSpeed: number;
  sound: boolean;
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
  scenario: string;
  timeframe: Timeframe;
  startingCapital: number;
  replaySpeed: ReplaySpeed;
  practiceDate: string;
};

const ACTION_LABELS: Record<string, string> = {
  buy1000: "Buy $1,000",
  buy5000: "Buy $5,000",
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

const CONTROLLER_PRESETS: Record<ControllerProfile, Record<string, string>> = {
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
  defaultReplaySpeed: "Normal",
  defaultTimeframe: "1m",
  defaultStartingCapital: 25_000,
  controllerProfile: "Xbox",
  controllerCursorSpeed: 900,
  sound: false,
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

const SPEED_MS: Record<ReplaySpeed, number | null> = {
  Slow: 1000,
  Normal: 500,
  Fast: 250,
  Manual: null,
};

const SPEED_ORDER: ReplaySpeed[] = ["Manual", "Slow", "Normal", "Fast"];
const TIMEFRAME_MINUTES: Record<Timeframe, number> = {
  "1m": 1,
  "5m": 5,
  "15m": 15,
  "30m": 30,
  "1h": 60,
};
const DEFAULT_INDICATORS: IndicatorVisibility = {
  sma20: true,
  sma50: false,
  sma200: false,
  vwap: true,
  rsi14: false,
};
function currency(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

function pct(value: number) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({ detail: response.statusText }));
    throw new Error(detail.detail ?? response.statusText);
  }
  return response.json() as Promise<T>;
}

function loadSettings(): SettingsState {
  const raw = localStorage.getItem("trading-replay-settings");
  if (!raw) return DEFAULT_SETTINGS;
  try {
    const parsed = JSON.parse(raw) as Partial<SettingsState>;
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      keyboard: { ...DEFAULT_SETTINGS.keyboard, ...(parsed.keyboard ?? {}) },
      controller: { ...DEFAULT_SETTINGS.controller, ...(parsed.controller ?? {}) },
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function saveSettings(settings: SettingsState) {
  localStorage.setItem("trading-replay-settings", JSON.stringify(settings));
}

function loadHistory(): Scorecard[] {
  const raw = localStorage.getItem("trading-replay-history");
  if (!raw) return [];
  try {
    return JSON.parse(raw) as Scorecard[];
  } catch {
    return [];
  }
}

function saveHistory(history: Scorecard[]) {
  localStorage.setItem("trading-replay-history", JSON.stringify(history.slice(0, 50)));
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

function controllerButtonLabel(value: string, profile: ControllerProfile) {
  const option = CONTROLLER_BUTTON_OPTIONS.find((item) => item.value === value);
  if (!option) return value;
  return profile === "PlayStation" ? option.playstation : option.xbox;
}

function controllerButtonGlyph(value: string, profile: ControllerProfile) {
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

function ControllerButtonChip({ value, profile }: { value?: string; profile: ControllerProfile }) {
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

function stickValue(value: number | undefined) {
  const deadzone = 0.14;
  const raw = value ?? 0;
  if (Math.abs(raw) < deadzone) return 0;
  return ((Math.abs(raw) - deadzone) / (1 - deadzone)) * Math.sign(raw);
}

function buildDisplayCandles(ticks: ReplayTick[], timeframe: Timeframe): DisplayCandle[] {
  if (!ticks.length) return [];

  const interval = TIMEFRAME_MINUTES[timeframe] * 60_000;
  const sessionStart = new Date(ticks[0].candleTimestamp).getTime();
  const candleMap = new Map<number, DisplayCandle>();

  for (const tick of ticks) {
    const candleTime = new Date(tick.candleTimestamp).getTime();
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

function latestRsi(candles: DisplayCandle[], period = 14) {
  if (candles.length <= period) return null;
  const slice = candles.slice(-(period + 1));
  let gains = 0;
  let losses = 0;
  for (let index = 1; index < slice.length; index += 1) {
    const change = slice[index].close - slice[index - 1].close;
    if (change >= 0) gains += change;
    else losses += Math.abs(change);
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

function computeIndicators(candles: DisplayCandle[], visible: IndicatorVisibility): IndicatorData {
  return {
    sma20: visible.sma20 ? movingAverage(candles, 20) : [],
    sma50: visible.sma50 ? movingAverage(candles, 50) : [],
    sma200: visible.sma200 ? movingAverage(candles, 200) : [],
    vwap: visible.vwap ? vwap(candles) : [],
  };
}

function buildTradeMarkers(fills: TradeFill[], ticks: ReplayTick[], timeframe: Timeframe): ChartMarker[] {
  if (!fills.length || !ticks.length) return [];
  const sessionStart = new Date(ticks[0].candleTimestamp).getTime();
  const interval = TIMEFRAME_MINUTES[timeframe] * 60_000;
  const tickByIndex = new Map(ticks.map((tick) => [tick.tickIndex, tick]));

  return fills
    .map((fill) => {
      const tick = tickByIndex.get(fill.tickIndex);
      const timestamp = tick?.candleTimestamp ?? fill.timestamp;
      const candleTime = new Date(timestamp).getTime();
      const bucket = sessionStart + Math.floor((candleTime - sessionStart) / interval) * interval;
      const isBuy = fill.side === "buy";
      return {
        time: Math.floor(bucket / 1000) as Time,
        position: isBuy ? "belowBar" : "aboveBar",
        color: isBuy ? "#38c172" : "#e45649",
        shape: isBuy ? "arrowUp" : "arrowDown",
        text: `${isBuy ? "Buy" : "Sell"} ${fill.quantity.toFixed(2)}`,
      } satisfies ChartMarker;
    })
    .sort((a, b) => Number(a.time) - Number(b.time));
}

function ReplayChart({
  candles,
  indicators,
  markers,
  showVolume,
}: {
  candles: DisplayCandle[];
  indicators: IndicatorData;
  markers: ChartMarker[];
  showVolume: boolean;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const indicatorSeriesRef = useRef<Record<keyof IndicatorData, ISeriesApi<"Line"> | null>>({
    sma20: null,
    sma50: null,
    sma200: null,
    vwap: null,
  });

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: "#151515" },
        textColor: "#d8d3c8",
      },
      grid: {
        vertLines: { color: "#2a2925" },
        horzLines: { color: "#2a2925" },
      },
      rightPriceScale: {
        borderColor: "#3a342b",
      },
      timeScale: {
        borderColor: "#3a342b",
        timeVisible: true,
        secondsVisible: false,
      },
      crosshair: {
        mode: 1,
      },
    });

    const candleSeries = chart.addCandlestickSeries({
      upColor: "#38c172",
      downColor: "#e45649",
      borderUpColor: "#38c172",
      borderDownColor: "#e45649",
      wickUpColor: "#8ee2ad",
      wickDownColor: "#ef8a7f",
    });
    const volumeSeries = chart.addHistogramSeries({
      priceFormat: { type: "volume" },
      priceScaleId: "",
      color: "#c89f52",
    });
    volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    indicatorSeriesRef.current = {
      sma20: chart.addLineSeries({ color: "#f2c94c", lineWidth: 1, priceLineVisible: false, lastValueVisible: false }),
      sma50: chart.addLineSeries({ color: "#56ccf2", lineWidth: 1, priceLineVisible: false, lastValueVisible: false }),
      sma200: chart.addLineSeries({ color: "#bb6bd9", lineWidth: 1, priceLineVisible: false, lastValueVisible: false }),
      vwap: chart.addLineSeries({ color: "#f2994a", lineWidth: 2, priceLineVisible: false, lastValueVisible: false }),
    };

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;

    const resizeObserver = new ResizeObserver(([entry]) => {
      chart.applyOptions({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      });
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      indicatorSeriesRef.current = { sma20: null, sma50: null, sma200: null, vwap: null };
    };
  }, []);

  useEffect(() => {
    if (!chartRef.current || !candleSeriesRef.current || !volumeSeriesRef.current) return;
    candleSeriesRef.current.setData(candles);
    const volumeData: HistogramData[] = candles.map((candle) => ({
      time: candle.time,
      value: showVolume ? candle.volume : 0,
      color: candle.close >= candle.open ? "rgba(56, 193, 114, 0.38)" : "rgba(228, 86, 73, 0.38)",
    }));
    volumeSeriesRef.current.setData(volumeData);
    candleSeriesRef.current.setMarkers(markers);
    indicatorSeriesRef.current.sma20?.setData(indicators.sma20);
    indicatorSeriesRef.current.sma50?.setData(indicators.sma50);
    indicatorSeriesRef.current.sma200?.setData(indicators.sma200);
    indicatorSeriesRef.current.vwap?.setData(indicators.vwap);
    if (candles.length) chartRef.current.timeScale().fitContent();
  }, [candles, indicators, markers, showVolume]);

  return <div className="chart-surface" ref={containerRef} />;
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" | "warn" }) {
  return (
    <div className={`metric ${tone ?? ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function App() {
  const [view, setView] = useState<View>("menu");
  const [options, setOptions] = useState<OptionsPayload | null>(null);
  const [error, setError] = useState<string>("");
  const [settings, setSettings] = useState<SettingsState>(() => loadSettings());
  const [history, setHistory] = useState<Scorecard[]>(() => loadHistory());
  const [activeControllerBind, setActiveControllerBind] = useState<string | null>(null);
  const [virtualCursor, setVirtualCursor] = useState<VirtualCursorState>(() => ({
    x: window.innerWidth / 2,
    y: window.innerHeight / 2,
    visible: false,
    pressed: false,
  }));
  const [setup, setSetup] = useState<SetupState>(() => ({
    mode: "standard",
    assetClass: "Random",
    scenario: "Random",
    timeframe: DEFAULT_SETTINGS.defaultTimeframe,
    startingCapital: DEFAULT_SETTINGS.defaultStartingCapital,
    replaySpeed: DEFAULT_SETTINGS.defaultReplaySpeed,
    practiceDate: "",
  }));

  const [activeSession, setActiveSession] = useState<StartSessionResponse | null>(null);
  const [ticks, setTicks] = useState<ReplayTick[]>([]);
  const [currentTickIndex, setCurrentTickIndex] = useState(-1);
  const [paused, setPaused] = useState(false);
  const [currentSpeed, setCurrentSpeed] = useState<ReplaySpeed>("Normal");
  const [chartTimeframe, setChartTimeframe] = useState<Timeframe>("1m");
  const [indicators, setIndicators] = useState<IndicatorVisibility>(DEFAULT_INDICATORS);
  const [cash, setCash] = useState(25_000);
  const [shares, setShares] = useState(0);
  const [avgCost, setAvgCost] = useState(0);
  const [realizedPnl, setRealizedPnl] = useState(0);
  const [fills, setFills] = useState<TradeFill[]>([]);
  const [score, setScore] = useState<Scorecard | null>(null);
  const cursorRef = useRef<VirtualCursorState>(virtualCursor);
  const hoveredElementRef = useRef<Element | null>(null);

  useEffect(() => {
    api<OptionsPayload>("/api/sessions/options")
      .then((payload) => {
        setOptions(payload);
        setSetup((previous) => ({
          ...previous,
          practiceDate: payload.dates[0] ?? "",
          timeframe: settings.defaultTimeframe,
          replaySpeed: settings.defaultReplaySpeed,
          startingCapital: settings.defaultStartingCapital,
        }));
      })
      .catch((err: Error) => setError(err.message));
  }, []);

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  useEffect(() => {
    cursorRef.current = virtualCursor;
  }, [virtualCursor]);

  useEffect(() => {
    document.body.classList.toggle("controller-cursor-active", virtualCursor.visible);
    return () => document.body.classList.remove("controller-cursor-active");
  }, [virtualCursor.visible]);

  const currentTick = currentTickIndex >= 0 ? ticks[currentTickIndex] : undefined;
  const currentPrice = currentTick?.price ?? 0;
  const unrealizedPnl = shares > 0 && currentPrice > 0 ? (currentPrice - avgCost) * shares : 0;
  const equity = cash + shares * currentPrice;
  const displayCandles = useMemo(
    () => buildDisplayCandles(ticks.slice(0, currentTickIndex + 1), chartTimeframe),
    [ticks, currentTickIndex, chartTimeframe],
  );
  const indicatorData = useMemo(() => computeIndicators(displayCandles, indicators), [displayCandles, indicators]);
  const tradeMarkers = useMemo(() => buildTradeMarkers(fills, ticks, chartTimeframe), [fills, ticks, chartTimeframe]);
  const rsi14 = useMemo(() => latestRsi(displayCandles), [displayCandles]);

  const availableForSetup = useMemo(() => {
    if (!options) return 0;
    return options.metadata.filter((row) => {
      const assetOk = setup.assetClass === "Random" || row.assetClass === setup.assetClass;
      const scenarioOk = row.scenarioFlags[setup.scenario] === true;
      const dateOk = setup.mode !== "practice" || !setup.practiceDate || row.date === setup.practiceDate;
      return assetOk && scenarioOk && dateOk;
    }).length;
  }, [options, setup.assetClass, setup.scenario, setup.mode, setup.practiceDate]);

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
  }, []);

  const beginSession = useCallback(
    async (mode: "standard" | "practice") => {
      setError("");
      if (!options) return;
      const request = {
        assetClass: setup.assetClass,
        scenario: setup.scenario,
        timeframe: setup.timeframe,
        startingCapital: setup.startingCapital,
        replaySpeed: setup.replaySpeed,
        practiceDate: mode === "practice" ? setup.practiceDate : undefined,
      };

      try {
        const session = await api<StartSessionResponse>("/api/sessions/start", {
          method: "POST",
          body: JSON.stringify(request),
        });
        const replay = await api<{ sessionId: string; ticks: ReplayTick[] }>(`/api/sessions/${session.sessionId}/replay`);
        setActiveSession(session);
        setTicks(replay.ticks);
        setCurrentTickIndex(-1);
        setPaused(false);
        setCurrentSpeed(session.replaySpeed);
        setChartTimeframe(session.timeframe);
        resetAccount(session.startingCapital);
        setView("play");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unable to start session");
      }
    },
    [options, resetAccount, setup],
  );

  const changeSpeed = useCallback((direction: -1 | 1) => {
    setCurrentSpeed((speed) => {
      const index = SPEED_ORDER.indexOf(speed);
      const nextIndex = Math.max(0, Math.min(SPEED_ORDER.length - 1, index + direction));
      return SPEED_ORDER[nextIndex];
    });
  }, []);

  const togglePauseOrStep = useCallback(() => {
    if (currentSpeed === "Manual") {
      stepReplay();
      return;
    }
    setPaused((value) => !value);
  }, [currentSpeed, stepReplay]);

  const addFill = useCallback((fill: Omit<TradeFill, "id">) => {
    setFills((previous) => [{ ...fill, id: crypto.randomUUID() }, ...previous]);
  }, []);

  const buyAmount = useCallback(
    (amount: number) => {
      if (!currentTick || currentPrice <= 0 || cash <= 0) return;
      const spend = Math.min(amount, cash);
      const quantity = spend / currentPrice;
      setAvgCost((previous) => ((previous * shares + spend) / (shares + quantity)));
      setShares((previous) => previous + quantity);
      setCash((previous) => previous - spend);
      addFill({
        side: "buy",
        quantity,
        price: currentPrice,
        tickIndex: currentTick.tickIndex,
        timestamp: currentTick.timestamp,
      });
    },
    [addFill, cash, currentPrice, currentTick, shares],
  );

  const sellFraction = useCallback(
    (fraction: number) => {
      if (!currentTick || currentPrice <= 0 || shares <= 0) return;
      const quantity = fraction >= 1 ? shares : shares * fraction;
      const proceeds = quantity * currentPrice;
      const pnl = (currentPrice - avgCost) * quantity;
      setCash((previous) => previous + proceeds);
      setShares((previous) => {
        const next = Math.max(0, previous - quantity);
        if (next === 0) setAvgCost(0);
        return next;
      });
      setRealizedPnl((previous) => previous + pnl);
      addFill({
        side: "sell",
        quantity,
        price: currentPrice,
        tickIndex: currentTick.tickIndex,
        timestamp: currentTick.timestamp,
      });
    },
    [addFill, avgCost, currentPrice, currentTick, shares],
  );

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
      setScore(result);
      setHistory((previous) => {
        const next = [result, ...previous];
        saveHistory(next);
        return next.slice(0, 50);
      });
      setView("score");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to score session");
    }
  }, [activeSession, fills]);

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
      if (action === "buy1000") buyAmount(1000);
      if (action === "buy5000") buyAmount(5000);
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
    [activateVirtualCursorTarget, backFromController, buyAmount, changeSpeed, endSession, sellFraction, togglePauseOrStep],
  );

  useEffect(() => {
    if (view !== "play") return;

    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName)) return;

      const bindings = settings.keyboard;
      if (keyMatches(event, bindings.buy1000)) {
        event.preventDefault();
        buyAmount(1000);
      } else if (keyMatches(event, bindings.buy5000)) {
        event.preventDefault();
        buyAmount(5000);
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
  }, [buyAmount, changeSpeed, endSession, sellFraction, settings.keyboard, togglePauseOrStep, view]);

  useEffect(() => {
    let frame = 0;
    let lastFrame = performance.now();
    let previousButtons: boolean[] = [];
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
  }, [activeControllerBind, controllerAction, settings.controller, settings.controllerCursorSpeed, view]);

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
      controller: CONTROLLER_PRESETS[profile],
    }));
  };

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

  const setupHeader = setup.mode === "practice" ? "Practice Mode" : "Start Session";

  return (
    <main className="app-shell" onMouseMove={handleMouseMove}>
      <header className="topbar">
        <div>
          <span className="eyebrow">Localhost Prototype</span>
          <h1>Trading Replay</h1>
        </div>
        <div className="status-strip">
          <span>SPY</span>
          <span>2 sessions</span>
          <span>{API_BASE.replace("http://", "")}</span>
        </div>
      </header>

      {error && (
        <div className="alert" role="alert">
          {error}
          <button type="button" onClick={() => setError("")}>Dismiss</button>
        </div>
      )}

      {view === "menu" && (
        <section className="menu-layout">
          <button className="menu-action primary" type="button" onClick={() => { setSetup((s) => ({ ...s, mode: "standard", timeframe: settings.defaultTimeframe, replaySpeed: settings.defaultReplaySpeed, startingCapital: settings.defaultStartingCapital })); setView("setup"); }}>
            <Play size={22} />
            <span>Start Session</span>
          </button>
          <button className="menu-action" type="button" onClick={() => { setSetup((s) => ({ ...s, mode: "practice", timeframe: settings.defaultTimeframe, replaySpeed: settings.defaultReplaySpeed, startingCapital: settings.defaultStartingCapital })); setView("setup"); }}>
            <StepForward size={22} />
            <span>Practice Mode</span>
          </button>
          <button className="menu-action" type="button" onClick={() => setView("settings")}>
            <Settings size={22} />
            <span>Settings</span>
          </button>
          <button className="menu-action" type="button" onClick={() => setView("history")}>
            <History size={22} />
            <span>View Past Sessions</span>
          </button>
          <button className="menu-action" type="button" onClick={() => window.close()}>
            <Square size={22} />
            <span>Quit</span>
          </button>
        </section>
      )}

      {view === "setup" && (
        <section className="setup-layout">
          <div className="section-heading">
            <button type="button" className="ghost" onClick={() => setView("menu")}>Back</button>
            <h2>{setupHeader}</h2>
          </div>

          <div className="setup-grid">
            <label>
              Asset Class
              <select value={setup.assetClass} onChange={(event) => setSetup((s) => ({ ...s, assetClass: event.target.value }))}>
                {options?.assetClasses.map((item) => (
                  <option key={item.label} value={item.label}>
                    {item.label} {item.availableCount ? `(${item.availableCount})` : ""}
                  </option>
                ))}
              </select>
            </label>

            <label>
              Scenario
              <select value={setup.scenario} onChange={(event) => setSetup((s) => ({ ...s, scenario: event.target.value }))}>
                {options?.scenarios.map((item) => (
                  <option key={item.label} value={item.label}>
                    {item.label} {item.availableCount ? `(${item.availableCount})` : ""}
                  </option>
                ))}
              </select>
            </label>

            <label>
              Chart Timeframe
              <select value={setup.timeframe} onChange={(event) => setSetup((s) => ({ ...s, timeframe: event.target.value as Timeframe }))}>
                {options?.timeframes.map((timeframe) => <option key={timeframe}>{timeframe}</option>)}
              </select>
            </label>

            <label>
              Replay Speed
              <select value={setup.replaySpeed} onChange={(event) => setSetup((s) => ({ ...s, replaySpeed: event.target.value as ReplaySpeed }))}>
                {options?.replaySpeeds.map((speed) => <option key={speed.label}>{speed.label}</option>)}
              </select>
            </label>

            <label>
              Starting Capital
              <input
                type="number"
                min="1000"
                step="1000"
                value={setup.startingCapital}
                onChange={(event) => setSetup((s) => ({ ...s, startingCapital: Number(event.target.value) }))}
              />
            </label>

            {setup.mode === "practice" && (
              <label>
                Practice Date
                <select value={setup.practiceDate} onChange={(event) => setSetup((s) => ({ ...s, practiceDate: event.target.value }))}>
                  {options?.dates.map((date) => <option key={date}>{date}</option>)}
                </select>
              </label>
            )}
          </div>

          <div className="capital-row">
            {options?.startingCapital.map((capital) => (
              <button
                type="button"
                className={setup.startingCapital === capital ? "selected" : ""}
                key={capital}
                onClick={() => setSetup((s) => ({ ...s, startingCapital: capital }))}
              >
                {currency(capital)}
              </button>
            ))}
          </div>

          <div className="empty-state" data-active={availableForSetup === 0}>
            {availableForSetup === 0 ? "No SPY prototype sessions match this setup." : `${availableForSetup} matching prototype session${availableForSetup === 1 ? "" : "s"}`}
          </div>

          <button className="primary cta" type="button" disabled={availableForSetup === 0 || !options} onClick={() => void beginSession(setup.mode)}>
            <Play size={20} />
            <span>{setup.mode === "practice" ? "Start Practice" : "Start Hidden Session"}</span>
          </button>
        </section>
      )}

      {view === "play" && activeSession && (
        <section className="game-layout">
          <div className="game-header">
            <div>
              <span className="eyebrow">Hidden Session</span>
              <h2>{activeSession.label.assetClass} / {activeSession.label.scenario}</h2>
            </div>
            <div className="timeframe-tabs" role="tablist" aria-label="Chart timeframe">
              {(["1m", "5m", "15m", "30m", "1h"] as Timeframe[]).map((timeframe) => (
                <button
                  type="button"
                  key={timeframe}
                  className={chartTimeframe === timeframe ? "selected" : ""}
                  onClick={() => setChartTimeframe(timeframe)}
                >
                  {timeframe}
                </button>
              ))}
            </div>
          </div>

          <div className="stats-grid">
            <Metric label="Price" value={currentPrice ? currency(currentPrice) : "Ready"} />
            <Metric label="Session Time" value={currentTick ? currentTick.timestamp.slice(11, 19) : "09:30:00"} />
            <Metric label="Speed" value={currentSpeed} />
            <Metric label="Cash" value={currency(cash)} />
            <Metric label="Shares" value={shares.toFixed(4)} />
            <Metric label="Position" value={currentPrice ? currency(shares * currentPrice) : currency(0)} />
            {settings.showPnl && <Metric label="Unrealized P&L" value={currency(unrealizedPnl)} tone={unrealizedPnl >= 0 ? "good" : "bad"} />}
            {settings.showPnl && <Metric label="Realized P&L" value={currency(realizedPnl)} tone={realizedPnl >= 0 ? "good" : "bad"} />}
            <Metric label="Equity" value={currentPrice ? currency(equity) : currency(activeSession.startingCapital)} tone={equity >= activeSession.startingCapital ? "good" : "bad"} />
            {indicators.rsi14 && <Metric label="RSI 14" value={rsi14 === null ? "..." : rsi14.toFixed(1)} />}
          </div>

          <div className="indicator-row">
            {([
              ["sma20", "SMA 20"],
              ["sma50", "SMA 50"],
              ["sma200", "SMA 200"],
              ["vwap", "VWAP"],
              ["rsi14", "RSI 14"],
            ] as [keyof IndicatorVisibility, string][]).map(([key, label]) => (
              <button
                type="button"
                key={key}
                className={indicators[key] ? "selected" : ""}
                onClick={() => setIndicators((previous) => ({ ...previous, [key]: !previous[key] }))}
              >
                {label}
              </button>
            ))}
          </div>

          <ReplayChart candles={displayCandles} indicators={indicatorData} markers={tradeMarkers} showVolume={settings.showVolume} />

          <div className="trade-controls">
            <button type="button" className="buy" onClick={() => buyAmount(1000)}>
              <ArrowUpCircle size={19} />
              <span>Buy $1,000</span>
            </button>
            <button type="button" className="buy" onClick={() => buyAmount(5000)}>
              <ArrowUpCircle size={19} />
              <span>Buy $5,000</span>
            </button>
            <button type="button" className="sell" onClick={() => sellFraction(0.5)}>
              <ArrowDownCircle size={19} />
              <span>Sell Half</span>
            </button>
            <button type="button" className="sell" onClick={() => sellFraction(1)}>
              <ArrowDownCircle size={19} />
              <span>Sell All</span>
            </button>
            <button type="button" onClick={togglePauseOrStep}>
              {currentSpeed === "Manual" ? <StepForward size={19} /> : paused ? <Play size={19} /> : <Pause size={19} />}
              <span>{currentSpeed === "Manual" ? "Next Tick" : paused ? "Resume" : "Pause"}</span>
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
                    <th>Price</th>
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
            <span>{score.date}</span>
            <span>{score.assetClass}</span>
            <span>{score.scenario}</span>
          </div>
          <div className="score-grid">
            <Metric label="Final P&L" value={currency(score.finalPnl)} tone={score.finalPnl >= 0 ? "good" : "bad"} />
            <Metric label="Return" value={pct(score.returnPct)} tone={score.returnPct >= 0 ? "good" : "bad"} />
            <Metric label="Score" value={pct(score.score)} tone={score.score >= 0 ? "good" : "bad"} />
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
        </section>
      )}

      {view === "settings" && (
        <section className="settings-layout">
          <div className="section-heading">
            <button type="button" className="ghost" onClick={() => setView("menu")}>Back</button>
            <h2>Settings</h2>
          </div>

          <div className="settings-grid">
            <label>
              Default Replay Speed
              <select value={settings.defaultReplaySpeed} onChange={(event) => updateSetting("defaultReplaySpeed", event.target.value as ReplaySpeed)}>
                {(["Slow", "Normal", "Fast", "Manual"] as ReplaySpeed[]).map((speed) => <option key={speed}>{speed}</option>)}
              </select>
            </label>
            <label>
              Default Timeframe
              <select value={settings.defaultTimeframe} onChange={(event) => updateSetting("defaultTimeframe", event.target.value as Timeframe)}>
                {(["1m", "5m", "15m", "30m", "1h"] as Timeframe[]).map((timeframe) => <option key={timeframe}>{timeframe}</option>)}
              </select>
            </label>
            <label>
              Default Capital
              <input type="number" min="1000" step="1000" value={settings.defaultStartingCapital} onChange={(event) => updateSetting("defaultStartingCapital", Number(event.target.value))} />
            </label>
            <label>
              Controller Profile
              <select value={settings.controllerProfile} onChange={(event) => updateControllerProfile(event.target.value as ControllerProfile)}>
                <option>Xbox</option>
                <option>PlayStation</option>
              </select>
            </label>
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
            <label className="check-row">
              <input type="checkbox" checked={settings.sound} onChange={(event) => updateSetting("sound", event.target.checked)} />
              Sound
            </label>
            <label className="check-row">
              <input type="checkbox" checked={settings.showVolume} onChange={(event) => updateSetting("showVolume", event.target.checked)} />
              Volume
            </label>
            <label className="check-row">
              <input type="checkbox" checked={settings.showPnl} onChange={(event) => updateSetting("showPnl", event.target.checked)} />
              P&L
            </label>
          </div>

          <div className="binding-section">
            <h3>Keyboard Bindings</h3>
            <div className="binding-grid">
              {Object.entries(settings.keyboard).map(([action, value]) => (
                <label key={action}>
                  {ACTION_LABELS[action] ?? action}
                  <input value={value === " " ? "Space" : value} onChange={(event) => updateKeyBinding(action, event.target.value)} />
                </label>
              ))}
            </div>
          </div>

          <div className="binding-section">
            <h3>{settings.controllerProfile} Controller Bindings</h3>
            <div className="binding-grid">
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
                      <ControllerButtonChip value={settings.controller[action]} profile={settings.controllerProfile} />
                    )}
                  </button>
                  <button className="binding-clear" type="button" onClick={() => clearControllerBinding(action)}>
                    Clear
                  </button>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {view === "history" && (
        <section className="history-layout">
          <div className="section-heading">
            <button type="button" className="ghost" onClick={() => setView("menu")}>Back</button>
            <h2>Past Sessions</h2>
          </div>
          {history.length === 0 ? (
            <div className="empty-state" data-active="true">No completed sessions yet.</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Ticker</th>
                  <th>Scenario</th>
                  <th>P&L</th>
                  <th>Return</th>
                  <th>Score</th>
                </tr>
              </thead>
              <tbody>
                {history.map((item, index) => (
                  <tr key={`${item.date}-${index}`}>
                    <td>{item.date}</td>
                    <td>{item.ticker}</td>
                    <td>{item.scenario}</td>
                    <td>{currency(item.finalPnl)}</td>
                    <td>{pct(item.returnPct)}</td>
                    <td>{pct(item.score)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
      <div
        aria-hidden="true"
        className={`virtual-cursor ${virtualCursor.visible ? "visible" : ""} ${virtualCursor.pressed ? "pressed" : ""}`}
        style={{ transform: `translate(${virtualCursor.x - 10}px, ${virtualCursor.y - 10}px)` }}
      />
    </main>
  );
}

export default App;
