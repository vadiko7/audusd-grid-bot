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
  sameRung,
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
    unackedPosDelta: 0,
    highestLvl: null,
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

export function isAccumulate(state: EngineState): boolean {
  return state.config.market.strategy === "accumulate";
}

export function buyCapUsd(state: EngineState): number {
  const mult = state.config.market.buyCapEquityMult ?? 3;
  return Math.max(0, equity(state) * mult);
}

export function pendingBuyNotional(state: EngineState): number {
  return state.orders
    .filter((o) => isMineOrder(o) && o.side === "buy")
    .reduce((sum, o) => sum + o.notional, 0);
}

export function buyUsedUsd(state: EngineState, mark = state.mark): number {
  const longN = state.position.size > 0 ? state.position.size * mark : 0;
  return longN + pendingBuyNotional(state);
}

export function underBuyCap(state: EngineState, extra = 0): boolean {
  return buyUsedUsd(state) + extra + 1e-9 < buyCapUsd(state);
}

function accumulateProxPct(state: EngineState): number {
  return Math.max(state.config.market.proximityMinPct, markProxPct(state));
}

function ratchetHighest(state: EngineState, price: number, why: string) {
  if (!(price > 0)) return;
  const px = roundPrice(price, state.config.market.priceDecimals);
  if (state.highestLvl != null && px <= state.highestLvl + 1e-12) return;
  const prev = state.highestLvl;
  state.highestLvl = px;
  pushLog(
    state,
    "info",
    `highest_lvl ${prev == null ? "set" : "ratchet"} ${prev == null ? "" : `${prev.toFixed(state.config.market.priceDecimals)} → `}${px.toFixed(state.config.market.priceDecimals)} (${why})`,
  );
}

function sellTicketUsd(state: EngineState, price: number): number {
  const m = state.config.market;
  const ticket = state.config.orderNotional;
  const hi = state.highestLvl;
  const frac =
    hi != null && price + 1e-12 >= hi ? (m.harvestSellFrac ?? 0.25) : (m.reloadSellFrac ?? 0.9);
  const floor = m.minQuoteNotional ?? 13;
  return Math.max(ticket * frac, floor);
}

function plusPnlSell(state: EngineState, price: number): boolean {
  const entry = state.position.entry;
  if (!(entry > 0) || isFlat(state)) return false;
  return price > entry;
}

function fillAnchor(state: EngineState): number | null {
  if (state.lastFillPrice && state.lastFillPrice > 0) return state.lastFillPrice;
  return null;
}

function inferLastFill(state: EngineState, orders: GridOrder[]): number | null {
  const live = orders.filter((o) => !o.id.startsWith("pending:") && o.mine !== false);
  if (!live.length) return null;
  const m = state.config.market;
  const f = state.factor;
  const buys = live.filter((o) => o.side === "buy");
  const sells = live.filter((o) => o.side === "sell");
  if (buys.length >= 1 && sells.length >= 1) {
    const buy = buys.reduce((a, b) => (a.price > b.price ? a : b));
    const sell = sells.reduce((a, b) => (a.price < b.price ? a : b));
    const steps = stepsAway(buy.price, sell.price, f);
    if (Math.abs(steps - 2) < 0.35) return upLevel(buy.price, f, m.priceDecimals);
  }
  if (!(state.mark > 0)) return null;
  const nearest = [...live].sort((a, b) => Math.abs(a.price - state.mark) - Math.abs(b.price - state.mark))[0];
  const dist = stepsAway(state.mark, nearest.price, f);
  if (dist < 0.65) return nearest.price;
  if (Math.abs(dist - 1) < 0.45) {
    return nearest.side === "sell"
      ? downLevel(nearest.price, f, m.priceDecimals)
      : upLevel(nearest.price, f, m.priceDecimals);
  }
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
    if (!isMineOrder(order)) continue;
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
  if (isAccumulate(state)) ratchetHighest(state, fill.price, "fill");
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
  const prevSize = state.position.size;
  const nextSize = live.position.size;
  const posDelta = nextSize - prevSize;
  const firstLive = state.accountSource !== "live";
  if (firstLive && Math.abs(prevSize) < 1e-6) {
    state.unackedPosDelta = 0;
  } else {
    state.unackedPosDelta += posDelta;
  }
  const vanished = prev.filter((order) => {
    if (!isMineOrder(order)) return false;
    if (nextIds.has(order.id)) return false;
    if (cancelled.has(order.id) || state.cancelSentAt[order.id]) return false;
    if (order.id.startsWith("pending:")) return false;
    return true;
  });
  const eps = 1e-6;
  const dirOf = (o: GridOrder) => (o.side === "buy" ? 1 : -1);
  let budget = state.unackedPosDelta;
  const filledIds = new Set<string>();
  const pool = [...vanished];
  while (pool.length) {
    const cand = pool
      .filter((o) => !filledIds.has(o.id) && budget * dirOf(o) > eps && Math.abs(budget) >= o.qty * 0.2)
      .sort((a, b) => Math.abs(a.price - state.mark) - Math.abs(b.price - state.mark))[0];
    if (!cand) break;
    filledIds.add(cand.id);
    budget -= dirOf(cand) * cand.qty;
    const fill: Fill = {
      orderId: cand.id,
      side: cand.side,
      price: cand.price,
      qty: cand.qty,
      ts: state.now,
    };
    state.fillsThisCycle.push(fill);
  }
  if (state.fillsThisCycle.length) {
    const latest = state.fillsThisCycle.reduce((a, b) =>
      Math.abs(a.price - state.mark) <= Math.abs(b.price - state.mark) ? a : b,
    );
    state.lastFillPrice = latest.price;
    state.lastFillSide = latest.side;
    state.lastFillAt = latest.ts;
    if (isAccumulate(state)) ratchetHighest(state, latest.price, "fill");
    for (const fill of state.fillsThisCycle) {
      pushLog(state, "fill", `fill ${fill.side.toUpperCase()} ${fill.price.toFixed(5)} × ${fill.qty.toFixed(1)}`, {
        side: fill.side,
        price: fill.price,
        qty: fill.qty,
      });
    }
  }
  state.unackedPosDelta = Math.abs(budget) < 0.05 ? 0 : budget;

  for (const order of vanished) {
    if (filledIds.has(order.id)) continue;
    pushLog(
      state,
      "info",
      `order gone ${order.side.toUpperCase()} ${order.price.toFixed(5)} — not a fill (pos ${prevSize.toFixed(1)} → ${nextSize.toFixed(1)})`,
    );
  }

  const pending = prev.filter((o) => o.id.startsWith("pending:") && !cancelled.has(o.id) && !filledIds.has(o.id));
  const PENDING_MS = 45_000;
  const stillPending = pending.filter((p) => {
    if (liveOpen.some((o) => o.side === p.side && sameRung(o.price, p.price, state.factor))) return false;
    if (state.now - p.placedAt > PENDING_MS) {
      pushLog(state, "warn", `pending ${p.side.toUpperCase()} ${p.price.toFixed(5)} expired — will re-place`);
      return false;
    }
    return true;
  });

  const wasNone = state.accountSource !== "live";
  state.accountSource = "live";
  state.accountEquity = live.equity;
  state.position = { ...live.position };
  state.realizedPnl = live.realizedPnl;
  state.unrealizedPnl = live.unrealizedPnl;
  state.orders = dedupRungs(state, [...liveOpen, ...stillPending]);
  state.cancelledIds = [...stillCancelled];
  if (!state.lastFillPrice) {
    const inferred = inferLastFill(state, state.orders);
    if (inferred) {
      state.lastFillPrice = inferred;
      state.lastFillAt = state.now;
      pushLog(
        state,
        "info",
        `lastFill inferred ${inferred.toFixed(state.config.market.priceDecimals)} from bot tickets`,
      );
    }
  }
  if (wasNone) {
    pushLog(state, "info", `live account ${live.accountIndex} · equity $${live.equity.toFixed(2)}`);
  }
}

function dedupRungs(state: EngineState, orders: GridOrder[]): GridOrder[] {
  const keep: GridOrder[] = [];
  for (const o of orders) {
    const i = keep.findIndex((k) => k.side === o.side && sameRung(k.price, o.price, state.factor));
    if (i < 0) {
      keep.push(o);
      continue;
    }
    const cur = keep[i]!;
    if (cur.id.startsWith("pending:") && !o.id.startsWith("pending:")) {
      keep[i] = o;
      continue;
    }
    if (o.id.startsWith("pending:")) continue;
    keep.push(o);
  }
  return keep;
}

function emit(state: EngineState, action: EngineAction) {
  state.actions = [...state.actions, action];
  if (action.type === "cancel") state.cancelSentAt[action.orderId] = state.now;
  if (action.type === "cancel_all") {
    for (const o of state.orders) {
      if (isMineOrder(o)) state.cancelSentAt[o.id] = state.now;
    }
  }
}

function markProxPct(state: EngineState): number {
  return proximityPct(state.spacingPct, state.config.market);
}

function hasNear(state: EngineState, target: number, side?: Side): boolean {
  const prox = isAccumulate(state) ? accumulateProxPct(state) : 0;
  return state.orders.some((o) => {
    if (side && o.side !== side) return false;
    if (sameRung(o.price, target, state.factor)) return true;
    if (!isMineOrder(o)) return false;
    return isAccumulate(state) && inProximity(o.price, target, prox);
  });
}

type GateFail = { reason: string; extra?: Record<string, string | number | boolean> };
type PlaceOpts = { qty?: number; reduceOnly?: boolean; allowImpulse?: boolean; allowExtra?: boolean };

function gateCandidate(state: EngineState, side: Side, target: number, opts: PlaceOpts = {}): GateFail | null {
  if (!state.config.armed) return { reason: "disarmed" };
  if (state.accountSource === "none") return { reason: "no live account" };
  if (state.pauseNewOpens) {
    return { reason: "pause_new_opens (extreme regime)", extra: { regime: state.regime } };
  }
  if (state.mark <= 0) return { reason: "no mark" };

  const acc = isAccumulate(state);
  const ticket = state.config.orderNotional;

  if (acc && side === "sell") {
    if (isFlat(state) || state.position.size <= 0) return { reason: "flat — no sells (no shorts)" };
    const atCap = !underBuyCap(state);
    if (atCap && !plusPnlSell(state, target)) {
      return { reason: `buy-cap — sell only +PnL above entry ${state.position.entry.toFixed(state.config.market.priceDecimals)}` };
    }
  }

  if (acc && side === "buy") {
    if (state.position.size < -1e-9) return { reason: "no shorts — will not buy into a short" };
    if (!underBuyCap(state, ticket)) {
      return {
        reason: `buy cap ${buyUsedUsd(state).toFixed(0)} ≥ ${buyCapUsd(state).toFixed(0)} (equity×${state.config.market.buyCapEquityMult ?? 3})`,
        extra: { buyUsed: buyUsedUsd(state), buyCap: buyCapUsd(state) },
      };
    }
  }

  const remaining = remainingCapacity(state);
  if (side === "buy" && remaining < ticket) {
    return {
      reason: `remaining ${remaining.toFixed(0)} < ${ticket}`,
      extra: { remaining },
    };
  }
  if (!acc && remaining < ticket) {
    return {
      reason: `remaining ${remaining.toFixed(0)} < ${ticket}`,
      extra: { remaining },
    };
  }

  if (hasNear(state, target, side)) {
    return { reason: `proximity to existing @ ${target.toFixed(5)}`, extra: { target } };
  }

  if (state.impulse !== "none" && !opts.allowImpulse) {
    if (acc) {
      if (side === "buy") {
        return {
          reason: `impulse ${state.impulse} — no new buys (Δ ${state.impulseDeltaPct.toFixed(3)}%)`,
          extra: { delta: state.impulseDeltaPct, impulse: state.impulse },
        };
      }
    } else {
      return {
        reason: `impulse ${state.impulse} — freeze new limits until cool (Δ ${state.impulseDeltaPct.toFixed(3)}%)`,
        extra: { delta: state.impulseDeltaPct, impulse: state.impulse },
      };
    }
  }

  if (state.lastFillPrice && sameRung(target, state.lastFillPrice, state.factor)) {
    return { reason: `just-filled level ${target.toFixed(5)}` };
  }

  if (!opts.allowExtra) {
    if (state.orders.filter((o) => isMineOrder(o) && o.side === side).length >= 1) {
      return { reason: `already have a ${side} (max 1 per side)` };
    }
    if (!acc && state.orders.filter(isMineOrder).length >= 2) {
      return { reason: "max 2 working bot orders" };
    }
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

function placeLimit(state: EngineState, side: Side, target: number, why: string, opts: PlaceOpts = {}): boolean {
  const m = state.config.market;
  const price = roundPrice(target, m.priceDecimals);
  const fail = gateCandidate(state, side, price, opts);
  if (fail) {
    if (fail.reason !== "disarmed" && fail.reason !== "no live account") {
      pushLog(state, "gate", `gate ${side.toUpperCase()} ${price.toFixed(m.priceDecimals)} — ${fail.reason}`, fail.extra);
    }
    return false;
  }
  let qty = opts.qty ?? baseQty(state.mark, state.config.orderNotional, m.sizeDecimals);
  let reduceOnly = Boolean(opts.reduceOnly);
  if (isAccumulate(state) && side === "sell") {
    const usd = sellTicketUsd(state, price);
    qty = opts.qty ?? baseQty(price, usd, m.sizeDecimals);
    reduceOnly = true;
    const maxClose = Math.abs(state.position.size);
    if (qty > maxClose) qty = roundQty(maxClose, m.sizeDecimals);
  }
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
    mine: true,
  };
  state.orders = [...state.orders, order];
  emit(state, { type: "place", side, price, qty, why, reduceOnly: reduceOnly || undefined });
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

function isMineOrder(order: GridOrder): boolean {
  return order.mine !== false;
}

function cancelAll(state: EngineState, reason: string) {
  const mine = state.orders.filter(isMineOrder);
  if (mine.length === 0) {
    state.lastCleanReason = reason;
    return;
  }
  const n = mine.length;
  for (const o of mine) dropOrder(state, o, reason);
  state.lastCleanReason = reason;
  pushLog(state, "clean", `clean ${n} bot limit(s) on ${state.config.market.symbol} — ${reason} (foreign orders left)`);
}

function dropOrder(state: EngineState, order: GridOrder, why: string) {
  if (!isMineOrder(order)) return;
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

function accumulateTargets(state: EngineState): { side: Side; price: number }[] {
  if (!fillAnchor(state)) return [];
  const levels = validLevels(state);
  const m = state.config.market;
  const out: { side: Side; price: number }[] = [];
  const buysOk = state.impulse === "none" && underBuyCap(state);
  if (buysOk) out.push({ side: "buy", price: levels.buy });
  if (!isFlat(state) && state.position.size > 0) {
    out.push({ side: "sell", price: levels.sell });
    if (state.impulse === "buy") {
      let px = levels.sell;
      for (let i = 0; i < 5; i++) {
        px = upLevel(px, state.factor, m.priceDecimals);
        if (px <= state.mark) continue;
        if (!plusPnlSell(state, px)) continue;
        out.push({ side: "sell", price: px });
      }
    }
  }
  return out;
}

function harvestRipSells(state: EngineState) {
  if (!isAccumulate(state) || state.impulse !== "buy") return;
  if (isFlat(state) || state.position.size <= 0) return;
  const m = state.config.market;
  const levels = validLevels(state);
  let px = levels.sell;
  let remaining = Math.abs(state.position.size);
  for (const o of state.orders.filter((x) => isMineOrder(x) && x.side === "sell")) remaining -= o.qty;
  for (let i = 0; i < 6 && remaining > 1e-6; i++) {
    if (i > 0) px = upLevel(px, state.factor, m.priceDecimals);
    if (px <= state.mark) continue;
    if (!plusPnlSell(state, px)) continue;
    if (hasNear(state, px, "sell")) continue;
    const usd = sellTicketUsd(state, px);
    let qty = baseQty(px, usd, m.sizeDecimals);
    qty = roundQty(Math.min(qty, remaining), m.sizeDecimals);
    if (qty <= 0) break;
    if (placeLimit(state, "sell", px, "impulse harvest +PnL", { qty, reduceOnly: true, allowImpulse: true, allowExtra: true })) {
      remaining -= qty;
    }
  }
}

function cleanInvalid(state: EngineState) {
  if (!fillAnchor(state)) return;
  if (isAccumulate(state)) {
    const allowed = accumulateTargets(state);
    const keep: GridOrder[] = [];
    for (const order of state.orders) {
      if (!isMineOrder(order)) {
        keep.push(order);
        continue;
      }
      const ok = allowed.some((t) => t.side === order.side && sameRung(t.price, order.price, state.factor));
      if (ok) keep.push(order);
      else dropOrder(state, order, `not in allowed set (${allowed.map((t) => `${t.side[0]}${t.price.toFixed(state.config.market.priceDecimals)}`).join(" ") || "none"})`);
    }
    state.orders = keep;
    return;
  }
  const levels = validLevels(state);
  const m = state.config.market;
  const keep: GridOrder[] = [];
  for (const order of state.orders) {
    if (!isMineOrder(order)) keep.push(order);
  }
  const mine = state.orders.filter(isMineOrder);
  const targetOf = (side: Side) => (side === "buy" ? levels.buy : levels.sell);
  mine.sort((a, b) => Math.abs(a.price - targetOf(a.side)) - Math.abs(b.price - targetOf(b.side)));
  const keptMine: Record<Side, boolean> = { buy: false, sell: false };
  const rungTaken = (side: Side, price: number) =>
    keep.some((k) => k.side === side && sameRung(k.price, price, state.factor));
  for (const order of mine) {
    if (rungTaken(order.side, order.price)) {
      dropOrder(
        state,
        order,
        `duplicate ${order.side} ${order.price.toFixed(m.priceDecimals)} — rung occupied`,
      );
      continue;
    }
    const tgt = targetOf(order.side);
    if (!sameRung(order.price, tgt, state.factor)) {
      dropOrder(
        state,
        order,
        `extra ${order.side} (only ±1: ${levels.buy.toFixed(m.priceDecimals)} / ${levels.sell.toFixed(m.priceDecimals)})`,
      );
      continue;
    }
    if (keptMine[order.side]) {
      dropOrder(state, order, `duplicate ${order.side} — already have ±1`);
      continue;
    }
    keep.push(order);
    keptMine[order.side] = true;
  }
  state.orders = keep;
}

function recenter(state: EngineState, reason: string) {
  cancelAll(state, reason);
  pushLog(state, "clean", `${reason} — wait for a fill; will not seed ±1 from mark`);
}

export function maintainPair(state: EngineState, why: string) {
  if (!state.config.armed) return;
  if (!fillAnchor(state)) {
    if (isAccumulate(state) && state.mark > 0) {
      const px = roundPrice(state.mark, state.config.market.priceDecimals);
      state.lastFillPrice = px;
      state.lastFillAt = state.now;
      ratchetHighest(state, px, "first-run seed from mark");
      pushLog(
        state,
        "info",
        `lastFill seeded from mark ${px.toFixed(state.config.market.priceDecimals)} (first run — place −1)`,
      );
    } else {
      if (!state.logs.some((l) => l.message.includes("no lastFill"))) {
        pushLog(state, "gate", "no lastFill — waiting for a fill before placing ±1");
      }
      return;
    }
  }
  if (isAccumulate(state)) {
    const m = state.config.market;
    const levels = validLevels(state);
    if (state.impulse === "buy") {
      harvestRipSells(state);
      return;
    }
    const needSell = !isFlat(state) && state.position.size > 0 && !hasNear(state, levels.sell, "sell");
    const needBuy = underBuyCap(state) && state.impulse === "none" && !hasNear(state, levels.buy, "buy");
    if (why.startsWith("arm") || needSell || needBuy) {
      pushLog(
        state,
        "info",
        `±1 ${why} buy ${levels.buy.toFixed(m.priceDecimals)} sell ${levels.sell.toFixed(m.priceDecimals)} lastFill ${fillAnchor(state)?.toFixed(m.priceDecimals)} hi ${state.highestLvl?.toFixed(m.priceDecimals) ?? "n/a"} cap ${buyUsedUsd(state).toFixed(0)}/${buyCapUsd(state).toFixed(0)}`,
      );
    }
    if (needSell) placeLimit(state, "sell", levels.sell, why, { reduceOnly: true });
    if (needBuy) placeLimit(state, "buy", levels.buy, why);
    return;
  }
  const levels = validLevels(state);
  const m = state.config.market;
  const needSell = !hasNear(state, levels.sell, "sell");
  const needBuy = !isFlat(state) && !hasNear(state, levels.buy, "buy");
  if (why.startsWith("arm") || needSell || needBuy) {
    pushLog(
      state,
      "info",
      `±1 ${why} buy ${levels.buy.toFixed(m.priceDecimals)} sell ${levels.sell.toFixed(m.priceDecimals)} lastFill ${fillAnchor(state)?.toFixed(m.priceDecimals)} $/lvl ${state.config.orderNotional}`,
    );
  }
  if (needSell) placeLimit(state, "sell", levels.sell, why);
  if (needBuy) placeLimit(state, "buy", levels.buy, why);
}

function postFillMissed(state: EngineState, fill: Fill) {
  const m = state.config.market;
  const up = upLevel(fill.price, state.factor, m.priceDecimals);
  const down = downLevel(fill.price, state.factor, m.priceDecimals);
  const keep: GridOrder[] = [];
  for (const order of state.orders) {
    if (!isMineOrder(order)) {
      keep.push(order);
      continue;
    }
    const belongs = sameRung(order.price, up, state.factor) || sameRung(order.price, down, state.factor);
    if (belongs) keep.push(order);
    else dropOrder(state, order, "old level after fill");
  }
  state.orders = keep;
  if (isAccumulate(state)) {
    if (state.impulse === "buy") {
      harvestRipSells(state);
      return;
    }
    if (state.impulse !== "none") {
      pushLog(state, "impulse", `post-fill skip new buys until impulse cools (anchor ${fill.price.toFixed(m.priceDecimals)})`);
      if (!isFlat(state) && !hasNear(state, up, "sell")) {
        placeLimit(state, "sell", up, "post-fill +1", { reduceOnly: true });
      }
      return;
    }
    if (!isFlat(state) && !hasNear(state, up, "sell")) placeLimit(state, "sell", up, "post-fill +1", { reduceOnly: true });
    if (underBuyCap(state) && !hasNear(state, down, "buy")) placeLimit(state, "buy", down, "post-fill −1");
    return;
  }
  if (state.impulse !== "none") {
    pushLog(state, "impulse", `post-fill skip new ±1 until impulse cools (anchor ${fill.price.toFixed(m.priceDecimals)})`);
    return;
  }
  if (!hasNear(state, up, "sell")) placeLimit(state, "sell", up, "post-fill +1");
  if (!hasNear(state, down, "buy")) placeLimit(state, "buy", down, "post-fill −1");
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
      if (isAccumulate(state)) {
        pushLog(state, "impulse", `impulse cool |Δ| ${resolved.deltaPct.toFixed(3)}% — catch missed rungs then ±1`);
      } else {
        pushLog(state, "impulse", `impulse cool |Δ| ${resolved.deltaPct.toFixed(3)}% — catch then current ±1`);
      }
    } else if (isAccumulate(state) && resolved.impulse === "buy") {
      pushLog(
        state,
        "impulse",
        `impulse BUY harvest ≥25% reduce-only above — no new buys (Δ ${resolved.deltaPct.toFixed(3)}%)`,
      );
    } else if (isAccumulate(state) && resolved.impulse === "sell") {
      pushLog(
        state,
        "impulse",
        `impulse SELL — block new buys, no knife-catch bunch (Δ ${resolved.deltaPct.toFixed(3)}%)`,
      );
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
    pushLog(state, "info", "armed — restore ±1 around last fill");
    if (state.accountSource === "live") {
      cleanInvalid(state);
      maintainPair(state, "arm restore ±1");
    }
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
  const acc = isAccumulate(state);
  if (acc) ratchetHighest(state, state.mark, "cool new high");
  const m = state.config.market;
  const distPct = (Math.abs(state.mark - anchor) / anchor) * 100;
  const prox = acc ? accumulateProxPct(state) : proximityPct(state.spacingPct, m);
  const far = distPct > prox;
  if (!far) {
    cleanInvalid(state);
    pushLog(
      state,
      "impulse",
      `impulse cool near Δ ${distPct.toFixed(2)}% < prox ${prox.toFixed(2)}% — clean leftover bot limits, ±1 only`,
    );
    return;
  }
  const side: Side = state.mark > anchor ? "sell" : "buy";
  if (isFlat(state) && side !== (m.prefer === "long" ? "buy" : "sell")) {
    pushLog(state, "impulse", `impulse cool far but flat — skip ${side} catch (prefer ${m.prefer})`);
    return;
  }
  if (acc && side === "buy" && !underBuyCap(state)) {
    pushLog(state, "impulse", `impulse cool far buy skipped — buy cap ${buyUsedUsd(state).toFixed(0)}/${buyCapUsd(state).toFixed(0)}`);
    cleanInvalid(state);
    return;
  }
  if (acc && side === "sell" && (isFlat(state) || state.position.size <= 0)) {
    pushLog(state, "impulse", "impulse cool far sell skipped — no shorts");
    return;
  }
  const rawSteps = stepsAway(anchor, state.mark, state.factor);
  const nLevels = Math.max(1, Math.min(8, Math.round(rawSteps)));
  const oneUsd = acc && side === "sell" ? sellTicketUsd(state, state.mark) : state.config.orderNotional;
  const one = baseQty(state.mark, oneUsd, m.sizeDecimals);
  if (one <= 0) return;
  const reducing = (state.position.size < 0 && side === "buy") || (state.position.size > 0 && side === "sell");
  let qty = roundQty(one * nLevels, m.sizeDecimals);
  let reduceOnly = false;
  if (reducing || (acc && side === "sell")) {
    qty = roundQty(Math.min(qty, Math.abs(state.position.size)), m.sizeDecimals);
    reduceOnly = true;
  } else {
    let remaining = remainingCapacity(state);
    if (acc && side === "buy") {
      remaining = Math.min(remaining, Math.max(0, buyCapUsd(state) - buyUsedUsd(state)));
    }
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
  if (acc) ratchetHighest(state, state.mark, "cool catch");
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
  } else if (isAccumulate(state) && anchor) {
    cleanInvalid(state);
    if (state.impulse === "buy") harvestRipSells(state);
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
  } else if (state.fillsThisCycle.length) {
    const latest = state.fillsThisCycle.reduce((a, b) =>
      Math.abs(a.price - state.mark) <= Math.abs(b.price - state.mark) ? a : b,
    );
    postFillMissed(state, latest);
  }

  if (state.fillsThisCycle.length === 0 && state.impulseJustCooled) {
    impulseCoolCatch(state);
  }

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
    strategy: m.strategy,
    priceDecimals: m.priceDecimals,
    sizeDecimals: m.sizeDecimals,
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
    highestLvl: state.highestLvl,
    buyCap: isAccumulate(state) ? buyCapUsd(state) : remaining,
    buyUsed: isAccumulate(state) ? buyUsedUsd(state) : posN,
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
