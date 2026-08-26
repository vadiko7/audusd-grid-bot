import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NATGAS } from "./markets.ts";
import { DEFAULT_FACTOR, DEFAULT_SPACING_PCT, ORDER_NOTIONAL } from "./constants.ts";
import {
  createInitialState,
  equity,
  remainingCapacity,
  setArmed,
  setOrderNotional,
  snapshotPublic,
  step,
} from "./engine.ts";
import { baseQty, downLevel, factorFromSpacing, roundPrice, upLevel } from "./math.ts";
import { classifyRegime, spacingFromAtr } from "./atr.ts";
import type { GridOrder } from "./types.ts";
import { nextImpulse } from "./impulse.ts";
import type { Candle, EngineState, LiveAccount } from "./types.ts";

function run(state: EngineState, mark: number, now: number, extras: { hourly?: Candle[]; minute?: Candle } = {}) {
  return step(state, {
    now,
    mark,
    hourlyCandles: extras.hourly,
    minuteCandle: extras.minute ?? null,
  });
}

function hourlyFromAtrPct(atrPct: number, mark: number, n = 16): Candle[] {
  const range = (atrPct / 100) * mark;
  const t0 = 1_000_000;
  const candles: Candle[] = [];
  let c = mark;
  for (let i = 0; i < n; i++) {
    const o = c;
    const h = o + range / 2;
    const l = o - range / 2;
    c = o;
    candles.push({ t: t0 + i * 3_600_000, o, h, l, c });
  }
  return candles;
}

function liveAccount(partial: Partial<LiveAccount> = {}): LiveAccount {
  return {
    accountIndex: 42,
    equity: 412.25,
    collateral: 400,
    available: 380,
    position: { size: 0, entry: 0 },
    positionNotional: 0,
    unrealizedPnl: 0,
    realizedPnl: 0,
    orders: [],
    foreignMargin: 0,
    ...partial,
  };
}

describe("geometry", () => {
  it("rounds base qty to 1 decimal from $100 notional", () => {
    assert.equal(baseQty(0.71575), 139.7);
    assert.equal(baseQty(0.71575, 50), 69.9);
  });

  it("builds ±1 geometric steps from 0.50% factor", () => {
    const p = 0.71575;
    assert.equal(upLevel(p, DEFAULT_FACTOR), roundPrice(p * 1.005));
    assert.equal(downLevel(p, DEFAULT_FACTOR), roundPrice(p / 1.005));
  });
});

describe("regime / spacing", () => {
  it("classifies ATR buckets", () => {
    assert.equal(classifyRegime(0.2), "low");
    assert.equal(classifyRegime(0.5), "normal");
    assert.equal(classifyRegime(0.9), "high");
    assert.equal(classifyRegime(1.3), "extreme");
  });

  it("clamps dynamic spacing", () => {
    assert.equal(spacingFromAtr(0.1), 0.3);
    assert.equal(spacingFromAtr(1.0), 0.8);
    assert.equal(spacingFromAtr(2.0), 1.0);
  });
});

describe("impulse", () => {
  it("triggers buy on +0.28% and cools under 0.10%", () => {
    assert.equal(nextImpulse("none", 0.28), "buy");
    assert.equal(nextImpulse("buy", 0.09), "none");
    assert.equal(nextImpulse("none", -0.28), "sell");
    assert.equal(nextImpulse("sell", -0.05), "none");
  });

  it("holds impulse between trigger and cool", () => {
    assert.equal(nextImpulse("buy", 0.15), "buy");
  });
});

describe("live account source of truth", () => {
  it("defaults to no equity until a live account is ingested", () => {
    const s = createInitialState();
    assert.equal(s.accountSource, "none");
    assert.equal(equity(s), 0);
    assert.equal(remainingCapacity(s), 0);
    setArmed(s, true);
    run(s, 0.7, 1_000);
    assert.equal(s.orders.length, 0);
  });

  it("uses live equity, position, and orders — never a starting balance", () => {
    const s = createInitialState();
    step(s, {
      now: 1_000,
      mark: 0.7,
      live: liveAccount({
        equity: 412.25,
        position: { size: -20, entry: 0.71 },
        positionNotional: 14.2,
        unrealizedPnl: 0.2,
        realizedPnl: 1.1,
      }),
    });
    assert.equal(s.accountSource, "live");
    assert.equal(equity(s), 412.25);
    assert.equal(s.position.size, -20);
    assert.equal(s.position.entry, 0.71);
    assert.equal(s.unrealizedPnl, 0.2);
    assert.ok(remainingCapacity(s) > ORDER_NOTIONAL);
  });

  it("does not cancel live working orders while disarmed", () => {
    const s = createInitialState();
    step(s, {
      now: 1_000,
      mark: 0.7,
      live: liveAccount({
        orders: [{ id: "99", side: "sell", price: 0.8, qty: 100, notional: 80, placedAt: 1 }],
      }),
    });
    assert.equal(s.orders.length, 1);
    assert.equal(s.actions.length, 0);
  });

  it("does not resurrect a cancelled live order from a stale snapshot", () => {
    const s = createInitialState();
    const liveOrder = { id: "301", side: "sell" as const, price: 0.8, qty: 100, notional: 80, placedAt: 1 };
    step(s, { now: 1_000, mark: 0.7, live: liveAccount({ orders: [liveOrder] }) });
    s.cancelledIds.push("301");
    s.cancelSentAt["301"] = 1_000;
    s.orders = [];
    step(s, { now: 2_000, mark: 0.7, live: liveAccount({ orders: [liveOrder] }) });
    assert.equal(s.orders.length, 1);
    assert.ok(s.cancelledIds.includes("301"));
    assert.equal(s.actions.length, 0);
    step(s, { now: 25_000, mark: 0.7, live: liveAccount({ orders: [liveOrder] }) });
    assert.ok(s.actions.some((a) => a.type === "cancel" && a.orderId === "301") || s.cancelledIds.includes("301") === false);
  });

  it("order gone with unchanged position is a cancel, not a fill — keeps lastFill ±1", () => {
    const s = createInitialState({ startingEquity: 2000 });
    const last = 0.7172;
    s.lastFillPrice = last;
    s.lastFillAt = 1;
    s.position = { size: -1533.8, entry: last };
    setArmed(s, true);
    const farSell = {
      id: "far",
      side: "sell" as const,
      price: upLevel(upLevel(last, DEFAULT_FACTOR), DEFAULT_FACTOR),
      qty: 139.2,
      notional: 100,
      placedAt: 1,
    };
    const innerSell = upLevel(last, DEFAULT_FACTOR);
    step(s, {
      now: 1_000,
      mark: 0.7186,
      live: liveAccount({
        equity: 500,
        position: { size: -1533.8, entry: last },
        positionNotional: 1100,
        orders: [farSell],
      }),
    });
    s.actions = [];
    step(s, {
      now: 2_000,
      mark: 0.7186,
      live: liveAccount({
        equity: 500,
        position: { size: -1533.8, entry: last },
        positionNotional: 1100,
        orders: [],
      }),
    });
    assert.equal(s.fillsThisCycle.length, 0);
    assert.equal(s.lastFillPrice, last);
    const sellPrices = [
      ...s.orders.filter((o) => o.side === "sell").map((o) => o.price),
      ...s.actions.filter((a) => a.type === "place" && a.side === "sell").map((a) => a.price),
    ];
    assert.ok(sellPrices.some((p) => Math.abs(p - innerSell) < 1e-8), `expected inner sell ${innerSell} got ${sellPrices}`);
    assert.ok(sellPrices.every((p) => Math.abs(p - farSell.price) > 1e-8));
  });

  it("changes notional per level and resizes next place", () => {
    const s = createInitialState({ startingEquity: 2000 });
    setOrderNotional(s, 50);
    s.lastFillPrice = 0.7;
    s.lastFillAt = 1;
    setArmed(s, true);
    run(s, 0.7, 1_000);
    assert.equal(s.config.orderNotional, 50);
    assert.equal(s.orders[0]?.qty, baseQty(0.7, 50));
    setOrderNotional(s, 200);
    assert.equal(s.config.orderNotional, 200);
    assert.ok(s.actions.some((a) => a.type === "cancel"));
  });
});

describe("engine cycle", () => {
  it("cleans extra ±2 down to one buy and one sell", () => {
    const s = createInitialState({ startingEquity: 5000 });
    s.lastFillPrice = 0.7172;
    s.lastFillAt = 1;
    s.position = { size: -140, entry: 0.7172 };
    s.orders = [
      { id: "1", side: "buy", price: 0.71363, qty: 139.2, notional: 99.3, placedAt: 1 },
      { id: "2", side: "sell", price: 0.72079, qty: 139.2, notional: 100.3, placedAt: 1 },
      { id: "3", side: "buy", price: 0.71505, qty: 139.3, notional: 99.6, placedAt: 1 },
      { id: "4", side: "sell", price: 0.71935, qty: 139.3, notional: 100.2, placedAt: 1 },
    ];
    setArmed(s, true);
    run(s, 0.7172, 2_000);
    assert.equal(s.orders.filter((o) => o.side === "buy").length, 1);
    assert.equal(s.orders.filter((o) => o.side === "sell").length, 1);
    assert.ok(s.orders.length <= 2);
    assert.ok(s.actions.filter((a) => a.type === "cancel" || a.type === "cancel_all").length >= 2);
  });

  it("after a fill, leftover ±2 does not block opposite ±1 and is cleaned", () => {
    const s = createInitialState({ startingEquity: 2000 });
    const last = 0.7172;
    s.lastFillPrice = last;
    s.lastFillAt = 1;
    s.position = { size: -139.2, entry: last };
    const farSell = upLevel(upLevel(last, DEFAULT_FACTOR), DEFAULT_FACTOR);
    s.orders = [{ id: "old", side: "sell", price: farSell, qty: 139.2, notional: 100, placedAt: 1 }];
    setArmed(s, true);
    run(s, 0.7186, 2_000);
    const innerSell = upLevel(last, DEFAULT_FACTOR);
    const innerBuy = downLevel(last, DEFAULT_FACTOR);
    const sells = s.orders.filter((o) => o.side === "sell");
    const buys = s.orders.filter((o) => o.side === "buy");
    assert.equal(sells.length, 1);
    assert.ok(Math.abs(sells[0].price - innerSell) < 1e-8);
    assert.equal(buys.length, 1);
    assert.ok(Math.abs(buys[0].price - innerBuy) < 1e-8);
    assert.ok(s.actions.some((a) => a.type === "cancel" && a.orderId === "old"));
  });

  it("uses the fill closest to mark, not an older vanished ticket", () => {
    const s = createInitialState({ startingEquity: 5000 });
    const first = 0.7172;
    const sold = upLevel(first, DEFAULT_FACTOR);
    s.lastFillPrice = first;
    s.lastFillAt = 1;
    s.position = { size: -139.2, entry: first };
    setArmed(s, true);
    const oldBuy = {
      id: "old",
      side: "buy" as const,
      price: downLevel(first, DEFAULT_FACTOR),
      qty: 139.2,
      notional: 100,
      placedAt: 1,
    };
    const newSell = { id: "new", side: "sell" as const, price: sold, qty: 139.2, notional: 100, placedAt: 1 };
    step(s, {
      now: 1_000,
      mark: sold,
      live: liveAccount({
        equity: 500,
        position: { size: -139.2, entry: first },
        positionNotional: 100,
        orders: [oldBuy, newSell],
      }),
    });
    s.actions = [];
    step(s, {
      now: 2_000,
      mark: sold,
      live: liveAccount({
        equity: 500,
        position: { size: -278.4, entry: (first + sold) / 2 },
        positionNotional: 200,
        orders: [],
      }),
    });
    assert.equal(s.lastFillPrice, sold);
    const innerBuy = downLevel(sold, DEFAULT_FACTOR);
    const innerSell = upLevel(sold, DEFAULT_FACTOR);
    const placed = s.actions.filter((a) => a.type === "place").map((a) => a.price);
    const working = s.orders.map((o) => o.price);
    const prices = [...placed, ...working];
    assert.ok(prices.some((p) => Math.abs(p - innerSell) < 1e-8), `need +1 ${innerSell} got ${prices}`);
    assert.ok(prices.some((p) => Math.abs(p - innerBuy) < 1e-8), `need -1 ${innerBuy} got ${prices}`);
    assert.ok(prices.every((p) => Math.abs(p - sold) > 1e-8), `must not re-place fill ${sold}`);
  });

  it("position move then vanished order still counts as that fill (lagged REST)", () => {
    const s = createInitialState({ startingEquity: 5000 });
    const first = 0.7172;
    const sold = upLevel(first, DEFAULT_FACTOR);
    s.lastFillPrice = first;
    s.lastFillAt = 1;
    s.position = { size: -139.2, entry: first };
    setArmed(s, true);
    const newSell = { id: "new", side: "sell" as const, price: sold, qty: 139.2, notional: 100, placedAt: 1 };
    step(s, {
      now: 1_000,
      mark: sold,
      live: liveAccount({
        equity: 500,
        position: { size: -278.4, entry: sold },
        positionNotional: 200,
        orders: [newSell],
      }),
    });
    assert.equal(s.lastFillPrice, first);
    step(s, {
      now: 2_000,
      mark: sold,
      live: liveAccount({
        equity: 500,
        position: { size: -278.4, entry: sold },
        positionNotional: 200,
        orders: [],
      }),
    });
    assert.equal(s.lastFillPrice, sold);
  });

  it("NATGAS: mark through the +1 sell walks lastFill and places the next ±1", () => {
    const s = createInitialState({ market: NATGAS, startingEquity: 5000 });
    const last = 2.855;
    s.lastFillPrice = last;
    s.lastFillAt = 1;
    s.position = { size: 35, entry: last };
    const oldBuy = downLevel(last, NATGAS.defaultFactor, NATGAS.priceDecimals);
    s.orders = [{ id: "old", side: "buy", price: oldBuy, qty: 34.36, notional: 96, placedAt: 1 }];
    setArmed(s, true);
    const crossed = upLevel(last, NATGAS.defaultFactor, NATGAS.priceDecimals);
    step(s, {
      now: 2_000,
      mark: 2.917,
      live: liveAccount({
        equity: 500,
        position: { size: 35, entry: last },
        positionNotional: 100,
        orders: [{ id: "old", side: "buy", price: oldBuy, qty: 34.36, notional: 96, placedAt: 1 }],
      }),
    });
    assert.equal(s.lastFillPrice, crossed);
    const nextSell = upLevel(crossed, NATGAS.defaultFactor, NATGAS.priceDecimals);
    const nextBuy = downLevel(crossed, NATGAS.defaultFactor, NATGAS.priceDecimals);
    const prices = [
      ...s.orders.map((o) => o.price),
      ...s.actions.filter((a) => a.type === "place").map((a) => a.price),
    ];
    assert.ok(prices.some((p) => Math.abs(p - nextSell) < 1e-6), `need sell ${nextSell} got ${prices}`);
    assert.ok(prices.some((p) => Math.abs(p - nextBuy) < 1e-6), `need buy ${nextBuy} got ${prices}`);
    assert.ok(!prices.some((p) => Math.abs(p - crossed) < 1e-6));
    assert.ok(s.actions.some((a) => a.type === "cancel" && a.orderId === "old"));
    assert.ok(!s.logs.some((l) => l.message.includes("marketable sell")));
  });

  it("pending ghost does not log order-gone and expires so ±1 can re-place", () => {
    const s = createInitialState({ startingEquity: 5000 });
    const last = 0.7172;
    s.lastFillPrice = last;
    s.lastFillAt = 1;
    s.position = { size: -1533.8, entry: last };
    setArmed(s, true);
    const sell = upLevel(last, DEFAULT_FACTOR);
    s.orders = [{ id: "pending:1", side: "sell", price: sell, qty: 139.4, notional: 100, placedAt: 1 }];
    step(s, {
      now: 2_000,
      mark: 0.71729,
      live: liveAccount({
        equity: 500,
        position: { size: -1533.8, entry: last },
        positionNotional: 1100,
        orders: [],
      }),
    });
    assert.ok(!s.logs.some((l) => l.message.includes("order gone")));
    assert.ok(s.orders.some((o) => o.side === "sell" && o.id.startsWith("pending:")));
    step(s, {
      now: 20_000,
      mark: 0.71729,
      live: liveAccount({
        equity: 500,
        position: { size: -1533.8, entry: last },
        positionNotional: 1100,
        orders: [],
      }),
    });
    assert.ok(s.logs.some((l) => l.message.includes("pending") && l.message.includes("expired")));
    assert.ok(s.actions.some((a) => a.type === "place" && a.side === "sell"));
  });

  it("does not place on a rung that already has a foreign/leftover order", () => {
    const s = createInitialState({ startingEquity: 5000 });
    const last = 0.7172;
    s.lastFillPrice = last;
    s.lastFillAt = 1;
    s.position = { size: -1533.8, entry: last };
    const sell = upLevel(last, DEFAULT_FACTOR);
    const leftover: GridOrder = {
      id: "leftover",
      side: "sell",
      price: sell,
      qty: 139.4,
      notional: 100,
      placedAt: 1,
      mine: false,
    };
    setArmed(s, true);
    step(s, {
      now: 2_000,
      mark: 0.71729,
      live: liveAccount({
        equity: 500,
        position: { size: -1533.8, entry: last },
        positionNotional: 1100,
        orders: [leftover],
      }),
    });
    assert.equal(s.orders.filter((o) => o.side === "sell").length, 1);
    assert.equal(s.orders.find((o) => o.side === "sell")?.id, "leftover");
    assert.ok(!s.actions.some((a) => a.type === "place" && a.side === "sell"));
    assert.ok(!s.actions.some((a) => a.type === "cancel" && a.orderId === "leftover"));
  });

  it("cancels a bot leftover on the fill price, then places real ±1", () => {
    const s = createInitialState({ startingEquity: 5000 });
    const last = 0.7172;
    s.lastFillPrice = last;
    s.lastFillAt = 1;
    s.position = { size: -1533.8, entry: last };
    const onFill: GridOrder = {
      id: "onfill",
      side: "buy",
      price: last,
      qty: 139.4,
      notional: 100,
      placedAt: 1,
      mine: true,
    };
    setArmed(s, true);
    step(s, {
      now: 2_000,
      mark: 0.71729,
      live: liveAccount({
        equity: 500,
        position: { size: -1533.8, entry: last },
        positionNotional: 1100,
        orders: [onFill],
      }),
    });
    assert.ok(s.actions.some((a) => a.type === "cancel" && a.orderId === "onfill"));
    const buy = downLevel(last, DEFAULT_FACTOR);
    const sell = upLevel(last, DEFAULT_FACTOR);
    const placed = s.actions.filter((a) => a.type === "place").map((a) => a.price);
    assert.ok(placed.some((p) => Math.abs(p - buy) < 1e-8));
    assert.ok(placed.some((p) => Math.abs(p - sell) < 1e-8));
  });

  it("without lastFill does not use average entry — no clean, no place on fill", () => {
    const s = createInitialState({ startingEquity: 5000 });
    const last = 0.7172;
    s.position = { size: -1533.8, entry: 0.72 };
    s.lastFillPrice = null;
    const onFill: GridOrder = {
      id: "onfill",
      side: "buy",
      price: last,
      qty: 139.4,
      notional: 100,
      placedAt: 1,
      mine: false,
    };
    setArmed(s, true);
    step(s, {
      now: 2_000,
      mark: 0.71729,
      live: liveAccount({
        equity: 500,
        position: { size: -1533.8, entry: 0.72 },
        positionNotional: 1100,
        orders: [onFill],
      }),
    });
    assert.equal(s.lastFillPrice, null);
    assert.ok(!s.actions.some((a) => a.type === "cancel"));
    assert.ok(!s.actions.some((a) => a.type === "place"));
    assert.equal(s.orders.find((o) => o.id === "onfill")?.id, "onfill");
  });

  it("with lastFill and no bot orders, places the missing ±1", () => {
    const s = createInitialState({ startingEquity: 5000 });
    const last = 0.7172;
    s.lastFillPrice = last;
    s.lastFillAt = 1;
    s.position = { size: -1533.8, entry: last };
    setArmed(s, true);
    step(s, {
      now: 2_000,
      mark: 0.71729,
      live: liveAccount({
        equity: 500,
        position: { size: -1533.8, entry: last },
        positionNotional: 1100,
        orders: [],
      }),
    });
    const buy = downLevel(last, DEFAULT_FACTOR);
    const sell = upLevel(last, DEFAULT_FACTOR);
    const places = s.actions.filter((a) => a.type === "place");
    assert.ok(places.some((a) => a.side === "buy" && Math.abs(a.price - buy) < 1e-8));
    assert.ok(places.some((a) => a.side === "sell" && Math.abs(a.price - sell) < 1e-8));
  });

  it("infers lastFill from an existing bot ±1 pair", () => {
    const s = createInitialState({ startingEquity: 5000 });
    const last = 0.7172;
    const buy = downLevel(last, DEFAULT_FACTOR);
    const sell = upLevel(last, DEFAULT_FACTOR);
    s.lastFillPrice = null;
    s.position = { size: -1533.8, entry: last };
    setArmed(s, true);
    step(s, {
      now: 2_000,
      mark: 0.71729,
      live: liveAccount({
        equity: 500,
        position: { size: -1533.8, entry: last },
        positionNotional: 1100,
        orders: [
          { id: "b", side: "buy", price: buy, qty: 139.4, notional: 100, placedAt: 1, mine: true },
          { id: "s", side: "sell", price: sell, qty: 139.4, notional: 100, placedAt: 1, mine: true },
        ],
      }),
    });
    assert.ok(s.lastFillPrice && Math.abs(s.lastFillPrice - last) < 1e-4);
    assert.ok(!s.actions.some((a) => a.type === "place"));
  });

  it("first live snapshot does not treat the open position as fills", () => {
    const s = createInitialState({ startingEquity: 5000 });
    const last = 2.9121;
    const buy = downLevel(last, NATGAS.defaultFactor);
    const sell = upLevel(last, NATGAS.defaultFactor);
    s.config.market = NATGAS;
    s.factor = NATGAS.defaultFactor;
    s.spacingPct = NATGAS.defaultSpacingPct;
    s.lastFillPrice = null;
    setArmed(s, true);
    step(s, {
      now: 2_000,
      mark: 2.8972,
      live: liveAccount({
        equity: 500,
        position: { size: 210.24, entry: 2.85 },
        positionNotional: 608,
        orders: [
          { id: "b", side: "buy", price: buy, qty: 34.5, notional: 100, placedAt: 1, mine: true },
          { id: "s", side: "sell", price: sell, qty: 34.5, notional: 100, placedAt: 1, mine: true },
        ],
      }),
    });
    assert.ok(s.lastFillPrice && Math.abs(s.lastFillPrice - last) < 0.002);
    assert.ok(!s.actions.some((a) => a.type === "cancel"));
    assert.ok(!s.actions.some((a) => a.type === "place"));
    assert.equal(s.orders.filter((o) => o.side === "buy").length, 1);
    assert.equal(s.orders.filter((o) => o.side === "sell").length, 1);
  });

  it("on-fill leftover infers lastFill and places real ±1, not the fill", () => {
    const s = createInitialState({ startingEquity: 5000 });
    s.config.market = NATGAS;
    s.factor = NATGAS.defaultFactor;
    s.spacingPct = NATGAS.defaultSpacingPct;
    const fill = 2.9121;
    s.lastFillPrice = null;
    s.position = { size: 210.24, entry: 2.85 };
    setArmed(s, true);
    step(s, {
      now: 2_000,
      mark: 2.8842,
      live: liveAccount({
        equity: 500,
        position: { size: 210.24, entry: 2.85 },
        positionNotional: 608,
        orders: [{ id: "onfill", side: "sell", price: fill, qty: 34.5, notional: 100, placedAt: 1, mine: true }],
      }),
    });
    const buy = downLevel(fill, NATGAS.defaultFactor);
    const sell = upLevel(fill, NATGAS.defaultFactor);
    assert.ok(s.actions.some((a) => a.type === "cancel" && a.orderId === "onfill"));
    const places = s.actions.filter((a) => a.type === "place");
    assert.ok(places.some((a) => a.side === "buy" && Math.abs(a.price - buy) < 1e-4));
    assert.ok(places.some((a) => a.side === "sell" && Math.abs(a.price - sell) < 1e-4));
    assert.ok(!places.some((a) => Math.abs(a.price - fill) < 1e-4));
  });

  it("when flat and armed with no fill, does not seed from mark", () => {
    const s = createInitialState({ startingEquity: 1000 });
    setArmed(s, true);
    run(s, 0.7, 1_000);
    assert.equal(s.orders.length, 0);
    assert.equal(s.actions.length, 0);
  });

  it("rejects remaining < 100", () => {
    const s = createInitialState({ startingEquity: 3 });
    s.lastFillPrice = 0.7;
    s.lastFillAt = 1;
    setArmed(s, true);
    run(s, 0.7, 1_000);
    assert.equal(s.orders.length, 0);
    assert.ok(s.logs.some((l) => l.level === "gate" && l.message.includes("remaining")));
  });

  it("fills a sell and then places missed ±1", () => {
    const s = createInitialState({ startingEquity: 2000 });
    setArmed(s, true);
    const mark0 = 0.7;
    run(s, mark0, 1_000);
    assert.equal(s.orders.length, 0);
    const seedPx = upLevel(mark0, DEFAULT_FACTOR);
    s.orders = [{ id: "seed", side: "sell", price: seedPx, qty: 100, notional: 70, placedAt: 1_000 }];
    run(s, seedPx, 2_000);
    assert.equal(s.fillsThisCycle.length, 1);
    assert.ok(s.position.size < 0);
    const prices = s.orders.map((o) => o.price).sort();
    const expectedBuy = downLevel(seedPx, DEFAULT_FACTOR);
    const expectedSell = upLevel(seedPx, DEFAULT_FACTOR);
    assert.ok(prices.includes(expectedBuy));
    assert.ok(prices.includes(expectedSell));
  });

  it("NATGAS long: no seed from mark; after buy fill places ±1 at 2%", () => {
    const s = createInitialState({ market: NATGAS, startingEquity: 2000 });
    setArmed(s, true);
    run(s, 2.85, 1_000);
    assert.equal(s.orders.length, 0);
    const seedPx = downLevel(2.85, NATGAS.defaultFactor, NATGAS.priceDecimals);
    s.orders = [{ id: "seed", side: "buy", price: seedPx, qty: 35, notional: 100, placedAt: 1_000 }];
    run(s, seedPx, 2_000);
    assert.equal(s.fillsThisCycle.length, 1);
    assert.ok(s.position.size > 0);
    const prices = s.orders.map((o) => o.price);
    assert.ok(prices.includes(upLevel(seedPx, NATGAS.defaultFactor, NATGAS.priceDecimals)));
    assert.ok(prices.includes(downLevel(seedPx, NATGAS.defaultFactor, NATGAS.priceDecimals)));
  });

  it("freezes all new limits during impulse so a walk cannot staircase", () => {
    const s = createInitialState({ startingEquity: 2000 });
    const t0 = 100_000;
    for (let i = 0; i < 8; i++) {
      run(s, 0.7, t0 + i * 2_000);
    }
    s.lastFillPrice = 0.7;
    s.lastFillAt = t0;
    s.position = { size: -baseQty(0.7), entry: 0.7 };
    setArmed(s, true);
    run(s, 0.7, t0 + 16_000);
    s.orders = [];
    s.actions = [];
    run(s, 0.7 * 1.0035, t0 + 16_000 + 50_000);
    assert.equal(s.impulse, "buy");
    assert.ok(s.logs.some((l) => l.level === "impulse" && l.message.includes("freeze new limits")));
    assert.equal(s.orders.length, 0);
  });

  it("does not backfill a ladder after price walks", () => {
    const s = createInitialState({ startingEquity: 5000 });
    s.lastFillPrice = 0.7;
    s.lastFillAt = 1;
    s.position = { size: -baseQty(0.7), entry: 0.7 };
    setArmed(s, true);
    run(s, 0.73, 10_000);
    assert.ok(s.orders.length <= 2);
    assert.ok(s.orders.filter((o) => o.side === "buy").length <= 1);
    assert.ok(s.orders.filter((o) => o.side === "sell").length <= 1);
    assert.equal(s.lastFillPrice, 0.7);
  });

  it("remaining uses leverage * equity minus position and pending", () => {
    const s = createInitialState({ startingEquity: 1000 });
    s.mark = 0.7;
    s.position = { size: -baseQty(0.7), entry: 0.7 };
    const eq = equity(s, 0.7);
    const rem = remainingCapacity(s, 0.7);
    assert.ok(eq > 900);
    assert.ok(rem < eq * 25);
    assert.ok(rem > ORDER_NOTIONAL);
  });

  it("remaining shares equity: other-market margin is not available", () => {
    const s = createInitialState({ startingEquity: 1000 });
    s.mark = 0.7;
    s.foreignMargin = 400;
    const rem = remainingCapacity(s, 0.7);
    assert.equal(rem, (1000 - 400) * 25);
  });

  it("keeps fixed spacing and does not re-grid on ATR candles", () => {
    const s = createInitialState({ startingEquity: 2000, dynamicSpacing: true });
    s.lastFillPrice = 0.7;
    s.lastFillAt = 1;
    setArmed(s, true);
    const low = hourlyFromAtrPct(0.4, 0.7);
    run(s, 0.7, 1_000, { hourly: low });
    const high = hourlyFromAtrPct(1.1, 0.7);
    high.forEach((c, i) => {
      c.t = (low.at(-1)?.t ?? 0) + (i + 1) * 3_600_000;
    });
    run(s, 0.7, 2_000, { hourly: [...low.slice(-2), ...high] });
    assert.equal(s.spacingPct, DEFAULT_SPACING_PCT);
    assert.equal(s.config.dynamicSpacing, false);
    assert.ok(!s.actions.some((a) => a.type === "cancel_all" && String(a.why).includes("spacing")));
  });

  it("impulse cool far from last fill sends one market for missed levels", () => {
    const s = createInitialState({ startingEquity: 8000 });
    const t0 = 100_000;
    for (let i = 0; i < 10; i++) run(s, 0.7, t0 + i * 2_000);
    s.lastFillPrice = 0.7;
    s.lastFillAt = t0;
    s.position = { size: -baseQty(0.7), entry: 0.7 };
    setArmed(s, true);
    run(s, 0.73, t0 + 50_000);
    assert.equal(s.impulse, "buy");
    let catchActions = s.actions.slice();
    for (let i = 1; i <= 35; i++) {
      run(s, 0.73, t0 + 50_000 + i * 2_000);
      if (s.impulse === "none" && s.actions.some((a) => a.type === "place")) {
        catchActions = s.actions.slice();
        break;
      }
    }
    assert.equal(s.impulse, "none");
    const mkt = catchActions.find((a) => a.type === "place" && a.exec === "market");
    assert.ok(mkt);
    assert.equal(mkt && mkt.type === "place" ? mkt.side : "", "sell");
    assert.ok(mkt && mkt.type === "place" ? mkt.qty > baseQty(0.73) : false);
  });

  it("impulse cool near last fill uses a limit at mark then ±1", () => {
    const s = createInitialState({ startingEquity: 8000 });
    const t0 = 100_000;
    for (let i = 0; i < 10; i++) run(s, 0.7, t0 + i * 2_000);
    s.lastFillPrice = 0.7;
    s.lastFillAt = t0;
    s.position = { size: -baseQty(0.7), entry: 0.7 };
    setArmed(s, true);
    const near = 0.7 * 1.0035;
    run(s, near, t0 + 50_000);
    assert.equal(s.impulse, "buy");
    let catchActions = s.actions.slice();
    for (let i = 1; i <= 35; i++) {
      run(s, near, t0 + 50_000 + i * 2_000);
      if (s.impulse === "none" && s.actions.some((a) => a.type === "place")) {
        catchActions = s.actions.slice();
        break;
      }
    }
    assert.equal(s.impulse, "none");
    const mkt = catchActions.find((a) => a.type === "place" && a.exec === "market");
    assert.equal(mkt, undefined);
    const lim = catchActions.find((a) => a.type === "place");
    assert.ok(lim);
  });

  it("public snapshot exposes levels and bias", () => {
    const s = createInitialState({ startingEquity: 1000 });
    setArmed(s, true);
    run(s, 0.72, 5_000);
    const snap = snapshotPublic(s);
    assert.equal(snap.bias, "flat");
    assert.equal(snap.levels.sell, upLevel(0.72, factorFromSpacing(snap.spacingPct)));
    assert.equal(snap.armed, true);
  });
});
