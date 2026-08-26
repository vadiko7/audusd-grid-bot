export const LIGHTER_REST = "https://mainnet.zklighter.elliot.ai";
export const LIGHTER_WS = "wss://mainnet.zklighter.elliot.ai/stream";

export type Prefer = "long" | "short";

export type MarketProfile = {
  symbol: string;
  marketId: number;
  prefer: Prefer;
  maxLeverage: number;
  orderNotional: number;
  priceDecimals: number;
  sizeDecimals: number;
  defaultSpacingPct: number;
  defaultFactor: number;
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
};

/** AUDUSD Short Geometric Grid */
export const AUDUSD: MarketProfile = {
  symbol: "AUDUSD",
  marketId: 106,
  prefer: "short",
  maxLeverage: 25,
  orderNotional: 25,
  priceDecimals: 5,
  sizeDecimals: 1,
  defaultSpacingPct: 0.1,
  defaultFactor: 1.001,
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
  proximityMinPct: 0.1,
  proximityMaxPct: 0.2,
  adverseSteps: 1.75,
  baseCycleMs: 2_000,
  elevatedCycleMs: 300,
};

/** NATGAS Long Geometric Grid */
export const NATGAS: MarketProfile = {
  symbol: "NATGAS",
  marketId: 158,
  prefer: "long",
  maxLeverage: 10,
  orderNotional: 25,
  priceDecimals: 4,
  sizeDecimals: 2,
  defaultSpacingPct: 0.5,
  defaultFactor: 1.005,
  atrSpacingMult: 0.55,
  spacingMinPct: 0.5,
  spacingMaxPct: 0.5,
  spacingChangeThresholdPct: 0.15,
  lowSpacingPct: 0.5,
  highSpacingPct: 0.5,
  regimeLow: 2.5,
  regimeHigh: 5.0,
  regimeExtreme: 8.0,
  impulseTriggerPct: 0.9,
  impulseCoolPct: 0.3,
  impulseWindowMs: 50_000,
  proximityMult: 1.25,
  proximityMinPct: 0.4,
  proximityMaxPct: 1.0,
  adverseSteps: 1.75,
  baseCycleMs: 2_000,
  elevatedCycleMs: 300,
};

export const MARKETS: Record<string, MarketProfile> = {
  AUDUSD,
  NATGAS,
};

export function parseMarkets(raw: string | undefined): MarketProfile[] {
  const names = (raw || "AUDUSD,NATGAS")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const out: MarketProfile[] = [];
  for (const name of names) {
    const m = MARKETS[name];
    if (!m) throw new Error(`unknown market ${name} (AUDUSD, NATGAS)`);
    if (!out.some((x) => x.symbol === m.symbol)) out.push(m);
  }
  if (out.length === 0) throw new Error("MARKETS is empty");
  return out;
}
