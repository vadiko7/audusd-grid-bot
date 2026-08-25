import { execFile } from "node:child_process";
import dns from "node:dns";
import https from "node:https";
import { promisify } from "node:util";
import {
  LIGHTER_REST,
  LIGHTER_WS,
  MARKET_ID,
  PRICE_DECIMALS,
  SIZE_DECIMALS,
} from "../src/lib/grid/constants.ts";
import type { Candle, GridOrder, LiveAccount, Side } from "../src/lib/grid/types.ts";

dns.setDefaultResultOrder("ipv4first");

const execFileAsync = promisify(execFile);
const UA = "curl/8.5.0";

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
type HttpResult = { status: number; body: string };

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function httpsCall(
  method: string,
  urlStr: string,
  headers: Record<string, string>,
  body?: string,
  timeoutMs = 8_000,
  pinIp?: string,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = https.request(
      {
        hostname: pinIp || u.hostname,
        port: 443,
        path: `${u.pathname}${u.search}`,
        method,
        servername: u.hostname,
        family: 4,
        headers: {
          host: u.hostname,
          accept: "application/json",
          "user-agent": UA,
          connection: "close",
          ...headers,
          ...(body ? { "content-length": String(Buffer.byteLength(body)) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("timeout"));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function curlCall(
  method: string,
  urlStr: string,
  headers: Record<string, string>,
  body?: string,
  timeoutMs = 8_000,
  pinIp?: string,
): Promise<HttpResult> {
  const u = new URL(urlStr);
  const args = [
    "-sS",
    "-4",
    "--http1.1",
    "-A",
    UA,
    "-H",
    "accept: application/json",
    "-w",
    "\n__STATUS__%{http_code}",
    "--max-time",
    String(Math.ceil(timeoutMs / 1000)),
  ];
  if (method !== "GET") args.push("-X", method);
  if (pinIp) args.push("--resolve", `${u.hostname}:443:${pinIp}`);
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase();
    if (key === "accept" || key === "user-agent" || key === "host") continue;
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

const PIN_IPS = (process.env.LIGHTER_PIN_IPS || "108.138.64.75,108.138.64.25,108.138.64.52")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

type Route = { t: "https" | "curl"; ip: string | null };
let route: Route | null = null;

function snippet(body: string): string {
  return body.replace(/\s+/g, " ").slice(0, 160);
}

async function request(
  method: string,
  path: string,
  headers?: Record<string, string>,
  body?: string,
  timeoutMs = 8_000,
): Promise<HttpResult> {
  const url = `${LIGHTER_REST}${path}`;
  const hdrs = headers ?? {};
  const ips: Array<string | null> = [null, ...PIN_IPS];
  const routes: Route[] = [];
  if (route) routes.push(route);
  for (const t of ["https", "curl"] as const) {
    for (const ip of ips) {
      const cand = { t, ip };
      if (!routes.some((r) => r.t === cand.t && r.ip === cand.ip)) routes.push(cand);
    }
  }
  let last = "no transport";
  for (const cand of routes) {
    try {
      const res =
        cand.t === "https"
          ? await httpsCall(method, url, hdrs, body, timeoutMs, cand.ip ?? undefined)
          : await curlCall(method, url, hdrs, body, timeoutMs, cand.ip ?? undefined);
      if (res.status >= 200 && res.status < 300) {
        if (!route || route.t !== cand.t || route.ip !== cand.ip) {
          route = cand;
          process.stdout.write(
            `${new Date().toISOString()} lighter via ${cand.t}${cand.ip ? `@${cand.ip}` : ""} ${method} ${path.split("?")[0]}\n`,
          );
        }
        return res;
      }
      last = `${cand.t}${cand.ip ? `@${cand.ip}` : ""} ${res.status} ${path} ${snippet(res.body)}`;
    } catch (err) {
      last = `${cand.t}${cand.ip ? `@${cand.ip}` : ""} ${err instanceof Error ? err.message : String(err)} ${path}`;
    }
  }
  throw new Error(`Lighter ${last}`);
}

async function lighterGet<T>(path: string, headers?: Record<string, string>): Promise<T> {
  const res = await request("GET", path, headers);
  return JSON.parse(res.body) as T;
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

let lastWsMark = 0;
let markSocket: WebSocket | null = null;
let wsRetry: ReturnType<typeof setTimeout> | null = null;

function startMarkSocket() {
  if (markSocket && (markSocket.readyState === WebSocket.OPEN || markSocket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  const sock = new WebSocket(LIGHTER_WS);
  markSocket = sock;
  sock.addEventListener("open", () => {
    sock.send(JSON.stringify({ type: "subscribe", channel: `market_stats/${MARKET_ID}` }));
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
      if (mark > 0 && (id === MARKET_ID || !Number.isFinite(id))) lastWsMark = mark;
    } catch {
      /* ignore malformed frames */
    }
  });
  sock.addEventListener("close", () => {
    if (markSocket === sock) markSocket = null;
    if (wsRetry) clearTimeout(wsRetry);
    wsRetry = setTimeout(startMarkSocket, 2_000);
  });
  sock.addEventListener("error", () => {
    try {
      sock.close();
    } catch {
      /* already closed */
    }
  });
}

export async function fetchMark(): Promise<number> {
  startMarkSocket();
  const paths = [
    `/api/v1/orderBooks?market_id=${MARKET_ID}`,
    `/api/v1/orderBookDetails?market_id=${MARKET_ID}`,
    `/api/v1/orderBooks`,
    `/api/v1/recentTrades?market_id=${MARKET_ID}&limit=1`,
  ];
  let last = "AUDUSD mark missing";
  for (const path of paths) {
    try {
      const json = await lighterGet<{
        order_book_details?: BookRow[];
        order_books?: BookRow[];
        trades?: Array<{ price?: string }>;
      }>(path);
      const mark = markFromBooks(json) || Number(json.trades?.[0]?.price);
      if (mark > 0) return mark;
      last = `${path} empty mark`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
  }
  if (lastWsMark > 0) return lastWsMark;
  const until = Date.now() + 3_000;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 200));
    if (lastWsMark > 0) return lastWsMark;
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
