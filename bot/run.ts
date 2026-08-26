import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { parseMarkets, type MarketProfile } from "../src/lib/grid/markets.ts";
import {
  createInitialState,
  flattenAtMark,
  remainingCapacity,
  setArmed,
  setOrderNotional,
  snapshotPublic,
  step,
} from "../src/lib/grid/engine.ts";
import type { EngineAction, EngineState, GridOrder, LiveAccount } from "../src/lib/grid/types.ts";
import { fetchAccount, fetchActiveOrders, fetchMark, restBlockedFor, restReady, sendTx } from "./rest.ts";
import { sameRung } from "../src/lib/grid/math.ts";
import { createAuthToken, dropSigner, refreshNonce, signCancelOrder, signCreateLimit, signCreateMarket, type LighterCreds } from "./signer.ts";

function loadDotEnv() {
  const candidates = [
    path.resolve(".env"),
    path.resolve("bot/.env"),
    path.join(path.dirname(new URL(import.meta.url).pathname), "..", ".env"),
  ];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("=");
      if (i < 0) continue;
      const k = t.slice(0, i).trim();
      let v = t.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (process.env[k] == null || process.env[k] === "") process.env[k] = v;
    }
    log(`loaded ${file}`);
    return file;
  }
  return null;
}

function reqEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`missing ${name} in .env`);
  return v;
}

function log(message: string) {
  process.stdout.write(`${new Date().toISOString()} ${message}\n`);
}

const envFile = loadDotEnv();
const SETTINGS_PATH = path.resolve("data/settings.json");
const OWNED_PATH = path.resolve("data/owned.json");

const OWNED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type SavedSettings = { markets?: Record<string, { orderNotional?: number }>; orderNotional?: number };
type Owned = {
  ids: Array<{ id: string; at: number }>;
  clients: Array<{ n: number; at: number }>;
};

function nowMs() {
  return Date.now();
}

function pruneOwned(owned: Owned, now = nowMs()): Owned {
  const cut = now - OWNED_TTL_MS;
  return {
    ids: owned.ids.filter((x) => x.at > cut),
    clients: owned.clients.filter((x) => x.at > cut).slice(-200),
  };
}

function coerceOwned(raw: unknown): Owned {
  const empty: Owned = { ids: [], clients: [] };
  if (!raw || typeof raw !== "object") return empty;
  const o = raw as { ids?: unknown; clients?: unknown };
  const ids: Owned["ids"] = [];
  if (Array.isArray(o.ids)) {
    for (const x of o.ids) {
      if (typeof x === "string") ids.push({ id: x, at: nowMs() });
      else if (x && typeof x === "object" && typeof (x as { id?: unknown }).id === "string") {
        const at = Number((x as { at?: unknown }).at);
        ids.push({ id: (x as { id: string }).id, at: Number.isFinite(at) ? at : nowMs() });
      }
    }
  }
  const clients: Owned["clients"] = [];
  if (Array.isArray(o.clients)) {
    for (const x of o.clients) {
      if (typeof x === "number") clients.push({ n: x, at: nowMs() });
      else if (x && typeof x === "object" && Number.isFinite(Number((x as { n?: unknown }).n))) {
        const at = Number((x as { at?: unknown }).at);
        clients.push({ n: Number((x as { n: number }).n), at: Number.isFinite(at) ? at : nowMs() });
      }
    }
  }
  return pruneOwned({ ids, clients });
}

function loadOwned(): Record<string, Owned> {
  try {
    if (!existsSync(OWNED_PATH)) return {};
    const raw = JSON.parse(readFileSync(OWNED_PATH, "utf8")) as Record<string, unknown>;
    const out: Record<string, Owned> = {};
    for (const [k, v] of Object.entries(raw)) out[k] = coerceOwned(v);
    return out;
  } catch {
    return {};
  }
}

function saveOwned() {
  mkdirSync(path.dirname(OWNED_PATH), { recursive: true });
  const dump: Record<string, Owned> = {};
  for (const b of books) dump[b.market.symbol] = b.owned;
  writeFileSync(OWNED_PATH, `${JSON.stringify(dump, null, 2)}\n`);
}

function isMine(owned: Owned, order: { id: string; clientOrderIndex?: number }): boolean {
  if (owned.ids.some((x) => x.id === order.id)) return true;
  if (order.clientOrderIndex != null && owned.clients.some((x) => x.n === order.clientOrderIndex)) return true;
  return false;
}

function adoptOrders(book: { owned: Owned; market: { symbol: string } }, liveOrders: { id: string; clientOrderIndex?: number }[]) {
  const now = nowMs();
  book.owned = pruneOwned(book.owned, now);
  const ids = new Map(book.owned.ids.map((x) => [x.id, x.at]));
  const clients = new Map(book.owned.clients.map((x) => [x.n, x.at]));
  for (const o of liveOrders) {
    if (o.clientOrderIndex != null && clients.has(o.clientOrderIndex)) {
      ids.set(o.id, now);
      clients.set(o.clientOrderIndex, now);
    }
    if (ids.has(o.id)) ids.set(o.id, now);
  }
  const liveIds = new Set(liveOrders.map((o) => o.id));
  book.owned = pruneOwned({
    ids: [...ids.entries()].filter(([id]) => liveIds.has(id)).map(([id, at]) => ({ id, at })),
    clients: [...clients.entries()].map(([n, at]) => ({ n, at })),
  }, now);
  saveOwned();
}

function loadSettings(): SavedSettings {
  try {
    if (!existsSync(SETTINGS_PATH)) return {};
    return JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as SavedSettings;
  } catch {
    return {};
  }
}

function saveSettings(symbol: string, orderNotional: number) {
  mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  const prev = loadSettings();
  const markets = { ...(prev.markets ?? {}) };
  markets[symbol] = { orderNotional };
  writeFileSync(SETTINGS_PATH, `${JSON.stringify({ ...prev, markets }, null, 2)}\n`);
}

function parseNotional(raw: unknown): number | null {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n) || n < 10 || n > 10_000) return null;
  return n;
}

const creds: LighterCreds = {
  accountIndex: Number(reqEnv("LIGHTER_ACCOUNT_INDEX")),
  apiKeyIndex: Number(process.env.LIGHTER_API_KEY_INDEX || "4"),
  privateKey: reqEnv("LIGHTER_API_PRIVATE_KEY"),
};
if (!Number.isFinite(creds.accountIndex) || creds.accountIndex < 0) {
  throw new Error("LIGHTER_ACCOUNT_INDEX must be a non-negative integer");
}
if (!Number.isFinite(creds.apiKeyIndex) || creds.apiKeyIndex < 0 || creds.apiKeyIndex > 254) {
  throw new Error("LIGHTER_API_KEY_INDEX must be 0–254");
}

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || "8787");
const WANT_ARM = process.env.ARM === "1";
const saved = loadSettings();
const profiles = parseMarkets(process.env.MARKETS);

type Book = {
  market: MarketProfile;
  engine: EngineState;
  mark: number;
  live: LiveAccount | null;
  owned: Owned;
  lastManualSkip: number;
  workingAll: { id: string; notional: number }[];
  manuals: GridOrder[];
};

function makeBook(market: MarketProfile): Book {
  const n =
    parseNotional(saved.markets?.[market.symbol]?.orderNotional) ??
    (market.symbol === "AUDUSD" ? parseNotional(saved.orderNotional) : null) ??
    parseNotional(process.env[`ORDER_NOTIONAL_${market.symbol}`]) ??
    market.orderNotional;
  const engine = createInitialState({
    market,
    armed: false,
    orderNotional: n,
  });
  const persisted = loadOwned()[market.symbol] ?? { ids: [], clients: [] };
  return { market, engine, mark: 0, live: null, owned: persisted, lastManualSkip: -1, workingAll: [], manuals: [] };
}

const books = profiles.map(makeBook);
const bySymbol = new Map(books.map((b) => [b.market.symbol, b]));

function bookOf(symbol: string | null): Book | undefined {
  if (!symbol) return books[0];
  return bySymbol.get(symbol.toUpperCase());
}

let lastError: string | null = null;
let lastTx: string | null = null;
let auth: { token: string; exp: number } | null = null;
let lastAccount = 0;
let wantOrderPoll = false;
let clientSeq = Date.now();
let busy = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;

async function ensureAuth(): Promise<string> {
  if (auth && auth.exp > Date.now() + 60_000) return auth.token;
  const token = await createAuthToken(creds);
  auth = { token, exp: Date.now() + 50 * 60_000 };
  return token;
}

async function refreshLive(book: Book) {
  const acc = await fetchAccount(creds.accountIndex, book.market.marketId);
  const token = await ensureAuth();
  const all = await fetchActiveOrders(creds.accountIndex, token, book.market);
  book.workingAll = all.map((o) => ({ id: o.id, notional: o.notional }));
  const now = nowMs();
  for (const o of all) {
    if (isMine(book.owned, o)) continue;
    const hitPending = book.engine.orders.some(
      (p) => p.side === o.side && sameRung(p.price, o.price, book.engine.factor),
    );
    if (hitPending) {
      book.owned.ids.push({ id: o.id, at: now });
      if (o.clientOrderIndex != null) book.owned.clients.push({ n: o.clientOrderIndex, at: now });
    }
  }
  adoptOrders(book, all);
  const mine = all.filter((o) => isMine(book.owned, o));
  book.manuals = all.filter((o) => !isMine(book.owned, o));
  const skipped = book.manuals.length;
  if (skipped !== book.lastManualSkip) {
    if (skipped > 0) log(`${book.market.symbol} leaving ${skipped} manual/unknown order(s) untouched`);
    book.lastManualSkip = skipped;
  }
  book.live = { ...acc, orders: mine };
}

function applySharedMargin() {
  for (const book of books) {
    if (!book.live) continue;
    let extra = 0;
    for (const other of books) {
      if (other.market.symbol === book.market.symbol) continue;
      extra += other.workingAll.reduce((s, o) => s + o.notional, 0) / other.market.maxLeverage;
    }
    book.live.foreignMargin = (book.live.foreignMargin || 0) + extra;
  }
}

async function executeActions(book: Book, actions: EngineAction[]) {
  if (actions.length === 0) return;
  const m = book.market;
  for (const action of actions) {
    if (action.type !== "cancel") continue;
    if (action.orderId.startsWith("pending:")) continue;
    try {
      const signed = await signCancelOrder(creds, {
        marketIndex: m.marketId,
        orderIndex: action.orderId,
      });
      const res = await sendTx({ ...signed, accountIndex: creds.accountIndex, apiKeyIndex: creds.apiKeyIndex });
      lastTx = res.hash || lastTx;
      await refreshNonce(creds);
      log(`${m.symbol} tx cancel ${action.side} ${action.price.toFixed(m.priceDecimals)} ${action.orderId} ${res.hash ?? ""}`);
      await new Promise((r) => setTimeout(r, 700));
    } catch (err) {
      log(`${m.symbol} cancel failed ${action.orderId} ${err instanceof Error ? err.message : String(err)} — left on book`);
    }
  }
  for (const action of actions) {
    if (action.type !== "place") continue;
    const clientOrderIndex = clientSeq++;
    const exec = action.exec === "market" ? "market" : "limit";
    const signed =
      exec === "market"
        ? await signCreateMarket(creds, {
            marketIndex: m.marketId,
            clientOrderIndex,
            baseAmount: Math.round(action.qty * 10 ** m.sizeDecimals),
            avgExecutionPrice: Math.round(action.price * 10 ** m.priceDecimals),
            isAsk: action.side === "sell",
            reduceOnly: action.reduceOnly,
          })
        : await signCreateLimit(creds, {
            marketIndex: m.marketId,
            clientOrderIndex,
            baseAmount: Math.round(action.qty * 10 ** m.sizeDecimals),
            price: Math.round(action.price * 10 ** m.priceDecimals),
            isAsk: action.side === "sell",
            reduceOnly: action.reduceOnly,
          });
    const res = await sendTx({ ...signed, accountIndex: creds.accountIndex, apiKeyIndex: creds.apiKeyIndex });
    lastTx = res.hash || lastTx;
    if (!book.owned.clients.some((x) => x.n === clientOrderIndex)) {
      book.owned.clients.push({ n: clientOrderIndex, at: nowMs() });
    }
    saveOwned();
    log(`${m.symbol} tx ${exec} ${action.side} ${action.price.toFixed(m.priceDecimals)} × ${action.qty} ${res.hash ?? ""}`);
  }
}

function drainAndSend() {
  if (busy) return;
  const jobs = books
    .map((b) => ({ book: b, actions: b.engine.actions.slice() }))
    .filter((j) => j.actions.length);
  if (!jobs.length) return;
  for (const j of jobs) j.book.engine.actions = [];
  busy = true;
  (async () => {
    for (const j of jobs) await executeActions(j.book, j.actions);
    wantOrderPoll = true;
  })()
    .catch(async (err) => {
      lastError = err instanceof Error ? err.message : String(err);
      log(`tx error ${lastError}`);
      if (/invalid nonce/i.test(lastError)) {
        await refreshNonce(creds).catch(() => {});
        dropSigner(creds);
      }
    })
    .finally(() => {
      busy = false;
    });
}

async function tick() {
  if (stopped) return;
  const now = Date.now();
  try {
    const poll = restReady() && (wantOrderPoll || now - lastAccount > 15_000);
    for (const book of books) {
      book.mark = await fetchMark(book.market.marketId);
      if (poll) await refreshLive(book);
    }
    if (poll) {
      wantOrderPoll = false;
      applySharedMargin();
      lastAccount = now;
      lastError = null;
    }
    for (const book of books) {
      if (book.mark > 0) {
        step(book.engine, {
          now,
          mark: book.mark,
          live: book.live,
        });
      }
    }
    drainAndSend();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    lastError = message;
    if (!message.includes("cooldown")) log(`feed error ${message}`);
  }
  const wait = Math.min(...books.map((b) => b.engine.cycleMs));
  timer = setTimeout(tick, Math.max(wait, 250));
}

function status() {
  return {
    accountIndex: creds.accountIndex,
    error: lastError,
    lastTx,
    books: books.map((b) => snapshotPublic(b.engine)),
  };
}

function htmlPage(): string {
  const titles = books.map((b) => `${b.market.symbol} ${b.market.prefer}`).join(" + ");
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${titles}</title>
<style>
body{font:14px/1.45 ui-sans-serif,system-ui;background:#08090b;color:#ecece8;margin:20px}
.muted{color:#8b8e93} .ok{color:#3f9a78} .warn{color:#c4a35a} .bad{color:#c45c4a}
ul{padding-left:1.1rem} code{font-family:ui-monospace,Menlo,monospace}
button{background:#1b1d22;color:#ecece8;border:1px solid #2e323a;padding:.35rem .7rem;margin-right:.4rem;cursor:pointer}
.grid{display:grid;gap:1.2rem;grid-template-columns:repeat(auto-fit,minmax(320px,1fr))}
.card{background:#101216;border:1px solid #2e323a;padding:1rem 1.1rem}
input{width:6rem;margin:0 .4rem;background:#1b1d22;color:#ecece8;border:1px solid #2e323a;padding:.3rem}
</style></head><body>
<h1>grid desk <span id="acct" class="muted"></span></h1>
<p id="err" class="bad"></p>
<p id="tx" class="muted"></p>
<div class="grid" id="books"></div>
<script>
function esc(s){return String(s).replace(/[&<>]/g,c=>c==="&"?"&#38;":c==="<"? "&#60;":"&#62;");}
function card(s){
  const d = s.prefer==="long"?4:5;
  const q = s.prefer==="long"?2:1;
  const orders=(s.orders||[]).map(o=>"<li>"+o.side.toUpperCase()+" "+Number(o.price).toFixed(d)+" × "+Number(o.qty).toFixed(q)+"</li>").join("")||"<li>none</li>";
  const logs=[...(s.logs||[])].slice(-24).reverse().map(l=>"<li><code>"+new Date(l.ts).toISOString().slice(11,19)+"</code> "+esc(l.level)+" "+esc(l.message)+"</li>").join("")||"<li>empty</li>";
  return '<div class="card" data-sym="'+esc(s.symbol)+'">'
    +"<h2>"+esc(s.symbol)+" "+esc(s.prefer)+" <code>m"+s.marketId+"</code></h2>"
    +"<p>armed <strong class='"+(s.armed?"ok":"warn")+"'>"+s.armed+"</strong>"
    +" · mark <code>"+Number(s.mark).toFixed(d)+"</code>"
    +" · equity <code>$"+Number(s.equity).toFixed(2)+"</code>"
    +" · pos <code>"+Number(s.position.size).toFixed(q)+"</code>"
    +" · rem <code>$"+Number(s.remaining).toFixed(0)+"</code>"
    +" · $/lvl <code>"+Number(s.orderNotional).toFixed(0)+"</code></p>"
    +'<p><button data-cmd="/arm">Arm</button><button data-cmd="/disarm">Disarm</button><button data-cmd="/flatten">Flatten</button></p>'
    +'<p><label>$/lvl <input class="notional" type="number" min="10" max="10000" step="1" value="'+Number(s.orderNotional)+'"></label>'
    +'<button class="setNotional">Set</button></p>'
    +"<h3>Working</h3><ul>"+orders+"</ul><h3>Blotter</h3><ul>"+logs+"</ul></div>";
}
async function refresh(){
  const s = await fetch("/status",{cache:"no-store"}).then(r=>r.json());
  document.getElementById("acct").textContent = "acct "+s.accountIndex;
  document.getElementById("err").textContent = s.error || "";
  document.getElementById("tx").textContent = s.lastTx ? "last tx "+s.lastTx : "";
  const root = document.getElementById("books");
  const focus = document.activeElement && document.activeElement.classList.contains("notional");
  if (!focus) root.innerHTML = (s.books||[]).map(card).join("");
}
document.getElementById("books").addEventListener("click", async (ev)=>{
  const t = ev.target;
  if (!(t instanceof HTMLElement)) return;
  const cardEl = t.closest(".card");
  if (!cardEl) return;
  const sym = cardEl.getAttribute("data-sym");
  if (t.dataset.cmd){
    await fetch(t.dataset.cmd+"?symbol="+encodeURIComponent(sym),{method:"POST"});
    refresh();
  }
  if (t.classList.contains("setNotional")){
    const usd = cardEl.querySelector(".notional").value;
    await fetch("/notional?symbol="+encodeURIComponent(sym)+"&usd="+encodeURIComponent(usd),{method:"POST"});
    refresh();
  }
});
refresh();
setInterval(refresh, 2000);
</script>
</body></html>`;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
  const symbol = url.searchParams.get("symbol");
  if (req.method === "POST" && (url.pathname === "/arm" || url.pathname === "/disarm" || url.pathname === "/flatten")) {
    const targets = symbol ? [bookOf(symbol)].filter(Boolean) : books;
    if (!targets.length) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unknown symbol" }));
      return;
    }
    for (const b of targets as Book[]) {
      if (url.pathname === "/arm") setArmed(b.engine, true);
      if (url.pathname === "/disarm") setArmed(b.engine, false);
      if (url.pathname === "/flatten") flattenAtMark(b.engine);
      log(`http ${url.pathname.slice(1)} ${b.market.symbol}`);
    }
    drainAndSend();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (url.pathname === "/notional" && req.method === "POST") {
    const b = bookOf(symbol);
    const usd = parseNotional(url.searchParams.get("usd"));
    if (!b || usd == null) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "symbol + usd 10–10000" }));
      return;
    }
    setOrderNotional(b.engine, usd);
    saveSettings(b.market.symbol, b.engine.config.orderNotional);
    drainAndSend();
    log(`http notional ${b.market.symbol} $${b.engine.config.orderNotional}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, symbol: b.market.symbol, orderNotional: b.engine.config.orderNotional }));
    return;
  }
  if (url.pathname === "/status") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(status()));
    return;
  }
  if (url.pathname === "/" && (req.method === "GET" || req.method === "HEAD")) {
    const body = htmlPage();
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(body);
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

async function main() {
  log(
    `bot start acct ${creds.accountIndex} key ${creds.apiKeyIndex} markets=${books.map((b) => b.market.symbol).join(",")} arm_on_start=${WANT_ARM} env=${envFile ?? "process-env"}`,
  );
  server.listen(PORT, HOST, () => log(`status http://${HOST}:${PORT}/`));
  for (;;) {
    if (stopped) return;
    try {
      for (const book of books) {
        await refreshLive(book);
        book.mark = await fetchMark(book.market.marketId);
      }
      applySharedMargin();
      for (const book of books) {
        step(book.engine, {
          now: Date.now(),
          mark: book.mark,
          live: book.live,
        });
        log(
          `${book.market.symbol} live equity $${book.engine.accountEquity?.toFixed(2)} pos ${book.engine.position.size} mark ${book.mark} remaining $${remainingCapacity(book.engine).toFixed(0)} foreignMargin $${book.engine.foreignMargin.toFixed(2)}`,
        );
        if (WANT_ARM) setArmed(book.engine, true);
      }
      lastAccount = Date.now();
      drainAndSend();
      timer = setTimeout(tick, 80);
      return;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      const wait = Math.max(4_000, restBlockedFor() + 200);
      if (!lastError.includes("cooldown")) log(`startup retry ${lastError}`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

function shutdown() {
  if (stopped) return;
  stopped = true;
  if (timer) clearTimeout(timer);
  server.close();
  log("stopped — working orders left on Lighter (disarm first to cancel)");
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
