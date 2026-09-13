export const LIGHTER_REST = "https://mainnet.zklighter.elliot.ai";
export const LIGHTER_WS = "wss://mainnet.zklighter.elliot.ai/stream";

export type Prefer = "long" | "short";
export type GridStrategy = "classic" | "accumulate";

export type MarketProfile = {
  symbol: string;
  marketId: number;
  prefer: Prefer;
  strategy: GridStrategy;
  maxLeverage: number;
  orderNotional: number;
  priceDecimals: number;
  sizeDecimals: number;
  defaultSpacingPct: number;
  defaultFactor: number;
  /** Take-profit side as a multiple of the entry step (sell for longs, buy for shorts). */
  tpSteps?: number;
  tpSpacingPct?: number;
  tpFactor?: number;
  atrSpacingMult: number;
  spacingMinPct: number;
  spacingMaxPct: number;
  spacingChangeThresholdPct: number;
  lowSpacingPct: number;
  highSpacingPct: number;
  regimeLow: number;
  regimeHigh: number;
  regimeExtreme: number;
  impulseTriggerPct: number;
  impulseCoolPct: number;
  impulseWindowMs: number;
  proximityMult: number;
  proximityMinPct: number;
  proximityMaxPct: number;
  adverseSteps: number;
  baseCycleMs: number;
  elevatedCycleMs: number;
  /** Long-accumulate: max long notional as a multiple of equity. */
  buyCapEquityMult?: number;
  /** Reduce-only sell fraction of ticket at/above highest_lvl. */
  harvestSellFrac?: number;
  /** Reduce-only sell fraction of ticket below highest_lvl. */
  reloadSellFrac?: number;
  minQuoteNotional?: number;
  minBaseAmount?: number;
  /** Target sleeve as a fraction of Lighter full equity (weights sum to 0.90). */
  weight?: number;
  /** w_i = position_notional / full_equity. Underweight when ≤ bandLow. */
  bandLow?: number;
  /** Informational. Does not block buys or change sell size. */
  bandHigh?: number;
};

/** Unallocated cash sleeve as a fraction of Lighter full equity. Weights sum to 0.90; this is the rest. */
export const CASH_SLEEVE_FRAC = 0.1;

/** AUDUSD Short Geometric Grid */
export const AUDUSD: MarketProfile = {
  symbol: "AUDUSD",
  marketId: 106,
  prefer: "short",
  strategy: "classic",
  maxLeverage: 25,
  orderNotional: 25,
  priceDecimals: 5,
  sizeDecimals: 1,
  defaultSpacingPct: 0.1,
  defaultFactor: 1.001,
  tpSteps: 1.1,
  tpFactor: 1.0011,
  atrSpacingMult: 0.8,
  spacingMinPct: 0.1,
  spacingMaxPct: 0.1,
  spacingChangeThresholdPct: 0.1,
  lowSpacingPct: 0.1,
  highSpacingPct: 0.1,
  regimeLow: 0.45,
  regimeHigh: 0.8,
  regimeExtreme: 1.2,
  impulseTriggerPct: 0.28,
  impulseCoolPct: 0.1,
  impulseWindowMs: 50_000,
  proximityMult: 1.25,
  proximityMinPct: 0.125,
  proximityMaxPct: 0.125,
  adverseSteps: 1.75,
  baseCycleMs: 2_000,
  elevatedCycleMs: 300,
};

/** NATGAS Long Geometric Grid — sleeve 8.1%, band 6–12% */
export const NATGAS: MarketProfile = {
  symbol: "NATGAS",
  marketId: 158,
  prefer: "long",
  strategy: "accumulate",
  maxLeverage: 10,
  orderNotional: 25,
  priceDecimals: 4,
  sizeDecimals: 2,
  defaultSpacingPct: 2.0,
  defaultFactor: 1.02,
  tpSteps: 1.1,
  tpFactor: 1.022,
  atrSpacingMult: 0.55,
  spacingMinPct: 2.0,
  spacingMaxPct: 2.0,
  spacingChangeThresholdPct: 0.15,
  lowSpacingPct: 2.0,
  highSpacingPct: 2.0,
  regimeLow: 2.5,
  regimeHigh: 5.0,
  regimeExtreme: 8.0,
  impulseTriggerPct: 0.9,
  impulseCoolPct: 0.3,
  impulseWindowMs: 50_000,
  proximityMult: 1.25,
  proximityMinPct: 2.5,
  proximityMaxPct: 2.5,
  adverseSteps: 8,
  baseCycleMs: 2_000,
  elevatedCycleMs: 300,
  buyCapEquityMult: 3,
  harvestSellFrac: 0.25,
  reloadSellFrac: 0.9,
  minQuoteNotional: 13,
  minBaseAmount: 0.01,
  weight: 0.081,
  bandLow: 0.06,
  bandHigh: 0.12,
};

/** SPCX long accumulate — cap buys at 3× equity, harvest rips, no shorts */
export const SPCX: MarketProfile = {
  symbol: "SPCX",
  marketId: 194,
  prefer: "long",
  strategy: "accumulate",
  maxLeverage: 20,
  orderNotional: 25,
  priceDecimals: 2,
  sizeDecimals: 4,
  defaultSpacingPct: 1.0,
  defaultFactor: 1.01,
  tpSteps: 1.1,
  tpFactor: 1.011,
  atrSpacingMult: 0.55,
  spacingMinPct: 1.0,
  spacingMaxPct: 1.0,
  spacingChangeThresholdPct: 0.15,
  lowSpacingPct: 1.0,
  highSpacingPct: 1.0,
  regimeLow: 2.5,
  regimeHigh: 5.0,
  regimeExtreme: 8.0,
  impulseTriggerPct: 1.75,
  impulseCoolPct: 0.5,
  impulseWindowMs: 50_000,
  proximityMult: 1.25,
  proximityMinPct: 1.25,
  proximityMaxPct: 1.25,
  adverseSteps: 8,
  baseCycleMs: 2_000,
  elevatedCycleMs: 250,
  buyCapEquityMult: 3,
  harvestSellFrac: 0.25,
  reloadSellFrac: 0.9,
  minQuoteNotional: 13,
  minBaseAmount: 0.065,
  weight: 0.198,
  bandLow: 0.18,
  bandHigh: 0.28,
};
export const TSLA: MarketProfile = {
  symbol: "TSLA",
  marketId: 112,
  prefer: "long",
  strategy: "accumulate",
  maxLeverage: 20,
  orderNotional: 25,
  priceDecimals: 2,
  sizeDecimals: 4,
  defaultSpacingPct: 0.75,
  defaultFactor: 1.0075,
  tpSteps: 1.1,
  tpFactor: 1.00825,
  atrSpacingMult: 0.55,
  spacingMinPct: 0.75,
  spacingMaxPct: 0.75,
  spacingChangeThresholdPct: 0.15,
  lowSpacingPct: 0.75,
  highSpacingPct: 0.75,
  regimeLow: 2.5,
  regimeHigh: 5.0,
  regimeExtreme: 8.0,
  impulseTriggerPct: 1.25,
  impulseCoolPct: 0.4,
  impulseWindowMs: 50_000,
  proximityMult: 1.25,
  proximityMinPct: 0.9375,
  proximityMaxPct: 0.9375,
  adverseSteps: 8,
  baseCycleMs: 2_000,
  elevatedCycleMs: 250,
  buyCapEquityMult: 3,
  harvestSellFrac: 0.25,
  reloadSellFrac: 0.9,
  minQuoteNotional: 13,
  minBaseAmount: 0.02,
  weight: 0.117,
  bandLow: 0.1,
  bandHigh: 0.17,
};

/** ETH long accumulate — $25, 0.80% entry, 50x, cap 3× equity */
export const ETH: MarketProfile = {
  symbol: "ETH",
  marketId: 0,
  prefer: "long",
  strategy: "accumulate",
  maxLeverage: 50,
  orderNotional: 25,
  priceDecimals: 2,
  sizeDecimals: 4,
  defaultSpacingPct: 0.8,
  defaultFactor: 1.008,
  tpSteps: 1.1,
  tpFactor: 1.0088,
  atrSpacingMult: 0.55,
  spacingMinPct: 0.8,
  spacingMaxPct: 0.8,
  spacingChangeThresholdPct: 0.15,
  lowSpacingPct: 0.8,
  highSpacingPct: 0.8,
  regimeLow: 2.5,
  regimeHigh: 5.0,
  regimeExtreme: 8.0,
  impulseTriggerPct: 1.25,
  impulseCoolPct: 0.4,
  impulseWindowMs: 50_000,
  proximityMult: 1.25,
  proximityMinPct: 1.0,
  proximityMaxPct: 1.0,
  adverseSteps: 8,
  baseCycleMs: 2_000,
  elevatedCycleMs: 250,
  buyCapEquityMult: 3,
  harvestSellFrac: 0.25,
  reloadSellFrac: 0.9,
  minQuoteNotional: 13,
  minBaseAmount: 0.005,
  weight: 0.063,
  bandLow: 0.05,
  bandHigh: 0.1,
};

/** GEV long accumulate — $25, 0.80% entry, 10x, cap 3× equity */
export const GEV: MarketProfile = {
  symbol: "GEV",
  marketId: 218,
  prefer: "long",
  strategy: "accumulate",
  maxLeverage: 10,
  orderNotional: 25,
  priceDecimals: 1,
  sizeDecimals: 5,
  defaultSpacingPct: 0.8,
  defaultFactor: 1.008,
  tpSteps: 1.1,
  tpFactor: 1.0088,
  atrSpacingMult: 0.55,
  spacingMinPct: 0.8,
  spacingMaxPct: 0.8,
  spacingChangeThresholdPct: 0.15,
  lowSpacingPct: 0.8,
  highSpacingPct: 0.8,
  regimeLow: 2.5,
  regimeHigh: 5.0,
  regimeExtreme: 8.0,
  impulseTriggerPct: 1.25,
  impulseCoolPct: 0.4,
  impulseWindowMs: 50_000,
  proximityMult: 1.25,
  proximityMinPct: 1.0,
  proximityMaxPct: 1.0,
  adverseSteps: 8,
  baseCycleMs: 2_000,
  elevatedCycleMs: 250,
  buyCapEquityMult: 3,
  harvestSellFrac: 0.25,
  reloadSellFrac: 0.9,
  minQuoteNotional: 13,
  minBaseAmount: 0.005,
  weight: 0.18,
  bandLow: 0.16,
  bandHigh: 0.24,
};

/** XAU long accumulate — $25, 0.50% entry, 25x, cap 3× equity */
export const XAU: MarketProfile = {
  symbol: "XAU",
  marketId: 92,
  prefer: "long",
  strategy: "accumulate",
  maxLeverage: 25,
  orderNotional: 25,
  priceDecimals: 2,
  sizeDecimals: 4,
  defaultSpacingPct: 0.5,
  defaultFactor: 1.005,
  tpSteps: 1.1,
  tpFactor: 1.0055,
  atrSpacingMult: 0.55,
  spacingMinPct: 0.5,
  spacingMaxPct: 0.5,
  spacingChangeThresholdPct: 0.15,
  lowSpacingPct: 0.5,
  highSpacingPct: 0.5,
  regimeLow: 2.5,
  regimeHigh: 5.0,
  regimeExtreme: 8.0,
  impulseTriggerPct: 0.65,
  impulseCoolPct: 0.2,
  impulseWindowMs: 50_000,
  proximityMult: 1.25,
  proximityMinPct: 0.625,
  proximityMaxPct: 0.625,
  adverseSteps: 8,
  baseCycleMs: 2_000,
  elevatedCycleMs: 250,
  buyCapEquityMult: 3,
  harvestSellFrac: 0.25,
  reloadSellFrac: 0.9,
  minQuoteNotional: 13,
  minBaseAmount: 0.002,
  weight: 0.162,
  bandLow: 0.14,
  bandHigh: 0.23,
};

/** BTC long accumulate — $25, 0.60% entry, 50x, cap 3× equity */
export const BTC: MarketProfile = {
  symbol: "BTC",
  marketId: 1,
  prefer: "long",
  strategy: "accumulate",
  maxLeverage: 50,
  orderNotional: 25,
  priceDecimals: 1,
  sizeDecimals: 5,
  defaultSpacingPct: 0.6,
  defaultFactor: 1.006,
  tpSteps: 1.1,
  tpFactor: 1.0066,
  atrSpacingMult: 0.55,
  spacingMinPct: 0.6,
  spacingMaxPct: 0.6,
  spacingChangeThresholdPct: 0.15,
  lowSpacingPct: 0.6,
  highSpacingPct: 0.6,
  regimeLow: 2.5,
  regimeHigh: 5.0,
  regimeExtreme: 8.0,
  impulseTriggerPct: 1.0,
  impulseCoolPct: 0.3,
  impulseWindowMs: 50_000,
  proximityMult: 1.25,
  proximityMinPct: 0.75,
  proximityMaxPct: 0.75,
  adverseSteps: 8,
  baseCycleMs: 2_000,
  elevatedCycleMs: 250,
  buyCapEquityMult: 3,
  harvestSellFrac: 0.25,
  reloadSellFrac: 0.9,
  minQuoteNotional: 13,
  minBaseAmount: 0.0001,
  weight: 0.099,
  bandLow: 0.08,
  bandHigh: 0.15,
};

export const MARKETS: Record<string, MarketProfile> = {
  AUDUSD,
  NATGAS,
  SPCX,
  TSLA,
  ETH,
  GEV,
  XAU,
  BTC,
};

export function parseMarkets(raw: string | undefined): MarketProfile[] {
  const names = (raw || "NATGAS,SPCX,TSLA,ETH,GEV,XAU,BTC")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const out: MarketProfile[] = [];
  for (const name of names) {
    const m = MARKETS[name];
    if (!m) throw new Error(`unknown market ${name} (AUDUSD, NATGAS, SPCX, TSLA, ETH, GEV, XAU, BTC)`);
    if (!out.some((x) => x.symbol === m.symbol)) out.push(m);
  }
  if (out.length === 0) throw new Error("MARKETS is empty");
  return out;
}
