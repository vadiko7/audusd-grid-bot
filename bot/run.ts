import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { MARKET_ID, ORDER_NOTIONAL, PRICE_DECIMALS, SIZE_DECIMALS } from "../src/lib/grid/constants.ts";
import {
  createInitialState,
  flattenAtMark,
  setArmed,
  setDynamic,
  setOrderNotional,
  snapshotPublic,
  step,
  type PublicSnapshot,
} from "../src/lib/grid/engine.ts";
import type { Candle, EngineAction, EngineState, LiveAccount } from "../src/lib/grid/types.ts";
import { fetchAccount, fetchActiveOrders, fetchCandles, fetchMark, restBlockedFor, restReady, sendTx } from "./rest.ts";
import { createAuthToken, dropSigner, signCancelAll, signCancelOrder, signCreateLimit, type LighterCreds } from "./signer.ts";

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
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
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

type SavedSettings = { orderNotional?: number };

function loadSettings(): SavedSettings {
  try {
    if (!existsSync(SETTINGS_PATH)) return {};
    return JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as SavedSettings;
  } catch {
    return {};
  }
}

function saveSettings(partial: SavedSettings) {
  mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  const next = { ...loadSettings(), ...partial };
  writeFileSync(SETTINGS_PATH, `${JSON.stringify(next, null, 2)}\n`);
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
const WANT_DYNAMIC = process.env.DYNAMIC_SPACING === "1";
const saved = loadSettings();
const startNotional =
  parseNotional(saved.orderNotional) ??
  parseNotional(process.env.ORDER_NOTIONAL) ??
  ORDER_NOTIONAL;

const engine: EngineState = createInitialState({
  dynamicSpacing: WANT_DYNAMIC,
  armed: false,
  orderNotional: startNotional,
});
if (WANT_DYNAMIC) setDynamic(engine, true);

let lastError: string | null = null;
let lastTx: string | null = null;
let auth: { token: string; exp: number } | null = null;
let live: LiveAccount | null = null;
let mark = 0;
let hourly: Candle[] = [];
let minute: Candle | null = null;
let lastCandles = 0;
let lastAccount = 0;
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

async function refreshLive() {
  const acc = await fetchAccount(creds.accountIndex);
  const token = await ensureAuth();
  const orders = await fetchActiveOrders(creds.accountIndex, token);
  live = { ...acc, orders };
}

async function executeActions(actions: EngineAction[]) {
  if (actions.length === 0) return;
  const seenCancel = new Set<string>();
  const hasCancelAll = actions.some((a) => a.type === "cancel_all");
  for (const action of actions) {
    if (action.type === "place") {
      const signed = await signCreateLimit(creds, {
        marketIndex: MARKET_ID,
        clientOrderIndex: clientSeq++,
        baseAmount: Math.round(action.qty * 10 ** SIZE_DECIMALS),
        price: Math.round(action.price * 10 ** PRICE_DECIMALS),
        isAsk: action.side === "sell",
        reduceOnly: action.reduceOnly,
      });
      const res = await sendTx({ ...signed, accountIndex: creds.accountIndex, apiKeyIndex: creds.apiKeyIndex });
      lastTx = res.hash || lastTx;
      log(`tx place ${action.side} ${action.price.toFixed(5)} × ${action.qty.toFixed(1)} ${res.hash ?? ""}`);
    } else if (action.type === "cancel") {
      if (hasCancelAll) continue;
      if (seenCancel.has(action.orderId)) continue;
      seenCancel.add(action.orderId);
      const idx = Number(action.orderId);
      if (!Number.isFinite(idx)) continue;
      const signed = await signCancelOrder(creds, { marketIndex: MARKET_ID, orderIndex: idx });
      const res = await sendTx({ ...signed, accountIndex: creds.accountIndex, apiKeyIndex: creds.apiKeyIndex });
      lastTx = res.hash || lastTx;
      log(`tx cancel ${action.orderId} ${res.hash ?? ""}`);
    } else if (action.type === "cancel_all") {
      const signed = await signCancelAll(creds);
      const res = await sendTx({ ...signed, accountIndex: creds.accountIndex, apiKeyIndex: creds.apiKeyIndex });
      lastTx = res.hash || lastTx;
      log(`tx cancel_all ${res.hash ?? ""}`);
    }
  }
}

function drainAndSend() {
  if (busy) return;
  const actions = engine.actions.slice();
  engine.actions = [];
  if (!actions.length) return;
  busy = true;
  executeActions(actions)
    .catch((err) => {
      lastError = err instanceof Error ? err.message : String(err);
      log(`tx error ${lastError}`);
      if (/invalid nonce/i.test(lastError)) dropSigner(creds);
    })
    .finally(() => {
      busy = false;
    });
}

async function tick() {
  if (stopped) return;
  const now = Date.now();
  try {
    mark = await fetchMark();
    if (restReady() && now - lastCandles > 60_000) {
      lastCandles = now;
      const [h, m] = await Promise.all([fetchCandles("1h", 30), fetchCandles("1m", 5)]);
      hourly = h;
      minute = m.at(-1) ?? null;
    }
    if (restReady() && now - lastAccount > 15_000) {
      lastAccount = now;
      await refreshLive();
    }
    if (restReady()) lastError = null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    lastError = message;
    const quiet = message.includes("cooldown");
    if (!quiet) log(`feed error ${message}`);
  }

  if (mark > 0) {
    step(engine, {
      now,
      mark,
      hourlyCandles: hourly.length ? hourly : undefined,
      minuteCandle: minute,
      live,
    });
    drainAndSend();
  }
  timer = setTimeout(tick, Math.max(engine.cycleMs, 800));
}

function status(): PublicSnapshot & { error: string | null; lastTx: string | null; accountIndex: number } {
  return {
    ...snapshotPublic(engine),
    error: lastError,
    lastTx,
    accountIndex: creds.accountIndex,
  };
}

function htmlPage(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AUDUSD grid</title>
<style>
body{font:14px/1.45 ui-sans-serif,system-ui;background:#08090b;color:#ecece8;margin:24px}
.muted{color:#8b8e93} .ok{color:#3f9a78} .warn{color:#c4a35a} .bad{color:#c45c4a}
ul{padding-left:1.1rem} code{font-family:ui-monospace,Menlo,monospace}
button{background:#1b1d22;color:#ecece8;border:1px solid #2e323a;padding:.35rem .7rem;margin-right:.4rem;cursor:pointer}
</style></head><body>
<h1>AUDUSD short grid <span id="acct" class="muted"></span></h1>
<p id="line">loading…</p>
<p id="err" class="bad"></p>
<p id="tx" class="muted"></p>
<p>
  <button type="button" data-cmd="/arm">Arm</button>
  <button type="button" data-cmd="/disarm">Disarm</button>
  <button type="button" data-cmd="/flatten">Flatten</button>
</p>
<p>
  <label>$ / level
    <input id="notional" type="number" min="10" max="10000" step="1" style="width:6rem;margin:0 .4rem;background:#1b1d22;color:#ecece8;border:1px solid #2e323a;padding:.3rem">
  </label>
  <button type="button" id="setNotional">Set</button>
  <span class="muted">10–10000 USD. Applies immediately; saved across reboot.</span>
</p>
<h2>Working</h2><ul id="orders"><li>none</li></ul>
<h2>Blotter</h2><ul id="logs"></ul>
<script>
function esc(s){
  return String(s).replace(/[&<>]/g, function(c){
    if (c === "&") return "&#38;";
    if (c === "<") return "&#60;";
    return "&#62;";
  });
}
async function refresh(){
  const s = await fetch("/status",{cache:"no-store"}).then(r=>r.json());
  document.getElementById("acct").textContent = "acct "+s.accountIndex;
  document.getElementById("line").innerHTML =
    "armed <strong class='"+(s.armed?"ok":"warn")+"'>"+s.armed+"</strong>"
    +" · source "+esc(s.accountSource)
    +" · mark <code>"+Number(s.mark).toFixed(5)+"</code>"
    +" · equity <code>$"+Number(s.equity).toFixed(2)+"</code>"
    +" · pos <code>"+Number(s.position.size).toFixed(1)+"</code>"
    +" · remaining <code>$"+Number(s.remaining).toFixed(0)+"</code>"
    +" · $/lvl <code>"+Number(s.orderNotional).toFixed(0)+"</code>";
  document.getElementById("err").textContent = s.error || "";
  document.getElementById("tx").textContent = s.lastTx ? "last tx "+s.lastTx : "";
  const inp = document.getElementById("notional");
  if (inp && document.activeElement !== inp) inp.value = String(s.orderNotional);
  const orders = (s.orders||[]).map(o=>"<li>"+o.side.toUpperCase()+" "+Number(o.price).toFixed(5)+" × "+Number(o.qty).toFixed(1)+"</li>");
  document.getElementById("orders").innerHTML = orders.join("") || "<li>none</li>";
  const logs = [...(s.logs||[])].slice(-40).reverse()
    .map(l=>"<li><code>"+new Date(l.ts).toISOString().slice(11,19)+"</code> "+esc(l.level)+" "+esc(l.message)+"</li>");
  document.getElementById("logs").innerHTML = logs.join("") || "<li>empty</li>";
}
document.querySelectorAll("button[data-cmd]").forEach(b=>{
  b.onclick = async ()=>{ await fetch(b.dataset.cmd,{method:"POST"}); refresh(); };
});
document.getElementById("setNotional").onclick = async ()=>{
  const usd = document.getElementById("notional").value;
  await fetch("/notional?usd="+encodeURIComponent(usd),{method:"POST"});
  refresh();
};
refresh();
setInterval(refresh, 2000);
</script>
</body></html>`;
}

function command(pathName: string): string | null {
  if (pathName === "/arm") return "arm";
  if (pathName === "/disarm") return "disarm";
  if (pathName === "/flatten") return "flatten";
  return null;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
  const cmd = command(url.pathname);
  if (cmd && req.method === "POST") {
    if (cmd === "arm") setArmed(engine, true);
    if (cmd === "disarm") setArmed(engine, false);
    if (cmd === "flatten") flattenAtMark(engine);
    drainAndSend();
    log(`http ${cmd}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, armed: engine.config.armed }));
    return;
  }
  if (url.pathname === "/notional" && req.method === "POST") {
    const usd = parseNotional(url.searchParams.get("usd"));
    if (usd == null) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "usd must be 10–10000" }));
      return;
    }
    setOrderNotional(engine, usd);
    saveSettings({ orderNotional: engine.config.orderNotional });
    drainAndSend();
    log(`http notional $${engine.config.orderNotional}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, orderNotional: engine.config.orderNotional }));
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
  log(`bot start acct ${creds.accountIndex} key ${creds.apiKeyIndex} arm_on_start=${WANT_ARM} notional=$${startNotional} env=${envFile ?? "process-env"}`);
  server.listen(PORT, HOST, () => log(`status http://${HOST}:${PORT}/`));
  for (;;) {
    if (stopped) return;
    try {
      await refreshLive();
      mark = await fetchMark();
      hourly = await fetchCandles("1h", 30);
      const m = await fetchCandles("1m", 5);
      minute = m.at(-1) ?? null;
      lastAccount = Date.now();
      lastCandles = Date.now();
      step(engine, { now: Date.now(), mark, hourlyCandles: hourly, minuteCandle: minute, live });
      log(`live equity $${engine.accountEquity?.toFixed(2)} pos ${engine.position.size.toFixed(1)} mark ${mark.toFixed(5)}`);
      if (WANT_ARM) {
        setArmed(engine, true);
        drainAndSend();
      }
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
