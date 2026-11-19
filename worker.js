// sellercloud-link: a small, READ-ONLY bridge between Sellercloud and the Production Hub.
//
// It holds the Sellercloud login only as Cloudflare secrets (never in monday or the app).
// It READS from Sellercloud: sign-in, product search, stock, photos, kit recipes.
// The one exception is kit assembly (POST /assemble), which changes stock and stays SWITCHED OFF
// until ASSEMBLE_ENABLED = yes. See the "Kit assembly" section below.
// Its only writes are to ONE monday board, "Sellercloud Products" (SYNC_BOARD_ID), never the
// Production Schedule boards, and posts to ONE Google Chat space (CHAT_WEBHOOK) from /pull.
//
// Settings (Cloudflare > this worker > Settings > Variables and Secrets):
//   SC_TEAM      (Text)   your Sellercloud team name, used to look up your API server
//   SC_USERNAME  (Secret) the view-only API employee's username
//   SC_PASSWORD  (Secret) that employee's password
//   APP_KEY      (Secret, required) a long random string you make up; every call must send it
//                as ?key=... or header X-App-Key. Without it set, every call is refused.
//   WAREHOUSE_COMPANY (Text, optional, default 317 = "WAREHOUSE") the warehouse company id or exact name
//                (or id) in Sellercloud; products under any other company are left out.
//   COUNT_WAREHOUSES (Text, optional, default 3232 = Skustack Warehouse) comma-separated warehouse
//                ids or names that count toward available stock.
//   ALLOWED_ORIGINS (Text, optional) comma-separated web origins allowed to call from a browser
//                page; by default only monday.com pages (*.monday.com, *.monday.app).
//   SC_SERVER    (Text, optional) your API server address, if you'd rather skip the team lookup
//   Kit assembly (all optional; assembly is off unless ASSEMBLE_ENABLED = yes):
//   ASSEMBLE_KEY (Secret) the only key that works for /assemble and /assemble/preview
//   ASSEMBLE_ENABLED (Text) "yes" turns the real assembly call on; anything else keeps it off
//   ASSEMBLE_MAX_QTY (Text, default 1) most kits one press may assemble
//   ASSEMBLE_WAREHOUSE (Text, default 3232 = Skustack Warehouse) the only warehouse it assembles in
//   BRIDGE_BIN   (Text, default 0.1oz_Bulk_Bin) the bin the break-down puts the 0.1 units into and the assembly takes them from
//   EXPIRY_DATE  (Text, optional) expiry date sent with disassembles and bin adjusts, e.g. 2099-12-31T00:00:00.
//                Left empty, no date is sent where Sellercloud allows it, else 2099-12-31.
//   SC_SOAP_URL  (Text, optional) the SOAP service address, if it isn't https://<server>.ws.sellercloud.com/scservice.asmx
//
// Endpoints (all GET, except POST /assemble):
//   /health                         checks the settings and that sign-in works
//   /products?q=&inStock=1&page=1&pageSize=50
//                                   search warehouse-company products (q = keyword or SKU);
//                                   inStock=1 keeps only items with available qty > 0
//   /qty?sku=SKU[&warehouse=ID]     qty per warehouse with name and Sellable flag; countedAvailable
//                                   is the total over warehouses that count (Sellable by default);
//                                   warehouses with 0 and 0 are hidden unless &all=1;
//                                   &raw=1 also shows Sellercloud's own Skustack row and any bins in it
//   /companies                      Sellercloud company ids and names, and which one is the warehouse company
//   /pull?sku=SKU&qty=N[&note=]     posts "please bring to the production room" for that SKU to the
//                                   Google Chat space (CHAT_WEBHOOK), once a minute per SKU at most
//   /kitimport[?job=ID]             read-only: Sellercloud's Kits import template columns, recent queued jobs,
//                                   and one job's full status (to see why a kit import saved nothing)
//   /apidocs[?q=word]               lists Sellercloud API endpoints matching a word (default: bins)
//   /sync[?dry=1]                   run one ~20-second batch of the copy now and show progress
//                                   (dry=1: count only, write nothing). Each batch continues where
//                                   the last stopped; the 30-minute trigger keeps it going.
//   /warehouses                     warehouse ids, names, Sellable flag, and whether each counts
//   POST /assemble/refresh {sku} (ASSEMBLE_KEY) refresh one product on the Sellercloud Products board now;
//                                   without sku: the full copy in short steps ({start:true} first, repeat while continue:true)
//   Sync settings (optional): SYNC_EVERY_MINUTES (30), SYNC_MAX_CALLS per run (300), SYNC_QUIET_MINUTES (3: the sync
//                waits until the Hub has made no call for this long), SYNC_MAX_DEFER_MINUTES (10: it runs anyway after this).
//                A KV namespace bound as TOKEN_KV makes the shared sign-in, the 30-minute gate and the Hub-in-use mark
//                reliable across Cloudflare locations (without it they use Cloudflare's cache, which is per location).
//                Kit setup and produce NEED TOKEN_KV (Nov 19): it keeps each run's "already sent" records.
//   POST /assemble/clear {itemId} (ASSEMBLE_KEY) Shragy's press only: forget one production's run records so it can
//                                   run again. Nothing in Sellercloud changes.
//   /images?sku=SKU                 photo links for one product
//   /soapops[?q=word]               lists Sellercloud SOAP calls whose name matches a word (default: bin)
//   /bins?sku=SKU[&raw=1]           the product's bins and qty in Skustack Warehouse (read-only)
//   /assemble/preview?sku=&qty=[&fromBin=]  (ASSEMBLE_KEY) kit recipe, parts needed vs Skustack and bin qty
//   /assemble/bins?q=text[&raw=1]  (ASSEMBLE_KEY) bin names in Skustack Warehouse matching the text, for autocomplete (&all=1: every name)
//   The Kits pop-up's read routes (/assemble/preview, plan, kit, bridge, bins, find) reuse Sellercloud answers for a short
//   time (bin list 10 min, catalog and kit parts 1 min, stock and bin qty 15 s); add &fresh=1 to read Sellercloud now.
//   POST /assemble {sku,qty,itemId,fromBin,toBin[,source,perKit]}  (ASSEMBLE_KEY, only when ASSEMBLE_ENABLED = yes)
//   /assemble/kit?sku=SKU          (ASSEMBLE_KEY) a product's kit parts and qty per kit (read-only)
//   /assemble/find?q=WORD[&page=1]  (ASSEMBLE_KEY) search warehouse-company products in Sellercloud for the
//                                   final pick, out-of-stock ones included (read-only; 1-2 Sellercloud calls)
//   /assemble/bridge?sku=SOURCE    (ASSEMBLE_KEY) the source's 0.1 oz bridge product: from its kit parts, and
//                                   products named like it with 0.1oz (read-only)
//   /assemble/plan?source=&final=&fromBin=&produced=[&finalSize=&sourceSize=&itemId=]  (ASSEMBLE_KEY) checks each step of the 0.1 flow for a
//                                   production (0.1 product, source kit, disassemble, final kit, assemble) and says
//                                   which are already in place. Read-only.
//   POST /assemble/setup {source,final,fromBin,produced}  (ASSEMBLE_KEY, only when ASSEMBLE_ENABLED = yes) creates the 0.1 product and sets the source
//                                   and final kits, ONLY where the plan says they're missing. Kit parts only, never stock.
//   POST /assemble/produce {source,final,fromBin,toBin,produced,itemId}  (ASSEMBLE_KEY, only when ASSEMBLE_ENABLED = yes)
//                                   disassembles the source in the From bin into 0.1 units, assembles the finals, then
//                                   removes the small 0.1 leftover (less than one final's worth) from the From bin
//   /soapops?type=Name                          the fields of one SOAP data type and their types (read-only)
//   /cachecheck                                 whether the worker's saved-step memory works on this address (read-only)
//   /assemblediag[?part=calls|send|stock|rest&sku=FINAL&fromBin=&toBin=] read-only assemble checks, one light part per call                 read-only: every Sellercloud assemble call and its fields, kit part fields,
//                                   the Kits import columns, kit/assemble API endpoints, the kit's parts as Sellercloud stores them,
//                                   the kit's and parts' stock with every bin-row field (lot, expiry), and the expiry date we'd send

let cachedBase = null;
let cachedToken = null; // { value, expiresAt }

let reqOrigin = "";
let reqEnv = {};

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...corsHeaders(), ...extra },
  });

function originAllowed(origin, env) {
  if (!origin) return false;
  let host;
  try { host = new URL(origin).hostname; } catch { return false; }
  if (!origin.startsWith("https://")) return false;
  const list = (env.ALLOWED_ORIGINS || "").split(",").map((x) => x.trim()).filter(Boolean);
  if (list.length) return list.includes(origin);
  return /(^|\.)monday\.com$/i.test(host) || /(^|\.)monday\.app$/i.test(host);
}

function corsHeaders() {
  const h = { vary: "Origin" };
  if (originAllowed(reqOrigin, reqEnv)) {
    h["access-control-allow-origin"] = reqOrigin;
    h["access-control-allow-methods"] = "GET, POST, OPTIONS";
    h["access-control-allow-headers"] = "X-App-Key, Content-Type";
  }
  return h;
}

async function getBase(env) {
  if (cachedBase) return cachedBase;
  let endpoint = (env.SC_SERVER || "").trim();
  if (!endpoint) {
    if (!env.SC_TEAM) throw new HttpError(500, "SC_TEAM is not set in the worker settings.");
    const r = await fetch(
      "https://api.sellercloud.com/api/server-by-team/?team=" + encodeURIComponent(env.SC_TEAM)
    );
    if (!r.ok) throw new HttpError(502, `Sellercloud server lookup failed (${r.status}).`);
    const info = await r.json();
    endpoint = info.RestApiEndpoint || info.restApiEndpoint || "";
    if (!endpoint) throw new HttpError(502, "Sellercloud server lookup returned no RestApiEndpoint. Check SC_TEAM.");
  }
  endpoint = endpoint.replace(/\/+$/, "");
  // Docs: token is at [RestApiEndpoint]/api/token and calls at .../rest/api/...
  cachedBase = /\/api$/i.test(endpoint) ? endpoint : endpoint + "/api";
  return cachedBase;
}

// Sellercloud limits sign-ins: Nov 19 15:01 UTC its /token answered 409 {"Error":"Too many requests.","RateLimitResetTime":...}.
// So the worker signs in as rarely as it can:
// - one sign-in at a time per worker instance (calls side by side wait for the one in flight);
// - the token is kept for all worker instances until shortly before it expires: in KV if a TOKEN_KV binding is added,
//   otherwise in Cloudflare's cache (both inside his Cloudflare account, never sent anywhere else);
// - after a refused sign-in nobody tries again before Sellercloud's RateLimitResetTime (a refused try can count too).
const TOKEN_KEY = "sc-token-v1";
const BLOCK_KEY = "sc-signin-blocked-v1";
const internalReq = (k) => new Request("https://sellercloud-link.internal/" + k);
async function sharedGet(env, k) {
  try {
    if (env.TOKEN_KV) return await env.TOKEN_KV.get(k, "json");
    const hit = await caches.default.match(internalReq(k));
    return hit ? await hit.json() : null;
  } catch { return null; }
}
async function sharedPut(env, k, val, secs) {
  secs = Math.max(60, Math.floor(secs));
  try {
    if (env.TOKEN_KV) return await env.TOKEN_KV.put(k, JSON.stringify(val), { expirationTtl: secs });
    await caches.default.put(internalReq(k), new Response(JSON.stringify(val), { headers: { "cache-control": `max-age=${secs}` } }));
  } catch {}
}
async function sharedDel(env, k) {
  try { if (env.TOKEN_KV) await env.TOKEN_KV.delete(k); else await caches.default.delete(internalReq(k)); } catch {}
}
let signInBlockedUntil = 0;
// Drops the kept token (Sellercloud answered 401 to it).
async function dropToken(env) { cachedToken = null; await sharedDel(env, TOKEN_KEY); }

let tokenPending = null;
async function getToken(env, base) {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  if (!tokenPending) tokenPending = tokenFromSharedOrSignIn(env, base).finally(() => { tokenPending = null; });
  return tokenPending;
}
async function tokenFromSharedOrSignIn(env, base) {
  const kept = await sharedGet(env, TOKEN_KEY);
  if (kept?.value && kept.expiresAt > Date.now() + 60_000) { cachedToken = kept; return kept.value; }
  return signIn(env, base);
}
// How long a sign-in may wait for Sellercloud's reset time: up to 30 s from the start of the call.
const signInWaitEnd = () => Math.max(deadline, callStart + 30_000);
async function signIn(env, base) {
  if (!env.SC_USERNAME || !env.SC_PASSWORD)
    throw new HttpError(500, "SC_USERNAME or SC_PASSWORD is not set in the worker settings.");
  let r, text = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    // Someone (this or another instance) was refused: wait for Sellercloud's reset time, or say when to try.
    const blocked = Math.max(signInBlockedUntil, Number((await sharedGet(env, BLOCK_KEY))?.until) || 0);
    if (blocked > Date.now()) {
      if ((quickBusy && blocked - Date.now() > QUICK_WAIT_MS) || blocked + 500 > signInWaitEnd()) throw signInLimitError(blocked);
      await sleep(blocked - Date.now() + 500);
      const kept = await sharedGet(env, TOKEN_KEY); // another instance may have signed in meanwhile
      if (kept?.value && kept.expiresAt > Date.now() + 60_000) { cachedToken = kept; return kept.value; }
    }
    const now = Date.now();
    subrequests++; scCalls++;
    r = await fetch(base + "/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ Username: env.SC_USERNAME, Password: env.SC_PASSWORD }),
    });
    if (r.ok) {
      const t = await r.json();
      if (!t.access_token) throw new HttpError(502, "Sellercloud sign-in returned no token.");
      // Docs disagree on 30 vs 60 minutes, so trust the response; fall back to 25 minutes.
      const secs = Number(t.expires_in) > 0 ? Number(t.expires_in) : 1500;
      cachedToken = { value: t.access_token, expiresAt: now + secs * 1000 };
      await sharedPut(env, TOKEN_KEY, cachedToken, secs - 120);
      return cachedToken.value;
    }
    text = (await r.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
    if (r.status === 409 || r.status === 429) {
      noteRefusal("sign-in", r.status, text, r);
      const until = Date.now() + busyWait(r, attempt, text, 120_000);
      signInBlockedUntil = Math.max(signInBlockedUntil, until);
      await sharedPut(env, BLOCK_KEY, { until: signInBlockedUntil }, (signInBlockedUntil - Date.now()) / 1000 + 5);
      continue; // the loop top waits for the reset time (or reports it)
    }
    if (r.status === 400 || r.status === 401 || r.status === 403 || attempt === 2) break;
    await sleep(3000 * (attempt + 1));
  }
  cachedToken = null;
  const said = text ? ` Sellercloud said: ${text}` : "";
  if (r.status === 400 || r.status === 401 || r.status === 403)
    throw new HttpError(502, `Sellercloud sign-in failed (${r.status}). Check the username and password secrets.${said}`);
  if (r.status === 409 || r.status === 429) throw signInLimitError(signInBlockedUntil);
  throw new HttpError(503, `Sellercloud turned the sign-in away (${r.status}) after 3 tries. Wait a minute, then press Run again.${said}`);
}
function signInLimitError(until) {
  let t;
  try { t = new Date(until).toLocaleTimeString("en-US", { timeZone: reqEnv?.TIME_ZONE || "America/New_York", hour: "numeric", minute: "2-digit", second: "2-digit" }); }
  catch { t = new Date(until).toISOString().slice(11, 19) + " UTC"; }
  return Object.assign(new HttpError(503, `Sellercloud is limiting sign-ins right now. It allows the next one at ${t}; the worker will sign in then and keep that sign-in for later calls.`),
    { busy: true, call: "sign-in", said: lastRefusal?.said || null, retryAt: new Date(until).toISOString() });
}

// The only kind of data call this worker makes to Sellercloud: a GET.
// In the Kits pop-up's read routes the answer is kept for a short time (readTtl), so a second look within
// seconds doesn't call Sellercloud again (Nov 19: the pop-up hit Sellercloud's "too many requests" limit).
async function scGet(env, path, params = {}) {
  const base = await getBase(env);
  const url = new URL(base + path);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, String(x)));
    else url.searchParams.set(k, String(v));
  }
  const text = await cachedRead("rest", url.toString(), readTtl("rest", path), () => scGetText(env, base, url, path));
  return JSON.parse(text);
}
async function scGetText(env, base, url, path) {
  let renewed = false;
  for (let attempt = 0; attempt < 7; attempt++) {
    await waitIfBusy();
    const token = await getToken(env, base);
    subrequests++; scCalls++;
    const r = await fetch(url.toString(), {
      method: "GET",
      headers: { Authorization: "Bearer " + token, Accept: "application/json" },
    });
    if (r.status === 401 && !renewed) {
      await dropToken(env); // token expired early; sign in once more
      renewed = true;
      continue;
    }
    // Too many requests (Sellercloud answers 409 or 429; Nov 19 it was 409 while the 2-minute sync ran):
    // wait as long as it asks (capped) and try again, then give up with a "busy" answer the Hub can retry.
    if (r.status === 409 || r.status === 429) {
      const said = (await r.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
      noteRefusal(path, r.status, said, r);
      const ms = busyWait(r, attempt, said);
      noteBusy(ms);
      // The Final SKU search waits too when Sellercloud's reset is only a few seconds away (once), before using the board.
      if ((!quickBusy || (attempt === 0 && ms <= QUICK_WAIT_MS)) && attempt < 6 && Date.now() + ms < deadline) { await sleep(ms); continue; }
      throw busyError(r.status, path, said, r);
    }
    if (!r.ok) {
      const text = (await r.text()).slice(0, 300);
      throw new HttpError(502, `Sellercloud ${path} failed (${r.status}). ${text}`);
    }
    return r.text();
  }
  throw busyError(409);
}

// How long to wait after a "too many requests" answer: Retry-After or the reset time Sellercloud sends,
// else 1.5, 3, 4.5 s and so on; never more than 10 s at a time.
function busyWait(r, attempt, said = "", cap = 10000) {
  // Sellercloud puts the reset time in the body: {"Error":"Too many requests.","RateLimitResetTime":"...Z"} (Nov 19).
  const m = /"RateLimitResetTime"\s*:\s*"([^"]+)"/i.exec(said || "");
  if (m) { const ms = Date.parse(/Z$|[+-]\d\d:?\d\d$/.test(m[1]) ? m[1] : m[1] + "Z") - Date.now(); if (Number.isFinite(ms)) return Math.min(cap, Math.max(500, ms + 500)); }
  const ra = Number(r.headers.get("retry-after"));
  if (ra > 0) return Math.min(10000, ra * 1000 + 250);
  const reset = Number(r.headers.get("x-ratelimit-reset") || r.headers.get("ratelimit-reset"));
  if (reset > 0) { const ms = reset > 1e9 ? reset * 1000 - Date.now() : reset * 1000; if (ms > 0) return Math.min(10000, ms + 250); }
  return Math.min(10000, 1500 * (attempt + 1)) + Math.floor(Math.random() * 700); // a little jitter so retries don't line up
}
// Once Sellercloud says "too many requests", the worker's other calls wait out the same time instead of
// adding to the pile (per worker instance).
let busyUntil = 0;
const noteBusy = (ms) => { busyUntil = Math.max(busyUntil, Date.now() + ms); };
async function waitIfBusy() {
  const ms = busyUntil - Date.now();
  if (ms <= 0) return;
  if ((quickBusy && ms > QUICK_WAIT_MS) || Date.now() + ms >= deadline) throw Object.assign(busyError(lastRefusal?.status || 409), { said: lastRefusal?.said || null,
    message: `Sellercloud refused a call a moment ago (${lastRefusal?.status || 409}).${lastRefusal?.said ? " Sellercloud said: " + lastRefusal.said : ""}` });
  await sleep(ms);
}

// Short-lived copies of Sellercloud reads, shared by all worker instances (Cloudflare's cache). Only used in the
// Kits pop-up's GET routes (readCacheOn), never in setup, produce or assemble, which always read fresh; ?fresh=1 skips it.
let readCacheOn = false;
// The Final SKU search doesn't wait out a "too many requests": it answers from the Sellercloud Products board at once.
let quickBusy = false;
const QUICK_WAIT_MS = 4500;
const READ_ROUTES = /^\/assemble\/(preview|plan|kit|bridge|bins|find)$/;
function readTtl(kind, what) {
  if (kind === "soap") return { WarehouseBin_ListAll: 600, ProductKit_GetKitDetails: 60, ProductWarehouseBin_ListAll_New: 15 }[what] || 0;
  if (/^\/catalog/i.test(what)) return 60;
  if (/^\/inventory/i.test(what)) return 15;
  return 0;
}
async function cachedRead(kind, keyText, ttl, fn) {
  if (!readCacheOn || !(ttl > 0)) return fn();
  let key = null;
  try {
    const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(kind + "|" + keyText)));
    key = new Request("https://sellercloud-link.internal/read/" + [...h].map((b) => b.toString(16).padStart(2, "0")).join(""));
    const hit = await caches.default.match(key);
    if (hit) return hit.text();
  } catch {}
  const text = await fn();
  if (key) await caches.default.put(key, new Response(text, { headers: { "cache-control": `max-age=${ttl}` } })).catch(() => {});
  return text;
}
// Sellercloud's own answer is kept with the error (and the last one on /health), so a 409 that isn't really
// "too many requests" shows what it was.
let lastRefusal = null;

// ── Live calls first (Nov 19) ──
// Sellercloud allows 10,800 REST calls an hour per user per IP address, all endpoints together (its "REST API Rate
// Limiting" page); over that it answers {"Error":"Too many requests.","RateLimitResetTime":...}. The 2-minute sync with
// up to 900 calls a run was far over it. Now: the Hub's calls (Kits pop-up, assembly, qty check, crew pull) mark the Hub
// as in use, and the 30-minute sync waits while it is (up to SYNC_MAX_DEFER_MINUTES, default 10) and steps aside in the
// middle of a run, continuing on the next timer tick. The sync also only re-reads a product's Skustack qty when its
// totals changed (plus 1/48 of products per pass, so each is re-read about once a day).
let scCalls = 0, scTallied = 0; // Sellercloud calls made by this instance (REST, sign-in, SOAP)
const HUB_ACTIVE = "hub-active-v1";
let hubMarkedAt = 0;
async function markHubActive(env) {
  if (Date.now() - hubMarkedAt < 20_000) return;
  hubMarkedAt = Date.now();
  await sharedPut(env, HUB_ACTIVE, { at: hubMarkedAt }, 3600);
}
async function hubActiveAt(env) { return Number((await sharedGet(env, HUB_ACTIVE))?.at) || 0; }
const syncQuietMs = (env) => Math.max(1, parseInt(env.SYNC_QUIET_MINUTES || "3", 10) || 3) * 60_000;
const syncMaxDeferMs = (env) => Math.max(0, parseInt(env.SYNC_MAX_DEFER_MINUTES ?? "10", 10) || 0) * 60_000;
// About how many Sellercloud calls the worker made this hour and last hour (all instances; a rough count).
const hourKey = (t) => "sc-calls-" + new Date(t).toISOString().slice(0, 13);
async function tallyCalls(env) {
  const add = scCalls - scTallied;
  if (add <= 0) return;
  scTallied = scCalls;
  const k = hourKey(Date.now());
  const had = Number((await sharedGet({}, k))?.n) || 0; // Cloudflare's cache only (no KV writes for a rough count)
  await sharedPut({}, k, { n: had + add }, 7300);
}
async function callCounts(env) {
  const now = Date.now();
  return { thisHour: Number((await sharedGet({}, hourKey(now)))?.n) || 0, lastHour: Number((await sharedGet({}, hourKey(now - 3600_000)))?.n) || 0,
    limitPerHour: 10800, note: "Rough count of the worker's Sellercloud calls (UTC hours). Sellercloud's limit is 10,800 an hour." };
}
function noteRefusal(call, status, said, r) {
  lastRefusal = { at: new Date().toISOString(), call, status, said: said || null,
    retryAfter: r?.headers?.get?.("retry-after") || null, reset: r?.headers?.get?.("x-ratelimit-reset") || r?.headers?.get?.("ratelimit-reset") || null };
  // Kept for all instances too (Cloudflare's cache), so /health shows the latest refusal whichever instance got it.
  sharedPut({}, "sc-last-refusal-v1", lastRefusal, 7200).catch(() => {});
}
async function latestRefusal() {
  const kept = await sharedGet({}, "sc-last-refusal-v1");
  if (!lastRefusal) return kept;
  if (!kept) return lastRefusal;
  return kept.at > lastRefusal.at ? kept : lastRefusal;
}
// When Sellercloud takes calls again, from its RateLimitResetTime (ISO), or null.
function resetFrom(said) {
  const m = /"RateLimitResetTime"\s*:\s*"([^"]+)"/i.exec(said || "");
  if (!m) return null;
  const t = Date.parse(/Z$|[+-]\d\d:?\d\d$/.test(m[1]) ? m[1] : m[1] + "Z");
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
function timeET(iso) {
  try { return new Date(iso).toLocaleTimeString("en-US", { timeZone: reqEnv?.TIME_ZONE || "America/New_York", hour: "numeric", minute: "2-digit", second: "2-digit" }) + " ET"; }
  catch { return new Date(iso).toISOString().slice(11, 19) + " UTC"; }
}
const busyError = (status, call = "", said = "", r = null) => {
  if (call) noteRefusal(call, status, said, r);
  const where = call === "sign-in" ? "turned the sign-in away" : "is busy";
  return Object.assign(new HttpError(503, `Sellercloud ${where} (${status}${/too many/i.test(said) || status === 429 ? ", too many requests" : ""}).` +
    `${said ? " Sellercloud said: " + said : ""} Try again in a moment.`), { busy: true, said: said || null, call: call || null });
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

const num = (x) => (typeof x === "number" ? x : Number(x) || 0);

function slimProduct(p) {
  return {
    sku: p.ID ?? p.ProductID ?? null,
    name: p.ProductName ?? null,
    companyId: p.CompanyID ?? null,
    company: p.CompanyName ?? null,
    upc: p.UPC ?? null,
    imageUrl: p.ImageUrl ?? null,
    available: num(p.InventoryAvailableQty),
    physical: num(p.PhysicalQty),
    reserved: num(p.ReservedQty),
    active: p.ActiveStatus ?? null,
  };
}

// Warehouse id -> { name, sellable }, cached for 6 hours. Tries the full list first, then single lookups.
let whCache = { info: {}, listLoadedAt: 0 };
const WH_TTL = 6 * 60 * 60 * 1000;

const whName = (w) => w?.Name ?? w?.WarehouseName ?? w?.Code ?? w?.Description ?? null;
const whId = (w) => w?.ID ?? w?.Id ?? w?.WarehouseID ?? null;
function whSellable(w) {
  if (!w || typeof w !== "object") return null;
  for (const [k, v] of Object.entries(w)) {
    if (/sellable/i.test(k) && !/non|not|un/i.test(k)) {
      if (typeof v === "boolean") return v;
      if (v === 1 || v === 0) return v === 1;
      if (v === "true" || v === "false") return v === "true";
    }
  }
  return null;
}
const whInfo = (w) => ({ name: whName(w), sellable: whSellable(w) });

let whListLoading = null;
async function loadWarehouseList(env) {
  whCache = { info: {}, listLoadedAt: Date.now() };
  try {
    const data = await scGet(env, "/Warehouses", { pageNumber: 1, pageSize: 500 });
    const list = Array.isArray(data) ? data : data?.Items || data?.Warehouses || [];
    for (const w of list) if (whId(w) != null) whCache.info[whId(w)] = whInfo(w);
  } catch {
    // fall back to single lookups
  }
}

async function warehouseInfo(env, ids) {
  if (Date.now() - whCache.listLoadedAt > WH_TTL) {
    if (!whListLoading) whListLoading = loadWarehouseList(env).finally(() => { whListLoading = null; });
  }
  if (whListLoading) await whListLoading;
  const missing = [...new Set(ids)].filter((id) => id != null && !(id in whCache.info));
  for (const id of missing.slice(0, 20)) {
    try {
      const w = await scGet(env, "/Warehouses/" + encodeURIComponent(id));
      whCache.info[id] = whInfo(Array.isArray(w) ? w[0] : w);
    } catch {
      whCache.info[id] = { name: null, sellable: null };
    }
  }
  return whCache.info;
}

// Which warehouses count for the production qty check (default: Skustack Warehouse only). COUNT_WAREHOUSES is a
// comma-separated list of warehouse names or ids; if it isn't set, Sellercloud's Sellable flag decides.
const countSetting = (env) => (env.COUNT_WAREHOUSES || "3232").trim(); // 3232 = Skustack Warehouse
function counts(env, w) {
  const list = countSetting(env).split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (list.length) return list.includes(String(w.warehouseId)) || list.includes((w.warehouse || "").toLowerCase());
  return w.sellable === true;
}

// Only products under the warehouse company count. WAREHOUSE_COMPANY (Text, required for /qty and
// /products) is that company's exact name or id in Sellercloud.
let learnedCompanyId = null;
const companySetting = (env) => (env.WAREHOUSE_COMPANY || "317").trim(); // 317 = "WAREHOUSE" company in Sellercloud
function companyMatches(env, p) {
  const want = companySetting(env).toLowerCase();
  if (!want) return false;
  const ok = String(p.CompanyID ?? "") === want || (p.CompanyName || "").trim().toLowerCase() === want;
  if (ok && p.CompanyID != null) learnedCompanyId = p.CompanyID;
  return ok;
}
function warehouseCompanyId(env) {
  const v = companySetting(env);
  return /^\d+$/.test(v) ? v : learnedCompanyId;
}
function needCompany(env) {
  if (!companySetting(env)) throw new HttpError(500, "WAREHOUSE_COMPANY is empty.");
}


// ───────────────────────── Hourly copy into monday ─────────────────────────
// Reads Warehouse-company products from Sellercloud (read-only) and writes them to ONE monday board,
// the "Sellercloud Products" board named in SYNC_BOARD_ID. It refuses to write anywhere else.
//   MONDAY_TOKEN  (Secret) a monday API token you create
//   SYNC_BOARD_ID (Text)   18440651605
//   SC_PRODUCT_URL (Text, optional) product page link with {sku}; default
//                  https://lgd.delta.sellercloud.com/catalog/catalog-details.aspx?ID={sku}

const LIVE_BOARDS = new Set(["18410399966", "18439411777"]); // never write to these
const COLS = {
  sku: "sc_sku", sellable: "sc_sellable", total: "sc_total", physical: "sc_physical",
  photo: "sc_photo", link: "sc_link", upc: "sc_upc", changed: "sc_synced",
};
const BOARD_NAME = "Sellercloud Products";

let subrequests = 0;
// Each call stops waiting on Sellercloud after about 20 s and answers { continue: true } (Nov 19: a long call was cut off).
let deadline = Infinity;
let callStart = Date.now();
const timeUp = () => Date.now() > deadline;
const countFetch = () => { subrequests++; };

async function mondayApi(env, query, variables = {}) {
  countFetch();
  const r = await fetch("https://api.monday.com/v2", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: env.MONDAY_TOKEN },
    body: JSON.stringify({ query, variables }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.errors || data.error_message)
    throw new HttpError(502, "monday API error: " + JSON.stringify(data.errors || data.error_message || r.status).slice(0, 300));
  return data.data;
}

function syncBoardId(env) {
  const id = String(env.SYNC_BOARD_ID || "").trim();
  if (!/^\d+$/.test(id)) throw new HttpError(500, "SYNC_BOARD_ID is not set.");
  if (LIVE_BOARDS.has(id)) throw new HttpError(500, "SYNC_BOARD_ID points at a production board. Refusing to write.");
  if (!env.MONDAY_TOKEN) throw new HttpError(500, "MONDAY_TOKEN is not set.");
  return id;
}

// Read-only search of the Sellercloud Products board by name or SKU (text contains), for when Sellercloud is busy.
// Matches every word of the search (any order), in the name or in the SKU, so "Temu - Hersheys C Kisses Blue Cookies N
// Cream 1lb" finds "Hersheys C Kisses Blue Cookies N Cream bulk by lb" style rows only when all words are there; if that
// finds nothing, the longest words alone are tried.
async function boardSearch(env, q) {
  const boardId = syncBoardId(env);
  const words = [...new Set(String(q).toLowerCase().split(/[^a-z0-9.]+/i).filter((w) => w.length >= 2))].slice(0, 8);
  const run = async (ws, col) => {
    const rules = (ws.length ? ws : [q]).map((w) => `{column_id:"${col}", compare_value:${gql([w])}, operator:contains_text}`).join(",");
    const d = await mondayApi(env, `query($b:[ID!],$c:[String!]){ boards(ids:$b){ items_page(limit:25, query_params:{operator:and, rules:[${rules}]}){
      items{ id name column_values(ids:$c){ id text value } } } } }`, { b: [boardId], c: [COLS.sku, COLS.physical, COLS.sellable, COLS.photo, COLS.upc] });
    return d.boards?.[0]?.items_page?.items || [];
  };
  let found = [...(await run(words, "name")), ...(await run(words, COLS.sku))];
  if (!found.length && words.length > 2) {
    const longest = [...words].sort((a, b) => b.length - a.length).slice(0, 3);
    found = [...(await run(longest, "name")), ...(await run(longest, COLS.sku))];
  }
  const urlTemplate = env.SC_PRODUCT_URL || "https://lgd.delta.sellercloud.com/catalog/catalog-details.aspx?ID={sku}";
  return found.map((it) => {
    const cv = Object.fromEntries(it.column_values.map((c) => [c.id, c]));
    const sku = (cv[COLS.sku]?.text || "").trim();
    let photo = null;
    try { photo = JSON.parse(cv[COLS.photo]?.value || "null")?.url || null; } catch {}
    return { sku, name: it.name, physical: num(cv[COLS.physical]?.text), available: num(cv[COLS.sellable]?.text), upc: cv[COLS.upc]?.text || null, imageUrl: photo, company: "WAREHOUSE",
      link: sku ? urlTemplate.replace("{sku}", encodeURIComponent(sku)) : null };
  }).filter((x, i, a) => x.sku && a.findIndex((y) => y.sku.toLowerCase() === x.sku.toLowerCase()) === i);
}

async function readBoard(env, boardId) {
  const d = await mondayApi(env, `query($b:[ID!]){ boards(ids:$b){ name description groups{ id title } } }`, { b: [boardId] });
  const b = d.boards?.[0];
  if (!b) throw new HttpError(500, "Sync board not found.");
  if (b.name !== BOARD_NAME) throw new HttpError(500, `Sync board is named "${b.name}", not "${BOARD_NAME}". Refusing to write.`);
  const inStock = b.groups.find((g) => /^in stock$/i.test(g.title))?.id;
  const outStock = b.groups.find((g) => /^out of stock$/i.test(g.title))?.id;
  if (!inStock || !outStock) throw new HttpError(500, 'Sync board needs groups "In stock" and "Out of stock".');

  const items = new Map(); // sku (lower case) -> item
  const dups = []; // extra rows for a SKU already seen
  const ids = Object.values(COLS).filter((c) => c !== COLS.link);
  let cursor = null;
  let first = true;
  while (first || cursor) {
    const q = first
      ? `query($b:[ID!],$c:[String!]){ boards(ids:$b){ items_page(limit:500){ cursor items{ id name group{id} column_values(ids:$c){ id text value } } } } }`
      : `query($cur:String!,$c:[String!]){ next_items_page(limit:500, cursor:$cur){ cursor items{ id name group{id} column_values(ids:$c){ id text value } } } }`;
    const d = await mondayApi(env, q, first ? { b: [boardId], c: ids } : { cur: cursor, c: ids });
    const page = first ? d.boards[0].items_page : d.next_items_page;
    for (const it of page.items) {
      const cv = Object.fromEntries(it.column_values.map((c) => [c.id, c]));
      const sku = (cv[COLS.sku]?.text || "").trim();
      if (!sku) continue;
      let photo = "";
      try { photo = JSON.parse(cv[COLS.photo]?.value || "null")?.url || ""; } catch {}
      const row = {
        id: it.id, name: it.name, group: it.group?.id,
        sellable: cv[COLS.sellable]?.text ?? "", total: cv[COLS.total]?.text ?? "",
        physical: cv[COLS.physical]?.text ?? "", upc: cv[COLS.upc]?.text ?? "", photo,
        checked: (() => { // "YYYY-MM-DD HH:MM:SS" in UTC, from the date column's stored value
          try { const v = JSON.parse(cv[COLS.changed]?.value || "null"); return v?.date ? `${v.date} ${v.time || "00:00:00"}` : ""; }
          catch { return ""; }
        })(),
      };
      // One row per SKU (exact, any case). If the board has more, keep the most recently synced one;
      // the sync removes the others (Nov 19: Test2/Test3 0.1oz each had a stale second row).
      const key = sku.toLowerCase();
      const had = items.get(key);
      if (!had) items.set(key, row);
      else if ((row.checked || "") > (had.checked || "")) { dups.push(had); items.set(key, row); }
      else dups.push(row);
    }
    cursor = page.cursor;
    first = false;
  }
  return { inStock, outStock, items, dups, description: b.description || "" };
}

async function warehouseCompanyIdForSync(env) {
  const id = warehouseCompanyId(env);
  if (id) return id;
  try {
    const data = await scGet(env, "/Companies", { pageNumber: 1, pageSize: 500 });
    const list = Array.isArray(data) ? data : data?.Items || data?.Companies || [];
    const want = companySetting(env).toLowerCase();
    const c = list.find((c) => String(c.CompanyName ?? c.Name ?? "").trim().toLowerCase() === want);
    if (c) return (learnedCompanyId = c.ID ?? c.Id ?? c.CompanyID);
  } catch {}
  return null; // fall back to filtering every catalog page ourselves
}

async function countedQty(env, sku) {
  const data = await scGet(env, "/Inventory/Warehouses", { productID: sku });
  const rows = (Array.isArray(data) ? data : data ? [data] : []).map((w) => ({
    warehouseId: w.WarehouseID ?? null, warehouse: w.WarehouseName ?? null,
    available: num(w.AvailableQty), physical: num(w.PhysicalQty),
  }));
  const names = /^[\d,\s]+$/.test(countSetting(env)) ? {} : await warehouseInfo(env, rows.map((r) => r.warehouseId));
  let sum = 0;
  for (const r of rows) {
    r.warehouse = r.warehouse || names[r.warehouseId]?.name || null;
    if (counts(env, r)) sum += r.available;
  }
  return sum;
}

async function pool(items, size, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) { const k = i++; await fn(items[k], k); }
  });
  await Promise.all(workers);
}

const gql = (v) => JSON.stringify(v);
const nowStamp = () => { const d = new Date().toISOString(); return { date: d.slice(0, 10), time: d.slice(11, 19) }; };
const stampText = (t) => `${t.date} ${t.time}`;

const skuSlot = (sku) => { let h = 0; for (const c of String(sku).toLowerCase()) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 48; };

// Refresh one product on the Sellercloud Products board now (the Hub's Refresh button): reads its catalog row and
// Skustack qty from Sellercloud (2-3 calls) and updates or adds its board row. Writes only to that board.
async function refreshOne(env, skuIn) {
  const boardId = syncBoardId(env);
  const sku = String(skuIn).trim();
  const data = await scGet(env, "/catalog", { SKU: [sku], pageNumber: 1, pageSize: 5 });
  const p = (data.Items || []).find((x) => String(x.ID ?? x.ProductID ?? "").toLowerCase() === sku.toLowerCase());
  if (!p) throw new HttpError(404, `Sellercloud has no product with SKU ${sku}.`);
  if (!companyMatches(env, p)) throw new HttpError(400, `${sku} isn't under the WAREHOUSE company in Sellercloud, so it isn't on the board.`);
  const realSku = String(p.ID ?? p.ProductID);
  const counted = await countedQty(env, realSku);
  const d = await mondayApi(env, `query($b:[ID!],$c:[String!]){ boards(ids:$b){ name groups{ id title }
    items_page(limit:25, query_params:{rules:[{column_id:"${COLS.sku}", compare_value:${gql([realSku])}, operator:contains_text}]}){ items{ id name group{id} } } } }`,
    { b: [boardId], c: [COLS.sku] });
  const b = d.boards?.[0];
  if (!b || b.name !== BOARD_NAME) throw new HttpError(500, `Sync board is not "${BOARD_NAME}". Refusing to write.`);
  const inStock = b.groups.find((g) => /^in stock$/i.test(g.title))?.id;
  const outStock = b.groups.find((g) => /^out of stock$/i.test(g.title))?.id;
  if (!inStock || !outStock) throw new HttpError(500, 'Sync board needs groups "In stock" and "Out of stock".');
  // contains_text can match longer SKUs too; keep the exact one (by name match on the SKU column below).
  const rows = b.items_page?.items || [];
  let row = null;
  if (rows.length) {
    const ids = rows.map((r) => r.id);
    const d2 = await mondayApi(env, `query($i:[ID!],$c:[String!]){ items(ids:$i){ id column_values(ids:$c){ id text } } }`, { i: ids, c: [COLS.sku] });
    const exact = new Set((d2.items || []).filter((it) => (it.column_values[0]?.text || "").trim().toLowerCase() === realSku.toLowerCase()).map((it) => it.id));
    row = rows.find((r) => exact.has(r.id)) || null;
  }
  const group = counted > 0 ? inStock : outStock;
  const name = (p.ProductName || realSku).slice(0, 255);
  const urlTemplate = env.SC_PRODUCT_URL || "https://lgd.delta.sellercloud.com/catalog/catalog-details.aspx?ID={sku}";
  const cols = {
    [COLS.total]: String(num(p.InventoryAvailableQty)), [COLS.physical]: String(num(p.PhysicalQty)), [COLS.sellable]: String(counted),
    [COLS.upc]: p.UPC ? String(p.UPC) : "", [COLS.changed]: nowStamp(),
    [COLS.link]: { url: urlTemplate.replace("{sku}", encodeURIComponent(realSku)), text: realSku },
  };
  if (p.ImageUrl) cols[COLS.photo] = { url: p.ImageUrl, text: "Photo" };
  if (!row) {
    cols[COLS.sku] = realSku;
    await mondayApi(env, `mutation($b:ID!,$g:String!,$n:String!,$v:JSON!){ create_item(board_id:$b, group_id:$g, item_name:$n, column_values:$v){ id } }`,
      { b: boardId, g: group, n: name, v: JSON.stringify(cols) });
  } else {
    cols.name = name;
    await mondayApi(env, `mutation($b:ID!,$i:ID!,$v:JSON!){ change_multiple_column_values(board_id:$b, item_id:$i, column_values:$v){ id } }`,
      { b: boardId, i: row.id, v: JSON.stringify(cols) });
    if (row.group?.id !== group) await mondayApi(env, `mutation($i:ID!,$g:String!){ move_item_to_group(item_id:$i, group_id:$g){ id } }`, { i: row.id, g: group });
  }
  return { done: true, sku: realSku, name, added: !row, physical: num(p.PhysicalQty), total: num(p.InventoryAvailableQty), available: counted,
    group: counted > 0 ? "In stock" : "Out of stock", at: new Date().toISOString(),
    message: `${realSku} ${row ? "updated" : "added"} on the Sellercloud Products board: ${counted} available in Skustack Warehouse.` };
}

// Progress is kept in the board description between runs, after this marker.
const STATE_RE = /\n?\[sync-state ([^\]]*)\]\s*$/;
function readState(description) {
  const m = description.match(STATE_RE);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

// One bounded batch of the copy. Each run continues where the last one stopped, so a large
// catalog is copied over several runs (the 30-minute trigger, or opening /sync again).
// Two runs at once (the timer and a manual /sync) could both create the same new product. A short lock stops that.
const SYNC_LOCK = new Request("https://sellercloud-link.internal/synclock");
// The scheduled sync runs at most once per SYNC_EVERY_MINUTES (default 30), whatever the Cloudflare timer says.
// Nov 19: the timer was still at every 2 minutes, and each run made a few hundred Sellercloud calls, so Sellercloud's
// "too many requests" limit was used up and the Kits pop-up's searches and checks were refused.
// It also skips a run while Sellercloud is refusing calls, and stops after SYNC_MAX_CALLS Sellercloud calls (default 300).
const SYNC_LAST = "sync-last-run-v1";
const syncEvery = (env) => Math.max(5, parseInt(env.SYNC_EVERY_MINUTES || "30", 10) || 30);
async function runSync(env, opts = {}) {
  let yieldSince = 0, dueSince = 0;
  if (opts.scheduled) {
    // The Cloudflare timer fires every few minutes; the sync itself runs every SYNC_EVERY_MINUTES (default 30).
    const rec = (await sharedGet(env, SYNC_LAST)) || {};
    const last = Number(rec.at) || 0;
    const pending = Number(rec.pendingSince) || 0;
    if (!pending && Date.now() - last < syncEvery(env) * 60_000 - 30_000)
      return { skipped: true, message: `Last sync run was ${Math.round((Date.now() - last) / 60000)} min ago; runs every ${syncEvery(env)} min.` };
    dueSince = pending || (last ? last + syncEvery(env) * 60_000 : Date.now());
    const keep = { at: last, pendingSince: dueSince };
    const overdue = Date.now() - dueSince > syncMaxDeferMs(env);
    // The Hub is in use (Kits pop-up, assembly, qty check): let its Sellercloud calls go first.
    if (!overdue && Date.now() - (await hubActiveAt(env)) < syncQuietMs(env)) {
      await sharedPut(env, SYNC_LAST, keep, 7200);
      return { skipped: true, message: "The Hub is using Sellercloud right now; the sync runs once it has been quiet for a few minutes." };
    }
    const blocked = Number((await sharedGet(env, BLOCK_KEY))?.until) || 0;
    if (blocked > Date.now() || busyUntil > Date.now()) {
      await sharedPut(env, SYNC_LAST, keep, 7200);
      return { skipped: true, message: "Sellercloud is limiting calls right now; the sync waits for the next run." };
    }
    await sharedPut(env, SYNC_LAST, { at: Date.now(), pendingSince: 0 }, syncEvery(env) * 60 + 3600);
    if (!overdue) yieldSince = Date.now(); // steps aside mid-run if the Hub starts calling
  }
  if (!opts.dry) {
    if (await caches.default.match(SYNC_LOCK).catch(() => null)) return { skipped: true, busySync: true, message: "Another sync is running. Try again in a minute." };
    await caches.default.put(SYNC_LOCK, new Response("1", { headers: { "cache-control": "max-age=180" } })).catch(() => {});
  }
  try {
    const out = await runSyncOnce(env, { ...opts, yieldSince });
    // Stopped for the Hub or a busy answer before the pass finished: the rest runs on the next timer tick.
    if (opts.scheduled && (out.thisRun?.stoppedForHub || out.thisRun?.stoppedBusy) && !out.pass?.finished)
      await sharedPut(env, SYNC_LAST, { at: Date.now(), pendingSince: dueSince || Date.now() }, 7200);
    return out;
  }
  finally { if (!opts.dry) await caches.default.delete(SYNC_LOCK).catch(() => {}); }
}
async function runSyncOnce(env, { dry = false, seconds = 20, yieldSince = 0, startNew = false } = {}) {
  subrequests = 0;
  const scAtStart = scCalls;
  const started = Date.now();
  // Cloudflare allows 1000 outgoing requests per run on Workers Paid (50 on the free plan:
  // set SUBREQUEST_LIMIT to 45 there).
  const budget = parseInt(env.SUBREQUEST_LIMIT || "900", 10);
  const timeBox = seconds * 1000;
  const boardId = syncBoardId(env);
  const board = await readBoard(env, boardId);
  const companyId = await warehouseCompanyIdForSync(env);

  let state = readState(board.description);
  let startedThisRun = false;
  if (!state || state.done || startNew) {
    // Start a new pass. Items not checked since passStart are out of stock at the end of the pass.
    state = { passStart: stampText(nowStamp()), page: 1, pageSize: budget >= 100 ? 50 : 20, checked: 0, total: null, done: false,
      passNo: ((state && state.passNo) || 0) + 1 };
    startedThisRun = true;
  }
  const passNo = state.passNo || 0;
  let recounted = 0, reused = 0, stoppedForHub = false;
  const pageSize = state.pageSize || 50;

  const products = [];
  let reachedEnd = false;
  let stoppedBusy = null;
  // Reserve room for: one write request per 20 products, the description update, and slack.
  const scMax = Math.max(20, parseInt(env.SYNC_MAX_CALLS || "300", 10) || 300);
  const room = () => Math.min(budget - subrequests - Math.ceil((products.length + 1) / 20) - 3, scMax - (scCalls - scAtStart));
  while (room() > 2 && Date.now() - started < timeBox) {
    if (yieldSince && (await hubActiveAt(env)) > yieldSince) { stoppedForHub = true; break; }
    const data = await scGet(env, "/catalog", {
      companyID: companyId ? [companyId] : undefined,
      physicalQtyFrom: 1,
      pageNumber: state.page,
      pageSize,
    });
    if (data.TotalResults != null) state.total = data.TotalResults;
    const list = (data.Items || []).filter((p) => companyMatches(env, p));
    // Look up the counted (Skustack) qty for each product on this page.
    // A product whose totals haven't changed since the board row keeps its Skustack qty (no extra call), except
    // for 1 in 48 products each pass, so every product is re-read about once a day at the 30-minute pace.
    const pageProducts = list.map((p) => {
      const sku = String(p.ID ?? "").trim();
      const ex = board.items.get(sku.toLowerCase());
      const same = ex && ex.sellable !== "" && num(ex.total) === num(p.InventoryAvailableQty) && num(ex.physical) === num(p.PhysicalQty)
        && skuSlot(sku) !== passNo % 48;
      return { p, counted: same ? num(ex.sellable) : null, need: !same };
    });
    const toLookUp = pageProducts.filter((x) => x.need);
    const canLookUp = Math.max(0, room() - 1);
    if (canLookUp < toLookUp.length) break; // not enough room for this page: next run takes it
    // Gentler on Sellercloud (4 at a time, was 8), and a busy answer ends this run: the page is taken again next run.
    let busyHit = null;
    reused += pageProducts.length - toLookUp.length;
    recounted += toLookUp.length;
    await pool(toLookUp, 4, async (x) => {
      if (busyHit) return;
      try { x.counted = await countedQty(env, String(x.p.ID)); } catch (e) { x.counted = null; if (e.busy) busyHit = e; }
    });
    if (busyHit) { stoppedBusy = busyHit.message; break; }
    products.push(...pageProducts);
    state.page++;
    if ((data.Items || []).length < pageSize) { reachedEnd = true; break; }
  }

  const urlTemplate = env.SC_PRODUCT_URL || "https://lgd.delta.sellercloud.com/catalog/catalog-details.aspx?ID={sku}";
  const url = (sku) => urlTemplate.replace("{sku}", encodeURIComponent(sku));
  const stamp = nowStamp();
  const muts = [];
  let created = 0, updated = 0, movedOut = 0;

  // The whole pass ran in this one run: rows with nothing new aren't rewritten (fewer monday calls); the end-of-pass
  // check below still knows they were seen. A pass over several runs stamps every row, as before.
  const compact = startedThisRun && reachedEnd;
  let unchanged = 0;
  for (const { p, counted } of products) {
    const sku = String(p.ID ?? "").trim();
    if (!sku) continue;
    const existing = board.items.get(sku.toLowerCase());
    const inStock = counted !== null ? counted > 0 : num(p.InventoryAvailableQty) > 0;
    const group = inStock ? board.inStock : board.outStock;
    const name = (p.ProductName || sku).slice(0, 255);
    const cols = {
      [COLS.total]: String(num(p.InventoryAvailableQty)),
      [COLS.physical]: String(num(p.PhysicalQty)),
      [COLS.sellable]: counted === null ? "" : String(counted),
      [COLS.upc]: p.UPC ? String(p.UPC) : "",
      [COLS.changed]: stamp, // "Last checked"
    };
    if (p.ImageUrl && (!existing || existing.photo !== p.ImageUrl)) cols[COLS.photo] = { url: p.ImageUrl, text: "Photo" };
    cols[COLS.link] = { url: url(sku), text: sku }; // set on every check, so existing rows get it too
    if (!existing) {
      cols[COLS.sku] = sku;
      muts.push(`create_item(board_id:${boardId}, group_id:${gql(group)}, item_name:${gql(name)}, column_values:${gql(JSON.stringify(cols))}){id}`);
      board.items.set(sku.toLowerCase(), { id: null, group });
      created++;
    } else {
      const same = existing.name === name && existing.group === group && existing.total === cols[COLS.total] && existing.physical === cols[COLS.physical]
        && existing.sellable === cols[COLS.sellable] && existing.upc === cols[COLS.upc] && !cols[COLS.photo];
      if (compact && same) { existing.checked = stampText(stamp); unchanged++; continue; }
      if (existing.name !== name) cols.name = name;
      muts.push(`change_multiple_column_values(board_id:${boardId}, item_id:${existing.id}, column_values:${gql(JSON.stringify(cols))}){id}`);
      if (existing.group !== group) muts.push(`move_item_to_group(item_id:${existing.id}, group_id:${gql(group)}){id}`);
      existing.checked = stampText(stamp);
      updated++;
    }
  }
  state.checked += products.length;
  // Remove duplicate rows (the stale copies; the kept row is the most recently synced).
  const dupesRemoved = board.dups.filter((d) => d.id).map((d) => ({ id: d.id, name: d.name, lastChecked: d.checked || null }));
  for (const d of dupesRemoved) muts.push(`delete_item(item_id:${d.id}){id}`);

  // End of a full pass: anything not checked during it is no longer in stock at the Warehouse company.
  if (reachedEnd) {
    for (const it of board.items.values()) {
      if (!it.id || it.group === board.outStock) continue;
      if (it.checked && it.checked >= state.passStart) continue;
      const cols = { [COLS.total]: "0", [COLS.physical]: "0", [COLS.sellable]: "0", [COLS.changed]: stamp };
      muts.push(`change_multiple_column_values(board_id:${boardId}, item_id:${it.id}, column_values:${gql(JSON.stringify(cols))}){id}`);
      muts.push(`move_item_to_group(item_id:${it.id}, group_id:${gql(board.outStock)}){id}`);
      movedOut++;
    }
    state.done = true;
  }

  const summary = {
    board: boardId,
    thisRun: { products: products.length, created, updated, unchanged, movedOut, recounted, reused, duplicatesRemoved: dupesRemoved, stoppedBusy, stoppedForHub,
      sellercloudCalls: scCalls - scAtStart },
    pass: { started: state.passStart + " UTC", checked: state.checked, total: state.total, finished: state.done },
    dry,
  };
  if (dry) return summary;

  for (let i = 0; i < muts.length; i += 20) {
    const chunk = muts.slice(i, i + 20).map((m, k) => `m${k}: ${m}`).join("\n");
    await mondayApi(env, `mutation {\n${chunk}\n}`);
  }
  const when = stampText(stamp).slice(0, 16) + " UTC";
  const progress = state.done
    ? `Last full sync finished ${when}: ${state.checked} products checked. ("Last checked" changes only when a row changes.)`
    : `Sync in progress: ${state.checked}${state.total ? " of " + state.total : ""} products checked so far (last run ${when}). It continues on the next run.`;
  await mondayApi(env, `mutation($b:ID!,$v:String!){ update_board(board_id:$b, board_attribute:description, new_value:$v) }`, {
    b: boardId,
    v: `Filled from Sellercloud (WAREHOUSE company). "Available (Skustack)" counts Skustack Warehouse only. Read-only copy: changes here are overwritten. ${progress}\n[sync-state ${JSON.stringify(state)}]`,
  });
  summary.subrequests = subrequests;
  summary.seconds = Math.round((Date.now() - started) / 100) / 10;
  return summary;
}

// ───────────────────────── Ask the crew for items (Google Chat) ─────────────────────────
//   CHAT_WEBHOOK (Secret) the Google Chat space's incoming webhook URL. The worker posts ONLY there.
const CHAT_PREFIX = "https://chat.googleapis.com/v1/spaces/";

async function postToChat(env, text) {
  const hook = (env.CHAT_WEBHOOK || "").trim();
  if (!hook) throw new HttpError(500, "CHAT_WEBHOOK is not set. Add it as a Secret.");
  if (!hook.startsWith(CHAT_PREFIX)) throw new HttpError(500, "CHAT_WEBHOOK must be a Google Chat webhook link.");
  const r = await fetch(hook, {
    method: "POST",
    headers: { "content-type": "application/json; charset=UTF-8" },
    body: JSON.stringify({ text }),
  });
  if (!r.ok) throw new HttpError(502, `Google Chat refused the message (${r.status}).`);
}

// Stops the same SKU being posted twice within a minute (double clicks).
const guardKey = (sku) => new Request("https://pull-guard.invalid/" + encodeURIComponent(sku));
async function recentlyPosted(sku) {
  return !!(await caches.default.match(guardKey(sku)));
}
async function markPosted(sku) {
  await caches.default.put(guardKey(sku), new Response("1", { headers: { "cache-control": "max-age=60" } }));
}

// Bins for the crew message: the product's Skustack bins that hold stock (read-only).
async function skustackBins(env, sku) {
  try {
    const { bins } = await productBins(env, sku);
    const list = bins.filter((b) => b.qty > 0).slice(0, 5);
    return list.length ? list : null;
  } catch {
    return null; // bins are a bonus; the message still goes out without them
  }
}

async function pullRequest(env, { sku, qty, note }) {
  needCompany(env);
  const found = await scGet(env, "/catalog", { SKU: [sku], pageNumber: 1, pageSize: 5 });
  const product = (found.Items || []).find((p) => String(p.ID ?? p.ProductID) === sku) || (found.Items || [])[0];
  if (!product) throw new HttpError(404, "No product with this SKU in Sellercloud.");
  if (!companyMatches(env, product))
    throw new HttpError(409, `This SKU belongs to ${product.CompanyName || "another company"}, not WAREHOUSE.`);
  const available = await countedQty(env, sku);
  const bins = await skustackBins(env, sku);
  if (await recentlyPosted(sku)) throw new HttpError(429, "This SKU was already posted in the last minute.");
  const lines = [
    "*Please bring to the production room*",
    product.ProductName || sku,
    `SKU: ${sku}`,
    qty ? `Qty needed: ${qty}` : null,
    `Available in Skustack: ${available}`,
    bins && bins.length
      ? "Bins: " + bins.map((b) => `${b.bin} (${b.qty})`).join(", ")
      : null,
    note ? `Note: ${note}` : null,
  ].filter(Boolean);
  await markPosted(sku); // mark first so a fast double click doesn't post twice
  try {
    await postToChat(env, lines.join("\n"));
  } catch (e) {
    await caches.default.delete(guardKey(sku)).catch(() => {});
    throw e;
  }
  return { posted: true, sku, qty: qty || null, available, bins: bins || [] };
}

// ---------------------------------------------------------------------------------------------
// Kit assembly (Sellercloud's SOAP web service, the same calls as Sellercloud's SellerHub app).
//
// SWITCHED OFF until ASSEMBLE_ENABLED is set to the Text value "yes". While it's off, the only
// SOAP calls the worker makes are reads (GetCurrentUser, ProductKit_GetKitDetails, the WSDL list).
// The one call that changes stock, ProductKit_Assemble_New_4, is only reachable through
// POST /assemble, which also needs ASSEMBLE_KEY, and is limited to:
//   - ASSEMBLE_WAREHOUSE (default 3232 = Skustack Warehouse), nothing else;
//   - kits under the WAREHOUSE company that have a recipe in Sellercloud;
//   - at most ASSEMBLE_MAX_QTY kits per press (default 1, for the first test);
//   - enough of every part in that warehouse (otherwise it's blocked with a message);
//   - one assembly per monday item (itemId), plus a one-minute double-click guard.
// After assembling it reads the stock again and only reports done when it really moved.
// ---------------------------------------------------------------------------------------------

const xmlEsc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
const xmlUnesc = (s) => String(s).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const tagAll = (xml, name) => [...xml.matchAll(new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${name}>`, "g"))].map((m) => m[1]);
const tag1 = (xml, name) => { const a = tagAll(xml, name); return a.length ? xmlUnesc(a[0].trim()) : null; };

async function soapUrl(env) {
  if (env.SC_SOAP_URL) return env.SC_SOAP_URL.trim();
  const host = new URL(await getBase(env)).hostname; // e.g. lgd.api.sellercloud.com
  const code = host.split(".")[0];
  return `https://${code}.ws.sellercloud.com/scservice.asmx`;
}

// Read-only SOAP calls the worker may make. Nothing here adjusts, sets, transfers or adds stock.
const SOAP_READS = new Set(["GetCurrentUser", "ProductKit_GetKitDetails", "ProductWarehouseBin_ListAll_New", "WarehouseBin_ListAll"]);
const SOAP_ASSEMBLE = "ProductKit_Assemble_New_4";
const SOAP_DISASSEMBLE = "ProductKit_Disassemble_New3";
// Removes the small 0.1 leftover from the From bin after an assembly (found on Shragy's server via /soapops?q=bin).
const SOAP_ADJUST = "WarehouseBin_AdjustQtyByName_WithReason";

async function soapCall(env, op, bodyXml) {
  const stockOp = op === SOAP_ASSEMBLE || op === SOAP_DISASSEMBLE || op === SOAP_ADJUST;
  if (!SOAP_READS.has(op) && !stockOp) throw new HttpError(500, `SOAP call ${op} is not allowed.`);
  if (stockOp && !assembleOn(env)) throw new HttpError(403, "Kit assembly is switched off.");
  if (!env.SC_USERNAME || !env.SC_PASSWORD) throw new HttpError(500, "SC_USERNAME or SC_PASSWORD is not set.");
  const off = ["AlwaysRecalculateWeight", "CalculateWeightIgnoreZeroWeightProducts", "AllowAnyProductShippingMethods",
    "FetchUserDefinedColumnsForProducts", "FetchUserDefinedColumnsForOrder", "SkipBundleItemQtyUpdating", "DoNotGetClientUser",
    "SkipCWAShippingRules", "DontIncludePORMAImages", "IncludeClientUserAddressBook", "SaveOrderPackageDimensions",
    "IncludeClientUserDocuments", "IncludeOrderTargetInfo", "IncludeWalmartOrderSpecificData", "SkipProductMetadata",
    "IncludePODetails", "IncludeShippingSuggestions", "UseOptimizedProductLoading", "CreateNewProducts", "SplitItems",
    "PaymentNotNeeded", "DoNotDownloadImageData", "BulkWipeRelationships", "BulkDeleteShadows", "BulkResetOffsetQty",
    "UseCache", "DontNeedCompanyProfile"].map((k) => `<${k}>false</${k}>`).join("");
  const envelope = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
<soap:Header><AuthHeader xmlns="http://api.sellercloud.com/"><UserName>${xmlEsc(env.SC_USERNAME)}</UserName><Password>${xmlEsc(env.SC_PASSWORD)}</Password><ValidateDeviceID>false</ValidateDeviceID></AuthHeader><ServiceOptions xmlns="http://api.sellercloud.com/">${off}</ServiceOptions></soap:Header>
<soap:Body><${op} xmlns="http://api.sellercloud.com/">${bodyXml}</${op}></soap:Body>
</soap:Envelope>`;
  const send = async () => {
    // Reads wait and try again when Sellercloud says "too many requests"; stock calls never repeat on their own.
    for (let attempt = 0; ; attempt++) {
      if (!stockOp) await waitIfBusy();
      subrequests++; scCalls++;
      const r = await fetch(await soapUrl(env), {
        method: "POST",
        headers: { "content-type": "text/xml; charset=utf-8", SOAPAction: `"http://api.sellercloud.com/${op}"` },
        body: envelope,
      });
      if (r.status === 409 || r.status === 429) {
        const said = (tag1(await r.text().catch(() => ""), "faultstring") || "").slice(0, 200);
        noteRefusal(op, r.status, said, r);
        const ms = busyWait(r, attempt, said);
        noteBusy(ms);
        if (!stockOp && attempt < 6 && Date.now() + ms < deadline) { await sleep(ms); continue; }
        throw busyError(r.status, op, said, r);
      }
      const text = await r.text();
      const fault = tag1(text, "faultstring");
      if (fault) throw new HttpError(502, `Sellercloud said: ${fault.slice(0, 300)}`);
      if (!r.ok) throw new HttpError(502, `Sellercloud ${op} failed (${r.status}).`);
      return text;
    }
  };
  return stockOp ? send() : cachedRead("soap", op + "|" + bodyXml, readTtl("soap", op), send);
}

const assembleOn = (env) => (env.ASSEMBLE_ENABLED || "").trim().toLowerCase() === "yes";
const assembleWarehouse = (env) => Number((env.ASSEMBLE_WAREHOUSE || "3232").trim());
// Shragy, Nov 19: the break-down puts the 0.1 units into one 0.1 bin, and the assembly takes them from there.
const bridgeBinName = (env) => String(env.BRIDGE_BIN || "0.1oz_Bulk_Bin").trim();
const assembleMax = (env) => Math.max(1, parseInt(env.ASSEMBLE_MAX_QTY || "1", 10) || 1);

let cachedUserId = null;
async function scUserId(env) {
  if (cachedUserId != null) return cachedUserId;
  const xml = await soapCall(env, "GetCurrentUser", "");
  const id = parseInt(tag1(xml, "UserID") || "", 10);
  if (!Number.isFinite(id)) throw new HttpError(502, "Sellercloud didn't return the user's ID.");
  return (cachedUserId = id);
}

async function kitRecipe(env, sku) {
  const xml = await soapCall(env, "ProductKit_GetKitDetails", `<KitParentProductID>${xmlEsc(sku)}</KitParentProductID>`);
  return tagAll(xml, "KitItemDetail").map((d) => ({
    sku: tag1(d, "ChildProductId"),
    perKit: Number(tag1(d, "Qty")) || 0,
  })).filter((p) => p.sku && p.perKit > 0);
}

// Tiny XML reader: turns a SOAP reply into a tree of { name, kids, text }.
function xmlTree(xml) {
  const root = { name: "#root", kids: [], text: "" };
  const stack = [root];
  const re = /<(\/?)([\w.:-]+)[^>]*?(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(xml))) {
    const top = stack[stack.length - 1];
    if (m[4] !== undefined) { top.text += m[4]; continue; }
    if (m[2].startsWith("?") || m[0].startsWith("<?") || m[0].startsWith("<!")) continue;
    const name = m[2].includes(":") ? m[2].split(":").pop() : m[2];
    if (m[1]) { if (stack.length > 1) stack.pop(); continue; }
    const node = { name, kids: [], text: "" };
    top.kids.push(node);
    if (!m[3]) stack.push(node);
  }
  return root;
}
const kid = (n, ...names) => {
  for (const want of names) {
    const k = n.kids.find((c) => c.name.toLowerCase() === want.toLowerCase());
    if (k) return xmlUnesc(k.text.trim());
  }
  return null;
};

// Bins of one product in the assembly warehouse, with qty, read from Sellercloud's
// ProductWarehouseBin_ListAll_New (a read). Returns { bins: [{bin, qty, physical, sellable}], raw }.
async function productBins(env, sku) {
  const xml = await soapCall(env, "ProductWarehouseBin_ListAll_New",
    `<ProductIdentifier>${xmlEsc(sku)}</ProductIdentifier><WarehouseID>${assembleWarehouse(env)}</WarehouseID>`);
  const bins = [];
  const walk = (n) => {
    const name = kid(n, "BinName", "Name");
    const hasBin = n.kids.some((c) => /^binname$/i.test(c.name));
    if (hasBin && name) {
      // Sellercloud's reply (checked Nov 19) gives BinName, BinID and QtyAvailable per bin;
      // it has no physical qty or sellable flag per bin.
      const avail = kid(n, "QtyAvailable", "AvailableQty", "Qty", "Quantity", "BinQty");
      bins.push({ bin: name, binId: kid(n, "BinID"), qty: num(avail) });
      return;
    }
    n.kids.forEach(walk);
  };
  walk(xmlTree(xml));
  bins.sort((a, b) => b.qty - a.qty);
  return { bins, raw: xml };
}

// The SOAP service's own list of calls (WSDL), kept for the life of the worker instance.
let wsdlCache = null;
async function wsdlText(env) {
  if (wsdlCache) return wsdlCache;
  subrequests++;
  const r = await fetch((await soapUrl(env)) + "?WSDL");
  if (!r.ok) throw new HttpError(502, `Couldn't read the SOAP service list (${r.status}).`);
  return (wsdlCache = await r.text());
}
const wsdlOpNames = (wsdl) => [...new Set([...wsdl.matchAll(/<wsdl:operation name="([^"]+)"/g)].map((m) => m[1]))];
// One SOAP call's input fields from Sellercloud's own WSDL: name, type, minOccurs, nillable.
const opFieldsMemo = new Map();
async function opFields(env, op) {
  if (opFieldsMemo.has(op)) return opFieldsMemo.get(op);
  const wsdl = await wsdlText(env);
  // indexOf, not a regex over the whole WSDL: the WSDL is large and a regex per call ran out of CPU (Nov 19).
  const open = `<s:element name="${op}">`;
  const a = wsdl.indexOf(open);
  const b = a < 0 ? -1 : wsdl.indexOf("</s:element>", a);
  const inner = a < 0 || b < 0 ? "" : wsdl.slice(a + open.length, b);
  const out = [...inner.matchAll(/<s:element\b([^>]*)\/?>/g)].map((x) => {
    const at = x[1], g = (k) => (at.match(new RegExp(`\\b${k}="([^"]+)"`)) || [])[1] || null;
    return { name: g("name"), type: (g("type") || "").replace(/^\w+:/, ""), minOccurs: g("minOccurs"), nillable: g("nillable") };
  }).filter((x) => x.name);
  opFieldsMemo.set(op, out);
  return out;
}
// The expiry date sent with a stock change (disassemble, bin adjust). SellerHub sent "now", which stamps the
// new units as expiring at once, so by the assembly they're already expired (a suspect for the Nov 19 assemble
// failure). Now: EXPIRY_DATE (Text, optional) if set; else no date when Sellercloud's WSDL lets the field be left
// out or empty; else a far-future date.
async function expiryXml(env, op) {
  const fixed = String(env.EXPIRY_DATE || "").trim();
  if (fixed) return `<ExpiryDate>${xmlEsc(fixed)}</ExpiryDate>`;
  const f = (await opFields(env, op).catch(() => [])).find((x) => x.name === "ExpiryDate");
  if (f && f.minOccurs === "0") return "";
  if (f && f.nillable === "true") return `<ExpiryDate xsi:nil="true" />`;
  return `<ExpiryDate>2099-12-31T00:00:00</ExpiryDate>`;
}
// Builds a SOAP call's body in the exact order and with every field Sellercloud's own WSDL lists for it.
// Sellercloud's page fills fields our old body left out (Nov 19: its assembly carried a serial), and a left-out
// text field reaches Sellercloud as null, which fits its "Object reference not set". Known values come from
// `known` (matched by name, any case); fields we don't know get a safe default: a new serial for serial
// fields, `note` for note/comment/reason fields, empty text, 0, false, or the expiry rule for dates.
// Returns { xml, filled: [{name, value, how}] }. If the WSDL can't be read, sends `known` as given.
const newSerial = () => { const a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", b = crypto.getRandomValues(new Uint8Array(10)); return [...b].map((x) => a[x % a.length]).join(""); };
async function wsdlBody(env, op, known, note) {
  const fields = await opFields(env, op).catch(() => []);
  const k = Object.fromEntries(Object.entries(known).map(([n, v]) => [n.toLowerCase(), v]));
  if (!fields.length) return { xml: Object.entries(known).map(([n, v]) => `<${n}>${v && typeof v === "object" && "raw" in v ? v.raw : xmlEsc(v)}</${n}>`).join(""), filled: [], fromWsdl: false };
  const filled = [];
  let xml = "";
  for (const f of fields) {
    const lc = f.name.toLowerCase(), t = (f.type || "").toLowerCase();
    if (lc in k) {
      const v = k[lc];
      if (v && typeof v === "object" && "raw" in v) { xml += `<${f.name}>${v.raw}</${f.name}>`; filled.push({ name: f.name, value: v.show || v.raw, how: "ours" }); }
      else { xml += `<${f.name}>${xmlEsc(v)}</${f.name}>`; filled.push({ name: f.name, value: String(v), how: "ours" }); }
      continue;
    }
    let v, how = "default";
    if (t === "datetime") {
      const fixed = String(env.EXPIRY_DATE || "").trim();
      if (!fixed && f.minOccurs === "0") { filled.push({ name: f.name, value: "(left out)", how }); continue; }
      if (!fixed && f.nillable === "true") { xml += `<${f.name} xsi:nil="true" />`; filled.push({ name: f.name, value: "(empty)", how }); continue; }
      v = fixed || "2099-12-31T00:00:00";
    } else if (/serial/.test(lc) && t === "string") { v = newSerial(); how = "new serial"; }
    else if (/note|comment|reason|memo/.test(lc) && t === "string") v = note || "";
    else if (t === "string") v = "";
    else if (t === "boolean") v = "false";
    else if (/^(int|long|short|decimal|double|float|unsignedint|unsignedlong)$/.test(t)) v = "0";
    else if (f.minOccurs === "0") { filled.push({ name: f.name, value: "(left out)", how: "unknown type " + f.type }); continue; }
    else throw new HttpError(500, `Sellercloud's ${op} needs ${f.name} (${f.type}), which I don't know how to fill. Nothing was sent.`);
    xml += `<${f.name}>${xmlEsc(v)}</${f.name}>`;
    filled.push({ name: f.name, value: v, how });
  }
  return { xml, filled, fromWsdl: true };
}
// Every field of every bin row in a ProductWarehouseBin_ListAll_New reply (lot, expiry and the rest), read-only.
function binRowsAll(xml) {
  const rows = [];
  const walk = (n) => {
    if (n.kids.some((c) => /^binname$/i.test(c.name))) {
      rows.push(Object.fromEntries(n.kids.filter((c) => !c.kids.length).map((c) => [c.name, xmlUnesc(c.text.trim())])));
      return;
    }
    n.kids.forEach(walk);
  };
  walk(xmlTree(xml));
  return rows;
}
// All bin names in the assembly warehouse, for typing a From or To bin with suggestions.
// Sellercloud's WarehouseBin_ListAll(WarehouseID) (a read; confirmed live Nov 19, 788 bins in 3232).
// Disabled bins are left out. Kept for 10 minutes.
let binListCache = null; // { at, names, raw }
async function warehouseBinNames(env) {
  if (binListCache && Date.now() - binListCache.at < 10 * 60 * 1000) return binListCache;
  const wh = assembleWarehouse(env);
  const xml = await soapCall(env, "WarehouseBin_ListAll", `<WarehouseID>${wh}</WarehouseID>`);
  const names = new Set();
  const walk = (n) => {
    const name = kid(n, "BinName");
    if (name) {
      const whId = kid(n, "WarehouseID");
      if ((whId == null || Number(whId) === wh) && !/^true$/i.test(kid(n, "IsDisabled") || "")) names.add(name);
      return;
    }
    n.kids.forEach(walk);
  };
  walk(xmlTree(xml));
  binListCache = { at: Date.now(), names: [...names].sort((a, b) => a.localeCompare(b)), raw: xml };
  return binListCache;
}

// The bin's exact name in the assembly warehouse, or a clear 409 if it isn't there.
// Nov 19: an assemble into a To bin Sellercloud didn't know failed with a bare "Object reference not set".
async function realBin(env, name, role) {
  const list = await warehouseBinNames(env);
  const hit = list.names.find((n) => n === name) || list.names.find((n) => n.toLowerCase() === name.toLowerCase());
  if (!hit) throw new HttpError(409, `${role} bin ${name} isn't a bin in Skustack Warehouse. Create it in Sellercloud or pick another bin.`);
  return hit;
}

// Qty of one product in the assembly warehouse.
async function whQty(env, sku) {
  const wh = assembleWarehouse(env);
  const data = await scGet(env, "/Inventory/Warehouses", { productID: sku, warehouseID: wh });
  const row = (Array.isArray(data) ? data : data ? [data] : []).find((w) => Number(w.WarehouseID) === wh) || {};
  return { available: num(row.AvailableQty), physical: num(row.PhysicalQty) };
}

async function assemblePreview(env, sku, qty, fromBin = "") {
  needCompany(env);
  if (!sku) throw new HttpError(400, "Add ?sku=... (the kit's SKU).");
  if (!(qty > 0)) throw new HttpError(400, "Add ?qty=... (how many kits).");
  const found = await scGet(env, "/catalog", { SKU: [sku], pageNumber: 1, pageSize: 5 });
  const product = (found.Items || []).find((p) => String(p.ID ?? p.ProductID) === sku);
  if (!product) throw new HttpError(404, `No product with SKU ${sku} in Sellercloud.`);
  if (!companyMatches(env, product))
    throw new HttpError(409, `${sku} belongs to ${product.CompanyName || "another company"}, not WAREHOUSE.`);
  const recipe = await kitRecipe(env, sku);
  const problems = [];
  if (!recipe.length) problems.push(`${sku} has no kit recipe in Sellercloud, so it can't be assembled.`);
  const parts = [];
  await pool(recipe, 2, async (p) => {
    const q = await whQty(env, p.sku);
    let bins = null;
    try { bins = (await productBins(env, p.sku)).bins; } catch (e) { if (e.busy) throw e; bins = null; }
    parts.push({ sku: p.sku, perKit: p.perKit, need: round3(p.perKit * qty), available: q.available, physical: q.physical, bins });
  });
  parts.sort((a, b) => a.sku.localeCompare(b.sku));
  const binsRead = parts.length > 0 && parts.every((p) => Array.isArray(p.bins));
  for (const p of parts) {
    if (fromBin && Array.isArray(p.bins)) {
      const b = p.bins.find((x) => x.bin.toLowerCase() === fromBin.toLowerCase());
      p.inFromBin = b ? b.qty : 0;
    }
    // The From bin is the signal when it can be read: Sellercloud shows the warehouse total late (Nov 19: the bin
    // showed 200 new 0.1 units while Skustack's total still said 0), so a full bin isn't blocked by a lagging total.
    const binOk = p.inFromBin != null && p.inFromBin >= p.need;
    p.enough = binOk || p.available >= p.need;
    if (p.inFromBin != null && !binOk) problems.push(`Not enough ${p.sku} in bin ${fromBin}: need ${p.need}, the bin has ${p.inFromBin}.`);
    else if (!p.enough) problems.push(`Not enough ${p.sku}: need ${p.need}, Skustack has ${p.available}.`);
  }
  // The kit's own bins (for picking the To bin), read-only.
  let kitBins = null;
  try { kitBins = (await productBins(env, sku)).bins.map((b) => ({ bin: b.bin, qty: b.qty })); } catch (e) { if (e.busy) throw e; kitBins = null; }
  // A bin that already holds enough of every part, if there is one.
  let suggestedFromBin = null;
  if (binsRead && parts.length) {
    const names = new Set(parts[0].bins.map((b) => b.bin));
    for (const name of names)
      if (parts.every((p) => (p.bins.find((b) => b.bin === name)?.qty || 0) >= p.need)) { suggestedFromBin = name; break; }
  }
  if (qty > assembleMax(env)) problems.push(`At most ${assembleMax(env)} kit${assembleMax(env) === 1 ? "" : "s"} per press for now.`);
  return {
    kit: sku, name: product.ProductName ?? null, qty, warehouseId: assembleWarehouse(env),
    parts, ok: problems.length === 0, problems,
    fromBin: fromBin || null, binsRead, suggestedFromBin, kitBins,
    binNote: binsRead ? null : "Couldn't read bin qty from Sellercloud, so only the warehouse total was checked.",
    assemblyOn: assembleOn(env), maxQty: assembleMax(env),
  };
}

const binName = (s) => {
  const v = String(s || "").trim();
  if (!v) throw new HttpError(400, "Both bins are needed: fromBin (where the parts are) and toBin (for the kits).");
  if (v.length > 60 || /[<>&]/.test(v)) throw new HttpError(400, "That bin name doesn't look right.");
  return v;
};
const doneKey = (itemId) => new Request("https://sellercloud-link.internal/assembled/" + encodeURIComponent(itemId));

// ---- Run records that must last (Nov 19: cookies and cream was assembled 3 × 500) ----
// Every record that says "this was already sent to Sellercloud" (assembly, disassemble, the saved split, emptied
// stock) lives in KV (the TOKEN_KV binding), never only in Cloudflare's cache: the cache is per location and can
// drop entries, so a later call that ran elsewhere saw no record and assembled again. Without KV, nothing that moves
// stock runs. Records never expire or delete themselves; only POST /assemble/clear (Shragy's press) clears an item.
// An old record still in the cache counts too.
let RUN_KV = null;
const needKv = () => new HttpError(503, "Kit runs are off until a KV namespace is bound to this worker as TOKEN_KV (Workers KV). It keeps each run's records so one press can never assemble twice. Nothing was sent.");
const durKey = (req) => "run:" + new URL(req.url).pathname;
const durable = {
  async match(req) {
    if (!RUN_KV) throw needKv();
    const v = await RUN_KV.get(durKey(req));
    if (v != null) return new Response(v);
    return (await caches.default.match(req).catch(() => null)) || undefined;
  },
  async put(req, resp, ttlSecs) { // ttlSecs only for short "a call is busy" locks; run records never expire
    if (!RUN_KV) throw needKv();
    await RUN_KV.put(durKey(req), typeof resp === "string" ? resp : await resp.text(), ttlSecs ? { expirationTtl: Math.max(60, ttlSecs) } : {});
  },
  async delete(req) {
    if (!RUN_KV) throw needKv();
    await RUN_KV.delete(durKey(req));
    await caches.default.delete(req).catch(() => {});
  },
};

// The assemble call's body: our values, plus Sellercloud's other fields filled the way wsdlBody says.
// Sellercloud's assemble call needs the kit's parts listed in kitItemsDetails (KitItemToAssembleDetail:
// KitItemProductId, AssembleFromWarehouseID, ReplacementSKU, KitQty, from Shragy's WSDL Nov 19). Our old body,
// like SellerHub's, left the list out, and Sellercloud failed with "Object reference not set" walking it.
async function assembleBody(env, { sku, qty, fromBin, toBin, userId, itemId, parts }) {
  const wh = assembleWarehouse(env);
  for (const p of parts) if (!Number.isInteger(Math.round(p.perKit * 1e6) / 1e6)) throw new HttpError(409, `${p.sku} is ${p.perKit} per kit in ${sku}'s kit, but Sellercloud's assembly takes whole units only. Nothing was sent.`);
  // KitQty is the part's TOTAL for the whole assembly, not per kit (Nov 19, cookies and cream: 500 kits sent with
  // KitQty 161 took 161 units in all). So it's always per kit × kits.
  const items = parts.map((p) => ({ sku: p.sku, kitQty: Math.round(p.perKit) * qty }));
  const raw = items.map((p) => `<KitItemToAssembleDetail><KitItemProductId>${xmlEsc(p.sku)}</KitItemProductId>` +
    `<AssembleFromWarehouseID>${wh}</AssembleFromWarehouseID><ReplacementSKU></ReplacementSKU><KitQty>${p.kitQty}</KitQty></KitItemToAssembleDetail>`).join("");
  return wsdlBody(env, SOAP_ASSEMBLE, {
    KitParentProductID: sku, QtyToAssemble: qty, AssembleIntoWarehouseID: wh,
    OriginalBinName: fromBin, DestinationBinName: toBin, AssemblyUserID: userId, FBAShipmentID: 0, WorkOrderID: 0,
    kitItemsDetails: { raw, show: items.map((p) => `${p.sku} × ${p.kitQty} from warehouse ${wh}`).join("; ") },
  }, itemId ? `Production (monday item ${itemId})` : "Production");
}

async function assembleKit(env, body) {
  if (!assembleOn(env)) throw new HttpError(403, "Kit assembly is switched off. It turns on once ASSEMBLE_ENABLED is set to yes.");
  const sku = String(body.sku || "").trim();
  const qty = parseInt(body.qty, 10);
  const itemId = String(body.itemId || "").trim();
  if (!itemId) throw new HttpError(400, "itemId (the monday item) is needed so a production is only assembled once.");
  const fromBin = await realBin(env, binName(body.fromBin), "From"), toBin = await realBin(env, binName(body.toBin), "To");
  if (!RUN_KV) throw needKv();
  if (await durable.match(doneKey(itemId)))
    throw new HttpError(409, "This production was already sent for assembly. Check Sellercloud before trying again.");

  const pre = await assemblePreview(env, sku, qty, fromBin);
  // This run's units per kit (bin total ÷ kits), sent to Sellercloud as each part's KitQty instead of the recipe's.
  // Only for a one-part kit; the stock check below confirms Sellercloud took exactly that many.
  const each = body.eachPerKit != null ? Number(body.eachPerKit) : null;
  if (each != null) {
    if (!Number.isInteger(each) || each < 1) throw new HttpError(400, "eachPerKit must be a whole number, 1 or more.");
    if (pre.parts.length !== 1) throw new HttpError(409, `${sku}'s kit has ${pre.parts.length} parts; a per-run qty only works for a one-part kit.`);
    const p = pre.parts[0];
    p.recipePerKit = p.perKit; p.perKit = each; p.need = each * qty;
    pre.problems = pre.problems.filter((x) => !x.startsWith(`Not enough ${p.sku}`));
    if (p.inFromBin != null ? p.inFromBin < p.need : p.available < p.need)
      pre.problems.push(`Not enough ${p.sku} in bin ${fromBin}: need ${p.need}, the bin has ${p.inFromBin ?? p.available}.`);
    pre.ok = pre.problems.length === 0;
  }
  if (!pre.ok) throw new HttpError(409, pre.problems.join(" "));
  // If the Hub says which kit it set up (source part and qty per kit), the recipe must be exactly that.
  if (body.source || body.perKit != null) {
    const want = String(body.source || "").trim().toLowerCase(), per = Number(body.perKit);
    const r = pre.parts;
    if (!(r.length === 1 && r[0].sku.toLowerCase() === want && Math.abs((r[0].recipePerKit ?? r[0].perKit) - per) < 0.0005))
      throw new HttpError(409, `${sku}'s kit in Sellercloud isn't ${body.source} × ${body.perKit} per kit, so I didn't assemble. Set up the kit again first.`);
  }
  // Lock this production before the call, so a double click can't assemble twice.
  // Parts are counted in the From bin when it can be read (the warehouse total can lag behind it), else by total.
  const partsBy = pre.parts.every((p) => p.inFromBin != null) ? "bin" : "total";
  const partQty = async (p) => partsBy === "bin" ? await binQtyOf(env, p.sku, fromBin) : (await whQty(env, p.sku)).physical;
  const before = { kit: await whQty(env, sku), parts: Object.fromEntries(pre.parts.map((p) => [p.sku, partsBy === "bin" ? p.inFromBin : p.physical])) };
  // The record keeps the "before" numbers, so a later call can still confirm an assembly Sellercloud showed late.
  const saveDone = (confirmed) => durable.put(doneKey(itemId), new Response(JSON.stringify({ sku, qty, kitBefore: before.kit.physical,
    parts: pre.parts.map((p) => ({ sku: p.sku, before: before.parts[p.sku], need: p.need })), partsBy, fromBin, at: Date.now(), confirmed }), { headers: { "cache-control": "max-age=2592000" } }));
  await saveDone(false);
  const userId = await scUserId(env);
  let reply = null, callError = null, sent = null;
  try {
    sent = await assembleBody(env, { sku, qty, fromBin, toBin, userId, itemId, parts: pre.parts });
    // Exactly one assemble call per record, never a second one in any path (Nov 19: an error reply can still
    // have assembled, and Sellercloud shows stock late, so "nothing moved" can't be trusted right after).
    const xml = await soapCall(env, SOAP_ASSEMBLE, sent.xml);
    reply = tag1(xml, SOAP_ASSEMBLE + "Result");
  } catch (e) {
    callError = e.message || String(e);
  }

  // Check whether stock really moved, whatever the reply said. Sellercloud can take a while to show it
  // (Nov 19: the 0.1 units showed only after a refresh), so read again for up to about a minute.
  let after, kitUp, partsOk, moved;
  for (let i = 0; i < 16; i++) {
    after = { kit: await whQty(env, sku), parts: {} };
    await pool(pre.parts, 6, async (p) => { after.parts[p.sku] = await partQty(p); });
    kitUp = after.kit.physical - before.kit.physical;
    partsOk = pre.parts.every((p) => Math.abs(before.parts[p.sku] - after.parts[p.sku] - p.need) < 0.0005);
    moved = kitUp === qty && partsOk;
    if (moved || (callError && i >= 1) || timeUp()) break;
    await sleep(4000);
  }
  const nothing = kitUp === 0 && pre.parts.every((p) => before.parts[p.sku] === after.parts[p.sku]);
  // Sellercloud made the kits but took its recipe's qty per kit, not this run's: it doesn't take a per-run qty.
  const p0 = pre.parts[0];
  const recipeUsed = each != null && !moved && kitUp === qty && p0.recipePerKit !== each
    && Math.abs(before.parts[p0.sku] - after.parts[p0.sku] - p0.recipePerKit * qty) < 0.0005;
  if (recipeUsed) {
    await durable.put(doneKey(itemId), new Response(JSON.stringify({ sku, qty, confirmed: true, recipeUsed: true, at: Date.now() }), { headers: { "cache-control": "max-age=2592000" } }));
    return { done: false, status: "recipe used", kit: sku, qty, fromBin, toBin,
      message: `Sellercloud assembled ${qty} × ${sku} but used its recipe of ${p0.recipePerKit} ${p0.sku} per kit, not the ${each} sent for this run, so it doesn't take a per-run qty. ${after.parts[p0.sku]} ${p0.sku} are still in bin ${fromBin}. I stopped there.`,
      parts: [{ sku: p0.sku, sent: each, used: p0.recipePerKit, before: before.parts[p0.sku], after: after.parts[p0.sku] }] };
  }
  // The record stays even when nothing seems to have moved: only Shragy's clear allows another try.
  if (moved) await saveDone(true);
  if (!moved && !callError && timeUp())
    return { done: false, continue: true, status: "assemble not confirmed", message: `Sent the assembly of ${qty} × ${sku}. Waiting for Sellercloud to show it.`,
      kit: sku, qty, fromBin, toBin, sent: sent?.filled, retriedWithTotals: sent?.retriedWithTotals || null, sellercloudReply: reply, error: null, kitBefore: before.kit.physical, kitAfter: after.kit.physical };
  return {
    done: moved,
    status: moved ? "assembled" : nothing ? (callError ? "failed" : "no stock change") : "partly changed",
    message: moved
      ? `Assembled ${qty} × ${sku} in Skustack, from bin ${fromBin} to bin ${toBin}.`
      : nothing && callError
        ? `Not assembled. ${callError}`
        : "Not confirmed. Stock didn't change the way it should. Check Sellercloud before trying again.",
    kit: sku, qty, fromBin, toBin, sent: sent?.filled, retriedWithTotals: sent?.retriedWithTotals || null, sellercloudReply: reply, error: callError,
    kitBefore: before.kit.physical, kitAfter: after.kit.physical,
    parts: pre.parts.map((p) => ({ sku: p.sku, need: p.need, before: before.parts[p.sku], after: after.parts[p.sku] })),
  };
}

const round3 = (x) => Math.round(x * 1000) / 1000;

async function findProduct(env, sku) {
  const found = await scGet(env, "/catalog", { SKU: [sku], pageNumber: 1, pageSize: 5 });
  return (found.Items || []).find((p) => String(p.ID ?? p.ProductID) === sku) || null;
}

// The fields of one SOAP data type and their types, from the service's own WSDL.
function wsdlTypeFields(wsdl, type) {
  const m = wsdl.match(new RegExp(`<s:complexType name="${type.replace(/[^\w]/g, "")}">([\\s\\S]*?)</s:complexType>`));
  if (!m) return [];
  return [...m[1].matchAll(/<s:element\b([^>]*)\/?>/g)].map((x) => ({
    name: (x[1].match(/\bname="([^"]+)"/) || [])[1] || null,
    type: ((x[1].match(/\btype="([^"]+)"/) || [])[1] || "").replace(/^\w+:/, "") || null,
  })).filter((x) => x.name);
}

// A kit's current parts, with names. Read-only.
async function kitDefinition(env, sku) {
  needCompany(env);
  if (!sku) throw new HttpError(400, "Add ?sku=... (the product's SKU).");
  const product = await findProduct(env, sku);
  if (!product) return { sku, exists: false, name: null, isKit: false, components: [] };
  if (!companyMatches(env, product))
    throw new HttpError(409, `${sku} belongs to ${product.CompanyName || "another company"}, not WAREHOUSE.`);
  let recipe = [], kitError = null;
  // A busy answer is passed on (the Hub retries), so it never reads as "this product has no kit parts".
  try { recipe = await kitRecipe(env, sku); } catch (e) { if (e.busy) throw e; kitError = e.message || String(e); }
  const components = [];
  await pool(recipe, 2, async (c) => {
    let name = null;
    try { name = (await findProduct(env, c.sku))?.ProductName ?? null; } catch { name = null; }
    components.push({ sku: c.sku, name, perKit: c.perKit });
  });
  components.sort((a, b) => a.sku.localeCompare(b.sku));
  return { sku, exists: true, name: product.ProductName ?? null, productType: product.ProductTypeName ?? product.ProductType ?? null,
    isKit: components.length > 0, components, sellercloudSaid: kitError };
}

// The 0.1 oz "bridge" product for a source product, read-only. Looks at the source's own kit parts first
// (a source set up as a kit of its 0.1 product), then searches the catalog by the name without its size.
const isBridgeName = (n) => /\b0\.1\s*oz\b|\)?0\.1oz/i.test(String(n || ""));
const baseName = (n) => String(n || "")
  .replace(/\s*\b(bulk\s+by\s+(the\s+)?lbs?|bulk)\b.*$/i, "")
  .replace(/\s*\d+(\.\d+)?\s*(oz|lbs?|ct|pc|pcs|count)\b.*$/i, "")
  .trim();
async function bridgeFor(env, sku) {
  const source = await kitDefinition(env, sku);
  if (!source.exists) throw new HttpError(404, `No product with SKU ${sku} in Sellercloud.`);
  const fromKit = source.components.filter((c) => isBridgeName(c.sku) || isBridgeName(c.name));
  const base = baseName(source.name || sku);
  let candidates = [];
  if (base) {
    const companyId = warehouseCompanyId(env);
    const data = await scGet(env, "/catalog", { Keyword: base, companyID: companyId ? [companyId] : undefined, pageNumber: 1, pageSize: 50 });
    candidates = (data.Items || []).filter((p) => companyMatches(env, p))
      .map((p) => ({ sku: String(p.ID ?? p.ProductID), name: p.ProductName ?? null }))
      .filter((p) => isBridgeName(p.sku) || isBridgeName(p.name));
  }
  return {
    sku, name: source.name, isKit: source.isKit, components: source.components, sellercloudSaid: source.sellercloudSaid,
    bridgeInKit: fromKit, searchedFor: base, bridgeCandidates: candidates.slice(0, 10),
  };
}

// ---- Production plan for the 0.1 logic (READ-ONLY: it checks each step and changes nothing) ----
// 1 unit of a 0.1 product = 0.1 oz. 1 lb = 160 units, 10 oz = 100, 8 oz = 80.
const normName = (n) => String(n || "").toLowerCase().replace(/[^a-z0-9.]/g, "").replace(/\./g, "");
// One assembly per run (Shragy, Nov 19: "its 1 assemble and its ok if a few 0.1 stays left over"): every kit takes
// the whole number of 0.1 units the bin allows (bin total ÷ kits, rounded down). [{kits, perKit}], or null if under 1.
// The produce step still takes a list, so a later split stays possible.
function spreadUnits(total, n) {
  const base = Math.floor(Math.round(total) / n);
  return base < 1 ? null : [{ kits: n, perKit: base }];
}
const isByPound = (n) => /\bby\s+(the\s+)?lbs?\b/i.test(String(n || ""));
function sizeFromName(n) {
  const m = String(n || "").match(/(\d+(?:\.\d+)?)\s*(oz|lbs?)\b/i);
  if (!m) return null;
  const v = Number(m[1]), lb = /^lb/i.test(m[2]);
  const units = lb ? v * 160 : v * 10;
  return { text: m[0], oz: lb ? v * 16 : v, units: round3(units), whole: Math.abs(units - Math.round(units)) < 1e-9 };
}
// A size typed in the Hub: "16oz", "2 lb", or a plain number of ounces.
function sizeTyped(v) {
  const t = String(v ?? "").trim();
  if (!t) return null;
  if (/^\d+(\.\d+)?$/.test(t)) return sizeFromName(t + "oz");
  return sizeFromName(t);
}
// Is this catalog name the 0.1 product of a source with this base name? (spaces and dots ignored)
function bridgeMatch(base, cand) {
  const b = normName(base), c = normName(cand.sku), n = normName(cand.name);
  const forms = [b + "01oz", b + "01ozbulk", b + "bulk01oz"];
  return forms.some((f) => c === f || n === f || (cand.sku.length >= 50 && c.length >= 20 && f.startsWith(c)));
}

// A run that has started keeps its own per-kit number (saved with its groups), passed in as runPerKit.
const runPer = (q) => { const n = Number(q?.runPerKit); return Number.isInteger(n) && n > 0 ? n : null; };
// The final kit step: ready when Sellercloud's recipe already shows this run's qty per kit, "to change" when the
// final is already a kit of that part at another qty (the recipe is changed before the assembly), "to set" when it
// has no kit yet, "different" when it's a kit of something else.
function finalKitStep(cur, partSku, perKit, size, unit) {
  const onPart = cur.length === 1 && cur[0].sku.toLowerCase() === String(partSku).toLowerCase();
  const want = perKit != null ? { sku: partSku, perKit } : null;
  const u = unit === "lb" ? " lb" : "";
  if (onPart && want && cur[0].perKit === perKit)
    return { step: "final kit", state: "ready", current: cur, want, size, summary: `Kit recipe already ${perKit}${u} of ${partSku} per kit.` };
  if (onPart && want)
    return { step: "final kit", state: "to change", current: cur, want, size, recipeFrom: cur[0].perKit, recipeTo: perKit,
      summary: `Set kit recipe ${cur[0].perKit} → ${perKit}${u} of ${partSku} per kit.` };
  return { step: "final kit", state: cur.length ? "different" : "to set", current: cur, want, size,
    summary: !cur.length && want ? `Set the kit recipe to ${perKit}${u} of ${partSku} per kit.` : null };
}

async function productionPlan(env, q) {
  needCompany(env);
  const sourceSku = String(q.source || "").trim(), finalSku = String(q.final || "").trim();
  const fromBin = String(q.fromBin || "").trim();
  const produced = Number(q.produced);
  if (!sourceSku) throw new HttpError(400, "source (the production's Sellercloud SKU) is needed.");
  if (!finalSku) throw new HttpError(400, "final (the final listing's SKU) is needed.");
  if (sourceSku.toLowerCase() === finalSku.toLowerCase()) throw new HttpError(400, "The source and the final listing can't be the same SKU.");
  if (!Number.isInteger(produced) || produced < 1) throw new HttpError(400, "produced must be a whole number, 1 or more.");

  const problems = [], steps = [];
  const source = await kitDefinition(env, sourceSku);
  if (!source.exists) throw new HttpError(404, `No product with SKU ${sourceSku} in Sellercloud.`);
  const final = await kitDefinition(env, finalSku);
  if (!final.exists) problems.push(`${finalSku} isn't a product in Sellercloud. Create it there first.`);
  // A kit read that failed must never look like "no kit yet" (that would set a new kit over an existing one).
  for (const d of [source, final])
    if (d.exists && d.sellercloudSaid && !/is not a kit/i.test(d.sellercloudSaid)) problems.push(`Couldn't read ${d.sku}'s kit parts from Sellercloud (${d.sellercloudSaid}). Try again in a minute.`);

  let binQty = null;
  if (fromBin) {
    const { bins } = await productBins(env, sourceSku);
    binQty = (bins.find((b) => b.bin.toLowerCase() === fromBin.toLowerCase()) || {}).qty || 0;
  } else problems.push("Pick the From bin.");

  // The final's size says what was made: the size typed in the Hub, else read from the final SKU, then its name.
  const finalSize = sizeTyped(q.finalSize) || sizeFromName(finalSku) || sizeFromName(final.name);
  const flags = { needFinalSize: false, needSourceSize: false };
  // By the pound: the source itself must be in the From bin. (Pre-sized checks this below.)
  const noSourceInBin = fromBin && !(binQty > 0);

  // A by-lb source goes through the 0.1 route like any other (1 lb = 160 units), so each kit can take
  // bin total ÷ qty produced (Shragy, Nov 19; cookies and cream 1 lb = 0.1oz × 160). That includes a final with
  // no kit yet: it's set as 160 × the source's 0.1 product. The whole-pound route (the final as a kit of the pound
  // product itself) is only for a final that's already set up that way in Sellercloud.
  const finalBridge = final.components.length === 1 && (isBridgeName(final.components[0].sku) || isBridgeName(final.components[0].name))
    ? final.components[0] : null;
  const finalOnPound = final.components.length === 1 && final.components[0].sku.toLowerCase() === sourceSku.toLowerCase();
  if (isByPound(source.name || sourceSku) && finalOnPound) {
    if (noSourceInBin) problems.push(`Bin ${fromBin} has no ${sourceSku}.`);
    const lbs = finalSize && /lb/i.test(finalSize.text) ? finalSize.oz / 16 : null;
    const want = lbs && Number.isInteger(lbs) ? lbs : null;
    if (!want) { flags.needFinalSize = true; problems.push(`Size not clear for ${finalSku}. Enter the size in whole pounds.`); }
    const cur = final.components;
    // Same rule as the 0.1 route (Shragy, Nov 19, for every kit run): one assembly, each kit takes bin total ÷ qty
    // produced, rounded down to whole pounds; what's left stays in the bin. More than PRODUCE_MAX_DIFF_PCT
    // (default 10%) off the recipe blocks.
    const maxDiff = Math.max(1, Number(env.PRODUCE_MAX_DIFF_PCT || 10) || 10);
    if (cur.length && !(cur.length === 1 && cur[0].sku.toLowerCase() === sourceSku.toLowerCase()))
      problems.push(`${finalSku} is already a kit of ${cur.map((c) => `${c.sku} × ${c.perKit}`).join(", ")}, not of ${sourceSku}.`);
    const lbGroups = want && binQty > 0 ? spreadUnits(binQty, produced) : null;
    const per = lbGroups ? lbGroups[0].perKit : null;
    const need = per != null ? per * produced : null, left = need != null ? binQty - need : null;
    if (want && binQty > 0 && !lbGroups) problems.push(`${produced} kits need at least ${produced} lb of ${sourceSku}; bin ${fromBin} has ${binQty}.`);
    else if (per != null && Math.abs(per - want) / want * 100 > maxDiff)
      problems.push(`The numbers don't match: bin ${fromBin} has ${binQty} lb for ${produced} kits, ${per} lb each, ${Math.round(Math.abs(per - want) / want * 100)}% off the size of ${want} lb. More than ${maxDiff}% off blocks. Check the qty produced and the bin.`);
    // Whole pounds can round a lot away, so the pounds left over count too (the 0.1 route leaves under 1 unit a kit).
    else if (left != null && left / need * 100 > maxDiff)
      problems.push(`The numbers don't match: ${left} lb of the ${binQty} in bin ${fromBin} would be left over after ${produced} kits of ${per} lb, more than ${maxDiff}%. Check the qty produced and the bin.`);
    // Shragy, Nov 19: the kit's recipe in Sellercloud shows this run's real qty per kit, changed before each run.
    const lbPer = runPer(q) ?? per ?? want;
    steps.push(finalKitStep(cur, sourceSku, lbPer, want, "lb"));
    steps.push({ step: "assemble", qty: produced, uses: need, from: sourceSku, perKitRecipe: lbPer, perKitSize: want, perKitActual: per, groups: lbGroups,
      leftover: left, leftoverStays: true,
      summary: need != null ? `${produced} kits × ${per} lb each (size ${want} lb), ${need} of the ${binQty} lb in the bin` + (left ? `; ${left} lb of ${sourceSku} stay in bin ${fromBin}.` : ".") : null });
    if (produced > assembleMax(env)) problems.push(`At most ${assembleMax(env)} kit${assembleMax(env) === 1 ? "" : "s"} per press for now.`);
    for (const st of steps) st.action = actionFor(st);
    return { mode: "by pound", ...flags, source: { sku: sourceSku, name: source.name }, final: { sku: finalSku, name: final.name, size: finalSize },
      perFinal: lbPer, perSize: want, fromBin: fromBin || null, binQty, produced, steps, problems, ok: problems.length === 0,
      assemblyOn: assembleOn(env), maxQty: assembleMax(env) };
  }

  // Pre-sized: source -> 0.1 product -> final.
  // Step 1: the 0.1 product. The source's own kit part comes first, then a name match.
  const br = await bridgeFor(env, sourceSku);
  const kitBridge = br.bridgeInKit.length === 1 && source.components.length === 1 ? br.bridgeInKit[0] : null;
  const matches = br.bridgeCandidates.filter((c) => bridgeMatch(br.searchedFor, c));
  let bridge = null, bridgeState;
  if (kitBridge) { bridge = { sku: kitBridge.sku, name: kitBridge.name }; bridgeState = "found (source's kit part)"; }
  else if (finalBridge && !source.components.length) { bridge = { sku: finalBridge.sku, name: finalBridge.name }; bridgeState = "found (final's kit part)"; }
  else if (matches.length === 1) { bridge = matches[0]; bridgeState = "found (name match)"; }
  else if (matches.length > 1) { bridgeState = "unsure: more than one match"; problems.push(`More than one 0.1 product could be ${sourceSku}'s: ${matches.map((m) => m.sku).join(", ")}.`); }
  else {
    bridgeState = "to create";
    const newSku = newBridgeSku(br.searchedFor || sourceSku);
    if (!newSku) problems.push(`Couldn't make a 0.1 SKU from ${source.name || sourceSku}.`);
    else {
      const taken = await findProduct(env, newSku);
      if (taken) { bridgeState = "unsure: SKU taken"; problems.push(`${newSku} already exists in Sellercloud but doesn't look like ${sourceSku}'s 0.1 product. Check it.`); }
      else bridge = { sku: newSku, name: newSku, isNew: true };
    }
  }
  steps.push({ step: "0.1 product", state: bridgeState, sku: bridge?.sku ?? null, name: bridge?.name ?? null,
    searchedFor: br.searchedFor, otherNames: br.bridgeCandidates.filter((c) => !bridge || c.sku !== bridge.sku).slice(0, 5) });

  // Step 2: the source as a kit of N units of the 0.1 product. An existing kit's qty wins over the name.
  // The source's units come from its own kit (N × 0.1 product). Without one: the size typed in the Hub,
  // else the size in the source SKU or name (Shragy, Nov 19: fine for this step only; the final's size never comes from here).
  const srcSize = kitBridge ? null : sizeTyped(q.sourceSize) || sizeFromName(sourceSku) || sizeFromName(source.name)
    || (isByPound(source.name || sourceSku) ? sizeFromName("1 lb") : null); // "bulk by lb": 1 unit of it = 1 lb = 160 units of 0.1
  let units = kitBridge ? kitBridge.perKit : srcSize && srcSize.whole ? srcSize.units : null;
  if (!kitBridge && source.components.length)
    problems.push(`${sourceSku} is already a kit of ${source.components.map((c) => `${c.sku} × ${c.perKit}`).join(", ")}, not of a 0.1 product.`);
  else if (!kitBridge && !srcSize) { flags.needSourceSize = true; problems.push(`${sourceSku} isn't set up with its 0.1 product yet. Size not clear for ${sourceSku}. Enter its size (for example 10oz).`); }
  else if (srcSize && !srcSize.whole) problems.push(`${srcSize.text} isn't a whole number of 0.1 oz units (${srcSize.units}).`);
  // Sellercloud won't make a product that has stock into a kit (Shragy tried by hand, Nov 19). So when the source
  // kit is still to set and the source has stock, it's emptied to zero first and the exact qty put back after
  // (Shragy's way, Nov 19: every later move stays a real disassemble and assembly).
  const srcKitToSet = !kitBridge && !source.components.length;
  let srcStock = null;
  if (srcKitToSet) {
    srcStock = await sourceStock(env, sourceSku);
    if (srcStock.problem) problems.push(srcStock.problem);
    else if (srcStock.bins.length)
      steps.push({ step: "empty source", sku: sourceSku, bins: srcStock.bins, total: srcStock.total, warehouse: assembleWarehouse(env) });
  }
  steps.push({ step: "source kit", state: kitBridge ? "ready" : source.components.length ? "different" : "to set",
    current: source.components, want: units != null && bridge ? { sku: bridge.sku, perKit: units } : null, sizeTyped: srcSize });
  if (srcStock && !srcStock.problem && srcStock.bins.length)
    steps.push({ step: "put back source", sku: sourceSku, bins: srcStock.bins, total: srcStock.total, warehouse: assembleWarehouse(env) });

  // Step 3: disassemble all of the source in the From bin into the 0.1 bin (BRIDGE_BIN, default 0.1oz_Bulk_Bin).
  // Shragy, Nov 19: a run uses only the 0.1 units its own break-down made, never other stock of that 0.1 product
  // already in the bin. Once a run has broken down, its saved record (q.runDis) gives its units.
  const bBin = bridgeBinName(env);
  const runDis = q.runDis && Number(q.runDis.units) > 0 ? q.runDis : null;
  if (fromBin && !runDis && !(binQty > 0)) problems.push(`Bin ${fromBin} has no ${sourceSku}.`);
  const fromSource = runDis ? Number(runDis.units) : binQty > 0 ? (units != null ? binQty * units : null) : 0;
  const unitsOut = runDis ? fromSource : binQty == null ? null : fromSource;
  steps.push(runDis
    ? { step: "disassemble", qty: runDis.qty, from: sourceSku, unitsOut: fromSource, into: bBin, done: true,
        summary: `Broke down ${runDis.qty} ${sourceSku} into ${fromSource} units of ${bridge?.sku || "0.1"} in bin ${bBin}.` }
    : { step: "disassemble", qty: binQty, from: sourceSku, unitsOut: fromSource, into: bBin,
        summary: binQty > 0 && fromSource != null ? `Break down ${binQty} ${sourceSku} from bin ${fromBin} into ${fromSource} units of ${bridge?.sku || "0.1"} in bin ${bBin}.` : null });

  // Step 4: the final as a kit of its size in 0.1 units. An existing kit's qty wins over the name.
  // The 10% check always compares with the final's size (typed, else in its SKU or name: 16 oz = 160), not with
  // its kit's recipe, which now changes every run (Shragy, Nov 19). Only a final with no size anywhere falls back
  // to its current recipe.
  const fc = final.components;
  const finalOnBridge = !!bridge && fc.length === 1 && fc[0].sku.toLowerCase() === bridge.sku.toLowerCase();
  const v = finalSize && finalSize.whole ? finalSize.units : finalOnBridge && !finalSize ? fc[0].perKit : null;
  if (fc.length && !finalOnBridge) problems.push(`${finalSku} is already a kit of ${fc.map((c) => `${c.sku} × ${c.perKit}`).join(", ")}, not of the 0.1 product.`);
  if (v == null) {
    flags.needFinalSize = true;
    problems.push(finalSize && !finalSize.whole
      ? `Size not clear for ${finalSku}: ${finalSize.text} isn't a whole number of 0.1 oz units. Enter the size.`
      : `Size not clear for ${finalSku}. Enter the size.`);
  }

  // Step 5: assemble. Shragy, Nov 19: the bin goes into the kits produced ("take the total used and divide it
  // into how much was produced"), so each kit takes bin total ÷ qty produced, more or less than the recipe,
  // rounded down to whole units in one assembly; the few units left stay in the bin as the 0.1 product.
  // A wildly wrong number (more than PRODUCE_MAX_DIFF_PCT, default 10%, off the recipe) still blocks.
  let groups = null, each = null;
  const maxDiff = Math.max(1, Number(env.PRODUCE_MAX_DIFF_PCT || 10) || 10);
  if (v != null && unitsOut != null && unitsOut > 0) {
    each = Math.floor(unitsOut / produced);
    groups = spreadUnits(unitsOut, produced);
    const diff = Math.abs(each - v) / v * 100;
    if (!groups) problems.push(`The bin gives ${unitsOut} units of 0.1, not enough for ${produced} kits.`);
    else if (diff > maxDiff)
      problems.push(`The numbers don't match: the bin gives ${unitsOut} units of 0.1 for ${produced} kits, ${each} each, ${Math.round(diff)}% off the size (${v} per kit). More than ${maxDiff}% off blocks. Check the qty produced and the bin.`);
  }
  const per = groups ? groups[0].perKit : null;
  const left = groups ? unitsOut - groups.reduce((t, g) => t + g.kits * g.perKit, 0) : null;
  // Step 4: the final as a kit of the 0.1 product, at this run's real units per kit (Shragy, Nov 19: "its importent
  // fro me to see the trie numbers"). Set before the assembly; skipped when Sellercloud already shows that number.
  // Once a run has started, its saved per-kit number counts (the bin changes after the break-down and assembly).
  const kitPer = runPer(q) ?? per ?? v;
  if (bridge) steps.push(finalKitStep(fc, bridge.sku, kitPer, v, "0.1"));
  else steps.push({ step: "final kit", state: "to set", current: fc, want: null, size: finalSize });
  // Shragy, Nov 19 ("yes i want that to happen"): the few 0.1 units left after the assembly are removed from the
  // From bin with one adjustment that names the run, once the assembly is confirmed.
  steps.push({ step: "assemble", qty: produced, uses: groups ? unitsOut - left : null, perKitRecipe: kitPer, perKitSize: v, perKitActual: per, groups,
    fromBin: bBin,
    summary: groups ? `${produced} kits × ${per} units of 0.1 each (size ${v}), ${unitsOut - left} of this run's ${unitsOut}, taken from bin ${bBin}` +
      (left ? `; then the ${left} left over are removed.` : ".") : null,
    leftover: left, leftoverStays: false });
  if (left > 0)
    steps.push({ step: "empty leftover", sku: bridge?.sku ?? null, bin: bBin, qty: left,
      summary: `Remove this run's ${left} leftover ${bridge?.sku || "0.1"} from bin ${bBin} after assembling (adjustment, reason names the run); other stock in the bin stays.` });

  if (produced > assembleMax(env)) problems.push(`At most ${assembleMax(env)} kit${assembleMax(env) === 1 ? "" : "s"} per press for now.`);
  for (const st of steps) st.action = actionFor(st);
  return { mode: "pre-sized", ...flags, source: { sku: sourceSku, name: source.name, productType: source.productType }, final: { sku: finalSku, name: final.name },
    bridge, units, perFinal: kitPer, perSize: v, fromBin: fromBin || null, bridgeBin: bBin, binQty, produced, steps, problems, ok: problems.length === 0,
    assemblyOn: assembleOn(env), maxQty: assembleMax(env) };
}

// The source's stock, for emptying it before it becomes a kit: every bin in the assembly warehouse with stock,
// and a problem when stock sits anywhere it can't be emptied and put back exactly (another warehouse, or stock
// in the warehouse that isn't in a bin, e.g. reserved for orders).
async function sourceStock(env, sku) {
  const wh = assembleWarehouse(env);
  const data = await scGet(env, "/Inventory/Warehouses", { productID: sku });
  const rows = (Array.isArray(data) ? data : data ? [data] : []).map((w) => ({
    id: Number(w.WarehouseID ?? 0), name: w.WarehouseName ?? null, physical: num(w.PhysicalQty), available: num(w.AvailableQty),
  }));
  const elsewhere = rows.filter((r) => r.id !== wh && (r.physical !== 0 || r.available !== 0));
  if (elsewhere.length)
    return { bins: [], total: 0, problem: `${sku} has stock outside Skustack (${elsewhere.map((r) => `${r.name || "warehouse " + r.id}: ${r.physical}`).join(", ")}). It must be at 0 everywhere to become a kit, and I only empty Skustack bins. Move it first.` };
  const here = rows.find((r) => r.id === wh) || { physical: 0, available: 0 };
  const bins = (await productBins(env, sku)).bins.filter((b) => b.qty !== 0).map((b) => ({ bin: b.bin, qty: b.qty }));
  const total = bins.reduce((a, b) => a + b.qty, 0);
  if (bins.some((b) => b.qty < 0) || total !== here.physical || total !== here.available)
    return { bins: [], total: 0, problem: `${sku}'s stock in Skustack doesn't add up (physical ${here.physical}, available ${here.available}, in bins ${total}). It may be reserved for orders. I won't empty it; check it in Sellercloud.` };
  return { bins, total, problem: null };
}
// Physical and available qty of one product in every warehouse.
async function warehouseTotals(env, sku) {
  const data = await scGet(env, "/Inventory/Warehouses", { productID: sku });
  return (Array.isArray(data) ? data : data ? [data] : []).map((w) => ({
    id: Number(w.WarehouseID ?? 0), name: w.WarehouseName ?? null, physical: num(w.PhysicalQty), available: num(w.AvailableQty),
  }));
}
async function binQtyOf(env, sku, bin) {
  return ((await productBins(env, sku)).bins.find((b) => b.bin.toLowerCase() === bin.toLowerCase()) || {}).qty || 0;
}
// One bin adjustment by +/- qty with a reason, then the bin read back. Returns { before, after, ok, error }.
async function adjustBinBy(env, sku, bin, qty, reason, waits = 10) {
  const before = await binQtyOf(env, sku, bin);
  let error = null;
  try {
    await soapCall(env, SOAP_ADJUST,
      `<ProductId>${xmlEsc(sku)}</ProductId><BinName>${xmlEsc(bin)}</BinName>` +
      `<WarehouseID>${assembleWarehouse(env)}</WarehouseID><Qty>${qty}</Qty>` +
      `<reason>${xmlEsc(reason)}</reason>` +
      `<SerialsList></SerialsList>${await expiryXml(env, SOAP_ADJUST)}<LotNumber></LotNumber>`);
  } catch (e) { error = e.message || String(e); }
  // Sellercloud can show bin changes late, so read again for up to ~40 s before deciding.
  let after = await binQtyOf(env, sku, bin);
  for (let i = 0; i < waits && after - before !== qty && !(error && i >= 1) && !timeUp(); i++) { await sleep(4000); after = await binQtyOf(env, sku, bin); }
  return { before, after, ok: after - before === qty, error };
}

// What a step will do: "skip" when it's already in place, otherwise what gets done.
function actionFor(st) {
  if (st.step === "0.1 product") return st.state.startsWith("found") ? "skip" : st.state === "to create" ? "create" : "stop";
  if (st.step === "source kit" || st.step === "final kit") return st.state === "ready" ? "skip" : st.state === "to set" || st.state === "to change" ? "set" : "stop";
  if (st.step === "empty leftover") return st.qty > 0 ? "adjust" : "skip";
  if (st.step === "empty source") return "zero";
  if (st.step === "put back source") return "restore";
  if (st.step === "disassemble") return st.done ? "skip" : st.qty > 0 ? "disassemble" : "skip";
  return st.step; // disassemble / assemble
}
// New 0.1 SKU: the source name without its size + " 0.1oz", the style already in the catalog, at most 50 characters.
function newBridgeSku(base) {
  const b = String(base || "").replace(/\s+/g, " ").trim();
  if (!b) return null;
  return (b.slice(0, 50 - 6).trim() + " 0.1oz");
}

// ---- Writes for the 0.1 flow. Each runs only on a press in the Hub (POST, ASSEMBLE_KEY). ----
// The one REST write path besides sign-in: creating the 0.1 product and the Kits import (kit parts only, never stock).
const SC_POST_ALLOWED = new Set(["/Products", "/Catalog/Imports/Kits"]);
async function scPost(env, path, body) {
  if (!SC_POST_ALLOWED.has(path)) throw new HttpError(500, `POST ${path} is not allowed.`);
  const base = await getBase(env);
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getToken(env, base);
    subrequests++; scCalls++;
    const r = await fetch(base + path, {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
    if (r.status === 401 && attempt === 0) { await dropToken(env); continue; }
    const text = await r.text();
    if (!r.ok) throw new HttpError(502, `Sellercloud ${path} failed (${r.status}). ${text.slice(0, 300)}`);
    try { return JSON.parse(text); } catch { return { raw: text }; }
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (str) => { let bin = ""; for (const b of new TextEncoder().encode(str)) bin += String.fromCharCode(b); return btoa(bin); };
// Kits import rows, the columns Sellercloud's own SellerHub app sends. Independent: the kit keeps its own
// stock and is filled by assembling (Sellercloud only assembles and disassembles Independent kits).
function kitCsv(rows) {
  const q = (v) => '"' + String(v).replace(/"/g, '""') + '"';
  return [["ParentSKU", "ChildSKU", "QTY", "Sequence", "InventoryDependantOption"],
    ...rows.map((r) => [r.kit, r.part, String(r.perKit), "1", "Independent"])].map((r) => r.map(q).join(",")).join("\n");
}
// The Kits import answers with the queued job's id: a bare number, or an object holding it.
function importJobId(res) {
  if (typeof res === "number" && Number.isFinite(res)) return res;
  if (typeof res === "string" && /^\d+$/.test(res.trim())) return Number(res.trim());
  if (res && typeof res === "object") {
    const v = res.ID ?? res.Id ?? res.id ?? res.JobID ?? res.JobId ?? res.QueuedJobID ?? res.QueuedJobId ?? (typeof res.raw === "string" && /^\d+$/.test(res.raw.trim()) ? res.raw.trim() : null);
    if (v != null && /^\d+$/.test(String(v))) return Number(v);
  }
  return null;
}
async function kitJob(env, jobId) {
  const data = await scGet(env, "/QueuedJobs", { jobID: jobId });
  const job = (data.Items || data.items || [])[0];
  if (!job) return { found: false, done: false, error: null, said: "" };
  // Whatever the job says about itself (status, messages), for the Hub to show when a kit didn't save.
  const said = Object.entries(job).filter(([k, v]) => /status|message|error|result|note/i.test(k) && v != null && v !== "" && typeof v !== "object")
    .map(([k, v]) => `${k}: ${String(v).replace(/\s+/g, " ").slice(0, 200)}`).join("; ").slice(0, 400);
  return { found: true, done: !!job.CompletedOn, error: job.ErrorMessage || null, said };
}
const lockKey = (kind, id) => new Request(`https://sellercloud-link.internal/${kind}/` + encodeURIComponent(String(id).toLowerCase()));
const isLocked = async (kind, id) => !!(await durable.match(lockKey(kind, id)));
const lock = (kind, id, secs) => durable.put(lockKey(kind, id), "1", secs); // secs 0: until Shragy clears it
const unlock = (kind, id) => durable.delete(lockKey(kind, id)).catch(() => {});

// One Kits import for one kit, then the kit read back (the import is a queued job, so parts can show up late).
async function importKit(env, r, polls, reads = 11) {
  const res = await scPost(env, "/Catalog/Imports/Kits", {
    Format: 1, FileContents: b64(kitCsv([r])), FileExtension: ".csv", Metadata: { OverwriteExistingKits: false },
  });
  const jobId = importJobId(res);
  const reply = JSON.stringify(res ?? null).slice(0, 200);
  let job = { done: false, error: null, said: "" };
  if (jobId) for (let i = 0; i < polls && !job.done; i++) { await sleep(3000); job = await kitJob(env, jobId).catch(() => job); }
  if (job.error) return { ok: false, jobId, reply, jobError: String(job.error), jobSaid: job.said };
  const check = async () => {
    let got = [], readError = null;
    try { got = await kitRecipe(env, r.kit); } catch (e) { readError = e.message || String(e); }
    const ok = got.length === 1 && got[0].sku.toLowerCase() === r.part.toLowerCase() && got[0].perKit === r.perKit;
    return { ok, got, readError };
  };
  let c = await check();
  // Sellercloud can mark the job done and still show no parts for a while (Test2 16oz, job 2398462: saved, but read
  // back empty for ~20 s). So keep reading for up to ~45 s, and treat "still no parts" as not yet, never as failed.
  for (let i = 0; i < reads && !c.ok && !c.got.length; i++) { await sleep(4000); c = await check(); }
  return { ok: c.ok, jobId, reply, jobDone: job.done, jobSaid: job.said, got: c.got, readError: c.readError };
}
function kitFail(r, k) {
  if (k.jobError) return { saved: false, jobId: k.jobId, error: `Setting ${r.kit}: Sellercloud said: ${k.jobError.slice(0, 300)}` };
  if (!k.got.length)
    return { saved: false, pending: true, jobId: k.jobId, sellercloudReply: k.reply, message: `Sellercloud hasn't shown ${r.kit}'s kit yet. It can take a minute. Press Run again; finished steps are skipped.` };
  return { saved: false, jobId: k.jobId, sellercloudReply: k.reply,
    error: `${r.kit} reads back as ${k.got.map((x) => `${x.sku} × ${x.perKit}`).join(", ") || "no parts"}, not ${r.part} × ${r.perKit}.${k.readError ? " " + k.readError.slice(0, 200) : ""}${k.jobId ? ` (import job ${k.jobId})` : ""}` };
}
// Put back what was emptied out of each bin. Returns { done: [...], failed: [{bin, qty, now}] }.
async function putBack(env, sku, bins, reason) {
  const out = { done: [], failed: [] };
  for (const b of bins) {
    if (!(b.qty > 0)) continue;
    const a = await adjustBinBy(env, sku, b.bin, b.qty, reason);
    if (a.ok) out.done.push(b);
    else out.failed.push({ bin: b.bin, qty: b.qty, now: a.after, error: a.error });
  }
  return out;
}
// An earlier press that emptied the source and stopped before putting it back: put it back first.
async function recoverEmptied(env, sku) {
  const hit = await durable.match(lockKey("zeroed", sku));
  if (!hit) return null;
  let bins = [];
  try { bins = JSON.parse(await hit.text()); } catch { bins = []; }
  const todo = [];
  for (const b of bins) {
    const now = await binQtyOf(env, sku, b.bin);
    if (now === 0) todo.push(b);
    else if (now !== b.qty) return { failed: [{ bin: b.bin, qty: b.qty, now }], done: [], unclear: true };
  }
  const back = await putBack(env, sku, todo, `Put back after an earlier kit setup of ${sku} stopped`);
  if (!back.failed.length) await durable.delete(lockKey("zeroed", sku)).catch(() => {});
  return back;
}

// Press 1: create the 0.1 product and set the two kits, only where missing.
// Nov 19 (Test3): one long call was cut off between setting the source kit and putting its stock back. So setup now
// runs in short steps. Each call does what it can in about 20 s and answers { continue: true } while there's more;
// the Hub calls again a few seconds later. What's in progress is kept in two records, saved in the worker's cache
// AND echoed to the Hub as `state` (the Hub sends it back), so a later call always knows what to put back:
//   zeroed/<source>: { bins: [{bin, qty}], at }   the source's stock taken out to make it a kit
//   kitjob/<kit>:    { jobId, at, part, perKit }    a Kits import sent and waiting to show
// Every put-back is checked bin by bin: a bin at 0 gets its qty back, a bin already at its qty is left alone.
const KIT_WAIT_MS = 120000;   // how long a kit may take to show after its import
const ZERO_WAIT_MS = 120000;  // how long the source may take to show 0 everywhere after emptying
const recKey = (kind, id) => lockKey(kind, id);
async function recGet(kind, id, body) {
  const hit = await durable.match(recKey(kind, id)).catch(() => null);
  if (hit) { try { const v = JSON.parse(await hit.text()); return Array.isArray(v) ? { bins: v, at: 0 } : v; } catch { /* fall through */ } }
  const fromHub = body?.state?.[kind]?.[String(id).toLowerCase()];
  return fromHub && typeof fromHub === "object" ? fromHub : null;
}
async function recSet(kind, id, val, out) {
  await durable.put(recKey(kind, id), new Response(JSON.stringify(val), { headers: { "cache-control": "max-age=2592000" } })).catch(() => {});
  out[kind] = out[kind] || {}; out[kind][String(id).toLowerCase()] = val;
}
async function recDel(kind, id, out) {
  await durable.delete(recKey(kind, id)).catch(() => {});
  out[kind] = out[kind] || {}; out[kind][String(id).toLowerCase()] = null;
}
// Put back what was taken out, checking each bin first. { done, failed, unclear }
async function putBackChecked(env, sku, bins, reason) {
  const todo = [];
  for (const b of bins) {
    const now = await binQtyOf(env, sku, b.bin);
    if (now === 0) todo.push(b);
    else if (now !== b.qty) return { done: [], failed: [{ bin: b.bin, qty: b.qty, now }], unclear: true };
  }
  const back = await putBack(env, sku, todo, reason);
  return { ...back, unclear: false };
}

// A production that has started keeps the per-kit number it was planned with (saved with its groups), so the
// kit recipe isn't changed again from a bin that has already been broken down or assembled.
async function withRunPer(body) {
  const itemId = String(body?.itemId || "").trim();
  if (!itemId || !RUN_KV) return body;
  const out = { ...body };
  const dis = await durable.match(lockKey("disrec", itemId)).catch(() => null);
  if (dis) { try { const d = JSON.parse(await dis.text()); if (d && d.units > 0) out.runDis = d; } catch {} }
  const hit = await durable.match(lockKey("groups", itemId)).catch(() => null);
  if (hit) { try { const g = JSON.parse(await hit.text()); if (Array.isArray(g) && g.length === 1 && g[0].perKit > 0) out.runPerKit = g[0].perKit; } catch {} }
  return out;
}
async function setupProduction(env, body) {
  if (!RUN_KV) throw needKv();
  // One setup call at a time per final kit, so two quick presses can't both empty the source.
  const key = String(body.final || body.source || "").trim();
  if (key && (await isLocked("setupcall", key))) return { saved: false, continue: true, message: "Still working on the last step.", state: body.state || {} };
  if (key) await lock("setupcall", key, 60);
  try { return await setupStep(env, await withRunPer(body)); } finally { if (key) await unlock("setupcall", key); }
}
async function setupStep(env, body) {
  if (!assembleOn(env)) throw new HttpError(403, "Sellercloud writes are switched off. They turn on once ASSEMBLE_ENABLED is set to yes.");
  const state = {};   // records changed in this call, echoed to the Hub
  const sourceSku = String(body.source || "").trim();
  const tag = `monday item ${String(body.itemId || "").slice(0, 40) || "?"}`;
  const reply = (r) => ({ ...r, state: mergeState(body.state, state) });

  // 1. The source was emptied to make it a kit: carry that on until its stock is back.
  const zeroed = sourceSku ? await recGet("zeroed", sourceSku, body) : null;
  if (zeroed && Array.isArray(zeroed.bins)) {
    const job = await recGet("kitjob", sourceSku, body);
    const want = job ? { kit: sourceSku, part: job.part, perKit: job.perKit } : null;
    const finish = async (extra) => {
      const back = await putBackChecked(env, sourceSku, zeroed.bins, `Put back after setting ${sourceSku} up as a kit (${tag})`);
      if (back.failed.length)
        return reply({ saved: false, critical: true, error: `IMPORTANT: ${sourceSku} isn't back in full. Put back by hand: ${back.failed.map((f) => `bin ${f.bin} should have ${f.qty}, shows ${f.now}`).join(", ")}.`, putBack: back });
      await recDel("zeroed", sourceSku, state);
      await recDel("kitjob", sourceSku, state);
      return reply({ ...extra, putBack: back });
    };
    // Kit already showing: put the stock back and carry on with the rest.
    const got = await kitRecipe(env, sourceSku).catch(() => []);
    if (got.length) {
      const ok = want ? got.length === 1 && got[0].sku.toLowerCase() === want.part.toLowerCase() && got[0].perKit === want.perKit : true;
      return finish(ok
        ? { saved: false, continue: true, message: `${sourceSku} is now a kit. Put its stock back; carrying on.` }
        : { saved: false, error: `${sourceSku} reads back as ${got.map((x) => `${x.sku} × ${x.perKit}`).join(", ")}, not what was sent. Its stock was put back. Check its Kit tab.` });
    }
    if (!job) {
      // Wait for every warehouse to show 0, then send the kit.
      const totals = await warehouseTotals(env, sourceSku);
      const left = totals.filter((w) => w.physical !== 0 || w.available !== 0);
      if (left.length) {
        if (Date.now() - (zeroed.at || 0) > ZERO_WAIT_MS)
          return finish({ saved: false, error: `Sellercloud still showed ${sourceSku} with stock after emptying (${left.map((w) => `${w.name || "warehouse " + w.id}: physical ${w.physical}, available ${w.available}`).join("; ")}), so I didn't set the kit. Its stock was put back.` });
        return reply({ saved: false, continue: true, message: `Emptied ${sourceSku}. Waiting for Sellercloud to show it at 0.` });
      }
      const plan = await productionPlan(env, body);
      const st = plan.steps.find((x) => x.step === "source kit");
      if (!st?.want) return finish({ saved: false, error: `Couldn't tell what ${sourceSku}'s kit should be. Its stock was put back.` });
      const r = { kit: sourceSku, part: st.want.sku, perKit: st.want.perKit };
      const sent = await sendKit(env, r);
      if (sent.error) return finish({ saved: false, error: `Setting ${sourceSku}: ${sent.error} Its stock was put back.` });
      await recSet("kitjob", sourceSku, { jobId: sent.jobId, at: Date.now(), part: r.part, perKit: r.perKit }, state);
      return reply({ saved: false, continue: true, message: `Sent ${sourceSku}'s kit to Sellercloud. Waiting for it to show.` });
    }
    // Kit sent, not showing yet.
    const j = job.jobId ? await kitJob(env, job.jobId).catch(() => ({})) : {};
    if (j.error) return finish({ saved: false, error: `Sellercloud didn't set ${sourceSku} as a kit. Its stock was put back. Import job ${job.jobId} said: ${String(j.error).slice(0, 300)}` });
    if (Date.now() - (job.at || 0) < KIT_WAIT_MS) return reply({ saved: false, continue: true, message: `Waiting for Sellercloud to show ${sourceSku}'s kit.` });
    return finish({ saved: false, pending: true, message: `Sellercloud hadn't shown ${sourceSku}'s kit after 2 minutes, so its stock was put back.${j.said ? ` Import job ${job.jobId}: ${j.said.slice(0, 200)}.` : ""} Check its Kit tab in a minute, then press Run again; finished steps are skipped.` });
  }

  // 2. Nothing in progress for the source: work from the plan.
  const plan = await productionPlan(env, body);
  const blocking = plan.problems.filter((p) => !/^Bin .* has no |^Pick the From bin|kits need .* bin|kits need .* units|At most \d+ kit|^The numbers don't match|^The bin gives/.test(p));
  if (blocking.length) return reply({ saved: false, error: blocking.join(" "), plan });
  const todo = plan.steps.filter((x) => ["create", "set"].includes(x.action));

  // A kit (without stock) already sent: wait for it to show.
  for (const x of plan.steps.filter((y) => (y.step === "source kit" || y.step === "final kit") && y.action === "set")) {
    const kit = x.step === "source kit" ? plan.source.sku : plan.final.sku;
    const job = await recGet("kitjob", kit, body);
    if (!job) continue;
    const j = job.jobId ? await kitJob(env, job.jobId).catch(() => ({})) : {};
    if (j.error) { await recDel("kitjob", kit, state); return reply({ saved: false, error: `Setting ${kit}: Sellercloud said: ${String(j.error).slice(0, 300)}`, plan }); }
    if (Date.now() - (job.at || 0) < KIT_WAIT_MS) return reply({ saved: false, continue: true, message: `Waiting for Sellercloud to show ${kit}'s kit.`, plan });
    // A changed recipe sent with "overwrite existing kits" that didn't show: send it once more the other way
    // (Sellercloud's help says its import revises an existing part's qty either way).
    if (x.state === "to change" && job.overwrite && !job.retried && x.want) {
      const r2 = { kit, part: x.want.sku, perKit: x.want.perKit };
      const sent2 = await sendKit(env, r2, false);
      if (sent2.error) { await recDel("kitjob", kit, state); return reply({ saved: false, error: `Changing ${kit}'s recipe: ${sent2.error}`, plan }); }
      await recSet("kitjob", kit, { jobId: sent2.jobId, at: Date.now(), part: r2.part, perKit: r2.perKit, overwrite: false, retried: true }, state);
      return reply({ saved: false, continue: true, message: `Sellercloud hadn't shown ${kit}'s new recipe yet, so I sent it once more. Waiting for it to show.`, plan });
    }
    await recDel("kitjob", kit, state);
    if (x.state === "to change")
      return reply({ saved: false, error: `Sellercloud still shows ${kit}'s recipe as ${x.recipeFrom}, not ${x.recipeTo} ${x.want?.sku || ""} per kit, after sending the change twice. Nothing was broken down or assembled.${j.said ? ` Import job ${job.jobId}: ${j.said.slice(0, 200)}.` : ""} You can change it in its Kit tab, then press Run again.`, plan });
    return reply({ saved: false, pending: true, message: `Sellercloud hadn't shown ${kit}'s kit after 2 minutes.${j.said ? ` Import job ${job.jobId}: ${j.said.slice(0, 200)}.` : ""} Check its Kit tab in a minute, then press Run again.`, plan });
  }
  // Kits that showed up: clear their records.
  for (const x of plan.steps.filter((y) => (y.step === "source kit" || y.step === "final kit") && y.action === "skip")) {
    const kit = x.step === "source kit" ? plan.source.sku : plan.final.sku;
    if (await recGet("kitjob", kit, body)) await recDel("kitjob", kit, state);
  }
  if (!todo.length) return reply({ saved: true, unchanged: true, message: "Everything is set up in Sellercloud.", plan });

  // One write per call, in order: the 0.1 product, the source kit, the final kit.
  const b = plan.steps.find((x) => x.step === "0.1 product");
  if (b && b.action === "create") {
    const type = plan.source.productType;
    if (!type) return reply({ saved: false, error: "Couldn't tell the source's product type, so I didn't create the 0.1 product.", plan });
    if (!(await findProduct(env, b.sku))) {
      if (await isLocked("creating", b.sku)) return reply({ saved: false, continue: true, message: `Waiting for Sellercloud to show ${b.sku}.`, plan });
      await lock("creating", b.sku, 120);
      await scPost(env, "/Products", { CompanyId: warehouseCompanyId(env) || 317, ProductSKU: b.sku, ProductName: b.sku, ProductTypeName: type });
    }
    return reply({ saved: false, continue: true, message: `Created ${b.sku}.`, plan });
  }
  const rows = plan.steps.filter((x) => (x.step === "source kit" || x.step === "final kit") && x.action === "set")
    .map((x) => ({ kit: x.step === "source kit" ? plan.source.sku : plan.final.sku, part: x.want.sku, perKit: x.want.perKit,
      change: x.state === "to change" ? { from: x.recipeFrom, to: x.recipeTo } : null }));
  if (rows.some((r) => !Number.isInteger(r.perKit) || r.perKit < 1)) return reply({ saved: false, error: "A kit qty isn't a whole number.", plan });
  rows.sort((p, q) => (p.kit === plan.source.sku ? 0 : 1) - (q.kit === plan.source.sku ? 0 : 1));
  const r = rows[0];
  const emptyStep = plan.steps.find((x) => x.step === "empty source");
  if (r.kit === plan.source.sku && emptyStep) {
    // Sellercloud won't make a product with stock a kit: save what comes out first, then empty the bins.
    await recSet("zeroed", r.kit, { bins: emptyStep.bins, at: Date.now() }, state);
    for (const e of emptyStep.bins) {
      const a = await adjustBinBy(env, r.kit, e.bin, -e.qty, `Emptied to set ${r.kit} up as a kit of ${r.part}; put back right after (${tag})`, 1);
      if (a.error) {
        const back = await putBackChecked(env, r.kit, emptyStep.bins, `Put back after a failed empty of ${r.kit} (${tag})`);
        if (back.failed.length) return reply({ saved: false, critical: true, error: `IMPORTANT: emptying ${r.kit} failed part way and it isn't back in full. Put back by hand: ${back.failed.map((f) => `bin ${f.bin} should have ${f.qty}, shows ${f.now}`).join(", ")}.`, plan });
        await recDel("zeroed", r.kit, state);
        return reply({ saved: false, error: `Couldn't empty ${r.kit} in bin ${e.bin}: ${a.error}`, plan });
      }
    }
    return reply({ saved: false, continue: true, message: `Took ${emptyStep.total} of ${r.kit} out of ${emptyStep.bins.map((e) => "bin " + e.bin).join(", ")} to set its kit. It goes back right after.`, plan });
  }
  const sent = await sendKit(env, { kit: r.kit, part: r.part, perKit: r.perKit }, !!r.change);
  if (sent.error) return reply({ saved: false, error: `${r.change ? "Changing" : "Setting"} ${r.kit}${r.change ? "'s recipe" : ""}: ${sent.error}`, plan });
  await recSet("kitjob", r.kit, { jobId: sent.jobId, at: Date.now(), part: r.part, perKit: r.perKit, overwrite: !!r.change }, state);
  return reply({ saved: false, continue: true, message: r.change
    ? `Sent ${r.kit}'s new recipe to Sellercloud (${r.change.from} → ${r.change.to} ${r.part} per kit). Waiting for it to show.`
    : `Sent ${r.kit}'s kit to Sellercloud. Waiting for it to show.`, plan });
}
function mergeState(prev, now) {
  const out = {};
  for (const kind of new Set([...Object.keys(prev || {}), ...Object.keys(now || {})])) {
    out[kind] = { ...((prev || {})[kind] || {}), ...((now || {})[kind] || {}) };
    for (const k of Object.keys(out[kind])) if (out[kind][k] == null) delete out[kind][k];
  }
  return out;
}
// One Kits import, sent and its job checked once (no waiting). { jobId } or { error }.
// overwrite: true to change an existing kit's qty (Shragy, Nov 19: Sellercloud lets him change a stocked kit's recipe).
async function sendKit(env, r, overwrite = false) {
  const res = await scPost(env, "/Catalog/Imports/Kits", {
    Format: 1, FileContents: b64(kitCsv([r])), FileExtension: ".csv", Metadata: { OverwriteExistingKits: !!overwrite },
  });
  const jobId = importJobId(res);
  if (!jobId) return { jobId: null };
  await sleep(2000);
  const j = await kitJob(env, jobId).catch(() => ({}));
  if (j.error) return { jobId, error: `Sellercloud said: ${String(j.error).slice(0, 300)}` };
  return { jobId };
}

// An assembly record for one group: none, confirmed, pending (sent, Sellercloud not showing it yet) or bad.
// A pending one is confirmed here once the stock shows it.
async function confirmAsm(env, key) {
  const hit = await durable.match(doneKey(key));
  if (!hit) return { state: "none" };
  let rec = null;
  try { rec = JSON.parse(await hit.text()); } catch { rec = null; }
  if (rec?.recipeUsed) return { state: "bad", rec, message: `Sellercloud assembled ${rec.qty} × ${rec.sku} with its recipe qty, not this run's qty per kit, so the rest wasn't assembled. Check the bin before going on.` };
  if (!rec || rec.confirmed !== false) return { state: "confirmed", rec };
  const kitNow = (await whQty(env, rec.sku)).physical;
  let partsOk = true;
  for (const p of rec.parts || []) {
    const now = rec.partsBy === "bin" && rec.fromBin ? await binQtyOf(env, p.sku, rec.fromBin) : (await whQty(env, p.sku)).physical;
    partsOk = partsOk && Math.abs(p.before - now - p.need) < 0.0005;
  }
  if (kitNow - rec.kitBefore === rec.qty && partsOk) {
    await durable.put(doneKey(key), new Response(JSON.stringify({ ...rec, confirmed: true }), { headers: { "cache-control": "max-age=2592000" } }));
    return { state: "confirmed", rec };
  }
  if (Date.now() - (rec.at || 0) < 180000) return { state: "pending", rec, message: `Waiting for Sellercloud to show the assembly of ${rec.qty} × ${rec.sku}.` };
  return { state: "bad", rec, message: `Sellercloud still doesn't show the assembly of ${rec.qty} × ${rec.sku} as expected (kit ${rec.kitBefore} → ${kitNow}). Check Sellercloud before trying again.` };
}

// Press 2 (only when ASSEMBLE_ENABLED = yes): disassemble the source in the From bin into 0.1 units (same bin),
// then assemble the finals from that bin into the To bin. Stock is checked after each step.
async function produceProduction(env, body) {
  if (!assembleOn(env)) throw new HttpError(403, "Kit assembly is switched off. It turns on once ASSEMBLE_ENABLED is set to yes.");
  if (!RUN_KV) throw needKv();
  if (body.source && (await durable.match(lockKey("zeroed", String(body.source).trim()))))
    return { done: false, status: "failed", message: `${String(body.source).trim()} was emptied for its kit setup and not put back yet. Press Run on the setup again first.` };
  const itemId = String(body.itemId || "").trim();
  if (!itemId) throw new HttpError(400, "itemId (the monday item) is needed so a production only runs once.");
  // Both bins must exist before anything moves (checked again inside the assemble).
  const fromBin = await realBin(env, binName(body.fromBin), "From"), toBin = await realBin(env, binName(body.toBin), "To");
  const plan = await productionPlan(env, await withRunPer({ ...body, fromBin }));
  // The 0.1 bin (pre-sized only): the break-down goes in, the assembly takes from it.
  const bBin = plan.mode === "pre-sized" ? await realBin(env, plan.bridgeBin, "0.1") : null;
  const notReady = plan.steps.filter((s) => ["create", "set", "stop"].includes(s.action));
  if (notReady.length) {
    const ch = notReady.find((s) => s.step === "final kit" && s.state === "to change");
    throw new HttpError(409, ch && notReady.length === 1
      ? `${plan.final.sku}'s kit recipe is ${ch.recipeFrom}, not this run's ${ch.recipeTo} per kit, so nothing was assembled. Run the setup again first; it changes the recipe.`
      : "Set up the 0.1 product and kits first.");
  }
  // The kits are assembled in at most two groups (some at N units of 0.1 each, the rest at N + 1, so the whole bin
  // is used). The split is saved on the first press, so later presses assemble the same groups even though the bin
  // has changed by then. Each group has its own once-only record (item id, or item id #g1 / #g2).
  const gSaved = await durable.match(lockKey("groups", itemId));
  let groups = null;
  if (gSaved) { try { groups = JSON.parse(await gSaved.text()); } catch { groups = null; } }
  const legacyDone = !groups && !!(await durable.match(doneKey(itemId))); // assembled before groups existed
  const asmStep = plan.steps.find((s) => s.step === "assemble");
  const fresh = !groups && !legacyDone;
  if (fresh) groups = asmStep?.groups || null; // one assembly at bin total ÷ qty produced, either route
  const gKey = (i) => (groups.length === 1 ? itemId : `${itemId}#g${i + 1}`);
  let started = legacyDone || !fresh;
  if (groups) for (let i = 0; i < groups.length; i++) {
    const c = await confirmAsm(env, gKey(i));
    if (c.state === "pending") return { done: false, continue: true, status: "assemble not confirmed", message: c.message, groups };
    if (c.state === "bad") return { done: false, status: "partly changed", message: c.message, groups };
    if (c.state !== "none") started = true;
  }
  if (!started && !plan.ok) throw new HttpError(409, plan.problems.join(" "));
  if (!groups && !legacyDone) throw new HttpError(409, "Couldn't work out how many units go into each kit. Check the qty produced and the bin.");
  if (fresh) await durable.put(lockKey("groups", itemId), new Response(JSON.stringify(groups), { headers: { "cache-control": "max-age=2592000" } }));
  const alreadyAsm = legacyDone || (groups && (await Promise.all(groups.map((_, i) => durable.match(doneKey(gKey(i)))))).every(Boolean));
  const anyAsm = legacyDone || (groups && (await Promise.all(groups.map((_, i) => durable.match(doneKey(gKey(i)))))).some(Boolean));

  // Break down once per production. After that, the run carries on from its own break-down record only.
  let dis = null;
  const disRec = plan.mode === "pre-sized" ? await (async () => { const h = await durable.match(lockKey("disrec", itemId)); try { return h ? JSON.parse(await h.text()) : null; } catch { return null; } })() : null;
  if (plan.mode === "pre-sized" && !anyAsm && disRec) {
    // Sent earlier: go on once the From bin shows the source taken out (before/after, so other stock doesn't matter).
    const srcNow = await binQtyOf(env, plan.source.sku, fromBin);
    if (!(disRec.srcBefore - srcNow >= disRec.qty))
      return { done: false, continue: true, status: "waiting", message: `Sellercloud still shows ${srcNow} of ${plan.source.sku} in bin ${fromBin} after the break-down of ${disRec.qty}. Wait a minute, then press Run again.`, plan };
  } else if (plan.mode === "pre-sized" && !anyAsm && plan.binQty > 0) {
    if (await isLocked("disassembled", itemId))
      return { done: false, status: "waiting", message: `This production was broken down by an earlier version without a record of its 0.1 units, so I stopped. Check Sellercloud, then clear and run again.`, plan };
    const k = plan.binQty, bridge = plan.bridge.sku, units = plan.units;
    const before = { src: await binQtyOf(env, plan.source.sku, fromBin), br: await binQtyOf(env, bridge, bBin) };
    // This run's break-down, saved before the call: later steps count only these units in the 0.1 bin
    // (Shragy, Nov 19: never mix in other stock of the 0.1 product already there).
    await durable.put(lockKey("disrec", itemId), new Response(JSON.stringify({ qty: k, units: k * units, bridge, bin: bBin, fromBin, srcBefore: before.src, bridgeBefore: before.br, at: Date.now() }), { headers: { "cache-control": "max-age=2592000" } }));
    await lock("disassembled", itemId, 0); // until Shragy clears it: a second break-down is never sent by itself
    let err = null;
    try {
      await soapCall(env, SOAP_DISASSEMBLE,
        `<KitParentProductID>${xmlEsc(plan.source.sku)}</KitParentProductID>` +
        `<QtyToDisAssemble>${k}</QtyToDisAssemble>` +
        `<DisAssembleIntoWarehouseID>${assembleWarehouse(env)}</DisAssembleIntoWarehouseID>` +
        `<DestinationBinName>${xmlEsc(bBin)}</DestinationBinName>` +
        `<OriginalBinName>${xmlEsc(fromBin)}</OriginalBinName>` +
        (await expiryXml(env, SOAP_DISASSEMBLE)));
    } catch (e) { err = e.message || String(e); }
    // Wait until the 0.1 units show in the bin (Sellercloud can take a while), up to about a minute.
    let after, moved = false, nothing = true;
    for (let i = 0; i < 16; i++) {
      after = { src: await binQtyOf(env, plan.source.sku, fromBin), br: await binQtyOf(env, bridge, bBin) };
      moved = before.src - after.src === k && after.br - before.br === k * units;
      nothing = before.src === after.src && before.br === after.br;
      if (moved || (err && i >= 1) || timeUp()) break;
      await sleep(4000);
    }
    dis = { qty: k, units: k * units, srcBefore: before.src, srcAfter: after.src, bridgeBefore: before.br, bridgeAfter: after.br, error: err };
    if (!moved) {
      // The lock stays even when nothing seems to have moved (Sellercloud shows stock late); Shragy's clear allows a retry.
      return { done: false, continue: !(nothing && err), status: nothing && err ? "disassemble failed" : "disassemble not confirmed",
        message: nothing && err ? `Not disassembled. ${err}`
          : `Sellercloud hasn't shown the break-down in bin ${bBin} yet (${bridge}: ${after.br}, expected ${before.br + k * units}). Wait a minute, then press Run again; it carries on from this run's break-down.`,
        disassemble: dis, plan };
    }
  }
  // The 0.1 units left after the assembly (bin total − kits × per kit). Saved on the first press, so later presses
  // remove exactly that qty even though the bin has changed by then.
  const leftStep = plan.steps.find((s) => s.step === "empty leftover");
  let leftover = leftStep?.qty ?? null;
  if (plan.mode === "pre-sized") {
    const saved = await durable.match(lockKey("leftover", itemId));
    if (saved && started) leftover = Number(await saved.text());
    else if (!started) await durable.put(lockKey("leftover", itemId), new Response(String(leftover ?? 0), { headers: { "cache-control": "max-age=2592000" } }));
  }
  let asm = null;
  const asms = [];
  if (!alreadyAsm && groups) {
    const part = plan.mode === "pre-sized" ? plan.bridge.sku : plan.source.sku;
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i], key = gKey(i);
      if (await durable.match(doneKey(key))) continue; // this group is done
      // Wait for Sellercloud to show the parts for the groups still to do in the From bin (Nov 19: right after
      // the break-down the stock check still saw 0 of the 0.1 product). Short reads; moves on once they're there.
      const need = groups.slice(i).reduce((t, x) => t + x.kits * x.perKit, 0);
      // Pre-sized: only this run's break-down counts; the 0.1 bin must show at least what it held before plus
      // this run's units still to use. Other stock of the 0.1 product in that bin is never counted.
      const pBin = plan.mode === "pre-sized" ? bBin : fromBin;
      let base = 0;
      if (plan.mode === "pre-sized") {
        const dr = await durable.match(lockKey("disrec", itemId));
        let d = null; try { d = dr ? JSON.parse(await dr.text()) : null; } catch { d = null; }
        if (!d) return { done: false, status: "no break-down record", message: `There's no record of this run's break-down into bin ${bBin}, so I didn't assemble (it would mix in other ${part}). Check Sellercloud, then clear and run again.`, groups, leftover };
        if (need > d.units) return { done: false, status: "numbers off", message: `This run broke down ${d.units} units of ${part}, fewer than the ${need} the kits need. Nothing was assembled.`, groups, leftover };
        base = d.bridgeBefore;
      }
      let inBin = await binQtyOf(env, part, pBin);
      for (let j = 0; j < 15 && inBin - base < need && !timeUp(); j++) { await sleep(3000); inBin = await binQtyOf(env, part, pBin); }
      if (inBin - base < need)
        return { done: false, continue: true, status: "waiting for parts", message: `Waiting for Sellercloud to show this run's ${part} units in bin ${pBin} (shows ${Math.max(0, inBin - base)} of ${need}).`, disassemble: dis, groups, leftover };
      asm = await assembleKit(env, {
        sku: plan.final.sku, qty: g.kits, itemId: key, fromBin: pBin, toBin, source: part, perKit: plan.perFinal,
        eachPerKit: g.perKit,
      });
      asms.push({ kits: g.kits, perKit: g.perKit, ...asm });
      if (!asm.done) return { done: false, continue: !!asm.continue, status: asm.status, message: (groups.length > 1 ? `Group ${i + 1} of ${groups.length} (${g.kits} kits × ${g.perKit}): ` : "") + asm.message,
        disassemble: dis, assemble: asm, groups, leftover };
      if (i < groups.length - 1)
        return { done: false, continue: true, status: "assembling", message: `Assembled ${g.kits} × ${plan.final.sku} (${g.perKit} units each). Carrying on with the other ${groups[i + 1].kits}.`,
          disassemble: dis, assemble: asm, groups, leftover };
    }
  }
  // Empty the small 0.1 leftover out of the From bin (pre-sized only). Only that product, that bin, that qty.
  let empty = null;
  if (plan.mode === "pre-sized" && leftover > 0 && !(await isLocked("emptied", itemId))) {
    // Rounding down leaves fewer units than kits; anything more means the counts are off, so nothing is removed.
    if (!(leftover < plan.produced)) return { done: false, status: "leftover too big", message: `Assembled, but ${leftover} units of 0.1 are left, more than one per kit, so I didn't remove them. Check the counts.`, assemble: asm, leftover };
    const bridge = plan.bridge.sku;
    const dr = await durable.match(lockKey("disrec", itemId));
    let d = null; try { d = dr ? JSON.parse(await dr.text()) : null; } catch { d = null; }
    if (!d) return { done: false, status: "leftover not removed", message: `Assembled, but there's no record of this run's break-down into bin ${bBin}, so I didn't remove the ${leftover} leftover (it could take other stock). Check Sellercloud.`, assemble: asm, leftover };
    const binNow = async () => ((await productBins(env, bridge)).bins.find((b) => b.bin.toLowerCase() === bBin.toLowerCase()) || {}).qty || 0;
    // After assembling, the 0.1 bin should hold what it held before this run plus this run's leftover.
    // Sellercloud can take a while to show it.
    const expect = d.bridgeBefore + leftover;
    let before = await binNow();
    for (let i = 0; i < 15 && before !== expect && !timeUp(); i++) { await sleep(4000); before = await binNow(); }
    if (before !== expect) return { done: false, continue: true, status: "leftover not found", message: `Assembled. Bin ${bBin} shows ${before} of ${bridge}, not the ${expect} expected (${d.bridgeBefore} from before this run plus this run's ${leftover} left over), so I didn't remove anything yet. Wait a minute, then press Run again.`, assemble: asm, leftover };
    await lock("emptied", itemId, 0);
    let err = null;
    try {
      await soapCall(env, SOAP_ADJUST,
        `<ProductId>${xmlEsc(bridge)}</ProductId><BinName>${xmlEsc(bBin)}</BinName>` +
        `<WarehouseID>${assembleWarehouse(env)}</WarehouseID><Qty>${-leftover}</Qty>` +
        `<reason>${xmlEsc(`Production leftover 0.1 after assembling ${plan.produced} x ${plan.final.sku} (monday item ${itemId})`)}</reason>` +
        `<SerialsList></SerialsList>${await expiryXml(env, SOAP_ADJUST)}<LotNumber></LotNumber>`);
    } catch (e) { err = e.message || String(e); }
    let after = await binNow();
    for (let i = 0; i < 15 && before - after !== leftover && !err; i++) { await sleep(4000); after = await binNow(); }
    const ok = before - after === leftover;
    // The lock stays; Shragy's clear allows a retry.
    empty = { sku: bridge, bin: bBin, qty: leftover, binBefore: before, binAfter: after, ok, error: err };
    if (!ok) return { done: false, status: before === after ? "leftover not removed" : "leftover not confirmed",
      message: before === after ? `Assembled, but the ${leftover} leftover units weren't removed. ${err || ""}`.trim()
        : `Assembled, but bin ${bBin} went from ${before} to ${after} instead of down by ${leftover}. Check Sellercloud.`,
      assemble: asm, emptyLeftover: empty, leftover };
  }
  const total = groups ? groups.reduce((t, g) => t + g.kits * g.perKit, 0) : null;
  const msg = groups && groups.length > 1 && plan.mode === "pre-sized"
    ? `Assembled ${plan.produced} × ${plan.final.sku} in Skustack, from bin ${bBin || fromBin} to bin ${toBin}: ${groups.map((g) => `${g.kits} with ${g.perKit}`).join(" and ")} units of ${plan.bridge.sku} (${total} in all).`
    : asm?.message || `${plan.final.sku} was already assembled.`;
  const stays = plan.steps.find((s) => s.step === "assemble" && s.leftoverStays)?.leftover || 0;
  return { done: true, status: "assembled", message: msg + (empty ? ` Removed this run's ${leftover} leftover ${plan.bridge.sku} from bin ${bBin}.` : "") +
      (stays ? ` ${stays}${plan.mode === "pre-sized" ? ` ${plan.bridge.sku}` : ` lb of ${plan.source.sku}`} stay in bin ${fromBin}.` : ""),
    disassemble: dis, disassembledEarlier: !dis && plan.mode === "pre-sized" && !(plan.binQty > 0), assemble: asm, assembles: asms, groups, emptyLeftover: empty, leftover, leftInBin: stays };
}

// Lists the SOAP service's operations (from its own WSDL) whose name matches q, with their inputs.
// Read-only: it only downloads the service description.
async function soapOps(env, q, type) {
  const wsdl = await wsdlText(env);
  if (type) return { type, fields: wsdlTypeFields(wsdl, type) };
  const re = new RegExp(q || "bin", "i");
  const names = [...new Set([...wsdl.matchAll(/<wsdl:operation name="([^"]+)"/g)].map((m) => m[1]))];
  const hits = names.filter((n) => re.test(n)).sort();
  const inputs = (n) => {
    const m = wsdl.match(new RegExp(`<s:element name="${n}">([\\s\\S]*?)</s:element>\\s*<s:element`, ""));
    return m ? [...m[1].matchAll(/<s:element[^>]*name="([^"]+)"/g)].map((x) => x[1]) : [];
  };
  return { totalOperations: names.length, matches: hits.length, operations: hits.slice(0, 80).map((n) => ({ name: n, inputs: inputs(n) })) };
}

// Read-only check that the worker's saved-step memory (Cloudflare's cache) works where it's deployed.
// The double-run guards depend on it. Writes and reads back one test entry inside Cloudflare; nothing in Sellercloud.
async function cacheWorks() {
  try {
    const k = new Request("https://sellercloud-link.internal/cachecheck");
    const v = String(Date.now()) + Math.random();
    await caches.default.put(k, new Response(v, { headers: { "cache-control": "max-age=60" } }));
    const got = await caches.default.match(k);
    return !!got && (await got.text()) === v;
  } catch { return false; }
}

async function handle(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  const url = new URL(request.url);
  const p0 = url.pathname.replace(/\/+$/, "");
  const isAssemble = p0 === "/assemble";
  const isPost = isAssemble || p0 === "/assemble/setup" || p0 === "/assemble/produce" || p0 === "/assemble/refresh" || p0 === "/assemble/clear";
  const okMethod = isPost ? request.method === "POST" : request.method === "GET";
  if (!okMethod)
    return json({ error: isPost ? `Use POST for ${p0}.` : "Only GET is allowed here." }, 405);

  if (!env.APP_KEY)
    return json({ error: "APP_KEY is not set. Add it as a Secret in the worker's Variables and Secrets." }, 401);
  const key = url.searchParams.get("key") || request.headers.get("X-App-Key") || "";
  const path = url.pathname.replace(/\/+$/, "");
  // PULL_KEY (Secret, optional) is a second key that only works for /pull, so the Production Hub
  // button can carry it without giving out the main key.
  const pullOk = path === "/pull" && env.PULL_KEY && safeEqual(key, env.PULL_KEY);
  // ASSEMBLE_KEY (Secret) is the only key that works for /assemble/... routes; the main key can't assemble or set up kits.
  if (path === "/assemble" || path.startsWith("/assemble/")) {
    if (!env.ASSEMBLE_KEY || !safeEqual(key, env.ASSEMBLE_KEY)) return json({ error: "Missing or wrong assemble key." }, 401);
  } else if (!pullOk && !safeEqual(key, env.APP_KEY)) return json({ error: "Missing or wrong key." }, 401);

  switch (url.pathname.replace(/\/+$/, "") || "/") {
    case "/":
    case "/health": {
      const base = await getBase(env);
      let signInError = null;
      try { await getToken(env, base); } catch (e) { signInError = e.message; }
      const lr = await latestRefusal();
      return json({ ok: !signInError, server: new URL(base).host, signedIn: !signInError, signInError, lastRefusal: lr, lastRefusalResets: resetFrom(lr?.said) ? timeET(resetFrom(lr.said)) : null, sellercloudCalls: await callCounts(env),
        runRecords: env.TOKEN_KV ? "KV (TOKEN_KV)" : "missing: kit runs are off until TOKEN_KV is bound",
        lastSync: await sharedGet(env, SYNC_LAST), hubLastActive: (await hubActiveAt(env)) ? new Date(await hubActiveAt(env)).toISOString() : null });
    }

    case "/products": {
      needCompany(env);
      const q = url.searchParams.get("q") || undefined;
      const inStock = url.searchParams.get("inStock") === "1";
      const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
      const pageSize = Math.min(50, Math.max(1, parseInt(url.searchParams.get("pageSize") || "50", 10)));
      const companyId = warehouseCompanyId(env);
      const data = await scGet(env, "/catalog", {
        Keyword: q,
        companyID: companyId ? [companyId] : undefined,
        physicalQtyFrom: inStock ? 1 : undefined,
        pageNumber: page,
        pageSize,
      });
      let raw = (data.Items || []).filter((p) => companyMatches(env, p));
      let items = raw.map(slimProduct);
      if (inStock) items = items.filter((p) => p.available > 0);
      return json({
        page,
        pageSize,
        totalResults: companyId ? data.TotalResults ?? null : null,
        company: companySetting(env),
        items,
      });
    }

    case "/qty": {
      const sku = url.searchParams.get("sku");
      if (!sku) return json({ error: "Add ?sku=..." }, 400);
      const warehouse = url.searchParams.get("warehouse") || undefined;
      const showEmpty = url.searchParams.get("all") === "1";
      needCompany(env);
      const found = await scGet(env, "/catalog", { SKU: [sku], pageNumber: 1, pageSize: 5 });
      const product = (found.Items || []).find((p) => String(p.ID ?? p.ProductID) === sku) || (found.Items || [])[0];
      if (!product) return json({ sku, found: false, error: "No product with this SKU in Sellercloud." }, 404);
      if (!companyMatches(env, product))
        return json({
          sku,
          found: true,
          inWarehouseCompany: false,
          company: product.CompanyName ?? product.CompanyID ?? null,
          error: `This SKU belongs to ${product.CompanyName || "another company"}, not the warehouse company, so its stock isn't counted.`,
        }, 409);
      const data = await scGet(env, "/Inventory/Warehouses", { productID: sku, warehouseID: warehouse });
      let rows = (Array.isArray(data) ? data : data ? [data] : []).map((w) => ({
        warehouseId: w.WarehouseID ?? null,
        warehouse: w.WarehouseName ?? null,
        sellable: null,
        counted: false,
        available: num(w.AvailableQty),
        physical: num(w.PhysicalQty),
      }));
      const info = await warehouseInfo(env, rows.map((w) => w.warehouseId));
      for (const w of rows) {
        const i = info[w.warehouseId] || {};
        if (!w.warehouse) w.warehouse = i.name ?? null;
        w.sellable = i.sellable ?? null;
        w.counted = counts(env, w);
      }
      const sum = (list, f) => list.reduce((s, w) => s + w[f], 0);
      const counted = rows.filter((w) => w.counted);
      const sellableKnown = !!countSetting(env) || rows.some((w) => w.sellable !== null);
      const result = {
        sku,
        name: product.ProductName ?? null,
        company: product.CompanyName ?? null,
        inWarehouseCompany: true,
        // The number the production qty check should use:
        countedAvailable: sellableKnown ? sum(counted, "available") : null,
        countedPhysical: sellableKnown ? sum(counted, "physical") : null,
        countedBy: countSetting(env) ? "COUNT_WAREHOUSES: " + countSetting(env) : sellableKnown ? "Sellable warehouses" : "unknown",
        allAvailable: sum(rows, "available"),
        allPhysical: sum(rows, "physical"),
        warehouses: showEmpty ? rows : rows.filter((w) => w.available !== 0 || w.physical !== 0),
      };
      if (!sellableKnown)
        result.note = "Sellercloud didn't say which warehouses are sellable. Set COUNT_WAREHOUSES to list the ones that count.";
      if (url.searchParams.get("raw") === "1") {
        // Shows the counted warehouses' rows exactly as Sellercloud sends them, to see whether bins are included.
        const raw = Array.isArray(data) ? data : data ? [data] : [];
        result.rawCountedRows = raw.filter((w) => counts(env, { warehouseId: w.WarehouseID, warehouse: w.WarehouseName }));
        result.bins = await skustackBins(env, sku);
      }
      return json(result);
    }

    case "/companies": {
      let list = [];
      try {
        const data = await scGet(env, "/Companies", { pageNumber: 1, pageSize: 500 });
        list = (Array.isArray(data) ? data : data?.Items || data?.Companies || []).map((c) => ({
          companyId: c.ID ?? c.Id ?? c.CompanyID ?? null,
          company: c.CompanyName ?? c.Name ?? null,
        }));
      } catch {
        // fall back to the companies seen on the first catalog pages
        const seen = new Map();
        for (let page = 1; page <= 5; page++) {
          const data = await scGet(env, "/catalog", { pageNumber: page, pageSize: 50 });
          for (const p of data.Items || []) if (p.CompanyID != null) seen.set(p.CompanyID, p.CompanyName ?? null);
          if ((data.Items || []).length < 50) break;
        }
        list = [...seen].map(([companyId, company]) => ({ companyId, company }));
      }
      return json({
        warehouseCompanySetting: companySetting(env),
        companies: list.map((c) => ({ ...c, isWarehouseCompany: companyMatches(env, { CompanyID: c.companyId, CompanyName: c.company }) })),
      });
    }

    case "/pull": {
      const sku = (url.searchParams.get("sku") || "").trim();
      if (!sku) return json({ error: "Add ?sku=..." }, 400);
      const qty = parseInt(url.searchParams.get("qty") || "", 10);
      const note = (url.searchParams.get("note") || "").slice(0, 200);
      return json(await pullRequest(env, { sku, qty: qty > 0 ? qty : null, note }));
    }

    case "/assemble/preview": {
      const qty = parseInt(url.searchParams.get("qty") || "", 10);
      return json(await assemblePreview(env, (url.searchParams.get("sku") || "").trim(), qty, (url.searchParams.get("fromBin") || "").trim()));
    }

    case "/assemble/bins": {
      // Bin names in Skustack Warehouse for autocomplete: ?q= filters (contains, any case), up to 50.
      const q = (url.searchParams.get("q") || "").trim().toLowerCase();
      const list = await warehouseBinNames(env);
      const hits = q ? list.names.filter((n) => n.toLowerCase().includes(q)) : list.names;
      // ?all=1 sends every name once, so the Hub can filter as you type without asking again.
      const cap = url.searchParams.get("all") === "1" ? 5000 : 50;
      const out = { warehouseId: assembleWarehouse(env), total: list.names.length, matches: hits.length, bins: hits.slice(0, cap) };
      if (url.searchParams.get("raw") === "1") out.rawReply = list.raw.slice(0, 3000);
      return json(out);
    }

    case "/assemble/find": {
      // Final-SKU search for the assembly pop-up. Reads Sellercloud directly, so new SKUs with 0 stock
      // (which the board sync skips) can still be picked. Read-only.
      needCompany(env);
      const q = (url.searchParams.get("q") || "").trim();
      if (q.length < 2) return json({ error: "Type at least 2 characters." }, 400);
      const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
      const companyId = warehouseCompanyId(env);
      let data;
      try {
        data = await scGet(env, "/catalog", { Keyword: q, companyID: companyId ? [companyId] : undefined, pageNumber: page, pageSize: 25 });
      } catch (e) {
        // Sellercloud busy or not answering: search the Sellercloud Products board instead, so the picker still
        // works. The board only holds products that had stock, so a brand-new 0-stock SKU may be missing there.
        if (page !== 1 || !env.MONDAY_TOKEN) throw e;
        const items = await boardSearch(env, q).catch(() => null);
        if (!items) throw e;
        // What Sellercloud actually answered, shown in the pop-up (Nov 19: "Sellercloud didn't answer" hid it).
        const retryAt = e.retryAt || resetFrom(e.said || lastRefusal?.said || "");
        const sellercloud = { status: e.status ?? null, call: e.call || "/catalog", busy: !!e.busy, said: e.said || null, retryAt, error: e.message };
        const why = e.busy
          ? `Sellercloud is limiting calls right now (too many requests)${retryAt ? `; it takes calls again at ${timeET(retryAt)}` : ""}.`
          : `Sellercloud's search failed: ${String(e.message || "").slice(0, 200)}`;
        if (!items.length) {
          return json({ error: `Sellercloud refused the search (${e.message.replace(/ Try again in a moment\.$/, "")}), and nothing matching "${q}" is on the Sellercloud Products board (it only lists products with stock). Try fewer words, or try again in a minute.`,
            busy: true, said: e.said || null, retryAt, sellercloud, q, page, items: [], source: "board" }, 503);
        }
        return json({ q, page, pageSize: 25, totalResults: null, items, source: "board", busy: !!e.busy, retryAt, sellercloud,
          note: `${why} These are from the Sellercloud Products board; a new product with no stock may not be listed yet.` });
      }
      let raw = (data.Items || []).filter((p) => companyMatches(env, p));
      // An exact SKU the keyword search missed (page 1 only).
      if (page === 1 && !raw.some((p) => String(p.ID ?? p.ProductID ?? "").toLowerCase() === q.toLowerCase())) {
        try {
          const exact = await scGet(env, "/catalog", { SKU: [q], pageNumber: 1, pageSize: 5 });
          const hit = (exact.Items || []).find((p) => String(p.ID ?? p.ProductID ?? "").toLowerCase() === q.toLowerCase() && companyMatches(env, p));
          if (hit) raw = [hit, ...raw];
        } catch {}
      }
      const urlTemplate = env.SC_PRODUCT_URL || "https://lgd.delta.sellercloud.com/catalog/catalog-details.aspx?ID={sku}";
      const items = raw.map((p) => {
        const x = slimProduct(p);
        return { ...x, link: x.sku ? urlTemplate.replace("{sku}", encodeURIComponent(x.sku)) : null };
      });
      return json({ q, page, pageSize: 25, totalResults: companyId ? data.TotalResults ?? null : null, items });
    }

    case "/assemble/kit": {
      return json(await kitDefinition(env, (url.searchParams.get("sku") || "").trim()));
    }

    case "/assemble/plan": {
      const g = (k) => (url.searchParams.get(k) || "").trim();
      const plan = await productionPlan(env, await withRunPer({ source: g("source"), final: g("final"), fromBin: g("fromBin"), produced: g("produced"),
        finalSize: g("finalSize"), sourceSize: g("sourceSize"), itemId: g("itemId") }));
      // Whether the worker can remember finished steps here (the double-run guards rely on it).
      plan.savedStepsWork = await cacheWorks();
      return json(plan);
    }

    case "/assemble/clear": {
      // Shragy's press only: forget one production's run records so it can be tried again. Changes nothing in
      // Sellercloud. Every "already sent" record of that item goes: assembly (and its groups), break-down, leftover.
      let body = {};
      try { body = (await request.json()) || {}; } catch {}
      const itemId = String(body.itemId || "").trim();
      if (!itemId) return json({ error: "itemId is needed." }, 400);
      if (!RUN_KV) throw needKv();
      const keys = [doneKey(itemId), doneKey(itemId + "#g1"), doneKey(itemId + "#g2"), doneKey(itemId + "#g3"),
        ...["groups", "disassembled", "disrec", "emptied", "leftover"].map((k) => lockKey(k, itemId))];
      const had = [];
      for (const k of keys) { if (await durable.match(k)) had.push(new URL(k.url).pathname.split("/")[1]); await durable.delete(k); }
      return json({ cleared: true, itemId, had: [...new Set(had)],
        message: had.length ? `Cleared this production's run records (${[...new Set(had)].join(", ")}). Check Sellercloud first: the next Run sends again.` : "This production had no run records." });
    }

    case "/assemble/setup":
    case "/assemble/produce": {
      let body;
      try { body = await request.json(); } catch { return json({ error: "Send the details as JSON." }, 400); }
      if (p0 === "/assemble/setup") { const r = await setupProduction(env, body || {}); return json(r, r.saved || r.pending || r.continue ? 200 : 409); }
      // assembleSent / disassembleSent (for the Hub, Nov 19): true once that item's assembly or break-down has been
      // sent to Sellercloud, confirmed or not. The Hub stops calling by itself once assembleSent is true and not done.
      const iid = String(body?.itemId || "").trim();
      const sentFlags = async () => {
        if (!iid || !RUN_KV) return { assembleSent: null, disassembleSent: null };
        const asm = [iid, iid + "#g1", iid + "#g2", iid + "#g3"];
        let a = false, conf = null;
        for (const k of asm) {
          const hit = await durable.match(doneKey(k));
          if (!hit) continue;
          a = true;
          let rec = null; try { rec = JSON.parse(await hit.text()); } catch {}
          const ok = !!rec && rec.confirmed !== false && !rec.recipeUsed;
          conf = conf === null ? ok : conf && ok;
        }
        // assembleConfirmed: every assembly of the item is confirmed in Sellercloud. Then a continue:true reply is
        // only the leftover removal (its own once-only lock), so the Hub can keep calling.
        return { assembleSent: a, assembleConfirmed: a ? !!conf : false, disassembleSent: !!(await durable.match(lockKey("disassembled", iid))),
          leftoverRemoved: !!(await durable.match(lockKey("emptied", iid))) };
      };
      let r;
      try { r = await produceProduction(env, body || {}); }
      catch (e) {
        const st = e instanceof HttpError ? e.status : 500;
        return json({ error: e.message || String(e), ...(e.busy ? { busy: true, call: e.call, said: e.said, retryAt: e.retryAt || null } : {}),
          ...(await sentFlags().catch(() => ({}))) }, st);
      }
      return json({ ...r, ...(await sentFlags()) }, r.done ? 200 : 409);
    }

    case "/assemble/refresh": {
      // The Hub's "Refresh from Sellercloud" button. {sku} refreshes one product now (2-3 Sellercloud calls).
      // Without a sku it runs the full copy in short steps: send {start:true} on the first press, then keep
      // calling while the answer has continue:true. Writes only to the Sellercloud Products board.
      let body = {};
      try { body = (await request.json()) || {}; } catch {}
      const sku = String(body.sku || url.searchParams.get("sku") || "").trim();
      if (sku) return json(await refreshOne(env, sku));
      const out = await runSync(env, { seconds: 14, startNew: body.start === true || url.searchParams.get("start") === "1" });
      if (out.skipped) return json({ continue: true, waiting: true, message: out.message });
      const finished = !!out.pass?.finished;
      return json({ ...out, continue: !finished && !out.thisRun?.stoppedBusy, finished,
        message: finished ? `Refresh finished: ${out.pass.checked} products checked.`
          : out.thisRun?.stoppedBusy ? "Sellercloud is busy; press Refresh again in a minute." : `Refreshing… ${out.pass.checked}${out.pass.total ? " of " + out.pass.total : ""} products checked.` });
    }

    case "/assemble/bridge": {
      const sku = (url.searchParams.get("sku") || "").trim();
      if (!sku) return json({ error: "Add ?sku=... (the source product's SKU)." }, 400);
      return json(await bridgeFor(env, sku));
    }

    case "/assemble": {
      let body;
      try { body = await request.json(); } catch { return json({ error: "Send the details as JSON." }, 400); }
      const result = await assembleKit(env, body || {});
      return json(result, result.done ? 200 : 409);
    }

    case "/bins": {
      const sku = (url.searchParams.get("sku") || "").trim();
      if (!sku) return json({ error: "Add ?sku=..." }, 400);
      const { bins, raw } = await productBins(env, sku);
      const out = { sku, warehouseId: assembleWarehouse(env), bins };
      if (url.searchParams.get("raw") === "1") out.rawReply = raw.slice(0, 4000);
      return json(out);
    }

    case "/cachecheck": {
      const works = await cacheWorks();
      return json({ works, host: url.hostname, note: works ? "Saved steps are remembered." : "Cloudflare didn't keep the test entry, so the worker can't remember finished steps on this address." });
    }

    case "/assemblediag": {
      // Read-only, in light parts so each stays inside Cloudflare's limits:
      //   (default) every assemble/disassemble/serial/work-order SOAP call with its fields
      //   part=send   the user, bins, the kit's parts, and exactly what an assembly of 1 would send (needs sku)
      //   part=stock  the kit's and parts' totals and every bin-row field (needs sku)
      //   part=rest   the Kits import columns and REST kit/assemble endpoints
      const part = (url.searchParams.get("part") || "calls").trim().toLowerCase();
      const sku = (url.searchParams.get("sku") || "").trim();
      const out = { part, nextParts: ["calls", "send", "stock", "rest"].filter((x) => x !== part) };
      const kitPartsOf = async () => {
        const xml = await soapCall(env, "ProductKit_GetKitDetails", `<KitParentProductID>${xmlEsc(sku)}</KitParentProductID>`);
        return tagAll(xml, "KitItemDetail").map((d) => Object.fromEntries([...d.matchAll(/<(?:\w+:)?(\w+)>([^<]*)<\/(?:\w+:)?\1>/g)].map((m) => [m[1], xmlUnesc(m[2])])));
      };
      if (part === "calls") {
        const wsdl = await wsdlText(env);
        const names = wsdlOpNames(wsdl);
        const pick = names.filter((n) => /assembl|serial|workorder/i.test(n)).sort().slice(0, 40);
        out.calls = [];
        for (const n of pick) out.calls.push({ name: n, fields: await opFields(env, n) });
        out.kitCalls = names.filter((n) => /kit/i.test(n) && !/assembl/i.test(n)).sort().slice(0, 60);
      } else if (part === "send") {
        try {
          const ux = await soapCall(env, "GetCurrentUser", "");
          out.apiUser = { assemblyUserIdSent: await scUserId(env), ids: Object.fromEntries([...ux.matchAll(/<(?:\w+:)?(\w*ID)>([^<]*)</gi)].slice(0, 20).map((m) => [m[1], m[2]])) };
        } catch (e) { out.apiUser = { error: e.message }; }
        for (const [k, role] of [["fromBin", "From"], ["toBin", "To"]]) {
          const v = (url.searchParams.get(k) || "").trim();
          if (v) { try { out[k] = { typed: v, sellercloudName: await realBin(env, v, role) }; } catch (e) { out[k] = { typed: v, error: e.message }; } }
        }
        if (sku) {
          try { out.kitParts = await kitPartsOf(); } catch (e) { out.kitParts = { error: e.message }; }
          try {
            const parts = Array.isArray(out.kitParts) ? out.kitParts.map((p) => ({ sku: p.ChildProductId || p.ChildProductID, perKit: Number(p.Qty) })).filter((p) => p.sku && p.perKit > 0) : [];
            const b = await assembleBody(env, { sku, qty: 1, fromBin: out.fromBin?.sellercloudName || "(From bin)", toBin: out.toBin?.sellercloudName || "(To bin)", userId: await scUserId(env), itemId: "", parts });
            out.assembleWouldSend = { fromWsdl: b.fromWsdl, fields: b.filled };
          } catch (e) { out.assembleWouldSend = { error: e.message }; }
        } else out.note = "Add &sku=FINAL to see what an assembly would send.";
      } else if (part === "stock") {
        if (!sku) return json({ error: "Add &sku=FINAL." }, 400);
        let parts = [];
        try { parts = (await kitPartsOf()).map((p) => p.ChildProductId || p.ChildProductID).filter(Boolean); } catch {}
        out.stock = [];
        for (const x of [sku, ...parts].slice(0, 4)) {
          const row = { sku: x };
          // Spaced out: Sellercloud answered 409 (too many requests) when these ran back to back (Nov 19).
          if (out.stock.length) await sleep(2000);
          try { row.warehouses = await warehouseTotals(env, x); } catch (e) { row.warehouses = { error: e.message }; }
          await sleep(1000);
          try { row.binRows = binRowsAll((await productBins(env, x)).raw).slice(0, 20); } catch (e) { row.binRows = { error: e.message }; }
          out.stock.push(row);
        }
      } else if (part === "rest") {
        try { out.kitImportTemplate = await scGet(env, "/Catalog/Imports/Kits/Template"); } catch (e) { out.kitImportTemplate = { error: e.message }; }
        out.restKitEndpoints = "Open /apidocs?q=kit|assembl for these.";
      } else return json({ error: "part must be calls, send, stock or rest." }, 400);
      return json(out);
    }

    case "/soapops": {
      return json(await soapOps(env, url.searchParams.get("q") || "bin", (url.searchParams.get("type") || "").trim()));
    }

    case "/kitimport": {
      // Read-only troubleshooting for the Kits import: the template columns, recent jobs, and one job's status.
      const out = {};
      const short = (v) => JSON.parse(JSON.stringify(v ?? null, (k, x) => (typeof x === "string" && x.length > 2000 ? x.slice(0, 2000) + "…" : x)));
      try { out.template = short(await scGet(env, "/Catalog/Imports/Kits/Template")); } catch (e) { out.template = { error: e.message }; }
      try { const d = await scGet(env, "/QueuedJobs", { pageNumber: 1, pageSize: 10 }); out.recentJobs = short((d?.Items || d?.items || d || []).slice?.(0, 10) ?? d); }
      catch (e) { out.recentJobs = { error: e.message }; }
      const job = url.searchParams.get("job");
      if (job) { try { out.job = short(await scGet(env, "/QueuedJobs", { jobID: job })); } catch (e) { out.job = { error: e.message }; } }
      return json(out);
    }

    case "/apidocs": {
      // Lists Sellercloud API paths matching a word (default: bins), from your server's own API docs.
      const base = await getBase(env);
      const q = new RegExp(url.searchParams.get("q") || "bin|location|skustack|wms", "i");
      let doc = null;
      for (const path of ["/swagger/docs/v1", "/swagger/v1/swagger.json"]) {
        const r = await fetch(base.replace(/\/api$/i, "") + path);
        if (r.ok) { doc = await r.json().catch(() => null); if (doc) break; }
      }
      if (!doc?.paths) return json({ error: "Couldn't read the API docs from your Sellercloud server." }, 502);
      const hits = [];
      for (const [path, ops] of Object.entries(doc.paths))
        for (const [method, op] of Object.entries(ops))
          if (q.test(path) || q.test(op.summary || "") || q.test((op.tags || []).join(" ")))
            hits.push({ method: method.toUpperCase(), path, summary: op.summary || "", params: (op.parameters || []).map((p) => p.name) });
      return json({ matches: hits.length, endpoints: hits.slice(0, 60) });
    }

    case "/sync": {
      try {
        const summary = await runSync(env, { dry: url.searchParams.get("dry") === "1", seconds: 20 });
        return json(summary);
      } catch (e) {
        if (/too many subrequests/i.test(e.message || ""))
          return json({ error: "Cloudflare's request limit for this plan was reached. Add SUBREQUEST_LIMIT as Text = 45 and try again." }, 500);
        throw e;
      }
    }

    case "/warehouses": {
      const info = await warehouseInfo(env, []);
      return json({
        warehouses: Object.entries(info).map(([id, i]) => ({
          warehouseId: Number(id),
          warehouse: i.name,
          sellable: i.sellable,
          counted: counts(env, { warehouseId: Number(id), warehouse: i.name, sellable: i.sellable }),
        })),
      });
    }

    case "/images": {
      const sku = url.searchParams.get("sku");
      if (!sku) return json({ error: "Add ?sku=..." }, 400);
      const data = await scGet(env, "/ProductImage", { productID: sku });
      const list = Array.isArray(data) ? data : data?.Images || data?.Items || [];
      return json({
        sku,
        images: list.map((i) => ({ url: i.Url ?? null, isDefault: !!i.IsDefault })),
      });
    }

    default:
      return json({ error: "Unknown path. Try /health, /products, /qty, /companies, /warehouses, /images or /sync." }, 404);
  }
}

export default {
  async scheduled(event, env, ctx) {
    callStart = Date.now();
    deadline = callStart + 150_000; // the sync's own time box is 120 s
    readCacheOn = false;
    quickBusy = false;
    ctx.waitUntil(runSync(env, { seconds: 120, scheduled: true }).catch((e) => console.log("sync failed: " + e.message))
      .finally(() => tallyCalls(env)));
  },
  async fetch(request, env, ctx) {
    reqOrigin = request.headers.get("Origin") || "";
    reqEnv = env;
    RUN_KV = env.TOKEN_KV || null;
    callStart = Date.now();
    deadline = callStart + (parseInt(env.CALL_SECONDS || "20", 10) || 20) * 1000;
    try {
      const u = new URL(request.url);
      readCacheOn = request.method === "GET" && READ_ROUTES.test(u.pathname.replace(/\/+$/, "")) && u.searchParams.get("fresh") !== "1";
      quickBusy = u.pathname.replace(/\/+$/, "") === "/assemble/find";
    } catch { readCacheOn = false; quickBusy = false; }
    try {
      const pth = new URL(request.url).pathname.replace(/\/+$/, "");
      // The Hub's own calls go first: the scheduled sync waits while these are coming in.
      if (/^\/(assemble(\/(?!refresh$).*)?|qty|pull|products)$/.test(pth) && request.method !== "OPTIONS") ctx?.waitUntil?.(markHubActive(env));
    } catch {}
    try {
      return await handle(request, env);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      return json({ error: e.message || "Something went wrong.", ...(e.busy ? { busy: true, call: e.call, said: e.said, retryAt: e.retryAt || null } : {}) }, status);
    } finally {
      try { ctx?.waitUntil?.(tallyCalls(env)); } catch {}
    }
  },
};
