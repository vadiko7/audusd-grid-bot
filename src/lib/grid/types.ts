export type Side = "buy" | "sell";
export type Impulse = "none" | "buy" | "sell";
export type Regime = "low" | "normal" | "high" | "extreme";
export type LogLevel =
  | "info"
  | "clean"
  | "regime"
  | "impulse"
  | "gate"
  | "fill"
  | "place"
  | "warn";

export type GridOrder = {
  id: string;
  side: Side;
  price: number;
  qty: number;
  notional: number;
  placedAt: number;
};

export type Position = {
  size: number;
  entry: number;
};

export type Fill = {
  orderId: string;
  side: Side;
  price: number;
  qty: number;
  ts: number;
};

export type Candle = {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
};

export type MarkTick = { t: number; p: number };

export type LogEvent = {
  ts: number;
  level: LogLevel;
  message: string;
  extra?: Record<string, string | number | boolean>;
};

export type LiveAccount = {
  accountIndex: number;
  equity: number;
  collateral: number;
  available: number;
  position: Position;
  positionNotional: number;
  unrealizedPnl: number;
  realizedPnl: number;
  orders: GridOrder[];
};

export type EngineAction =
  | { type: "place"; side: Side; price: number; qty: number; why: string; reduceOnly?: boolean }
  | { type: "cancel"; orderId: string; side: Side; price: number; why: string }
  | { type: "cancel_all"; why: string };

export type EngineConfig = {
  dynamicSpacing: boolean;
  armed: boolean;
  /** USD notional per grid level. Live-adjustable. */
  orderNotional: number;
  /** Test-only sim equity. Live mode ignores this. */
  startingEquity: number;
};

export type EngineState = {
  config: EngineConfig;
  now: number;
  mark: number;
  prevMark: number | null;
  factor: number;
  spacingPct: number;
  regime: Regime;
  pauseNewOpens: boolean;
  impulse: Impulse;
  impulseDeltaPct: number;
  lastFillPrice: number | null;
  lastFillSide: Side | null;
  lastFillAt: number | null;
  orders: GridOrder[];
  position: Position;
  realizedPnl: number;
  unrealizedPnl: number;
  accountEquity: number | null;
  accountSource: "none" | "live" | "sim";
  markHistory: MarkTick[];
  logs: LogEvent[];
  cycleMs: number;
  elevated: boolean;
  orderSeq: number;
  pendingRegime: Regime | null;
  pendingRegimeCount: number;
  lastAtrBarT: number | null;
  lastAppliedSpacingPct: number;
  fillsThisCycle: Fill[];
  lastCleanReason: string | null;
  hourlyCandles: Candle[];
  minuteCandle: Candle | null;
  atrPct: number;
  actions: EngineAction[];
  cancelledIds: string[];
};

export type StepInput = {
  now: number;
  mark: number;
  hourlyCandles?: Candle[];
  minuteCandle?: Candle | null;
  live?: LiveAccount | null;
};
