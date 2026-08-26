import {
  FLAT_NOTIONAL_EPS,
  LOG_LIMIT,
  MARK_HISTORY_LIMIT,
  ORDER_NOTIONAL,
  RECENT_FILL_ELEVATED_MS,
  VELOCITY_SPIKE_PCT,
  VELOCITY_SPIKE_WINDOW_MS,
} from "./constants.ts";
import { AUDUSD } from "./markets.ts";
import { resolveImpulse, velocityPct } from "./impulse.ts";
import {
  adverseAgainstLong,
  adverseAgainstShort,
  baseQty,
  downLevel,
  inProximity,
  proximityPct,
  roundPrice,
  roundQty,
  signedSize,
  stepsAway,
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
  const market = config.market ?? AUDUSD;
  const cfg: EngineConfig = {
    market,
    dynamicSpacing: false,
    armed: false,
    orderNotional: market.orderNotional,
    startingEquity: 0,
    ...config,
    market,
    dynamicSpacing: false,
  };
  if (!Number.isFinite(cfg.orderNotional) || cfg.orderNotional < 10) cfg.orderNotional = market.orderNotional;
  return {
    config: cfg,
    now: 0,
    mark: 0,
    prevMark: null,
    factor: market.defaultFactor,
    spacingPct: market.defaultSpacingPct,
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
    cycleMs: market.baseCycleMs,
    elevated: false,
    orderSeq: 1,
    pendingRegime: null,
    pendingRegimeCount: 0,
    lastAtrBarT: null,
    lastAppliedSpacingPct: market.defaultSpacingPct,
    fillsThisCycle: [],
    lastCleanReason: null,
    hourlyCandles: [],
    minuteCandle: null,
    atrPct: 0,
    actions: [],
    cancelledIds: [],
    impulseJustCooled: false,
    foreignMargin: 0,
    cancelSentAt: {},
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
  const lev = state.config.market.maxLeverage;
  const free = Math.max(0, equity(state, mark) - state.foreignMargin);
  return free * lev - positionNotional(state, mark) - pendingNotional(state);
}

export function isFlat(state: EngineState, mark = state.mark): boolean {
  return positionNotional(state, mark) < FLAT_NOTIONAL_EPS;
}

export function bias(state: EngineState): "short" | "long" | "flat" {
  if (isFlat(state)) return "flat";
  return state.position.size < 0 ? "short" : "long";
}

function fillAnchor(state: EngineState): number | null {
  if (state.lastFillPrice && state.lastFillPrice > 0) return state.lastFillPrice;
  if (!isFlat(state) && state.position.entry > 0) return state.position.entry;
  return null;
}

function anchorPrice(state: EngineState): number {
  return fillAnchor(state) ?? state.mark;
}

export function validLevels(state: EngineState): { sell: number; buy: number } {
  const a = anchorPrice(state);
  const m = state.config.market;
  return { sell: upLevel(a, state.factor, m.priceDecimals), buy: downLevel(a, state.factor, m.priceDecimals) };
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
  state.foreignMargin = Number.isFinite(live.foreignMargin) ? Math.max(0, live.foreignMargin) : 0;
  const prev = state.orders;
  const cancelled = new Set(state.cancelledIds);
  const RETRY_MS = 20_000;
  const stillCancelled = new Set<string>();
  for (const id of cancelled) {
    const stillLive = live.orders.some((o) => o.id === id);
    if (!stillLive) continue;
    const sent = state.cancelSentAt[id] ?? 0;
    if (sent && state.now - sent < RETRY_MS) stillCancelled.add(id);
    else {
      pushLog(state, "warn", `cancel ${id} still on DEX — retry`);
      delete state.cancelSentAt[id];
    }
  }
  const liveOpen = live.orders;
  const nextIds = new Set(liveOpen.map((o) => o.id));

  for (const order of prev) {
    if (order.id.startsWith("pending:")) continue;
    if (nextIds.has(order.id)) continue;
    if (cancelled.has(order.id) || state.cancelSentAt[order.id]) {
      delete state.cancelSentAt[order.id];
      continue;
    }
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
  state.cancelledIds = [...stillCancelled];
  if (wasNone) {
    pushLog(state, "info", `live account ${live.accountIndex} · equity $${live.equity.toFixed(2)}`);
  }
}

function emit(state: EngineState, action: EngineAction) {
  state.actions = [...state.actions, action];
  if (action.type === "cancel") state.cancelSentAt[action.orderId] = state.now;
  if (action.type === "cancel_all") {
    for (const o of state.orders) state.cancelSentAt[o.id] = state.now;
  }
}

function hasNear(state: EngineState, target: number): boolean {
  const prox = proximityPct(state.spacingPct, state.config.market);
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

  if (state.impulse !== "none") {
    return {
      reason: `impulse ${state.impulse} — freeze new limits until cool (Δ ${state.impulseDeltaPct.toFixed(3)}%)`,
      extra: { delta: state.impulseDeltaPct, impulse: state.impulse },
    };
  }

  if (state.orders.filter((o) => o.side === side).length >= 1) {
    return { reason: `already have a ${side} (max 1 per side)` };
  }
  if (state.orders.length >= 2) {
    return { reason: "max 2 working bot orders" };
  }

  if (isFlat(state) && side !== (state.config.market.prefer === "long" ? "buy" : "sell")) {
    return { reason: `flat — skip opposite (${state.config.market.prefer}-preferring)` };
  }

  if (side === "sell" && target <= state.mark) {
    return { reason: `marketable sell ${target.toFixed(5)} ≤ mark ${state.mark.toFixed(5)}` };
  }
  if (side === "buy" && target >= state.mark) {
    return { reason: `marketable buy ${target.toFixed(5)} ≥ mark ${state.mark.toFixed(5)}` };
  }

  return null;
}

function expectedFillPnl(state: EngineState, side: Side, price: number, qty: number): {
  pnl: number;
  kind: "reduce" | "add" | "open";
  note: string;
} {
  const pos = state.position.size;
  const entry = state.position.entry;
  if (Math.abs(pos) < FLAT_NOTIONAL_EPS || entry <= 0) {
    return { pnl: 0, kind: "open", note: `open ${side} from flat` };
  }
  const reducing = (pos < 0 && side === "buy") || (pos > 0 && side === "sell");
  if (reducing) {
    const closeQty = Math.min(qty, Math.abs(pos));
    const pnl = pos < 0 ? (entry - price) * closeQty : (price - entry) * closeQty;
    const sign = pnl >= 0 ? "+" : "";
    return {
      pnl,
      kind: "reduce",
      note: `if filled REDUCE PnL ${sign}$${pnl.toFixed(2)} vs entry ${entry.toFixed(state.config.market.priceDecimals)}`,
    };
  }
  const improves = pos < 0 ? price > entry : price < entry;
  return {
    pnl: 0,
    kind: "add",
    note: improves
      ? `if filled ADD ${pos < 0 ? "short above" : "long below"} entry (better avg)`
      : `if filled ADD ${pos < 0 ? "short below" : "long above"} entry (worse avg)`,
  };
}

function placeLimit(state: EngineState, side: Side, target: number, why: string): boolean {
  const m = state.config.market;
  const price = roundPrice(target, m.priceDecimals);
  const fail = gateCandidate(state, side, price);
  if (fail) {
    if (fail.reason !== "disarmed" && fail.reason !== "no live account") {
      pushLog(state, "gate", `gate ${side.toUpperCase()} ${price.toFixed(m.priceDecimals)} — ${fail.reason}`, fail.extra);
    }
    return false;
  }
  const qty = baseQty(state.mark, state.config.orderNotional, m.sizeDecimals);
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
  const expect = expectedFillPnl(state, side, price, qty);
  const px = price.toFixed(m.priceDecimals);
  const q = qty.toFixed(m.sizeDecimals);
  pushLog(state, "place", `place ${side.toUpperCase()} ${px} × ${q} (${why}) · ${expect.note}`, {
    side,
    price,
    qty,
    why,
    expectPnl: Number(expect.pnl.toFixed(2)),
    expectKind: expect.kind,
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
  pushLog(state, "clean", `clean ALL ${n} bot limit(s) on ${state.config.market.symbol} — ${reason} (other markets untouched)`);
}

function dropOrder(state: EngineState, order: GridOrder, why: string) {
  if (state.cancelledIds.includes(order.id)) return;
  state.cancelledIds.push(order.id);
  emit(state, {
    type: "cancel",
    orderId: order.id,
    side: order.side,
    price: order.price,
    why,
  });
  const m = state.config.market;
  pushLog(
    state,
    "clean",
    `clean ${order.side.toUpperCase()} ${order.price.toFixed(m.priceDecimals)} — ${why}`,
  );
}

function cleanInvalid(state: EngineState) {
  if (!fillAnchor(state)) return;
  const levels = validLevels(state);
  const prox = proximityPct(state.spacingPct, state.config.market);
  const buys = state.orders.filter((o) => o.side === "buy");
  const sells = state.orders.filter((o) => o.side === "sell");
  const pickClosest = (orders: GridOrder[], target: number): GridOrder | null => {
    let best: GridOrder | null = null;
    let bestDist = Infinity;
    for (const o of orders) {
      if (!inProximity(o.price, target, prox)) continue;
      const d = Math.abs(o.price - target);
      if (d < bestDist) {
        best = o;
        bestDist = d;
      }
    }
    return best;
  };
  const keepBuy = pickClosest(buys, levels.buy);
  const keepSell = pickClosest(sells, levels.sell);
  const keepIds = new Set([keepBuy?.id, keepSell?.id].filter(Boolean) as string[]);
  const keep: GridOrder[] = [];
  for (const order of state.orders) {
    if (keepIds.has(order.id)) {
      keep.push(order);
      continue;
    }
    dropOrder(
      state,
      order,
      `extra ${order.side} (only ±1: ${levels.buy.toFixed(state.config.market.priceDecimals)} / ${levels.sell.toFixed(state.config.market.priceDecimals)})`,
    );
  }
  state.orders = keep;
}

function recenter(state: EngineState, reason: string) {
  cancelAll(state, reason);
  pushLog(state, "clean", `${reason} — wait for a fill; will not seed ±1 from mark`);
}

function maintainPair(state: EngineState, why: string) {
  if (!state.config.armed) return;
  if (!fillAnchor(state)) return;
  const levels = validLevels(state);
  if (!hasNear(state, levels.sell)) placeLimit(state, "sell", levels.sell, why);
  if (!isFlat(state) && !hasNear(state, levels.buy)) placeLimit(state, "buy", levels.buy, why);
}

function postFillMissed(state: EngineState, fill: Fill) {
  const m = state.config.market;
  const up = upLevel(fill.price, state.factor, m.priceDecimals);
  const down = downLevel(fill.price, state.factor, m.priceDecimals);
  const prox = proximityPct(state.spacingPct, m);
  const keep: GridOrder[] = [];
  for (const order of state.orders) {
    const belongs = inProximity(order.price, up, prox) || inProximity(order.price, down, prox);
    if (belongs) keep.push(order);
    else if (!state.cancelledIds.includes(order.id)) {
      state.cancelledIds.push(order.id);
      emit(state, {
        type: "cancel",
        orderId: order.id,
        side: order.side,
        price: order.price,
        why: "old level after fill",
      });
      pushLog(
        state,
        "clean",
        `clean ${order.side.toUpperCase()} ${order.price.toFixed(m.priceDecimals)} — old level after fill (keep ±1 ${down.toFixed(m.priceDecimals)} / ${up.toFixed(m.priceDecimals)})`,
      );
    }
  }
  state.orders = keep;
  if (state.impulse !== "none") {
    pushLog(state, "impulse", `post-fill skip new ±1 until impulse cools (anchor ${fill.price.toFixed(m.priceDecimals)})`);
    return;
  }
  if (!hasNear(state, up)) placeLimit(state, "sell", up, "post-fill +1");
  if (!hasNear(state, down)) placeLimit(state, "buy", down, "post-fill −1");
}

function lockFixedSpacing(state: EngineState) {
  const m = state.config.market;
  state.spacingPct = m.defaultSpacingPct;
  state.factor = m.defaultFactor;
  state.lastAppliedSpacingPct = m.defaultSpacingPct;
  state.pauseNewOpens = false;
  if (state.regime !== "normal") state.regime = "normal";
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
    triggerPct: state.config.market.impulseTriggerPct,
    coolPct: state.config.market.impulseCoolPct,
    windowMs: state.config.market.impulseWindowMs,
  });
  if (resolved.impulse !== state.impulse) {
    if (resolved.impulse === "none") {
      state.impulseJustCooled = true;
      pushLog(state, "impulse", `impulse cool |Δ| ${resolved.deltaPct.toFixed(3)}% — catch then current ±1`);
    } else {
      pushLog(
        state,
        "impulse",
        `impulse ${resolved.impulse.toUpperCase()} — freeze new limits until cool (Δ ${resolved.deltaPct.toFixed(3)}%)`,
      );
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
    recentFill || vel5 >= VELOCITY_SPIKE_PCT || state.impulse !== "none";
  state.elevated = elevated;
  state.cycleMs = elevated ? state.config.market.elevatedCycleMs : state.config.market.baseCycleMs;
}

export function setArmed(state: EngineState, armed: boolean): EngineState {
  if (state.config.armed === armed) return state;
  state.config = { ...state.config, armed };
  if (armed) {
    pushLog(state, "info", "armed — ±1 only after a fill (no seed from mark)");
  } else {
    cancelAll(state, "disarmed");
    pushLog(state, "info", "disarmed — working limits cancelled");
  }
  return state;
}

export function setDynamic(state: EngineState, _on: boolean): EngineState {
  if (state.config.dynamicSpacing) {
    state.config = { ...state.config, dynamicSpacing: false };
  }
  pushLog(state, "info", `spacing fixed ${state.config.market.defaultSpacingPct.toFixed(2)}% — ATR adaptive off`);
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
    emit(state, { type: "place", side, price: roundPrice(state.mark, state.config.market.priceDecimals), qty, why: "flatten", reduceOnly: true });
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

function impulseCoolCatch(state: EngineState): void {
  if (!state.impulseJustCooled) return;
  state.impulseJustCooled = false;
  const anchor = fillAnchor(state);
  if (!anchor || state.mark <= 0 || !state.config.armed) return;
  const m = state.config.market;
  const distPct = (Math.abs(state.mark - anchor) / anchor) * 100;
  const prox = proximityPct(state.spacingPct, m);
  const far = distPct > prox;
  if (!far) {
    cleanInvalid(state);
    pushLog(
      state,
      "impulse",
      `impulse cool near Δ ${distPct.toFixed(2)}% < prox ${prox.toFixed(2)}% (2× spacing) — clean leftover bot limits, ±1 only`,
    );
    return;
  }
  const side: Side = state.mark > anchor ? "sell" : "buy";
  if (isFlat(state) && side !== (m.prefer === "long" ? "buy" : "sell")) {
    pushLog(state, "impulse", `impulse cool far but flat — skip ${side} catch (prefer ${m.prefer})`);
    return;
  }
  const rawSteps = stepsAway(anchor, state.mark, state.factor);
  const nLevels = Math.max(1, Math.min(8, Math.round(rawSteps)));
  const one = baseQty(state.mark, state.config.orderNotional, m.sizeDecimals);
  if (one <= 0) return;
  const reducing = (state.position.size < 0 && side === "buy") || (state.position.size > 0 && side === "sell");
  let qty = roundQty(one * nLevels, m.sizeDecimals);
  let reduceOnly = false;
  if (reducing) {
    qty = roundQty(Math.min(qty, Math.abs(state.position.size)), m.sizeDecimals);
    reduceOnly = true;
  } else {
    const remaining = remainingCapacity(state);
    const maxQty = baseQty(state.mark, remaining, m.sizeDecimals);
    qty = roundQty(Math.min(qty, maxQty), m.sizeDecimals);
  }
  if (qty <= 0) return;
  const price = roundPrice(state.mark, m.priceDecimals);
  cancelAll(state, "impulse cool catch market");
  emit(state, {
    type: "place",
    side,
    price,
    qty,
    why: `impulse-cool market ${nLevels} lvl`,
    exec: "market",
    reduceOnly,
  });
  state.lastFillPrice = state.mark;
  state.lastFillAt = state.now;
  pushLog(
    state,
    "place",
    `impulse cool MARKET ${side.toUpperCase()} ${price.toFixed(m.priceDecimals)} × ${qty.toFixed(m.sizeDecimals)} · ${nLevels} missed lvl · Δ ${distPct.toFixed(2)}% > prox ${prox.toFixed(2)}% then ±1`,
    { side, price, qty, exec: "market", n: nLevels, distPct, prox },
  );
}

function runArmedCycle(state: EngineState) {
  const currentBias = bias(state);
  const anchor = fillAnchor(state);
  const steps = state.config.market.adverseSteps;
  let waitFill = false;
  if (state.impulseJustCooled) {
    /* distance handled by impulseCoolCatch */
  } else if (anchor && currentBias === "short" && adverseAgainstShort(anchor, state.mark, state.factor, steps)) {
    recenter(state, `adverse ≥ ${steps} steps against short`);
    waitFill = true;
  } else if (anchor && currentBias === "long" && adverseAgainstLong(anchor, state.mark, state.factor, steps)) {
    recenter(state, `adverse ≥ ${steps} steps against long`);
    waitFill = true;
  } else if (anchor) {
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

  if (state.fillsThisCycle.length === 0) impulseCoolCatch(state);

  if (!waitFill) maintainPair(state, "maintain ±1");
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

  lockFixedSpacing(state);
  updateImpulse(state, input);

  if (state.config.armed) runArmedCycle(state);

  updateCadence(state);
  return state;
}

export function snapshotPublic(state: EngineState) {
  const mark = state.mark;
  const m = state.config.market;
  const posN = positionNotional(state);
  const pend = pendingNotional(state);
  const eq = equity(state);
  const remaining = remainingCapacity(state);
  const levels = mark > 0 ? validLevels(state) : { sell: 0, buy: 0 };
  return {
    symbol: m.symbol,
    prefer: m.prefer,
    marketId: m.marketId,
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
