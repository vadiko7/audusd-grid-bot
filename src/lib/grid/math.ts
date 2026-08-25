import {
  ADVERSE_STEPS,
  ORDER_NOTIONAL,
  PRICE_DECIMALS,
  PROXIMITY_MAX_PCT,
  PROXIMITY_MIN_PCT,
  PROXIMITY_MULT,
  SIZE_DECIMALS,
} from "./constants.ts";

const PRICE_MULT = 10 ** PRICE_DECIMALS;
const SIZE_MULT = 10 ** SIZE_DECIMALS;

export function roundPrice(price: number): number {
  return Math.round(price * PRICE_MULT) / PRICE_MULT;
}

export function roundQty(qty: number): number {
  return Math.round(qty * SIZE_MULT) / SIZE_MULT;
}

export function baseQty(mark: number, notional = ORDER_NOTIONAL): number {
  if (mark <= 0 || notional <= 0) return 0;
  return roundQty(notional / mark);
}

export function factorFromSpacing(spacingPct: number): number {
  return 1 + spacingPct / 100;
}

export function upLevel(price: number, factor: number): number {
  return roundPrice(price * factor);
}

export function downLevel(price: number, factor: number): number {
  return roundPrice(price / factor);
}

export function proximityPct(spacingPct: number): number {
  return clamp(PROXIMITY_MULT * spacingPct, PROXIMITY_MIN_PCT, PROXIMITY_MAX_PCT);
}

export function inProximity(price: number, target: number, proxPct: number): boolean {
  if (target <= 0) return false;
  return Math.abs(price - target) / target <= proxPct / 100;
}

export function stepsAway(from: number, to: number, factor: number): number {
  if (from <= 0 || to <= 0 || factor <= 1) return 0;
  return Math.abs(Math.log(to / from) / Math.log(factor));
}

export function adverseAgainstShort(anchor: number, mark: number, factor: number): boolean {
  if (anchor <= 0 || mark <= anchor) return false;
  return stepsAway(anchor, mark, factor) >= ADVERSE_STEPS;
}

export function adverseAgainstLong(anchor: number, mark: number, factor: number): boolean {
  if (anchor <= 0 || mark >= anchor) return false;
  return stepsAway(anchor, mark, factor) >= ADVERSE_STEPS;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function signedSize(side: "buy" | "sell", qty: number): number {
  return side === "buy" ? qty : -qty;
}
