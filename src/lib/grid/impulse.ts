import { IMPULSE_COOL_PCT, IMPULSE_TRIGGER_PCT, IMPULSE_WINDOW_MS } from "./constants.ts";
import type { Impulse, MarkTick } from "./types.ts";

export function sampleNear(history: MarkTick[], targetT: number): MarkTick | null {
  if (history.length === 0) return null;
  let best = history[0]!;
  let bestDist = Math.abs(best.t - targetT);
  for (const tick of history) {
    const dist = Math.abs(tick.t - targetT);
    if (dist < bestDist) {
      best = tick;
      bestDist = dist;
    }
  }
  return best;
}

export function velocityPct(history: MarkTick[], mark: number, now: number, windowMs: number): number {
  if (mark <= 0 || history.length < 2) return 0;
  const ref = sampleNear(history, now - windowMs);
  if (!ref || ref.p <= 0) return 0;
  if (Math.abs(now - ref.t - windowMs) > windowMs * 0.45) return 0;
  return ((mark - ref.p) / ref.p) * 100;
}

export function candleDeltaPct(open: number, close: number): number {
  if (open <= 0) return 0;
  return ((close - open) / open) * 100;
}

export function nextImpulse(prev: Impulse, signedPct: number): Impulse {
  const mag = Math.abs(signedPct);
  if (mag < IMPULSE_COOL_PCT) return "none";
  if (signedPct >= IMPULSE_TRIGGER_PCT) return "buy";
  if (signedPct <= -IMPULSE_TRIGGER_PCT) return "sell";
  return prev;
}

export function resolveImpulse(opts: {
  prev: Impulse;
  history: MarkTick[];
  mark: number;
  now: number;
  minuteOpen?: number | null;
  minuteClose?: number | null;
}): { impulse: Impulse; deltaPct: number } {
  const vel = velocityPct(opts.history, opts.mark, opts.now, IMPULSE_WINDOW_MS);
  const candle =
    opts.minuteOpen != null && opts.minuteClose != null
      ? candleDeltaPct(opts.minuteOpen, opts.minuteClose)
      : 0;
  const signed = Math.abs(vel) >= Math.abs(candle) ? vel : candle;
  return { impulse: nextImpulse(opts.prev, signed), deltaPct: signed };
}
