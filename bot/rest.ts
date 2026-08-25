import dns from "node:dns";
import {
  LIGHTER_REST,
  MARKET_ID,
  PRICE_DECIMALS,
  SIZE_DECIMALS,
} from "../src/lib/grid/constants.ts";
import type { Candle, GridOrder, LiveAccount, Side } from "../src/lib/grid/types.ts";

dns.setDefaultResultOrder("ipv4first");

type RawPosition = {
  market_id: number;
  sign: number | string;
  position: string;
  avg_entry_price: string;
  position_value: string;
  unrealized_pnl: string;
  realized_pnl: string;
};

type RawAccount = {
  index?: number;
  account_index?: number;
  collateral?: string;
  available_balance?: string;
  total_asset_value?: string | number;
  cross_asset_value?: string | number;
  positions?: RawPosition[];
  l1_address?: string;
  pending_order_count?: number;
};

type RawOrder = {
  order_index?: number;
  order_id?: string;
  market_index?: number;
  market_id?: number;
  price?: string;
  remaining_base_amount?: string;
  initial_base_amount?: string;
  is_ask?: boolean;
  side?: string;
  timestamp?: number;
  created_at?: number;
};

type BookRow = { market_id?: number; mark_price?: string | number };

const UA = "audusd-grid-bot/1.0";

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

async function lighterGet<T>(path: string, headers?: Record<string, string>): Promise<T> {
  const res = await fetch(`${LIGHTER_REST}${path}`, {
    method: "GET",
    headers: {
      accept: "application/json",
      "user-agent": UA,
      ...headers,
    },
    cache: "no-store",
    redirect: "follow",
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`Lighter ${res.status} ${path}`);
  return (await res.json()) as T;
}

export function mapAccount(raw: RawAccount): LiveAccount {
  const accountIndex = Number(raw.account_index ?? raw.index ?? 0);
  const pos = (raw.positions ?? []).find((p) => Number(p.market_id) === MARKET_ID);
  const sign = num(pos?.sign) || 0;
  const absSize = num(pos?.position);
  const size = sign === 0 ? 0 : sign * absSize;
  const entry = num(pos?.avg_entry_price);
  const positionNotional = Math.abs(num(pos?.position_value) || size * entry);
  const unrealizedPnl = num(pos?.unrealized_pnl);
  const realizedPnl = num(pos?.realized_pnl);
  const collateral = num(raw.collateral);
  const totalAsset = num(raw.total_asset_value);
  const crossAsset = num(raw.cross_asset_value);
  const equity = totalAsset > 0 ? totalAsset : crossAsset > 0 ? crossAsset : collateral + unrealizedPnl;
  return {
    accountIndex,
    equity,
    collateral,
    available: num(raw.available_balance),
    position: { size, entry },
    positionNotional,
    unrealizedPnl,
    realizedPnl,
    orders: [],
  };
}

export function mapOrders(raw: RawOrder[]): GridOrder[] {
  return raw
    .filter((o) => Number(o.market_index ?? o.market_id ?? MARKET_ID) === MARKET_ID)
    .map((o) => {
      const isAsk = o.is_ask === true || o.side === "sell" || o.side === "ask";
      const side: Side = isAsk ? "sell" : "buy";
      const priceRaw = String(o.price ?? "0");
      const qtyRaw = String(o.remaining_base_amount ?? o.initial_base_amount ?? "0");
      const price = priceRaw.includes(".") ? num(priceRaw) : num(priceRaw) / 10 ** PRICE_DECIMALS;
      const qty = qtyRaw.includes(".") ? num(qtyRaw) : num(qtyRaw) / 10 ** SIZE_DECIMALS;
      return {
        id: String(o.order_index ?? o.order_id ?? ""),
        side,
        price,
        qty,
        notional: qty * price,
        placedAt: Number(o.timestamp ?? o.created_at ?? Date.now()),
      };
    })
    .filter((o) => o.id && o.price > 0 && o.qty > 0);
}

export async function fetchAccount(accountIndex: number): Promise<LiveAccount> {
  const json = await lighterGet<{ code: number; message?: string; accounts?: RawAccount[] }>(
    `/api/v1/account?by=index&value=${encodeURIComponent(String(accountIndex))}`,
  );
  if (json.code !== 200 || !json.accounts?.[0]) {
    throw new Error(json.message || "Account not found on Lighter");
  }
  return mapAccount(json.accounts[0]);
}

export async function fetchActiveOrders(accountIndex: number, auth: string): Promise<GridOrder[]> {
  const qs = new URLSearchParams({
    account_index: String(accountIndex),
    market_id: String(MARKET_ID),
    auth,
  });
  const json = await lighterGet<{ code: number; message?: string; orders?: RawOrder[] }>(
    `/api/v1/accountActiveOrders?${qs.toString()}`,
    { authorization: auth },
  );
  if (json.code && json.code !== 200) {
    throw new Error(json.message || "Failed to load open orders");
  }
  return mapOrders(json.orders ?? []);
}

function markFromBooks(json: {
  order_book_details?: BookRow[];
  order_books?: BookRow[];
}): number {
  const rows = json.order_book_details ?? json.order_books ?? [];
  const row = rows.find((r) => Number(r.market_id) === MARKET_ID) ?? rows[0];
  return Number(row?.mark_price);
}

export async function fetchMark(): Promise<number> {
  const paths = [
    `/api/v1/orderBooks?market_id=${MARKET_ID}`,
    `/api/v1/orderBookDetails?market_id=${MARKET_ID}`,
    `/api/v1/orderBooks`,
    `/api/v1/orderBookDetails`,
  ];
  let last = "AUDUSD mark missing";
  for (const path of paths) {
    try {
      const json = await lighterGet<{ order_book_details?: BookRow[]; order_books?: BookRow[] }>(path);
      const mark = markFromBooks(json);
      if (mark > 0) return mark;
      last = `${path} empty mark`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
  }
  try {
    const json = await lighterGet<{ trades?: Array<{ price?: string }> }>(
      `/api/v1/recentTrades?market_id=${MARKET_ID}&limit=1`,
    );
    const mark = Number(json.trades?.[0]?.price);
    if (mark > 0) return mark;
  } catch (err) {
    last = err instanceof Error ? err.message : String(err);
  }
  throw new Error(last);
}

export async function fetchCandles(resolution: "1m" | "1h", countBack: number): Promise<Candle[]> {
  const now = Date.now();
  const hours = resolution === "1h" ? countBack + 2 : 6;
  const start = now - hours * 3600_000;
  const path =
    `/api/v1/markPriceCandles?market_id=${MARKET_ID}` +
    `&resolution=${resolution}&start_timestamp=${start}&end_timestamp=${now}` +
    `&count_back=${countBack}`;
  const json = await lighterGet<{ c?: Candle[] }>(path);
  return json.c ?? [];
}

export async function sendTx(tx: {
  txType: number;
  txInfo: string;
  accountIndex: number;
  apiKeyIndex: number;
}): Promise<{ hash?: string; code?: number; message?: string }> {
  const body = new URLSearchParams();
  body.set("tx_type", String(tx.txType));
  body.set("tx_info", tx.txInfo);
  body.set("account_index", String(tx.accountIndex));
  body.set("api_key_index", String(tx.apiKeyIndex));
  body.set("price_protection", "true");
  const res = await fetch(`${LIGHTER_REST}/api/v1/sendTx`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
      "user-agent": UA,
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json()) as { hash?: string; tx_hash?: string; code?: number; message?: string };
  if (!res.ok || (json.code && json.code !== 200)) {
    throw new Error(json.message || `sendTx ${res.status}`);
  }
  return { hash: json.tx_hash || json.hash, code: json.code, message: json.message };
}
