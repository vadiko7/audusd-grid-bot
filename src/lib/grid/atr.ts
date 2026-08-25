import {
  ATR_PERIOD,
  ATR_SPACING_MULT,
  DEFAULT_SPACING_PCT,
  HIGH_SPACING_PCT,
  LOW_SPACING_PCT,
  REGIME_EXTREME,
  REGIME_HIGH,
  REGIME_HYSTERESIS_BARS,
  REGIME_LOW,
  SPACING_MAX_PCT,
  SPACING_MIN_PCT,
} from "./constants.ts";
import { clamp } from "./math.ts";
import type { Candle, Regime } from "./types.ts";

export function trueRange(candle: Candle, prevClose: number | null): number {
  const hl = candle.h - candle.l;
  if (prevClose == null) return Math.max(hl, 0);
  return Math.max(hl, Math.abs(candle.h - prevClose), Math.abs(candle.l - prevClose));
}

export function atr(candles: Candle[], period = ATR_PERIOD): number {
  if (candles.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    const prev = i === 0 ? null : candles[i - 1]!.c;
    trs.push(trueRange(candles[i]!, prev));
  }
  const slice = trs.slice(-period);
  if (slice.length === 0) return 0;
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

export function atrPct(atrValue: number, mark: number): number {
  if (mark <= 0) return 0;
  return (atrValue / mark) * 100;
}

export function classifyRegime(atrPercent: number): Regime {
  if (atrPercent > REGIME_EXTREME) return "extreme";
  if (atrPercent > REGIME_HIGH) return "high";
  if (atrPercent < REGIME_LOW) return "low";
  return "normal";
}

export function spacingFromAtr(atrPercent: number): number {
  return clamp(atrPercent * ATR_SPACING_MULT, SPACING_MIN_PCT, SPACING_MAX_PCT);
}

export function spacingFromRegime(regime: Regime): number {
  if (regime === "low") return LOW_SPACING_PCT;
  if (regime === "high") return HIGH_SPACING_PCT;
  return DEFAULT_SPACING_PCT;
}

export type Hysteresis = {
  regime: Regime;
  pending: Regime | null;
  count: number;
  lastBarT: number | null;
};

export function applyRegimeHysteresis(
  current: Hysteresis,
  raw: Regime,
  barT: number | null,
): Hysteresis {
  if (raw === current.regime) {
    return { regime: current.regime, pending: null, count: 0, lastBarT: barT };
  }
  const barChanged = barT != null && barT !== current.lastBarT;
  if (!barChanged && current.lastBarT != null) {
    return current;
  }
  const samePending = current.pending === raw;
  const count = samePending ? current.count + 1 : 1;
  if (count >= REGIME_HYSTERESIS_BARS) {
    return { regime: raw, pending: null, count: 0, lastBarT: barT };
  }
  return { regime: current.regime, pending: raw, count, lastBarT: barT };
}
