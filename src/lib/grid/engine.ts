import {
  ADVERSE_STEPS,
  BASE_CYCLE_MS,
  DEFAULT_FACTOR,
  DEFAULT_SPACING_PCT,
  ELEVATED_CYCLE_MS,
  FLAT_NOTIONAL_EPS,
  LOG_LIMIT,
  MARK_HISTORY_LIMIT,
  MAX_LEVERAGE,
  ORDER_NOTIONAL,
  RECENT_FILL_ELEVATED_MS,
  SPACING_CHANGE_THRESHOLD_PCT,
  VELOCITY_SPIKE_PCT,
  VELOCITY_SPIKE_WINDOW_MS,
} from "./constants.ts";
import { applyRegimeHysteresis, atr, atrPct, classifyRegime, spacingFromAtr } from "./atr.ts";
import { resolveImpulse, velocityPct } from "./impulse.ts";
import {
  adverseAgainstLong,
  adverseAgainstShort,
  baseQty,
  downLevel,
  factorFromSpacing,
  inProximity,
  proximityPct,
  roundPrice,
  signedSize,
  upLevel,
} from "./math.ts";
import type {
  EngineAction,
  EngineConfig,
  EngineState,
  Fill,
  GridOrder,
  LiveAccount,
  LogLevel,
  Side,
  StepInput,
} from "./types.ts";

function pushLog(
  state: EngineState,
  level: LogLevel,
  message: string,
  extra?: Record<string, string | number | boolean>,
) {
  state.logs = [...state.logs.slice(-(LOG_LIMIT - 1)), { ts: state.now, level, message, extra }];
}

export function createInitialState(config: Partial<EngineConfig> = {}): EngineState {
  const cfg: EngineConfig = {
    dynamicSpacing: false,
    armed: false,
    orderNotional: ORDER_NOTIONAL,
    startingEquity: 0,
    ...config,
  };
  if (!Number.isFinite(cfg.orderNotional) || cfg.orderNotional < 10) cfg.orderNotional = ORDER_NOTIONAL;
  return {
    config: cfg,
    now: 0,
    mark: 0,
    prevMark: null,
    factor: DEFAULT_FACTOR,
    spacingPct: DEFAULT_SPACING_PCT,
    regime: "normal",
    pauseNewOpens: false,
    impulse: "none",
    impulseDeltaPct: 0,
    lastFillPrice: null,
    lastFillSide: null,
    lastFillAt: null,
    orders: [],
    position: { size: 0, entry: 0 },
    realizedPnl: 0,
    unrealizedPnl: 0,
    accountEquity: null,
    accountSource: cfg.startingEquity > 0 ? "sim" : "none",
    markHistory: [],
    logs: [],
    cycleMs: BASE_CYCLE_MS,
    elevated: false,
    orderSeq: 1,
    pendingRegime: null,
    pendingRegimeCount: 0,
    lastAtrBarT: null,
    lastAppliedSpacingPct: DEFAULT_SPACING_PCT,
    fillsThisCycle: [],
    lastCleanReason: null,
    hourlyCandles: [],
    minuteCandle: null,
    atrPct: 0,
    actions: [],
    cancelledIds: [],
  };
}

export function positionNotional(state: EngineState, mark = state.mark): number {
  return Math.abs(state.position.size * mark);
}

export function pendingNotional(state: EngineState): number {
  return state.orders.reduce((sum, o) => sum + o.notional, 0);
}

export function equity(state: EngineState, mark = state.mark): number {
  if (state.accountSource === "none") return 0;
  if (state.accountSource === "live" && state.accountEquity != null) {
    return state.accountEquity;
  }
  const unrealized =
    state.position.size === 0 ? 0 : (mark - state.position.entry) * state.position.size;
  return state.config.startingEquity + state.realizedPnl + unrealized;
}

export function remainingCapacity(state: EngineState, mark = state.mark): number {
  if (state.accountSource === "none") return 0;
  return equity(state, mark) * MAX_LEVERAGE - positionNotional(state, mark) - pendingNotional(state);
}

export function isFlat(state: EngineState, mark = state.mark): boolean {
  return positionNotional(state, mark) < FLAT_NOTIONAL_EPS;
}

export function bias(state: EngineState): "short" | "long" | "flat" {
  if (isFlat(state)) return "flat";
  return state.position.size < 0 ? "short" : "long";
}

function anchorPrice(state: EngineState): number {
  if (state.lastFillPrice && state.lastFillPrice > 0) return state.lastFillPrice;
  return state.mark;
}

export function validLevels(state: EngineState): { sell: number; buy: number } {
  const a = anchorPrice(state);
  return { sell: upLevel(a, state.factor), buy: downLevel(a, state.factor) };
}

function detectFills(state: EngineState): Fill[] {
  const { prevMark, mark, now, orders } = state;
  if (prevMark == null || mark <= 0) return [];
  const fills: Fill[] = [];
  for (const order of orders) {
    const crossedSell = order.side === "sell" && prevMark < order.price && mark >= order.price;
    const crossedBuy = order.side === "buy" && prevMark > order.price && mark <= order.price;
    if (crossedSell || crossedBuy) {
      fills.push({
        orderId: order.id,
        side: order.side,
        price: order.price,
        qty: order.qty,
        ts: now,
      });
    }
  }
  return fills;
}

function applyFill(state: EngineState, fill: Fill) {
  const signed = signedSize(fill.side, fill.qty);
  const pos = state.position;
  if (pos.size === 0 || Math.sign(pos.size) === Math.sign(signed)) {
    const newSize = pos.size + signed;
    const absOld = Math.abs(pos.size);
    const absAdd = Math.abs(signed);
    pos.entry = absOld + absAdd === 0 ? fill.price : (pos.entry * absOld + fill.price * absAdd) / (absOld + absAdd);
    pos.size = newSize;
  } else {
    const closeQty = Math.min(Math.abs(pos.size), fill.qty);
    const direction = Math.sign(pos.size);
    state.realizedPnl += (fill.price - pos.entry) * direction * closeQty;
    const leftover = Math.abs(pos.size) - closeQty;
    const residual = fill.qty - closeQty;
    if (leftover <= 1e-9 && residual <= 1e-9) {
      pos.size = 0;
      pos.entry = 0;
    } else if (leftover > 1e-9) {
      pos.size = direction * leftover;
    } else {
      pos.size = signedSize(fill.side, residual);
      pos.entry = fill.price;
    }
  }
  state.orders = state.orders.filter((o) => o.id !== fill.orderId);
  state.lastFillPrice = fill.price;
  state.lastFillSide = fill.side;
  state.lastFillAt = fill.ts;
  pushLog(state, "fill", `fill ${fill.side.toUpperCase()} ${fill.price.toFixed(5)} × ${fill.qty.toFixed(1)}`, {
    side: fill.side,
    price: fill.price,
    qty: fill.qty,
  });
}

function ingestLive(state: EngineState, live: LiveAccount) {
  const prev = state.orders;
  const cancelled = new Set(state.cancelledIds);
  const liveOpen = live.orders.filter((o) => !cancelled.has(o.id));
  const nextIds = new Set(liveOpen.map((o) => o.id));

  for (const order of prev) {
    if (order.id.startsWith("pending:")) continue;
    if (cancelled.has(order.id)) continue;
    if (nextIds.has(order.id)) continue;
    const fill: Fill = {
      orderId: order.id,
      side: order.side,
      price: order.price,
      qty: order.qty,
      ts: state.now,
    };
    state.fillsThisCycle.push(fill);
    state.lastFillPrice = fill.price;
    state.lastFillSide = fill.side;
    state.lastFillAt = fill.ts;
    pushLog(state, "fill", `fill ${fill.side.toUpperCase()} ${fill.price.toFixed(5)} × ${fill.qty.toFixed(1)}`, {
      side: fill.side,
      price: fill.price,
      qty: fill.qty,
    });
  }

  const pending = prev.filter((o) => o.id.startsWith("pending:") && !cancelled.has(o.id));
  const stillPending = pending.filter(
    (p) => !liveOpen.some((o) => o.side === p.side && Math.abs(o.price - p.price) < 1e-8),
  );

  const wasNone = state.accountSource !== "live";
  state.accountSource = "live";
  state.accountEquity = live.equity;
  state.position = { ...live.position };
  state.realizedPnl = live.realizedPnl;
  state.unrealizedPnl = live.unrealizedPnl;
  state.orders = [...liveOpen, ...stillPending];
  state.cancelledIds = [...cancelled].filter((id) => live.orders.some((o) => o.id === id) || id.startsWith("pending:"));
  if (wasNone) {
    pushLog(state, "info", `live account ${live.accountIndex} · equity $${live.equity.toFixed(2)}`);
  }
}

function emit(state: EngineState, action: EngineAction) {
  state.actions = [...state.actions, action];
}

function hasNear(state: EngineState, target: number): boolean {
  const prox = proximityPct(state.spacingPct);
  return state.orders.some((o) => inProximity(o.price, target, prox));
}

type GateFail = { reason: string; extra?: Record<string, string | number | boolean> };

function gateCandidate(state: EngineState, side: Side, target: number): GateFail | null {
  if (!state.config.armed) return { reason: "disarmed" };
  if (state.accountSource === "none") return { reason: "no live account" };
  if (state.pauseNewOpens) {
    return { reason: "pause_new_opens (extreme regime)", extra: { regime: state.regime } };
  }
  if (state.mark <= 0) return { reason: "no mark" };

  const remaining = remainingCapacity(state);
  if (remaining < state.config.orderNotional) {
    return {
      reason: `remaining ${remaining.toFixed(0)} < ${state.config.orderNotional}`,
      extra: { remaining },
    };
  }

  if (hasNear(state, target)) {
    return { reason: `proximity to existing @ ${target.toFixed(5)}`, extra: { target } };
  }

  if (state.impulse === "buy" && side === "sell") {
    return {
      reason: `impulse BUY blocks sell (Δ ${state.impulseDeltaPct.toFixed(3)}%)`,
      extra: { delta: state.impulseDeltaPct },
    };
  }
  if (state.impulse === "sell" && side === "buy") {
    return {
      reason: `impulse SELL blocks buy (Δ ${state.impulseDeltaPct.toFixed(3)}%)`,
      extra: { delta: state.impulseDeltaPct },
    };
  }

  if (isFlat(state) && side === "buy") {
    return { reason: "flat — skip opposite (short-preferring)" };
  }

  if (side === "sell" && target <= state.mark) {
    return { reason: `marketable sell ${target.toFixed(5)} ≤ mark ${state.mark.toFixed(5)}` };
  }
  if (side === "buy" && target >= state.mark) {
    return { reason: `marketable buy ${target.toFixed(5)} ≥ mark ${state.mark.toFixed(5)}` };
  }

  return null;
}

function placeLimit(state: EngineState, side: Side, target: number, why: string): boolean {
  const price = roundPrice(target);
  const fail = gateCandidate(state, side, price);
  if (fail) {
    if (fail.reason !== "disarmed" && fail.reason !== "no live account") {
      pushLog(state, "gate", `gate ${side.toUpperCase()} ${price.toFixed(5)} — ${fail.reason}`, fail.extra);
    }
    return false;
  }
  const qty = baseQty(state.mark, state.config.orderNotional);
  if (qty <= 0) {
    pushLog(state, "gate", "gate — base_qty is 0");
    return false;
  }
  const order: GridOrder = {
    id: state.accountSource === "live" ? `pending:${state.orderSeq++}` : `o-${state.orderSeq++}`,
    side,
    price,
    qty,
    notional: qty * price,
    placedAt: state.now,
  };
  state.orders = [...state.orders, order];
  emit(state, { type: "place", side, price, qty, why });
  pushLog(state, "place", `place ${side.toUpperCase()} ${price.toFixed(5)} × ${qty.toFixed(1)} (${why})`, {
    side,
    price,
    qty,
    why,
  });
  return true;
}

function cancelAll(state: EngineState, reason: string) {
  if (state.orders.length === 0) {
    state.lastCleanReason = reason;
    return;
  }
  const n = state.orders.length;
  for (const o of state.orders) state.cancelledIds.push(o.id);
  emit(state, { type: "cancel_all", why: reason });
  state.orders = [];
  state.lastCleanReason = reason;
  pushLog(state, "clean", `clean ALL ${n} limit(s) — ${reason}`);
}

function cleanInvalid(state: EngineState) {
  const levels = validLevels(state);
  const prox = proximityPct(state.spacingPct);
  const keep: GridOrder[] = [];
  for (const order of state.orders) {
    const belongs =
      (order.side === "sell" && inProximity(order.price, levels.sell, prox)) ||
      (order.side === "buy" && inProximity(order.price, levels.buy, prox));
    if (belongs) keep.push(order);
    else if (state.cancelledIds.includes(order.id)) {
      /* already cancelling — do not emit another tx */
    } else {
      state.cancelledIds.push(order.id);
      emit(state, {
        type: "cancel",
        orderId: order.id,
        side: order.side,
        price: order.price,
        why: "not in ±1 set",
      });
      pushLog(
        state,
        "clean",
        `clean ${order.side.toUpperCase()} ${order.price.toFixed(5)} — not in ±1 set (${levels.buy.toFixed(5)} / ${levels.sell.toFixed(5)})`,
      );
    }
  }
  state.orders = keep;
}

function recenter(state: EngineState, reason: string) {
  cancelAll(state, reason);
  state.lastFillPrice = state.mark;
  state.lastFillSide = null;
}

function maintainPair(state: EngineState, why: string) {
  if (!state.config.armed) return;
  const levels = validLevels(state);
  if (!hasNear(state, levels.sell)) placeLimit(state, "sell", levels.sell, why);
  if (!isFlat(state) && !hasNear(state, levels.buy)) placeLimit(state, "buy", levels.buy, why);
}

function postFillMissed(state: EngineState, fill: Fill) {
  const up = upLevel(fill.price, state.factor);
  const down = downLevel(fill.price, state.factor);
  if (!hasNear(state, up)) placeLimit(state, "sell", up, "post-fill missed +1");
  if (!hasNear(state, down)) placeLimit(state, "buy", down, "post-fill missed −1");
}

function updateSpacingAndRegime(state: EngineState, input: StepInput) {
  if (input.hourlyCandles && input.hourlyCandles.length > 0) {
    state.hourlyCandles = input.hourlyCandles;
  }
  const candles = state.hourlyCandles;
  if (candles.length >= 2 && state.mark > 0) {
    const atrValue = atr(candles);
    state.atrPct = atrPct(atrValue, state.mark);
    const raw = classifyRegime(state.atrPct);
    const lastBarT = candles[candles.length - 1]?.t ?? null;
    const next = applyRegimeHysteresis(
      {
        regime: state.regime,
        pending: state.pendingRegime,
        count: state.pendingRegimeCount,
        lastBarT: state.lastAtrBarT,
      },
      raw,
      lastBarT,
    );
    if (next.regime !== state.regime) {
      pushLog(state, "regime", `regime ${state.regime} → ${next.regime} (ATR ${state.atrPct.toFixed(3)}%)`, {
        from: state.regime,
        to: next.regime,
        atrPct: Number(state.atrPct.toFixed(4)),
      });
    }
    state.regime = next.regime;
    state.pendingRegime = next.pending;
    state.pendingRegimeCount = next.count;
    state.lastAtrBarT = next.lastBarT;
  }

  const pause = state.regime === "extreme";
  if (pause !== state.pauseNewOpens) {
    state.pauseNewOpens = pause;
    pushLog(state, "regime", pause ? "pause_new_opens = true (extreme)" : "pause_new_opens = false");
  }

  const nextSpacing = state.config.dynamicSpacing
    ? spacingFromAtr(state.atrPct || DEFAULT_SPACING_PCT)
    : DEFAULT_SPACING_PCT;
  const delta = Math.abs(nextSpacing - state.lastAppliedSpacingPct);
  if (delta >= SPACING_CHANGE_THRESHOLD_PCT) {
    const prev = state.lastAppliedSpacingPct;
    state.spacingPct = nextSpacing;
    state.factor = factorFromSpacing(nextSpacing);
    state.lastAppliedSpacingPct = nextSpacing;
    pushLog(
      state,
      "regime",
      `spacing ${prev.toFixed(2)}% → ${nextSpacing.toFixed(2)}% (factor ${state.factor.toFixed(5)})`,
    );
    if (state.config.armed) {
      cancelAll(state, `spacing change ${delta.toFixed(2)}%`);
      maintainPair(state, "re-place ±1 after spacing change");
    }
  } else {
    state.spacingPct = state.lastAppliedSpacingPct;
    state.factor = factorFromSpacing(state.spacingPct);
  }
}

function updateImpulse(state: EngineState, input: StepInput) {
  if (input.minuteCandle) state.minuteCandle = input.minuteCandle;
  const minute = state.minuteCandle;
  const resolved = resolveImpulse({
    prev: state.impulse,
    history: state.markHistory,
    mark: state.mark,
    now: state.now,
    minuteOpen: minute?.o ?? null,
    minuteClose: minute?.c ?? null,
  });
  if (resolved.impulse !== state.impulse) {
    if (resolved.impulse === "none") {
      pushLog(state, "impulse", `impulse cool |Δ| ${resolved.deltaPct.toFixed(3)}%`);
    } else if (resolved.impulse === "buy") {
      pushLog(state, "impulse", `impulse BUY — BLOCK new sell limits (Δ ${resolved.deltaPct.toFixed(3)}%)`);
    } else {
      pushLog(state, "impulse", `impulse SELL — BLOCK new buy limits (Δ ${resolved.deltaPct.toFixed(3)}%)`);
    }
  }
  state.impulse = resolved.impulse;
  state.impulseDeltaPct = resolved.deltaPct;
}

function updateCadence(state: EngineState) {
  const vel5 = Math.abs(velocityPct(state.markHistory, state.mark, state.now, VELOCITY_SPIKE_WINDOW_MS));
  const recentFill =
    state.lastFillAt != null && state.now - state.lastFillAt <= RECENT_FILL_ELEVATED_MS;
  const elevated =
    state.config.dynamicSpacing ||
    state.regime === "high" ||
    state.regime === "extreme" ||
    recentFill ||
    vel5 >= VELOCITY_SPIKE_PCT ||
    state.impulse !== "none";
  state.elevated = elevated;
  state.cycleMs = elevated ? ELEVATED_CYCLE_MS : BASE_CYCLE_MS;
}

export function setArmed(state: EngineState, armed: boolean): EngineState {
  if (state.config.armed === armed) return state;
  state.config = { ...state.config, armed };
  if (armed) {
    pushLog(state, "info", "armed — short geometric grid live");
    maintainPair(state, "arm ±1");
  } else {
    cancelAll(state, "disarmed");
    pushLog(state, "info", "disarmed — working limits cancelled");
  }
  return state;
}

export function setDynamic(state: EngineState, on: boolean): EngineState {
  if (state.config.dynamicSpacing === on) return state;
  state.config = { ...state.config, dynamicSpacing: on };
  pushLog(state, "info", on ? "dynamic ATR spacing ON" : "dynamic ATR spacing OFF (fixed 0.50%)");
  return state;
}

export function setOrderNotional(state: EngineState, usd: number): EngineState {
  const next = Math.round(Number(usd));
  if (!Number.isFinite(next) || next < 10 || next > 10_000) {
    pushLog(state, "warn", `notional rejected ${usd} (use 10–10000)`);
    return state;
  }
  if (state.config.orderNotional === next) return state;
  const prev = state.config.orderNotional;
  state.config = { ...state.config, orderNotional: next };
  pushLog(state, "info", `notional $${prev} → $${next} / level`);
  if (state.config.armed) {
    cancelAll(state, `notional change $${prev} → $${next}`);
    maintainPair(state, "re-place ±1 after notional change");
  }
  return state;
}

export function flattenAtMark(state: EngineState): EngineState {
  if (isFlat(state) || state.mark <= 0) return state;
  const qty = Math.abs(state.position.size);
  const side: Side = state.position.size < 0 ? "buy" : "sell";
  if (state.accountSource === "live") {
    cancelAll(state, "flatten");
    emit(state, { type: "place", side, price: roundPrice(state.mark), qty, why: "flatten", reduceOnly: true });
    pushLog(state, "info", `flatten ${side.toUpperCase()} ${qty.toFixed(1)} @ mark (reduce-only limit)`);
    return state;
  }
  applyFill(state, {
    orderId: "flatten",
    side,
    price: state.mark,
    qty,
    ts: state.now,
  });
  cancelAll(state, "flatten");
  pushLog(state, "info", `flatten ${side.toUpperCase()} ${qty.toFixed(1)} @ ${state.mark.toFixed(5)}`);
  return state;
}

export function resetSession(state: EngineState): EngineState {
  const config = { ...state.config, armed: false, startingEquity: 0 };
  const next = createInitialState(config);
  next.now = state.now;
  next.mark = state.mark;
  pushLog(next, "info", "session reset — waiting for live account");
  return next;
}

function runArmedCycle(state: EngineState) {
  const currentBias = bias(state);
  const anchor = anchorPrice(state);
  if (currentBias === "short" && adverseAgainstShort(anchor, state.mark, state.factor)) {
    recenter(state, `adverse ≥ ${ADVERSE_STEPS} steps against short`);
    maintainPair(state, "re-place ±1 after adverse");
  } else if (currentBias === "long" && adverseAgainstLong(anchor, state.mark, state.factor)) {
    recenter(state, `adverse ≥ ${ADVERSE_STEPS} steps against long`);
    maintainPair(state, "re-place ±1 after adverse");
  } else {
    cleanInvalid(state);
  }

  if (state.accountSource !== "live") {
    const fills = detectFills(state);
    for (const fill of fills) {
      applyFill(state, fill);
      state.fillsThisCycle.push(fill);
      postFillMissed(state, fill);
    }
  } else {
    for (const fill of state.fillsThisCycle) postFillMissed(state, fill);
  }

  maintainPair(state, "maintain ±1");
}

export function step(state: EngineState, input: StepInput): EngineState {
  state.fillsThisCycle = [];
  state.actions = [];
  state.now = input.now;
  if (input.mark > 0) {
    state.prevMark = state.mark > 0 ? state.mark : null;
    state.mark = input.mark;
    state.markHistory = [
      ...state.markHistory.slice(-(MARK_HISTORY_LIMIT - 1)),
      { t: input.now, p: input.mark },
    ];
  }

  if (input.live) ingestLive(state, input.live);

  updateSpacingAndRegime(state, input);
  updateImpulse(state, input);

  if (state.config.armed) runArmedCycle(state);

  updateCadence(state);
  return state;
}

export function snapshotPublic(state: EngineState) {
  const mark = state.mark;
  const posN = positionNotional(state);
  const pend = pendingNotional(state);
  const eq = equity(state);
  const remaining = remainingCapacity(state);
  const levels = mark > 0 ? validLevels(state) : { sell: 0, buy: 0 };
  return {
    mark,
    equity: eq,
    remaining,
    positionNotional: posN,
    pendingNotional: pend,
    position: { ...state.position },
    realizedPnl: state.realizedPnl,
    unrealizedPnl:
      state.accountSource === "live"
        ? state.unrealizedPnl
        : state.position.size === 0
          ? 0
          : (mark - state.position.entry) * state.position.size,
    orders: state.orders.slice(),
    logs: state.logs,
    regime: state.regime,
    pauseNewOpens: state.pauseNewOpens,
    impulse: state.impulse,
    impulseDeltaPct: state.impulseDeltaPct,
    spacingPct: state.spacingPct,
    factor: state.factor,
    atrPct: state.atrPct,
    cycleMs: state.cycleMs,
    elevated: state.elevated,
    armed: state.config.armed,
    dynamicSpacing: state.config.dynamicSpacing,
    orderNotional: state.config.orderNotional,
    accountSource: state.accountSource,
    lastFillPrice: state.lastFillPrice,
    lastFillAt: state.lastFillAt,
    lastFillSide: state.lastFillSide,
    levels,
    bias: bias(state),
    flat: isFlat(state),
    fillsThisCycle: state.fillsThisCycle,
    markHistory: state.markHistory,
    hourlyCandles: state.hourlyCandles,
    now: state.now,
  };
}

export type PublicSnapshot = ReturnType<typeof snapshotPublic>;
