import type { MarketProfile } from "./markets.ts";

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
  clientOrderIndex?: number;
  /** false = someone else's / leftover; occupies the rung, never cancel */
  mine?: boolean;
  /** Impulse / cool bunch that must stay on the book until the position marks it filled. */
  holdUntilFill?: boolean;
  /** Stable id in the order journal. Survives pending → exchange id. */
  journalId?: string;
  /** Up-impulse probe. Stays until fill — a cool must not merge it just because it sits one step from the high. */
  impulseProbe?: boolean;
};

export type OpenHold = {
  side: Side;
  price: number;
  qty: number;
  reduceOnly?: boolean;
  triedAt?: number;
  /** Bot cancelled it. After the cool: bigger order if price went past it, otherwise the same limit. */
  parked?: boolean;
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

export type OrderStatus = "open" | "filled" | "canceled";

/** One row per order. impulsePct grows with the leg; impulsePctAtPlace is the size when we sent it. */
export type OrderRecord = {
  id: string;
  exchangeId: string;
  symbol: string;
  side: Side;
  price: number;
  qty: number;
  notional: number;
  reduceOnly: boolean;
  why: string;
  impulse: Impulse;
  /** |extreme − origin| / origin × 100 while this order was open. Frozen on fill or cancel. */
  impulsePct: number;
  /** Same measure at the moment the order was sent. */
  impulsePctAtPlace: number;
  placedAt: number;
  mark: number;
  status: OrderStatus;
  closedAt: number | null;
  closePx: number | null;
  pnl: number | null;
};

export type OrderEvent = OrderRecord & { event: "place" | "filled" | "canceled" | "update" };

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
  /** USD margin already used by other markets on this account. */
  foreignMargin: number;
};

export type EngineAction =
  | { type: "place"; side: Side; price: number; qty: number; why: string; reduceOnly?: boolean; exec?: "limit" }
  | { type: "cancel"; orderId: string; side: Side; price: number; why: string }
  | { type: "cancel_all"; why: string };

export type EngineConfig = {
  market: MarketProfile;
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
  impulseJustCooled: boolean;
  impulseCooledFrom: Impulse | null;
  /** Set on a cool whose retrace is already a full opposite impulse. Armed after the cool bunch, no second bunch. */
  impulseArmNext: "buy" | "sell" | null;
  /** Extreme of the leg that just cooled. Origin of the opposite impulse. */
  impulseTurn: number | null;
  /** lastFill (or mark) when the current impulse started. */
  impulseOrigin: number | null;
  /** Furthest mark in the impulse direction. Bunch size uses this, not the bounce. */
  impulseExtreme: number | null;
  /** First price of this direction. The one cool bunch is measured from here. */
  campaignOrigin: number | null;
  campaignSide: "buy" | "sell" | null;
  /** Furthest price of this direction. A new extreme before the first bunch can extend the same leg. */
  campaignExtreme: number | null;
  /** This direction already placed its cool bunch. Do not cool again until the other direction starts. */
  campaignBunched: boolean;
  /** While flat impulse: measure the next leg from here instead of the stale last fill. */
  impulseAnchor: number | null;
  /** One-ticket reduce-only sell placed because the buy cap blocked a dump buy. */
  relief: { qty: number; baselinePos: number; price: number } | null;
  foreignMargin: number;
  cancelSentAt: Record<string, number>;
  unackedPosDelta: number;
  /** Accumulate: ratchet high-water fill. Never decreases. */
  highestLvl: number | null;
  /** Live order ids of resting bunch limits (persist across ingest / restart). */
  holdIds: string[];
  /** Cool / impulse limits to keep replacing until a real fill. */
  openHolds: OpenHold[];
  /** Sell rungs that filled (or vanished at/through mark). Do not re-place. */
  soldRungs: Array<{ price: number; at: number }>;
  /** Every bot order, from place until fill or cancel. Capped; the desk and CSV keep the tail. */
  orderLog: OrderRecord[];
  /** Events emitted this step. The process appends them to data/orders.csv. */
  orderEvents: OrderEvent[];
  journalSeq: number;
  /** This up-impulse already sent its one buy. Cleared when the leg ends. */
  upProbe: boolean;
  /** Excursion of the leg that just ended. Cool-catch orders inherit it. */
  lastLegPct: number;
  lastLegSide: Impulse;
  /** True only while the cool catch is placing. */
  orderLeg: boolean;
};

export type StepInput = {
  now: number;
  mark: number;
  hourlyCandles?: Candle[];
  minuteCandle?: Candle | null;
  live?: LiveAccount | null;
};

export type PublicSnapshot = {
  symbol: string;
  prefer: "long" | "short";
  marketId: number;
  mark: number;
  equity: number;
  remaining: number;
  positionNotional: number;
  pendingNotional: number;
  position: Position;
  realizedPnl: number;
  unrealizedPnl: number;
  orders: GridOrder[];
  logs: LogEvent[];
  regime: Regime;
  pauseNewOpens: boolean;
  impulse: Impulse;
  impulseDeltaPct: number;
  spacingPct: number;
  factor: number;
  atrPct: number;
  cycleMs: number;
  elevated: boolean;
  armed: boolean;
  dynamicSpacing: boolean;
  orderNotional: number;
  accountSource: EngineState["accountSource"];
  lastFillPrice: number | null;
  lastFillAt: number | null;
  lastFillSide: Side | null;
  highestLvl: number | null;
  buyCap: number;
  buyUsed: number;
  levels: { sell: number; buy: number };
  bias: "short" | "long" | "flat";
};
