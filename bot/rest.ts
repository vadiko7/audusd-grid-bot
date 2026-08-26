import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  LIGHTER_REST,
  LIGHTER_WS,
} from "../src/lib/grid/constants.ts";
import type { MarketProfile } from "../src/lib/grid/markets.ts";
import { MARKETS } from "../src/lib/grid/markets.ts";
import type { Candle, GridOrder, LiveAccount, Side } from "../src/lib/grid/types.ts";

const execFileAsync = promisify(execFile);

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
  client_order_index?: number;
  client_order_id?: string | number;
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
type HttpResult = { status: number; body: string };

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

async function curlCall(
  method: string,
  urlStr: string,
  headers: Record<string, string> = {},
  body?: string,
  timeoutMs = 8_000,
): Promise<HttpResult> {
  const args = [
    "-sS",
    "-H",
    "accept: application/json",
    "-w",
    "\n__STATUS__%{http_code}",
    "--max-time",
    String(Math.max(3, Math.ceil(timeoutMs / 1000))),
  ];
  if (method !== "GET" && method !== "HEAD") args.push("-X", method);
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === "accept") continue;
    args.push("-H", `${k}: ${v}`);
  }
  if (body) args.push("--data-binary", body);
  args.push(urlStr);
  const { stdout } = await execFileAsync("curl", args, { maxBuffer: 12_000_000 });
  const idx = stdout.lastIndexOf("\n__STATUS__");
  if (idx < 0) return { status: 0, body: stdout };
  return {
    body: stdout.slice(0, idx),
    status: Number(stdout.slice(idx + "\n__STATUS__".length)),
  };
}

let coolUntil = 0;
let coolMs = 15_000;

export function restReady(): boolean {
  return Date.now() >= coolUntil;
}

export function restBlockedFor(): number {
  return Math.max(0, coolUntil - Date.now());
}

function tripCool(status: number, hint: string) {
  if (status !== 405 && !/Human Verification/i.test(hint)) return;
  coolUntil = Date.now() + coolMs;
  process.stdout.write(
    `${new Date().toISOString()} Lighter REST blocked ${status} — cooldown ${Math.round(coolMs / 1000)}s (WS mark still used)\n`,
  );
  coolMs = Math.min(coolMs * 2, 180_000);
}

async function request(
  method: string,
  path: string,
  headers?: Record<string, string>,
  body?: string,
  timeoutMs = 8_000,
): Promise<HttpResult> {
  if (Date.now() < coolUntil) {
    throw new Error(`Lighter REST cooldown ${Math.ceil((coolUntil - Date.now()) / 1000)}s`);
  }
  const res = await curlCall(method, `${LIGHTER_REST}${path}`, headers ?? {}, body, timeoutMs);
  if (res.status >= 200 && res.status < 300) {
    coolMs = 15_000;
    return res;
  }
  const hint = res.body.replace(/\s+/g, " ").slice(0, 120);
  tripCool(res.status, hint);
  throw new Error(`Lighter curl ${res.status} ${path} ${hint}`);
}

function parseLighterJson<T>(body: string): T {
  const quoted = body.replace(
    /"(order_index|order_id|client_order_index|client_order_id)"\s*:\s*(-?\d+)/g,
    (_, k, n) => (`"${k}":"${n}"`),
  );
  return JSON.parse(quoted) as T;
}

async function lighterGet<T>(path: string, headers?: Record<string, string>): Promise<T> {
  const res = await request("GET", path, headers);
  return parseLighterJson<T>(res.body);
}

function leverageOf(marketId: number): number {
  for (const m of Object.values(MARKETS)) {
    if (m.marketId === marketId) return m.maxLeverage;
  }
  return 10;
}

export function mapAccount(raw: RawAccount, marketId: number): LiveAccount {
  const accountIndex = Number(raw.account_index ?? raw.index ?? 0);
  const pos = (raw.positions ?? []).find((p) => Number(p.market_id) === marketId);
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
  let foreignMargin = 0;
  for (const p of raw.positions ?? []) {
    if (Number(p.market_id) === marketId) continue;
    const pn = Math.abs(num(p.position_value) || num(p.position) * num(p.avg_entry_price));
    if (pn > 0) foreignMargin += pn / leverageOf(Number(p.market_id));
  }
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
    foreignMargin,
  };
}

export function mapOrders(raw: RawOrder[], market: Pick<MarketProfile, "marketId" | "priceDecimals" | "sizeDecimals">): GridOrder[] {
  return raw
    .filter((o) => Number(o.market_index ?? o.market_id ?? market.marketId) === market.marketId)
    .map((o) => {
      const isAsk = o.is_ask === true || o.side === "sell" || o.side === "ask";
      const side: Side = isAsk ? "sell" : "buy";
      const priceRaw = String(o.price ?? "0");
      const qtyRaw = String(o.remaining_base_amount ?? o.initial_base_amount ?? "0");
      const price = priceRaw.includes(".") ? num(priceRaw) : num(priceRaw) / 10 ** market.priceDecimals;
      const qty = qtyRaw.includes(".") ? num(qtyRaw) : num(qtyRaw) / 10 ** market.sizeDecimals;
      const client = Number(o.client_order_index ?? o.client_order_id);
      return {
        id: String(o.order_index ?? o.order_id ?? ""),
        side,
        price,
        qty,
        notional: qty * price,
        placedAt: Number(o.timestamp ?? o.created_at ?? Date.now()),
        clientOrderIndex: Number.isFinite(client) ? client : undefined,
      };
    })
    .filter((o) => o.id && o.price > 0 && o.qty > 0);
}

export async function fetchAccount(accountIndex: number, marketId: number): Promise<LiveAccount> {
  const json = await lighterGet<{ code: number; message?: string; accounts?: RawAccount[] }>(
    `/api/v1/account?by=index&value=${encodeURIComponent(String(accountIndex))}`,
  );
  if (json.code !== 200 || !json.accounts?.[0]) {
    throw new Error(json.message || "Account not found on Lighter");
  }
  return mapAccount(json.accounts[0], marketId);
}

export async function fetchActiveOrders(
  accountIndex: number,
  auth: string,
  market: Pick<MarketProfile, "marketId" | "priceDecimals" | "sizeDecimals">,
): Promise<GridOrder[]> {
  const qs = new URLSearchParams({
    account_index: String(accountIndex),
    market_id: String(market.marketId),
    auth,
  });
  const json = await lighterGet<{ code: number; message?: string; orders?: RawOrder[] }>(
    `/api/v1/accountActiveOrders?${qs.toString()}`,
    { authorization: auth },
  );
  if (json.code && json.code !== 200) {
    throw new Error(json.message || "Failed to load open orders");
  }
  return mapOrders(json.orders ?? [], market);
}

function markFromBooks(
  json: { order_book_details?: BookRow[]; order_books?: BookRow[] },
  marketId: number,
): number {
  const rows = json.order_book_details ?? json.order_books ?? [];
  const row = rows.find((r) => Number(r.market_id) === marketId) ?? rows[0];
  return Number(row?.mark_price);
}

const wsMarks = new Map<number, { mark: number; at: number }>();
const subscribed = new Set<number>();
let markSocket: WebSocket | null = null;
let wsRetry: ReturnType<typeof setTimeout> | null = null;
let wsPing: ReturnType<typeof setInterval> | null = null;

function startMarkSocket(marketId: number) {
  subscribed.add(marketId);
  if (markSocket && markSocket.readyState === WebSocket.OPEN) {
    markSocket.send(JSON.stringify({ type: "subscribe", channel: `market_stats/${marketId}` }));
    return;
  }
  if (markSocket && markSocket.readyState === WebSocket.CONNECTING) return;
  const sock = new WebSocket(LIGHTER_WS);
  markSocket = sock;
  sock.addEventListener("open", () => {
    for (const id of subscribed) {
      sock.send(JSON.stringify({ type: "subscribe", channel: `market_stats/${id}` }));
    }
    if (wsPing) clearInterval(wsPing);
    wsPing = setInterval(() => {
      if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ type: "ping" }));
    }, 45_000);
  });
  sock.addEventListener("message", (ev) => {
    try {
      const msg = JSON.parse(String(ev.data)) as {
        market_stats?: { market_id?: number; mark_price?: string };
        market_id?: number;
        mark_price?: string;
      };
      const stats = msg.market_stats ?? msg;
      const id = Number(stats.market_id);
      const mark = Number(stats.mark_price);
      if (mark > 0 && Number.isFinite(id)) wsMarks.set(id, { mark, at: Date.now() });
    } catch {
      /* ignore malformed frames */
    }
  });
  sock.addEventListener("close", () => {
    if (markSocket === sock) markSocket = null;
    if (wsPing) {
      clearInterval(wsPing);
      wsPing = null;
    }
    if (wsRetry) clearTimeout(wsRetry);
    const first = [...subscribed][0];
    if (first != null) wsRetry = setTimeout(() => startMarkSocket(first), 2_000);
  });
  sock.addEventListener("error", () => {
    try {
      sock.close();
    } catch {
      /* already closed */
    }
  });
}

export function peekMark(marketId: number): number {
  return wsMarks.get(marketId)?.mark ?? 0;
}

export async function fetchMark(marketId: number): Promise<number> {
  startMarkSocket(marketId);
  const hit = wsMarks.get(marketId);
  if (hit && Date.now() - hit.at < 12_000) return hit.mark;
  if (restReady() && !hit) {
    try {
      const json = await lighterGet<{ order_book_details?: BookRow[] }>(
        `/api/v1/orderBookDetails?market_id=${marketId}`,
      );
      const mark = markFromBooks(json, marketId);
      if (mark > 0) return mark;
    } catch {
      /* wait for WS */
    }
  }
  const until = Date.now() + 4_000;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 150));
    const again = wsMarks.get(marketId);
    if (again) return again.mark;
  }
  if (hit) return hit.mark;
  throw new Error(`mark missing market ${marketId} (waiting for public WS market_stats)`);
}

export async function fetchCandles(
  marketId: number,
  resolution: "1m" | "1h",
  countBack: number,
): Promise<Candle[]> {
  const now = Date.now();
  const hours = resolution === "1h" ? countBack + 2 : 6;
  const start = now - hours * 3600_000;
  const path =
    `/api/v1/markPriceCandles?market_id=${marketId}` +
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
  const raw = await request(
    "POST",
    "/api/v1/sendTx",
    { "content-type": "application/x-www-form-urlencoded" },
    body.toString(),
    15_000,
  );
  const json = JSON.parse(raw.body) as { hash?: string; tx_hash?: string; code?: number; message?: string };
  if (json.code && json.code !== 200) {
    throw new Error(json.message || `sendTx ${raw.status}`);
  }
  return { hash: json.tx_hash || json.hash, code: json.code, message: json.message };
}
