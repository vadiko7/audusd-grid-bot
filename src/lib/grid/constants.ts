/** Back-compat AUDUSD constants. Spec lives in markets.ts. */
export {
  LIGHTER_REST,
  LIGHTER_WS,
} from "./markets.ts";
import { AUDUSD } from "./markets.ts";

export const SYMBOL = AUDUSD.symbol;
export const MARKET_ID = AUDUSD.marketId;
export const MAX_LEVERAGE = AUDUSD.maxLeverage;
export const MARGIN_MODE = "cross" as const;
export const ORDER_NOTIONAL = AUDUSD.orderNotional;
export const PRICE_DECIMALS = AUDUSD.priceDecimals;
export const SIZE_DECIMALS = AUDUSD.sizeDecimals;
export const DEFAULT_SPACING_PCT = AUDUSD.defaultSpacingPct;
export const DEFAULT_FACTOR = AUDUSD.defaultFactor;
export const ATR_PERIOD = 14;
export const ATR_SPACING_MULT = AUDUSD.atrSpacingMult;
export const SPACING_MIN_PCT = AUDUSD.spacingMinPct;
export const SPACING_MAX_PCT = AUDUSD.spacingMaxPct;
export const SPACING_CHANGE_THRESHOLD_PCT = AUDUSD.spacingChangeThresholdPct;
export const LOW_SPACING_PCT = AUDUSD.lowSpacingPct;
export const HIGH_SPACING_PCT = AUDUSD.highSpacingPct;
export const REGIME_LOW = AUDUSD.regimeLow;
export const REGIME_HIGH = AUDUSD.regimeHigh;
export const REGIME_EXTREME = AUDUSD.regimeExtreme;
export const REGIME_HYSTERESIS_BARS = 2;
export const IMPULSE_TRIGGER_PCT = AUDUSD.impulseTriggerPct;
export const IMPULSE_COOL_PCT = AUDUSD.impulseCoolPct;
export const IMPULSE_WINDOW_MS = AUDUSD.impulseWindowMs;
export const PROXIMITY_MULT = AUDUSD.proximityMult;
export const PROXIMITY_MIN_PCT = AUDUSD.proximityMinPct;
export const PROXIMITY_MAX_PCT = AUDUSD.proximityMaxPct;
export const ADVERSE_STEPS = AUDUSD.adverseSteps;
export const FLAT_NOTIONAL_EPS = 1;
export const BASE_CYCLE_MS = AUDUSD.baseCycleMs;
export const ELEVATED_CYCLE_MS = AUDUSD.elevatedCycleMs;
export const RECENT_FILL_ELEVATED_MS = 30_000;
export const VELOCITY_SPIKE_PCT = 0.08;
export const VELOCITY_SPIKE_WINDOW_MS = 5_000;
export const MARK_STALE_MS = 4_000;
export const LOG_LIMIT = 400;
export const MARK_HISTORY_LIMIT = 360;
export const MAX_WORKING_ORDERS = 2;
