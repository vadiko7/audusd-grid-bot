import { AUDUSD, type MarketProfile } from "./markets.ts";
import { ADVERSE_STEPS, ORDER_NOTIONAL, PRICE_DECIMALS, SIZE_DECIMALS } from "./constants.ts";

export function roundTo(value: number, decimals: number): number {
  const m = 10 ** decimals;
  return Math.round(value * m) / m;
}

export function roundPrice(price: number, decimals = PRICE_DECIMALS): number {
  return roundTo(price, decimals);
}

export function roundQty(qty: number, decimals = SIZE_DECIMALS): number {
  return roundTo(qty, decimals);
}

export function baseQty(mark: number, notional = ORDER_NOTIONAL, sizeDecimals = SIZE_DECIMALS): number {
  if (mark <= 0 || notional <= 0) return 0;
  return roundQty(notional / mark, sizeDecimals);
}

export function factorFromSpacing(spacingPct: number): number {
  return 1 + spacingPct / 100;
}

export function upLevel(price: number, factor: number, priceDecimals = PRICE_DECIMALS): number {
  return roundPrice(price * factor, priceDecimals);
}

export function downLevel(price: number, factor: number, priceDecimals = PRICE_DECIMALS): number {
  return roundPrice(price / factor, priceDecimals);
}

export function proximityPct(spacingPct: number, market: MarketProfile = AUDUSD): number {
  return market.proximityMult * spacingPct;
}

export function inProximity(price: number, target: number, proxPct: number): boolean {
  if (target <= 0) return false;
  return Math.abs(price - target) / target <= proxPct / 100;
}

export function stepsAway(from: number, to: number, factor: number): number {
  if (from <= 0 || to <= 0 || factor <= 1) return 0;
  return Math.abs(Math.log(to / from) / Math.log(factor));
}

export function adverseAgainstShort(anchor: number, mark: number, factor: number, steps = ADVERSE_STEPS): boolean {
  if (anchor <= 0 || mark <= anchor) return false;
  return stepsAway(anchor, mark, factor) >= steps;
}

export function adverseAgainstLong(anchor: number, mark: number, factor: number, steps = ADVERSE_STEPS): boolean {
  if (anchor <= 0 || mark >= anchor) return false;
  return stepsAway(anchor, mark, factor) >= steps;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function signedSize(side: "buy" | "sell", qty: number): number {
  return side === "buy" ? qty : -qty;
}
