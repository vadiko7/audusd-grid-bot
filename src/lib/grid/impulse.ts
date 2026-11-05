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

export function nextImpulse(prev: Impulse, signedPct: number, trigger = IMPULSE_TRIGGER_PCT, cool = IMPULSE_COOL_PCT): Impulse {
  const mag = Math.abs(signedPct);
  if (mag < cool) return "none";
  if (signedPct >= trigger) return "buy";
  if (signedPct <= -trigger) return "sell";
  return prev;
}

/** Move from anchor (last fill or post-cool mark). No time window.
 *  A hot impulse ends only on a correction >= cool — even if that correction
 *  is already large enough to be the opposite impulse. The engine cools first
 *  (one bunch) and may arm the other leg after. Never jump sell↔buy here.
 */
export function excursionImpulse(opts: {
  prev: Impulse;
  mark: number;
  anchor: number;
  extreme: number | null;
  trigger: number;
  cool: number;
}): { impulse: Impulse; deltaPct: number; retracePct: number } {
  const { prev, mark, anchor, trigger, cool } = opts;
  if (!(mark > 0) || !(anchor > 0) || !(trigger > 0)) return { impulse: "none", deltaPct: 0, retracePct: 0 };
  const fromOrigin = ((mark - anchor) / anchor) * 100;
  if (prev === "none" || opts.extreme == null) {
    if (fromOrigin >= trigger) return { impulse: "buy", deltaPct: fromOrigin, retracePct: 0 };
    if (fromOrigin <= -trigger) return { impulse: "sell", deltaPct: fromOrigin, retracePct: 0 };
    return { impulse: "none", deltaPct: fromOrigin, retracePct: 0 };
  }
  if (prev === "sell") {
    const low = Math.min(opts.extreme, mark);
    const bounce = low > 0 ? ((mark - low) / low) * 100 : 0;
    if (bounce >= cool) return { impulse: "none", deltaPct: fromOrigin, retracePct: bounce };
    return { impulse: "sell", deltaPct: fromOrigin, retracePct: bounce };
  }
  const high = Math.max(opts.extreme, mark);
  const dip = high > 0 ? ((high - mark) / high) * 100 : 0;
  if (dip >= cool) return { impulse: "none", deltaPct: fromOrigin, retracePct: dip };
  return { impulse: "buy", deltaPct: fromOrigin, retracePct: dip };
}

export function resolveImpulse(opts: {
  prev: Impulse;
  history: MarkTick[];
  mark: number;
  now: number;
  minuteOpen?: number | null;
  minuteClose?: number | null;
  triggerPct?: number;
  coolPct?: number;
  windowMs?: number;
}): { impulse: Impulse; deltaPct: number } {
  const windowMs = opts.windowMs ?? IMPULSE_WINDOW_MS;
  const vel = velocityPct(opts.history, opts.mark, opts.now, windowMs);
  const candle =
    opts.minuteOpen != null && opts.minuteClose != null
      ? candleDeltaPct(opts.minuteOpen, opts.minuteClose)
      : 0;
  const signed = Math.abs(vel) >= Math.abs(candle) ? vel : candle;
  return {
    impulse: nextImpulse(opts.prev, signed, opts.triggerPct ?? IMPULSE_TRIGGER_PCT, opts.coolPct ?? IMPULSE_COOL_PCT),
    deltaPct: signed,
  };
}
