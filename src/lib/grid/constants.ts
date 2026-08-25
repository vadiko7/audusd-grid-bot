/** AUDUSD Short Geometric Grid — Lighter DEX. Spec constants only. */

export const SYMBOL = "AUDUSD";
export const MARKET_ID = 106;
export const MAX_LEVERAGE = 25;
export const MARGIN_MODE = "cross" as const;
export const ORDER_NOTIONAL = 100;

export const PRICE_DECIMALS = 5;
export const SIZE_DECIMALS = 1;

export const DEFAULT_SPACING_PCT = 0.5;
export const DEFAULT_FACTOR = 1.005;

export const ATR_PERIOD = 14;
export const ATR_SPACING_MULT = 0.8;
export const SPACING_MIN_PCT = 0.3;
export const SPACING_MAX_PCT = 1.0;
export const SPACING_CHANGE_THRESHOLD_PCT = 0.1;
export const LOW_SPACING_PCT = 0.35;
export const HIGH_SPACING_PCT = 0.85;

export const REGIME_LOW = 0.45;
export const REGIME_HIGH = 0.8;
export const REGIME_EXTREME = 1.2;
export const REGIME_HYSTERESIS_BARS = 2;

export const IMPULSE_TRIGGER_PCT = 0.28;
export const IMPULSE_COOL_PCT = 0.1;
export const IMPULSE_WINDOW_MS = 50_000;

export const PROXIMITY_MULT = 2;
export const PROXIMITY_MIN_PCT = 0.5;
export const PROXIMITY_MAX_PCT = 1.5;

export const ADVERSE_STEPS = 1.75;
export const FLAT_NOTIONAL_EPS = 1;

export const BASE_CYCLE_MS = 1500;
export const ELEVATED_CYCLE_MS = 250;
export const RECENT_FILL_ELEVATED_MS = 30_000;
export const VELOCITY_SPIKE_PCT = 0.08;
export const VELOCITY_SPIKE_WINDOW_MS = 5_000;

export const MARK_STALE_MS = 4_000;
export const LOG_LIMIT = 400;
export const MARK_HISTORY_LIMIT = 360;
export const MAX_WORKING_ORDERS = 2;

export const LIGHTER_REST = "https://mainnet.zklighter.elliot.ai";
export const LIGHTER_WS = "wss://mainnet.zklighter.elliot.ai/stream";
