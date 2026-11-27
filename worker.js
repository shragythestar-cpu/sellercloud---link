// sellercloud-link: a small, READ-ONLY bridge between Sellercloud and the Production Hub.
//
// It holds the Sellercloud login only as Cloudflare secrets (never in monday or the app).
// It READS from Sellercloud: sign-in, product search, stock, photos, kit recipes.
// The one exception is kit assembly (POST /assemble), which changes stock and stays SWITCHED OFF
// until ASSEMBLE_ENABLED = yes. See the "Kit assembly" section below.
// Second exception (Nov 25): /temu-backlog marks old unshipped Temu orders shipped, only while switched on. See "Temu backlog".
// Third exception (Nov 25): /labels-autoship marks a Temu order shipped once its label is printed, only while switched on
// (plus a one-order test call). See "Labels auto mark shipped".
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
//   POST /bins/contents {bins:[names]} (APP_KEY or ASSEMBLE_KEY; Nov 25) READ-ONLY: each bin of Skustack Warehouse with
//     exists, totalQty and skus [{sku, qty}] (up to 25 bins; each kept 60 s).
//   Split runs (Nov 24): POST /assemble/job and /assemble/plan take outputs [{itemId, final, qty, toBin, fba?}] (2 to 6):
//     one break-down, one assembly per part into its bin at the same units per kit, leftover removed once; every card
//     of the run is locked to the main card. Every plan answer has features { splitOutputs: true, maxOutputs: 6 }.
//   Live-board copy (Nov 24): every 5 minutes (cron */5) reads the live Production Schedule (READ ONLY) and copies its
//     open productions (group Production Schedule, not Done) to the Hub board 18439411777; Text MIRROR_ENABLED = yes turns
//     it on. GET /mirror/status (ASSEMBLE_KEY or APP_KEY). Writes only to the Hub board, through mirrorMutate.
//   Labels (Nov 24; nothing calls Sellercloud). Carrier (Nov 24): upload data takes a batch-level `carrier`; batches and
//     /labels/batch show `carrier` and `carriers` (worked out from the lines for older batches); /labels/batches and
//     /labels/stats take ?carrier=; /labels/stats adds `carriers`.
//   Label downloads (Nov 24): /labels/file honours Range: bytes=a-b (206). POST /labels/file-link {batchId} (Hub key) gives a
//     15-minute signed link to GET /labels/dl (no key in it), which streams the PDF straight to the browser.: POST /labels/upload (multipart file + data JSON; header X-Labels-Key =
//     Secret LABELS_KEY, 501 until it's set); GET /labels/batches?from=&to=, /labels/batch?batchId=, /labels/file?batchId=,
//     /labels/stats?from=&to=&groupBy=day|week|month, POST /labels/downloaded {batchId,by} (ASSEMBLE_KEY or APP_KEY).
//     PDFs in KV (TOKEN_KV, labels:file:<batchId>); batches and lines in the SQLite Durable Object LabelStore (binding LABELS).
//   Scan station (Nov 25): the Hub's FBM printing tab (GET /scan only says so now). With the Hub key:
//     GET /labels/day?date= (the day's batches, lines, printed packages, UPC links; each line has scSku, its Sellercloud SKU,
//     learned read-only from one Sellercloud order per product title and kept in KV labels:titlesku:v1); GET /labels/upc?upc= (Sellercloud
//     products with that UPC, read-only, kept 7 days in KV, plus saved links); POST /labels/printed {items:[{batchId,pkg}],by};
//     POST /labels/link {upc,sku[,remove]}. The page prints a scanned product's labels grouped by units per package.
//     GET /labels/photo?sku= (read-only: the catalog image, else Sellercloud product images; also tried without the platform name; kept 7 days in KV; none kept 1 hour).
//   /assemble/platforms  (ASSEMBLE_KEY) platforms for "Create final SKU": prefix and company each (company: Text PLATFORM_COMPANY_<KEY>)
//   POST /assemble/create-product {sku,name?,platform? or companyName/companyId,sourceSku?,productType?,itemId?}
//     (ASSEMBLE_KEY, only when ASSEMBLE_ENABLED = yes) creates ONE product in that company. Refuses an SKU that exists
//     in any company; never sends twice for the same SKU (KV record), no retries.
//   /assemble/companies  (ASSEMBLE_KEY) every Sellercloud company with its id (read-only)
//   /assemble/catalog?company=ID_or_NAME[&q=WORD&sku=SKU&page=1&raw=1]  (ASSEMBLE_KEY) products in any company (read-only)
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
//   Mix kits (one final from 2+ sources): plan, setup and produce take sources (2+ SKUs: JSON array, repeated
//                                   ?sources= or a comma list) instead of source, plus types (picked per source:
//                                   {"SKU":"lb"|"oz"} or "SKU:lb,SKU:oz") and maxDiffPct (weight check, default 10).
//                                   Each source breaks down into its own 0.1 product in the 0.1 bin; the final's recipe
//                                   gets one line per 0.1 product (this run's units ÷ produced); one assembly; each
//                                   0.1 product's leftover removed. Weight in vs final size × produced: over the limit,
//                                   or a source type not clear (unknownTypes), blocks setup and produce.
//   Background runs (Durable Object JobQueue, binding JOBS; ASSEMBLE_KEY):
//     POST /assemble/job {the fields setup and produce take, itemId, userId[, fba]}  checks the kit (read-only) and
//                                   queues it; the worker then runs setup and produce by itself, one step at a time.
//     GET  /assemble/job?itemId=a[&itemIds=b,c] or ?jobIds=x,y   each job's state, step n of total, steps, result.
//     GET  /assemble/jobs[?active=1]   every job (active=1: running, waiting, or finished and not acked yet).
//     POST /assemble/job/cancel {itemId|jobId}   only before it starts.   POST /assemble/job/ack {jobIds}   board written.
//   /soapops?type=Name                          the fields of one SOAP data type and their types (read-only)
//   /kittool?sku=KIT                            read-only: the kit as the web Kit tab loads it (delta host); never saves
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
// Nov 23 (his yes): a kit's FINAL SKU may be under WAREHOUSE or any platform company in PLATFORMS (Temu, LG DEALS LLC,
// EAST AND WEST SALES, Walmart company, WOOT, or a PLATFORM_COMPANY_<KEY> override, by name or id).
// Sources, kit parts and the 0.1 products stay WAREHOUSE only; the warehouse is still only ASSEMBLE_WAREHOUSE.
function isPlatformCompany(env, p) {
  const names = new Set(platformList(env).map((x) => normCo(x.company)).filter(Boolean));
  return names.has(normCo(p.CompanyName)) || (p.CompanyID != null && names.has(normCo(p.CompanyID)));
}
const finalCompanyOk = (env, p) => companyMatches(env, p) || isPlatformCompany(env, p);
const notFinalCompany = (sku, p) => `${sku} belongs to ${p.CompanyName || "another company"}, which isn't WAREHOUSE or a platform company.`;


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
  // Nov 23: the crew chat message is only the SKU, nothing else for now.
  // Stock and bin lookups are skipped here so a request uses fewer Sellercloud calls.
  if (await recentlyPosted(sku)) throw new HttpError(429, "This SKU was already posted in the last minute.");
  const lines = [sku];
  await markPosted(sku); // mark first so a fast double click doesn't post twice
  try {
    await postToChat(env, lines.join("\n"));
  } catch (e) {
    await caches.default.delete(guardKey(sku)).catch(() => {});
    throw e;
  }
  return { posted: true, sku, qty: qty || null, available: null, bins: [] };
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
const SOAP_READS = new Set(["GetCurrentUser", "ProductKit_GetKitDetails", "ProductKit_ListKitItems", "ProductWarehouseBin_ListAll_New", "WarehouseBin_ListAll",
  "ProductWarehouseBin_All_ByBinName"]);
const SOAP_ASSEMBLE = "ProductKit_Assemble_New_4";
const SOAP_DISASSEMBLE = "ProductKit_Disassemble_New3";
// Removes the small 0.1 leftover from the From bin after an assembly (found on Shragy's server via /soapops?q=bin).
const SOAP_ADJUST = "WarehouseBin_AdjustQtyByName_WithReason";
// Nov 23: a kit part's qty on a kit with stock. The Kits import and SOAP AddKitItem both re-add the part, and Sellercloud
// refuses that on a kit with stock ("Please remove inventory before you add new item in kit"). The web Kit tab edits the
// qty in place through a JSON call on the "delta" host (KitTool/Load and KitTool/Save); the worker signs in there with its
// own Sellercloud login (delta's /api/token, checked with /kittool on Nov 23). See editKitParts.

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

// ---- Bin contents (Nov 25, for the Hub's "auto-assign a free production bin"). READ-ONLY: what is in each named bin of
// Skustack Warehouse, from WarehouseBin_ListAll (does the bin exist) and ProductWarehouseBin_All_ByBinName (its products,
// both reads). Each bin's answer is kept 60 s (the shortest KV keeps); nothing is written to Sellercloud.
const BIN_CONTENTS_MAX = 25;
const BIN_CONTENTS_SECS = 60;
async function binContentsOne(env, name, names, debug) {
  const hit = names.find((n) => n === name) || names.find((n) => n.toLowerCase() === name.toLowerCase());
  if (!hit) return { bin: name, exists: false, totalQty: 0, skus: [] };
  const ck = "bin-contents-v1:" + hit.toLowerCase();
  const kept = await sharedGet(env, ck);
  if (!debug && kept && Date.now() - (kept.at || 0) < BIN_CONTENTS_SECS * 1000) return kept.v;
  const wh = assembleWarehouse(env);
  const xml = await soapCall(env, "ProductWarehouseBin_All_ByBinName",
    `<BinName>${xmlEsc(hit)}</BinName><WarehouseID>${wh}</WarehouseID><IncludeQtySoldData>false</IncludeQtySoldData>`);
  const by = new Map();
  let rowFields = null, rows = 0;
  const walk = (n) => {
    const sku = kid(n, "ProductID", "ProductId", "ProductSKU", "SKU");
    if (sku && !n.kids.some((c) => /^product(id|sku)$/i.test(c.name) && c.kids.length)) {
      const whId = kid(n, "WarehouseID");
      if (whId != null && Number(whId) !== wh) return;
      const bn = kid(n, "BinName");
      if (bn && bn.toLowerCase() !== hit.toLowerCase()) return;
      const q = num(kid(n, "QtyAvailable", "AvailableQty", "PhysicalQty", "Qty", "Quantity", "BinQty"));
      by.set(sku, (by.get(sku) || 0) + q);
      rows++; if (!rowFields) rowFields = n.kids.map((c) => c.name);
      return;
    }
    n.kids.forEach(walk);
  };
  walk(xmlTree(xml));
  const skus = [...by].filter(([, q]) => q !== 0).map(([sku, qty]) => ({ sku, qty })).sort((a, b) => b.qty - a.qty || a.sku.localeCompare(b.sku));
  const v = { bin: hit, exists: true, totalQty: skus.reduce((t, x) => t + x.qty, 0), skus };
  if (debug) return { ...v, rows, rowFields };   // field names only, to check the reply's shape; never cached
  await sharedPut(env, ck, { at: Date.now(), v }, BIN_CONTENTS_SECS);
  return v;
}
async function binContents(env, body) {
  let list = body?.bins;
  if (typeof list === "string") list = list.split(",");
  if (!Array.isArray(list)) throw new HttpError(400, "Send { bins: [bin names] }.");
  const want = [...new Set(list.map((x) => String(x ?? "").trim()).filter(Boolean))];
  if (!want.length) throw new HttpError(400, "Send at least one bin name.");
  if (want.length > BIN_CONTENTS_MAX) throw new HttpError(400, `Up to ${BIN_CONTENTS_MAX} bins at a time, not ${want.length}.`);
  if (want.some((b) => b.length > 60 || /[<>&]/.test(b))) throw new HttpError(400, "A bin name doesn't look right.");
  const { names } = await warehouseBinNames(env);
  const bins = [];
  const debug = body.debug === true;
  for (const b of want) bins.push(await binContentsOne(env, b, names, debug));
  return { warehouseId: assembleWarehouse(env), bins };
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
  if (!finalCompanyOk(env, product)) throw new HttpError(409, notFinalCompany(sku, product));
  const recipe = await kitRecipe(env, sku);
  const problems = [];
  if (!recipe.length) problems.push(`${sku} has no kit recipe in Sellercloud, so it can't be assembled.`);
  // A final under a platform company still only takes WAREHOUSE parts.
  if (!companyMatches(env, product)) {
    await pool(recipe, 2, async (p) => {
      const part = await findProduct(env, p.sku);
      if (!part) problems.push(`Part ${p.sku} isn't a product in Sellercloud.`);
      else if (!companyMatches(env, part)) problems.push(`Part ${p.sku} belongs to ${part.CompanyName || "another company"}, not WAREHOUSE. Kit parts must be WAREHOUSE products.`);
    });
  }
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
  if (!itemId.includes("#")) await splitGuard(itemId);
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
  // A mix (several 0.1 products): the recipe must be exactly this run's lines.
  if (Array.isArray(body.expectParts)) {
    const r = pre.parts, w = body.expectParts;
    const same = r.length === w.length && w.every((x) => r.some((p) => p.sku.toLowerCase() === String(x.sku).toLowerCase() && Math.abs((p.recipePerKit ?? p.perKit) - Number(x.perKit)) < 0.0005));
    if (!same) throw new HttpError(409, `${sku}'s kit in Sellercloud isn't ${w.map((x) => `${x.perKit} ${x.sku}`).join(" + ")} per kit, so I didn't assemble. Run the setup again first.`);
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
// final: true only for a kit's final SKU, which may also be under a platform company. Everything else stays WAREHOUSE.
async function kitDefinition(env, sku, { final = false } = {}) {
  needCompany(env);
  if (!sku) throw new HttpError(400, "Add ?sku=... (the product's SKU).");
  const product = await findProduct(env, sku);
  if (!product) return { sku, exists: false, name: null, isKit: false, components: [] };
  if (final ? !finalCompanyOk(env, product) : !companyMatches(env, product))
    throw new HttpError(409, final ? notFinalCompany(sku, product) : `${sku} belongs to ${product.CompanyName || "another company"}, not WAREHOUSE.`);
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
    company: product.CompanyName ?? null, companyId: product.CompanyID ?? null,
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
  const final = await kitDefinition(env, finalSku, { final: true });
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
// Sellercloud's QueuedJobStatus numbers (developer.sellercloud.com, queued-job-statuses).
const JOB_STATUS = { 0: "Submitted", 1: "Processing", 3: "Completed", 4: "Failed", 5: "PartialSuccess", 6: "OnHold", 7: "Cancelled",
  8: "Cancelled_Service_Restarted", 9: "Aborted_Too_Much_Time_Consumed", 10: "Cancelled_While_Running" };
// A queued job's own log lines (GET /QueuedJobs/{id}/Logs). A Kits import can finish as Completed with no ErrorMessage
// and still skip a row; the reason is only in this log. Errors first, then the rest. Read-only, 1-2 calls.
async function jobLogs(env, jobId) {
  if (!jobId) return [];
  const read = async (isError) => {
    const d = await scGet(env, `/QueuedJobs/${encodeURIComponent(jobId)}/Logs`, { pageNumber: 1, pageSize: 20, ...(isError ? { IsError: true } : {}) });
    return (d?.Items || d?.items || []).map((x) => ({ time: x.LogTime ?? null, error: !!x.IsError, message: String(x.Message ?? "").replace(/\s+/g, " ").trim() }))
      .filter((x) => x.message);
  };
  try {
    const errs = await read(true);
    return errs.length ? errs : await read(false);
  } catch (e) { return [{ error: true, message: `Couldn't read the job's log: ${String(e.message || e).slice(0, 150)}` }]; }
}
const logText = (logs) => logs.length ? " Sellercloud's job log: " + logs.slice(0, 5).map((x) => x.message.slice(0, 200)).join(" | ") + "." : "";
async function kitJob(env, jobId) {
  const data = await scGet(env, "/QueuedJobs", { jobID: jobId });
  const job = (data.Items || data.items || [])[0];
  if (!job) return { found: false, done: false, error: null, said: "" };
  // Whatever the job says about itself (status, messages), for the Hub to show when a kit didn't save.
  const said = Object.entries(job).filter(([k, v]) => /status|message|error|result|note/i.test(k) && v != null && v !== "" && typeof v !== "object")
    .map(([k, v]) => `${k}: ${String(v).replace(/\s+/g, " ").slice(0, 200)}${/status/i.test(k) && JOB_STATUS[v] != null ? ` (${JOB_STATUS[v]})` : ""}`).join("; ").slice(0, 400);
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

// A source emptied to make it a kit: carry that on until its stock is back. null when nothing is in progress.
// wantOf() gives the source's kit ({sku, perKit}) from the current plan.
async function continueZeroed(env, sourceSku, body, state, reply, tag, wantOf) {
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
      const w = await wantOf();
      if (!w) return finish({ saved: false, error: `Couldn't tell what ${sourceSku}'s kit should be. Its stock was put back.` });
      const r = { kit: sourceSku, part: w.sku, perKit: w.perKit };
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
  return null;
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
  if (hit) { try { const g = JSON.parse(await hit.text());
    if (Array.isArray(g) && g.length && g[0].perKit > 0 && (g.length === 1 || (g[0].key && g.every((x) => x.perKit === g[0].perKit)))) out.runPerKit = g[0].perKit; } catch {} }
  return out;
}
// ---- Split runs (Nov 24, Shragy: "Build it"): one production run, set amounts reserved for other channels, the rest
// to the main channel; one Kits card per channel. In Sellercloud: ONE break-down of the bin into the 0.1 bin, then one
// assembly per output (its final SKU, its qty, its To bin), every final at the same units per kit (run's 0.1 units ÷
// total produced, rounded down), each final's recipe set to that and checked before its assembly; the leftover is
// removed once at the end. One run, one set of records under the main card; every card of the run is locked to it.
// Only through the background run (POST /assemble/job); /assemble/plan shows it.
const SPLIT_MAX = 6;
const SPLIT_FEATURES = { splitOutputs: true, maxOutputs: SPLIT_MAX };
// The run's outputs, checked and in a fixed form, or null when the body has none.
function splitOutputs(env, body) {
  let raw = body?.outputs;
  if (raw == null || raw === "") return null;
  if (typeof raw === "string") { try { raw = JSON.parse(raw); } catch { throw new HttpError(400, "outputs must be a JSON list."); } }
  if (!Array.isArray(raw)) throw new HttpError(400, "outputs must be a list of { itemId, final, qty, toBin }.");
  if (isMix(body)) throw new HttpError(400, "Split runs don't work with mix kits yet. Assemble a mix kit as one card.");
  if (raw.length < 2 || raw.length > SPLIT_MAX) throw new HttpError(400, `A split run has 2 to ${SPLIT_MAX} parts, not ${raw.length}.`);
  const main = String(body.itemId || "").trim();
  if (!main) throw new HttpError(400, "itemId (the main card) is needed.");
  const fbaBin = String(env.FBA_BIN || "FBA_manual_import").trim();
  const problems = [], ids = new Set(), finals = new Set(), out = [];
  raw.forEach((o, i) => {
    const n = i + 1;
    if (!o || typeof o !== "object") { problems.push(`Part ${n} isn't an object.`); return; }
    const itemId = String(o.itemId ?? "").trim(), final = String(o.final ?? "").trim(), toBin = String(o.toBin ?? "").trim();
    const qty = Number(o.qty), fba = o.fba === true || o.fba === "yes";
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(itemId)) problems.push(`Part ${n}: itemId is needed.`);
    else if (ids.has(itemId.toLowerCase())) problems.push(`Part ${n}: card ${itemId} is listed twice.`);
    if (!final) problems.push(`Part ${n}: final (its final SKU) is needed.`);
    else if (finals.has(final.toLowerCase())) problems.push(`Part ${n}: ${final} is listed twice; each part needs its own final SKU.`);
    else if (String(body.source || "").trim().toLowerCase() === final.toLowerCase()) problems.push(`Part ${n}: the final can't be the source SKU.`);
    if (!Number.isInteger(qty) || qty < 1) problems.push(`Part ${n}: qty must be a whole number, 1 or more.`);
    if (!toBin) problems.push(`Part ${n}: toBin is needed.`);
    else if (toBin.length > 60 || /[<>&]/.test(toBin)) problems.push(`Part ${n}: that To bin name doesn't look right.`);
    else if (fba && toBin.toLowerCase() !== fbaBin.toLowerCase()) problems.push(`Part ${n}: FBA parts always assemble into bin ${fbaBin}, not ${toBin}.`);
    ids.add(itemId.toLowerCase()); finals.add(final.toLowerCase());
    out.push({ itemId, final, qty, toBin, fba, main: itemId.toLowerCase() === main.toLowerCase(), key: `${main}#o${n}`,
      ...(o.finalSize ? { finalSize: String(o.finalSize).trim().slice(0, 20) } : {}) });
  });
  if (!problems.length && !out.some((o) => o.main)) problems.push(`The main card ${main} must be one of the parts.`);
  if (problems.length) throw new HttpError(400, problems.join(" "));
  return out;
}
// Which split run a card belongs to (the main card's id), or null. Only non-main cards carry the mark.
async function splitOf(itemId) {
  const id = String(itemId || "").trim();
  if (!id || !RUN_KV) return null;
  const h = await durable.match(lockKey("splitof", id)).catch(() => null);
  if (!h) return null;
  const m = (await h.text()).trim();
  return m && m.toLowerCase() !== id.toLowerCase() ? m : null;
}
async function splitGuard(itemId) {
  const m = await splitOf(itemId);
  if (m) throw new HttpError(409, `This card is part of the split run on card ${m}. It assembles with that run, not on its own.`);
}
// The plan of a split run (READ-ONLY): the usual plan for the first part at the run's total, plus each other final.
async function splitPlan(env, body, outs) {
  const total = outs.reduce((t, o) => t + o.qty, 0);
  const base = await productionPlan(env, { ...body, final: outs[0].final, produced: total, finalSize: outs[0].finalSize || body.finalSize });
  const problems = [...base.problems];
  if (base.mode !== "pre-sized") problems.push("Split runs work for the 0.1 route only, not for a final that's a kit of the pound product itself.");
  const bridge = base.bridge || null;
  const per = base.perFinal ?? null;
  const fk0 = base.steps.find((x) => x.step === "final kit");
  const asm0 = base.steps.find((x) => x.step === "assemble") || {};
  const each = asm0.groups && asm0.groups.length === 1 ? asm0.groups[0].perKit : null;
  const fks = [{ ...fk0, sku: outs[0].final, outKey: outs[0].key }];
  for (const o of outs.slice(1)) {
    let fin;
    try { fin = await kitDefinition(env, o.final, { final: true }); }
    catch (e) { if (e.busy) throw e; problems.push(e.message || String(e)); fks.push({ step: "final kit", state: "different", current: [], want: null, sku: o.final, outKey: o.key, action: "stop" }); continue; }
    if (!fin.exists) { problems.push(`${o.final} isn't a product in Sellercloud. Create it there first.`); fks.push({ step: "final kit", state: "different", current: [], want: null, sku: o.final, outKey: o.key, action: "stop" }); continue; }
    if (fin.sellercloudSaid && !/is not a kit/i.test(fin.sellercloudSaid)) problems.push(`Couldn't read ${o.final}'s kit parts from Sellercloud (${fin.sellercloudSaid}). Try again in a minute.`);
    const fc = fin.components;
    const size = sizeTyped(o.finalSize) || sizeFromName(o.final) || sizeFromName(fin.name);
    const onBridge = !!bridge && fc.length === 1 && fc[0].sku.toLowerCase() === bridge.sku.toLowerCase();
    const v = size && size.whole ? size.units : onBridge && !size ? fc[0].perKit : null;
    if (fc.length && !onBridge) problems.push(`${o.final} is already a kit of ${fc.map((c) => `${c.sku} × ${c.perKit}`).join(", ")}, not of the 0.1 product.`);
    if (v == null) problems.push(`Size not clear for ${o.final}. Enter the size.`);
    else if (base.perSize != null && v !== base.perSize)
      problems.push(`${o.final} is ${round3(v / 10)} oz but ${outs[0].final} is ${round3(base.perSize / 10)} oz. Every part of a split run must be the same size.`);
    const st = bridge ? finalKitStep(fc, bridge.sku, per ?? v, v, "0.1") : { step: "final kit", state: "to set", current: fc, want: null, size };
    st.action = actionFor(st);
    fks.push({ ...st, sku: o.final, outKey: o.key });
  }
  const asms = outs.map((o, i) => ({ step: "assemble", sku: o.final, qty: o.qty, toBin: o.toBin, itemId: o.itemId, outKey: o.key, part: i + 1,
    fromBin: asm0.fromBin, perKitRecipe: per, perKitSize: base.perSize, perKitActual: each, uses: each != null ? each * o.qty : null,
    groups: each != null ? [{ kits: o.qty, perKit: each }] : null, action: "assemble",
    summary: each != null ? `${o.qty} × ${o.final} at ${each} units of ${bridge?.sku || "0.1"} each, into bin ${o.toBin}.` : null }));
  const steps = [];
  for (const st of base.steps) {
    if (st.step === "final kit") steps.push(...fks);
    else if (st.step === "assemble") steps.push(...asms);
    else steps.push(st);
  }
  const splitGroups = each != null ? outs.map((o) => ({ kits: o.qty, perKit: each, sku: o.final, toBin: o.toBin, itemId: o.itemId, key: o.key })) : null;
  return { ...base, split: true, produced: total, final: { sku: outs[0].final, name: base.final?.name ?? null },
    outputs: outs.map((o, i) => ({ itemId: o.itemId, final: o.final, qty: o.qty, toBin: o.toBin, fba: o.fba, main: o.main, step: asms[i].summary })),
    splitGroups, steps, problems, ok: problems.length === 0, features: SPLIT_FEATURES };
}
// The run's body with its outputs in their checked form, for the job and the produce step.
function splitBody(body, outs) {
  const total = outs.reduce((t, o) => t + o.qty, 0);
  return { ...body, outputs: outs, produced: total, final: outs[0].final, toBin: outs[0].toBin };
}
// ---- Mix kits (Shragy, Nov 19): one final kit made from several source products. -------------------------------
// Same rules as a single kit, per product: each source breaks down into its own 0.1 product in the 0.1 bin; per kit
// for that 0.1 product = this run's units of it ÷ qty produced, rounded down; the final's recipe gets one line per
// 0.1 product, set to those real numbers before the run; ONE assembly (sent as the run total) into the To bin; each
// 0.1 product's leftover is removed afterwards with one adjustment naming the run. Only this run's 0.1 units count.
// Weight check before Run (his words: "if we use 10 pounds to create 400 1 pounders that is obviusly not making
// sense"): weight in = each source's bin qty × its weight (bulk by lb: 1 unit = 1 lb; others: the oz in the SKU or
// name), weight out = the final's size × qty produced; more than maxDiffPct (default 10) apart blocks, no override.
// A source whose type isn't clear blocks until the Hub sends it (types), picked by the person assembling.
// Mix mode only when `sources` holds 2 or more SKUs; single kits are untouched.
function listParam(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  const t = String(v ?? "").trim();
  if (!t) return [];
  if (t.startsWith("[")) { try { return listParam(JSON.parse(t)); } catch { /* fall through */ } }
  return t.split(",").map((x) => x.trim()).filter(Boolean);
}
// types: {"SKU": "lb"|"oz"|"10oz"} or "SKU1:lb,SKU2:oz" (split at each entry's last colon). Keys compared lower-case.
function typesParam(v) {
  let obj = {};
  if (v && typeof v === "object" && !Array.isArray(v)) obj = v;
  else {
    const t = String(v ?? "").trim();
    if (t.startsWith("{")) { try { obj = JSON.parse(t) || {}; } catch { obj = {}; } }
    else for (const e of t.split(",")) { const i = e.lastIndexOf(":"); if (i > 0) obj[e.slice(0, i).trim()] = e.slice(i + 1).trim(); }
  }
  const out = {};
  for (const [k, val] of Object.entries(obj)) if (k && val != null && String(val).trim()) out[k.toLowerCase()] = String(val).trim();
  return out;
}
const isMix = (q) => listParam(q?.sources).length >= 2;
// What one unit of a source weighs: { type: "lb"|"oz"|"unknown", from, unitsPer (0.1 units in one), ozPer, size }.
function sourceKind(sku, name, given) {
  const t = `${sku} ${name || ""}`;
  const named = sizeFromName(sku) || sizeFromName(name);
  if (given) {
    if (/^lbs?$/i.test(given)) return { type: "lb", from: "picked", unitsPer: 160, ozPer: 16, size: "1 lb" };
    if (/^oz$/i.test(given)) return named && named.whole
      ? { type: "oz", from: "picked", unitsPer: named.units, ozPer: named.oz, size: named.text }
      : { type: "oz", from: "picked", unitsPer: null, ozPer: null, size: null, needSize: true };
    const z = sizeTyped(given);
    if (z && z.whole) return { type: "oz", from: "picked", unitsPer: z.units, ozPer: z.oz, size: z.text };
  }
  if (isByPound(t)) return { type: "lb", from: "name", unitsPer: 160, ozPer: 16, size: "1 lb" };
  const bulk = /\bbulk\b/i.test(t), lbWord = /(^|[^\d.\s])\s*\blbs?\b/i.test(t) && !named;
  if (!named && (bulk || lbWord)) return { type: "lb", from: "name", unitsPer: 160, ozPer: 16, size: "1 lb" };
  if (named && !bulk) return named.whole
    ? { type: "oz", from: "name", unitsPer: named.units, ozPer: named.oz, size: named.text }
    : { type: "unknown", from: null, unitsPer: null, ozPer: null, size: named.text };
  return { type: "unknown", from: null, unitsPer: null, ozPer: null, size: named ? named.text : null };
}
// The 0.1 product of one source: its own kit part first, then a name match, else a new one to create.
async function mixBridge(env, sourceSku, source) {
  const br = await bridgeFor(env, sourceSku);
  const kitBridge = br.bridgeInKit.length === 1 && source.components.length === 1 ? br.bridgeInKit[0] : null;
  if (kitBridge) return { bridge: { sku: kitBridge.sku, name: kitBridge.name }, state: "found (source's kit part)", kitBridge, br };
  const matches = br.bridgeCandidates.filter((c) => bridgeMatch(br.searchedFor, c));
  if (matches.length === 1) return { bridge: matches[0], state: "found (name match)", kitBridge: null, br };
  if (matches.length > 1) return { bridge: null, state: "unsure: more than one match", problem: `More than one 0.1 product could be ${sourceSku}'s: ${matches.map((m) => m.sku).join(", ")}.`, br };
  const newSku = newBridgeSku(br.searchedFor || sourceSku);
  if (!newSku) return { bridge: null, state: "unsure", problem: `Couldn't make a 0.1 SKU from ${source.name || sourceSku}.`, br };
  if (await findProduct(env, newSku)) return { bridge: null, state: "unsure: SKU taken", problem: `${newSku} already exists in Sellercloud but doesn't look like ${sourceSku}'s 0.1 product. Check it.`, br };
  return { bridge: { sku: newSku, name: newSku, isNew: true }, state: "to create", kitBridge: null, br };
}
const mixKey = (itemId, x) => `${itemId}|${String(x).toLowerCase()}`;
async function readRec(kind, id) {
  const h = await durable.match(lockKey(kind, id)).catch(() => null);
  if (!h) return null;
  try { return JSON.parse(await h.text()); } catch { return null; }
}
const putRec = (kind, id, val) => durable.put(lockKey(kind, id), new Response(JSON.stringify(val), { headers: { "cache-control": "max-age=2592000" } }));
// A started mix run: its saved parts (per-kit numbers) and each source's break-down record.
async function withMixRun(q) {
  const itemId = String(q?.itemId || "").trim();
  if (!itemId || !RUN_KV) return q;
  const run = await readRec("mixrun", itemId);
  if (!run) return q;
  const dis = {};
  for (const s of run.sources || []) { const d = await readRec("disrec", mixKey(itemId, s.sku)); if (d) dis[s.sku.toLowerCase()] = d; }
  return { ...q, mixRun: run, mixDis: dis };
}

async function mixPlan(env, q) {
  needCompany(env);
  const skus = listParam(q.sources), finalSku = String(q.final || "").trim(), fromBin = String(q.fromBin || "").trim();
  const produced = Number(q.produced), types = typesParam(q.types);
  if (skus.length < 2) throw new HttpError(400, "sources needs 2 or more SKUs for a mix.");
  if (new Set(skus.map((x) => x.toLowerCase())).size !== skus.length) throw new HttpError(400, "A SKU is listed twice in sources.");
  if (!finalSku) throw new HttpError(400, "final (the final listing's SKU) is needed.");
  if (skus.some((x) => x.toLowerCase() === finalSku.toLowerCase())) throw new HttpError(400, "The final listing can't also be a source.");
  if (!Number.isInteger(produced) || produced < 1) throw new HttpError(400, "produced must be a whole number, 1 or more.");
  const maxPct = Math.max(1, Number(q.maxDiffPct) || Number(env.PRODUCE_MAX_DIFF_PCT || 10) || 10);
  const bBin = bridgeBinName(env), run = q.mixRun || null, dis = q.mixDis || {};
  const problems = [], steps = [], sources = [], unknownTypes = [];
  if (!fromBin) problems.push("Pick the From bin.");

  const final = await kitDefinition(env, finalSku, { final: true });
  if (!final.exists) problems.push(`${finalSku} isn't a product in Sellercloud. Create it there first.`);
  else if (final.sellercloudSaid && !/is not a kit/i.test(final.sellercloudSaid)) problems.push(`Couldn't read ${finalSku}'s kit parts from Sellercloud (${final.sellercloudSaid}). Try again in a minute.`);
  const finalSize = sizeTyped(q.finalSize) || sizeFromName(finalSku) || sizeFromName(final.name);
  if (!finalSize) problems.push(`Size not clear for ${finalSku}. Enter the size.`);

  for (const sku of skus) {
    const src = await kitDefinition(env, sku);
    if (!src.exists) { problems.push(`No product with SKU ${sku} in Sellercloud.`); sources.push({ sku, exists: false, type: "unknown" }); continue; }
    if (src.sellercloudSaid && !/is not a kit/i.test(src.sellercloudSaid)) problems.push(`Couldn't read ${sku}'s kit parts from Sellercloud (${src.sellercloudSaid}). Try again in a minute.`);
    const b = await mixBridge(env, sku, src);
    if (b.problem) problems.push(b.problem);
    const kind = sourceKind(sku, src.name, types[sku.toLowerCase()]);
    // An existing kit of its 0.1 product says how many units one holds; a type picked or read from the name must agree.
    let unitsPer = kind.unitsPer, type = kind.type;
    if (b.kitBridge) {
      if (unitsPer != null && unitsPer !== b.kitBridge.perKit)
        problems.push(`${sku} is a kit of ${b.kitBridge.perKit} × ${b.kitBridge.sku} in Sellercloud (${b.kitBridge.perKit / 10} oz), but its ${kind.from === "picked" ? "picked type" : "name"} says ${kind.size} (${unitsPer} units). Check which is right.`);
      unitsPer = b.kitBridge.perKit;
      if (type === "unknown") type = "kit";
    } else if (src.components.length) problems.push(`${sku} is already a kit of ${src.components.map((c) => `${c.sku} × ${c.perKit}`).join(", ")}, not of a 0.1 product.`);
    if (type === "unknown" || unitsPer == null) {
      unknownTypes.push(sku);
      problems.push(kind.needSize ? `Size not clear for ${sku}. Enter its size in oz.` : `Type not clear for ${sku}: pick bulk by lb or oz.`);
    }
    // This run's units: its saved break-down once it has run, else what's in the From bin now.
    const d = dis[sku.toLowerCase()];
    let binQty = null;
    if (fromBin) binQty = ((await productBins(env, sku)).bins.find((x) => x.bin.toLowerCase() === fromBin.toLowerCase()) || {}).qty || 0;
    if (fromBin && !d && !(binQty > 0)) problems.push(`Bin ${fromBin} has no ${sku}.`);
    const qty = d ? d.qty : binQty;
    const units = d ? d.units : qty != null && unitsPer != null ? qty * unitsPer : null;
    sources.push({ sku, name: src.name, exists: true, type, typeFrom: b.kitBridge && kind.type === "unknown" ? "kit" : kind.from, size: kind.size,
      unitsPer, bridge: b.bridge, bridgeState: b.state, binQty: qty, units, weightOz: units != null ? round3(units / 10) : null, brokenDown: !!d });

    steps.push({ step: "0.1 product", sku, state: b.state, bridgeSku: b.bridge?.sku ?? null, name: b.bridge?.name ?? null,
      summary: b.bridge ? (b.state === "to create" ? `Create ${b.bridge.sku}.` : `${sku}'s 0.1 product is ${b.bridge.sku}.`) : null });
    const kitToSet = !b.kitBridge && !src.components.length;
    let stock = null;
    if (kitToSet && !d) {
      stock = await sourceStock(env, sku);
      if (stock.problem) problems.push(stock.problem);
      else if (stock.bins.length) steps.push({ step: "empty source", sku, bins: stock.bins, total: stock.total, warehouse: assembleWarehouse(env),
        summary: `Take ${stock.total} ${sku} out of ${stock.bins.map((e) => "bin " + e.bin).join(", ")} to set its kit; put back right after.` });
    }
    steps.push({ step: "source kit", sku, state: b.kitBridge ? "ready" : src.components.length ? "different" : "to set", current: src.components,
      want: unitsPer != null && b.bridge ? { sku: b.bridge.sku, perKit: unitsPer } : null,
      summary: b.kitBridge ? `${sku} is a kit of ${b.kitBridge.perKit} × ${b.kitBridge.sku}.` : unitsPer != null && b.bridge ? `Set ${sku} as a kit of ${unitsPer} × ${b.bridge.sku}.` : null });
    if (stock && !stock.problem && stock.bins.length)
      steps.push({ step: "put back source", sku, bins: stock.bins, total: stock.total, warehouse: assembleWarehouse(env), summary: `Put the ${stock.total} ${sku} back.` });
    steps.push(d
      ? { step: "disassemble", sku, qty: d.qty, from: sku, unitsOut: d.units, into: bBin, done: true, summary: `Broke down ${d.qty} ${sku} into ${d.units} units of ${d.bridge} in bin ${bBin}.` }
      : { step: "disassemble", sku, qty: binQty, from: sku, unitsOut: units, into: bBin,
          summary: binQty > 0 && units != null && b.bridge ? `Break down ${binQty} ${sku} from bin ${fromBin} into ${units} units of ${b.bridge.sku} in bin ${bBin}.` : null });
  }

  // Weight check: in = this run's sources, out = final size × qty produced.
  const known = sources.every((x) => x.weightOz != null);
  const inOz = known ? round3(sources.reduce((t, x) => t + x.weightOz, 0)) : null;
  const outOz = finalSize ? round3(finalSize.oz * produced) : null;
  const diffPct = inOz != null && outOz ? Math.round(Math.abs(inOz - outOz) / outOz * 1000) / 10 : null;
  const weight = { inOz, outOz, inLb: inOz != null ? round3(inOz / 16) : null, outLb: outOz != null ? round3(outOz / 16) : null, diffPct, maxPct, ok: diffPct != null && diffPct <= maxPct };
  if (diffPct != null && diffPct > maxPct)
    problems.push(`The weight doesn't add up: ${weight.inLb} lb goes in (${sources.map((x) => `${x.sku} ${round3(x.weightOz / 16)} lb`).join(", ")}), but ${produced} × ${finalSize.text} is ${weight.outLb} lb, ${diffPct}% off. More than ${maxPct}% off blocks. Check the qty produced and the bins.`);

  // One recipe line per 0.1 product (two sources with the same 0.1 product share a line).
  const byBridge = new Map();
  for (const x of sources) if (x.bridge && x.units != null) {
    const k = x.bridge.sku.toLowerCase();
    const e = byBridge.get(k) || { sku: x.bridge.sku, units: 0, sources: [] };
    e.units += x.units; e.sources.push(x.sku); byBridge.set(k, e);
  }
  const savedPer = new Map((run?.parts || []).map((p) => [p.sku.toLowerCase(), p]));
  const parts = [...byBridge.values()].map((e) => {
    const sp = savedPer.get(e.sku.toLowerCase());
    const perKit = sp ? sp.perKit : Math.floor(e.units / produced);
    const leftover = sp ? sp.leftover : e.units - perKit * produced;
    return { sku: e.sku, sources: e.sources, units: sp ? sp.units : e.units, perKit, leftover };
  });
  for (const pt of parts) if (!(pt.perKit >= 1)) problems.push(`${pt.units} units of ${pt.sku} aren't enough for ${produced} kits.`);
  const allParts = known && sources.every((x) => x.bridge) && parts.length > 0;

  // The final's recipe: one line per 0.1 product at this run's real per kit.
  const fc = final.components || [];
  const want = allParts ? parts.map((pt) => ({ sku: pt.sku, perKit: pt.perKit })) : null;
  const sameSet = want && fc.length === want.length && want.every((w) => fc.some((c) => c.sku.toLowerCase() === w.sku.toLowerCase()));
  const fState = !want ? (fc.length ? "different" : "to set") : sameSet
    ? (want.every((w) => fc.find((c) => c.sku.toLowerCase() === w.sku.toLowerCase()).perKit === w.perKit) ? "ready" : "to change")
    : fc.length ? "different" : "to set";
  if (fState === "different" && want) problems.push(`${finalSku} is already a kit of ${fc.map((c) => `${c.sku} × ${c.perKit}`).join(", ")}, not of this mix's 0.1 products. Change its Kit tab first.`);
  const recipeText = (list) => list.map((w) => `${w.perKit} ${w.sku}`).join(" + ");
  steps.push({ step: "final kit", sku: finalSku, state: fState, current: fc, want: want ? { parts: want } : null, size: finalSize,
    recipeFrom: fState === "to change" ? fc.map((c) => ({ sku: c.sku, perKit: c.perKit })) : null, recipeTo: fState === "to change" ? want : null,
    summary: !want ? null : fState === "ready" ? `Kit recipe already ${recipeText(want)} per kit.`
      : fState === "to change" ? `Set kit recipe ${recipeText(fc)} → ${recipeText(want)} per kit.`
      : fState === "to set" ? `Set the kit recipe to ${recipeText(want)} per kit.` : null });
  steps.push({ step: "assemble", sku: finalSku, qty: produced, fromBin: bBin, parts: allParts ? parts : null,
    summary: allParts ? `${produced} kits × (${recipeText(parts)}), one assembly from bin ${bBin}.` : null });
  for (const pt of parts) if (pt.leftover > 0)
    steps.push({ step: "empty leftover", sku: pt.sku, bin: bBin, qty: pt.leftover,
      summary: `Remove this run's ${pt.leftover} leftover ${pt.sku} from bin ${bBin} after assembling (adjustment, reason names the run); other stock in the bin stays.` });

  if (produced > assembleMax(env)) problems.push(`At most ${assembleMax(env)} kit${assembleMax(env) === 1 ? "" : "s"} per press for now.`);
  for (const st of steps) st.action = actionFor(st);
  return { mode: "mix", source: null, sources, final: { sku: finalSku, name: final.name, size: finalSize }, parts, recipe: want,
    weight, unknownTypes, perFinal: null, fromBin: fromBin || null, bridgeBin: bBin, produced, steps, problems,
    ok: problems.length === 0 && unknownTypes.length === 0, assemblyOn: assembleOn(env), maxQty: assembleMax(env) };
}

// Several kit lines in one Kits import (the final's recipe). { jobId } or { error }.
async function sendKitRows(env, rows, overwrite) {
  const res = await scPost(env, "/Catalog/Imports/Kits", {
    Format: 1, FileContents: b64(kitCsv(rows)), FileExtension: ".csv", Metadata: { OverwriteExistingKits: !!overwrite },
  });
  const jobId = importJobId(res);
  if (!jobId) return { jobId: null };
  await sleep(2000);
  const j = await kitJob(env, jobId).catch(() => ({}));
  if (j.error) return { jobId, error: `Sellercloud said: ${String(j.error).slice(0, 300)}` };
  return { jobId };
}

// Setup for a mix: one write per call, in order: each 0.1 product, each source kit (emptied and put back if it has
// stock), then the final's recipe. Same records and waits as a single kit.
async function mixSetupStep(env, body) {
  if (!assembleOn(env)) throw new HttpError(403, "Sellercloud writes are switched off. They turn on once ASSEMBLE_ENABLED is set to yes.");
  const state = {};
  const tag = `monday item ${String(body.itemId || "").slice(0, 40) || "?"}`;
  const reply = (r) => ({ ...r, state: mergeState(body.state, state) });
  const skus = listParam(body.sources);
  // A source emptied for its kit: finish that first.
  for (const sku of skus) {
    const cz = await continueZeroed(env, sku, body, state, reply, tag, async () => {
      const plan = await mixPlan(env, body);
      return plan.steps.find((x) => x.step === "source kit" && x.sku.toLowerCase() === sku.toLowerCase())?.want || null;
    });
    if (cz) return cz;
  }
  const plan = await mixPlan(env, body);
  const blocking = plan.problems.filter((p) => !/^Bin .* has no |^Pick the From bin|aren't enough for|^At most \d+ kit/.test(p));
  if (blocking.length) return reply({ saved: false, error: blocking.join(" "), plan });
  if (plan.unknownTypes.length) return reply({ saved: false, error: `Pick bulk by lb or oz for ${plan.unknownTypes.join(", ")} first.`, plan });
  const kitOf = (x) => x.step === "final kit" ? plan.final.sku : x.sku;
  // Kits already sent: wait for them to show.
  for (const x of plan.steps.filter((y) => (y.step === "source kit" || y.step === "final kit") && y.action === "set")) {
    const kit = kitOf(x);
    const job = await recGet("kitjob", kit, body);
    if (!job) continue;
    const j = job.jobId ? await kitJob(env, job.jobId).catch(() => ({})) : {};
    if (j.error) { await recDel("kitjob", kit, state); return reply({ saved: false, error: `Setting ${kit}: Sellercloud said: ${String(j.error).slice(0, 300)}`, plan }); }
    if (Date.now() - (job.at || 0) < KIT_WAIT_MS) return reply({ saved: false, continue: true, message: `Waiting for Sellercloud to show ${kit}'s kit.`, plan });
    if (x.step === "final kit" && x.state === "to change" && job.overwrite && !job.retried && x.want) {
      const rows = x.want.parts.map((w) => ({ kit, part: w.sku, perKit: w.perKit }));
      const sent2 = await sendKitRows(env, rows, false);
      if (sent2.error) { await recDel("kitjob", kit, state); return reply({ saved: false, error: `Changing ${kit}'s recipe: ${sent2.error}`, plan }); }
      await recSet("kitjob", kit, { jobId: sent2.jobId, at: Date.now(), parts: x.want.parts, overwrite: false, retried: true }, state);
      return reply({ saved: false, continue: true, message: `Sellercloud hadn't shown ${kit}'s new recipe yet, so I sent it once more. Waiting for it to show.`, plan });
    }
    await recDel("kitjob", kit, state);
    const logs = await jobLogs(env, job.jobId);
    if (x.step === "final kit" && x.state === "to change")
      return reply({ saved: false, error: `Sellercloud still doesn't show ${kit}'s new recipe after sending it twice. Nothing was broken down or assembled.${j.said ? ` Import job ${job.jobId}: ${j.said.slice(0, 200)}.` : ""}${logText(logs)} You can change it in its Kit tab, then press Run again.`, jobLog: logs, plan });
    return reply({ saved: false, pending: true, message: `Sellercloud hadn't shown ${kit}'s kit after 2 minutes.${j.said ? ` Import job ${job.jobId}: ${j.said.slice(0, 200)}.` : ""}${logText(logs)} Check its Kit tab in a minute, then press Run again.`, jobLog: logs, plan });
  }
  for (const x of plan.steps.filter((y) => (y.step === "source kit" || y.step === "final kit") && y.action === "skip"))
    if (await recGet("kitjob", kitOf(x), body)) await recDel("kitjob", kitOf(x), state);
  const todo = plan.steps.filter((x) => ["create", "set"].includes(x.action));
  if (!todo.length) return reply({ saved: true, unchanged: true, message: "Everything is set up in Sellercloud.", plan });

  // 1. A missing 0.1 product.
  const b = plan.steps.find((x) => x.step === "0.1 product" && x.action === "create");
  if (b) {
    const src = plan.sources.find((x) => x.sku === b.sku);
    const type = src ? (await kitDefinition(env, src.sku)).productType : null;
    if (!type) return reply({ saved: false, error: `Couldn't tell ${b.sku}'s product type, so I didn't create its 0.1 product.`, plan });
    if (!(await findProduct(env, b.bridgeSku))) {
      if (await isLocked("creating", b.bridgeSku)) return reply({ saved: false, continue: true, message: `Waiting for Sellercloud to show ${b.bridgeSku}.`, plan });
      await lock("creating", b.bridgeSku, 120);
      await scPost(env, "/Products", { CompanyId: warehouseCompanyId(env) || 317, ProductSKU: b.bridgeSku, ProductName: b.bridgeSku, ProductTypeName: type });
    }
    return reply({ saved: false, continue: true, message: `Created ${b.bridgeSku}.`, plan });
  }
  // 2. A source kit (emptied first when it has stock; Sellercloud won't make a stocked product a kit).
  const sk = plan.steps.find((x) => x.step === "source kit" && x.action === "set");
  if (sk) {
    if (!sk.want || !Number.isInteger(sk.want.perKit) || sk.want.perKit < 1) return reply({ saved: false, error: `Couldn't tell what ${sk.sku}'s kit should be.`, plan });
    const r = { kit: sk.sku, part: sk.want.sku, perKit: sk.want.perKit };
    const emptyStep = plan.steps.find((x) => x.step === "empty source" && x.sku === sk.sku);
    if (emptyStep) {
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
    const sent = await sendKit(env, r, false);
    if (sent.error) return reply({ saved: false, error: `Setting ${r.kit}: ${sent.error}`, plan });
    await recSet("kitjob", r.kit, { jobId: sent.jobId, at: Date.now(), part: r.part, perKit: r.perKit }, state);
    return reply({ saved: false, continue: true, message: `Sent ${r.kit}'s kit to Sellercloud. Waiting for it to show.`, plan });
  }
  // 3. The final's recipe, one line per 0.1 product.
  const fk = plan.steps.find((x) => x.step === "final kit" && x.action === "set");
  if (fk) {
    if (!fk.want || fk.want.parts.some((w) => !Number.isInteger(w.perKit) || w.perKit < 1)) return reply({ saved: false, error: "A kit qty isn't a whole number.", plan });
    const kit = plan.final.sku, change = fk.state === "to change";
    if (change) {
      const e = await editKitParts(env, kit, fk.want.parts.map((w) => ({ sku: w.sku, perKit: w.perKit })), "Recipe for this mix run");
      if (e.ok) return reply({ saved: false, continue: true, message: `Changed ${kit}'s recipe in Sellercloud (${fk.summary.replace(/^Set (the )?kit recipe (to )?/, "").replace(/\.$/, "")}).`, plan });
      if (e.error) return reply({ saved: false, critical: !!e.critical, error: `Changing ${kit}'s recipe: ${e.error} Nothing was broken down or assembled.`, plan });
    }
    const sent = await sendKitRows(env, fk.want.parts.map((w) => ({ kit, part: w.sku, perKit: w.perKit })), change);
    if (sent.error) return reply({ saved: false, error: `${change ? "Changing" : "Setting"} ${kit}'s recipe: ${sent.error}`, plan });
    await recSet("kitjob", kit, { jobId: sent.jobId, at: Date.now(), parts: fk.want.parts, overwrite: change }, state);
    return reply({ saved: false, continue: true, message: `Sent ${kit}'s ${change ? "new " : ""}recipe to Sellercloud (${fk.summary.replace(/^Set (the )?kit recipe (to )?/, "").replace(/\.$/, "")}). Waiting for it to show.`, plan });
  }
  return reply({ saved: false, error: "Nothing left I can set up; check the plan.", plan });
}

// Produce for a mix: break down each source into the 0.1 bin (one record each), then ONE assembly of the final with
// the recipe's per-kit numbers (sent as run totals), then each 0.1 product's leftover removed. Records as single kits.
async function mixProduce(env, body) {
  if (!assembleOn(env)) throw new HttpError(403, "Kit assembly is switched off. It turns on once ASSEMBLE_ENABLED is set to yes.");
  if (!RUN_KV) throw needKv();
  const skus = listParam(body.sources);
  for (const sku of skus) if (await durable.match(lockKey("zeroed", sku)))
    return { done: false, status: "failed", message: `${sku} was emptied for its kit setup and not put back yet. Press Run on the setup again first.` };
  const itemId = String(body.itemId || "").trim();
  if (!itemId) throw new HttpError(400, "itemId (the monday item) is needed so a production only runs once.");
  const fromBin = await realBin(env, binName(body.fromBin), "From"), toBin = await realBin(env, binName(body.toBin), "To");
  const plan = await mixPlan(env, await withMixRun({ ...body, fromBin }));
  const bBin = await realBin(env, plan.bridgeBin, "0.1");
  const notReady = plan.steps.filter((s) => ["create", "set", "stop"].includes(s.action));
  if (notReady.length) {
    const ch = notReady.find((s) => s.step === "final kit" && s.state === "to change");
    throw new HttpError(409, ch && notReady.length === 1
      ? `${plan.final.sku}'s kit recipe isn't this run's numbers yet (${ch.summary}), so nothing was assembled. Run the setup again first; it changes the recipe.`
      : "Set up the 0.1 products and kits first.");
  }
  let run = await readRec("mixrun", itemId);
  const asmState = await confirmAsm(env, itemId);
  if (asmState.state === "pending") return { done: false, continue: true, status: "assemble not confirmed", message: asmState.message };
  if (asmState.state === "bad") return { done: false, status: "partly changed", message: asmState.message };
  const assembled = asmState.state === "confirmed";
  if (!run) {
    if (assembled) return { done: false, status: "no break-down record", message: `${plan.final.sku} was assembled for this item, but there's no record of the mix run. Check Sellercloud, then clear and run again.` };
    if (!plan.ok) throw new HttpError(409, [...plan.problems, ...(plan.unknownTypes.length ? [`Pick bulk by lb or oz for ${plan.unknownTypes.join(", ")}.`] : [])].join(" "));
    run = { produced: plan.produced, final: plan.final.sku, at: Date.now(),
      sources: plan.sources.map((x) => ({ sku: x.sku, bridge: x.bridge.sku, qty: x.binQty, unitsPer: x.unitsPer, units: x.units })),
      parts: plan.parts.map((pt) => ({ sku: pt.sku, units: pt.units, perKit: pt.perKit, leftover: pt.leftover, sources: pt.sources })) };
    await putRec("mixrun", itemId, run);
  }
  const breakdowns = [];
  if (!assembled) {
    // 1. Break down each source once, into the 0.1 bin. Each 0.1 product's bin qty is saved before its first break-down.
    for (const s of run.sources) {
      const dKey = mixKey(itemId, s.sku);
      const rec = await readRec("disrec", dKey);
      if (rec) {
        const srcNow = await binQtyOf(env, s.sku, fromBin);
        if (!(rec.srcBefore - srcNow >= rec.qty))
          return { done: false, continue: true, status: "waiting", message: `Sellercloud still shows ${srcNow} of ${s.sku} in bin ${fromBin} after the break-down of ${rec.qty}. Wait a minute, then press Run again.` };
        continue;
      }
      if (await isLocked("disassembled", dKey))
        return { done: false, status: "no break-down record", message: `${s.sku} was sent for break-down without a record of its 0.1 units, so I stopped. Check Sellercloud, then clear and run again.` };
      if (timeUp()) return { done: false, continue: true, status: "breaking down", message: `Broke down ${breakdowns.length} so far. Carrying on.`, breakdowns };
      const base = mixKey(itemId, "base:" + s.bridge);
      if (!(await readRec("brbase", base))) await putRec("brbase", base, { qty: await binQtyOf(env, s.bridge, bBin), at: Date.now() });
      const before = { src: await binQtyOf(env, s.sku, fromBin), br: await binQtyOf(env, s.bridge, bBin) };
      if (before.src < s.qty) return { done: false, status: "numbers off", message: `Bin ${fromBin} now has ${before.src} of ${s.sku}, not the ${s.qty} this run was planned with. Nothing more was broken down. Check Sellercloud, then clear and run again.` };
      await putRec("disrec", dKey, { qty: s.qty, units: s.qty * s.unitsPer, bridge: s.bridge, bin: bBin, fromBin, srcBefore: before.src, bridgeBefore: before.br, at: Date.now() });
      await lock("disassembled", dKey, 0);
      await lock("disassembled", itemId, 0); // the item-level flag the Hub reads (disassembleSent)
      let err = null;
      try {
        await soapCall(env, SOAP_DISASSEMBLE,
          `<KitParentProductID>${xmlEsc(s.sku)}</KitParentProductID>` +
          `<QtyToDisAssemble>${s.qty}</QtyToDisAssemble>` +
          `<DisAssembleIntoWarehouseID>${assembleWarehouse(env)}</DisAssembleIntoWarehouseID>` +
          `<DestinationBinName>${xmlEsc(bBin)}</DestinationBinName>` +
          `<OriginalBinName>${xmlEsc(fromBin)}</OriginalBinName>` +
          (await expiryXml(env, SOAP_DISASSEMBLE)));
      } catch (e) { err = e.message || String(e); }
      let after, moved = false, nothing = true;
      for (let i = 0; i < 16; i++) {
        after = { src: await binQtyOf(env, s.sku, fromBin), br: await binQtyOf(env, s.bridge, bBin) };
        moved = before.src - after.src === s.qty && after.br - before.br === s.qty * s.unitsPer;
        nothing = before.src === after.src && before.br === after.br;
        if (moved || (err && i >= 1) || timeUp()) break;
        await sleep(4000);
      }
      breakdowns.push({ sku: s.sku, qty: s.qty, units: s.qty * s.unitsPer, srcBefore: before.src, srcAfter: after.src, bridgeBefore: before.br, bridgeAfter: after.br, error: err });
      if (!moved) return { done: false, continue: !(nothing && err), status: nothing && err ? "disassemble failed" : "disassemble not confirmed",
        message: nothing && err ? `${s.sku} not broken down. ${err}` : `Sellercloud hasn't shown the break-down of ${s.sku} in bin ${bBin} yet. Wait a minute, then press Run again; it carries on from this run's records.`, breakdowns };
    }
    // 2. Wait for this run's units of each 0.1 product in the 0.1 bin (over what it held before), then ONE assembly.
    for (const pt of run.parts) {
      const base = await readRec("brbase", mixKey(itemId, "base:" + pt.sku));
      if (!base) return { done: false, status: "no break-down record", message: `There's no record of what bin ${bBin} held of ${pt.sku} before this run, so I didn't assemble (it would mix in other stock). Check Sellercloud, then clear and run again.` };
      const need = pt.perKit * run.produced;
      let inBin = await binQtyOf(env, pt.sku, bBin);
      for (let j = 0; j < 15 && inBin - base.qty < need && !timeUp(); j++) { await sleep(3000); inBin = await binQtyOf(env, pt.sku, bBin); }
      if (inBin - base.qty < need)
        return { done: false, continue: true, status: "waiting for parts", message: `Waiting for Sellercloud to show this run's ${pt.sku} units in bin ${bBin} (shows ${Math.max(0, inBin - base.qty)} of ${need}).`, breakdowns };
    }
    const asm = await assembleKit(env, { sku: plan.final.sku, qty: run.produced, itemId, fromBin: bBin, toBin,
      expectParts: run.parts.map((pt) => ({ sku: pt.sku, perKit: pt.perKit })) });
    if (!asm.done) return { done: false, continue: !!asm.continue, status: asm.status, message: asm.message, assemble: asm, breakdowns };
  }
  // 3. Each 0.1 product's leftover: only this run's, out of the 0.1 bin.
  const removed = [];
  for (const pt of run.parts) {
    if (!(pt.leftover > 0)) continue;
    const eKey = mixKey(itemId, pt.sku);
    if (await isLocked("emptied", eKey)) continue;
    if (!(pt.leftover < run.produced)) return { done: false, status: "leftover too big", message: `Assembled, but ${pt.leftover} units of ${pt.sku} are left, more than one per kit, so I didn't remove them. Check the counts.` };
    const base = await readRec("brbase", mixKey(itemId, "base:" + pt.sku));
    if (!base) return { done: false, status: "leftover not removed", message: `Assembled, but there's no record of what bin ${bBin} held of ${pt.sku} before this run, so I didn't remove its ${pt.leftover} leftover. Check Sellercloud.` };
    const expect = base.qty + pt.leftover;
    let before = await binQtyOf(env, pt.sku, bBin);
    for (let i = 0; i < 15 && before !== expect && !timeUp(); i++) { await sleep(4000); before = await binQtyOf(env, pt.sku, bBin); }
    if (before !== expect) return { done: false, continue: true, status: "leftover not found", message: `Assembled. Bin ${bBin} shows ${before} of ${pt.sku}, not the ${expect} expected (${base.qty} from before this run plus this run's ${pt.leftover} left over), so I didn't remove it yet. Wait a minute, then press Run again.`, removed };
    await lock("emptied", eKey, 0);
    await lock("emptied", itemId, 0); // the item-level flag the Hub reads (leftoverRemoved)
    let err = null;
    try {
      await soapCall(env, SOAP_ADJUST,
        `<ProductId>${xmlEsc(pt.sku)}</ProductId><BinName>${xmlEsc(bBin)}</BinName>` +
        `<WarehouseID>${assembleWarehouse(env)}</WarehouseID><Qty>${-pt.leftover}</Qty>` +
        `<reason>${xmlEsc(`Production leftover 0.1 after assembling ${run.produced} x ${plan.final.sku} (monday item ${itemId})`)}</reason>` +
        `<SerialsList></SerialsList>${await expiryXml(env, SOAP_ADJUST)}<LotNumber></LotNumber>`);
    } catch (e) { err = e.message || String(e); }
    let after = await binQtyOf(env, pt.sku, bBin);
    for (let i = 0; i < 15 && before - after !== pt.leftover && !err; i++) { await sleep(4000); after = await binQtyOf(env, pt.sku, bBin); }
    const ok = before - after === pt.leftover;
    removed.push({ sku: pt.sku, bin: bBin, qty: pt.leftover, binBefore: before, binAfter: after, ok, error: err });
    if (!ok) return { done: false, status: before === after ? "leftover not removed" : "leftover not confirmed",
      message: before === after ? `Assembled, but the ${pt.leftover} leftover ${pt.sku} weren't removed. ${err || ""}`.trim()
        : `Assembled, but bin ${bBin} went from ${before} to ${after} for ${pt.sku} instead of down by ${pt.leftover}. Check Sellercloud.`, removed };
  }
  return { done: true, status: "assembled",
    message: `Assembled ${run.produced} × ${plan.final.sku} from bin ${bBin} to bin ${toBin}: ${run.parts.map((pt) => `${pt.perKit} ${pt.sku}`).join(" + ")} per kit.` +
      (removed.length ? ` Removed this run's leftover ${removed.map((r) => `${r.qty} ${r.sku}`).join(", ")} from bin ${bBin}.` : ""),
    breakdowns, removed, parts: run.parts };
}

// ---- Background kit runs (Shragy, Nov 19: "i want to be able to close a kit while its assembling and move on to the
// next ... it shold show exectly whats happening"). The Hub hands a kit to the worker once (POST /assemble/job) and
// can close the pop-up; a Durable Object (JobQueue, binding JOBS) keeps every job and drives it with its alarm, one
// step at a time: the same setup and produce code the Hub's own loop calls, with the same once-only records, so a
// job can never assemble or break down twice. Several kits run at once, a step of each in turn. A kit that shares a
// source product or its final with an earlier kit still running (or stopped and waiting to be cleared) waits for it.
// The Hub reads each job's steps and writes the board itself once a job is done, then acks it.
const JOB_STEP_MS = 25_000;            // one step's time box (the same as a Hub call)
const JOB_STUCK_MS = 20 * 60_000;       // no step finished for this long: stop with the last message
const JOB_KEEP_MS = 3 * 86400_000;      // finished jobs the Hub has acked are kept this long
const JOB_ACTIVE = new Set(["queued", "waiting", "running"]);
const jobKeyOf = (id) => "job:" + id;
const jobItemKey = (itemId) => "item:" + String(itemId).toLowerCase();
function callInit(env, ms) {
  reqEnv = env; RUN_KV = env.TOKEN_KV || null; callStart = Date.now(); deadline = callStart + ms; readCacheOn = false; quickBusy = false;
}
// What the Hub reads back for an item (assembleSent, assembleConfirmed, disassembleSent, leftoverRemoved).
async function itemSentFlags(iid) {
  if (!iid || !RUN_KV) return { assembleSent: null, disassembleSent: null };
  const asm = [iid, iid + "#g1", iid + "#g2", iid + "#g3", ...Array.from({ length: SPLIT_MAX }, (_, i) => `${iid}#o${i + 1}`)];
  let a = false, conf = null;
  for (const k of asm) {
    const hit = await durable.match(doneKey(k));
    if (!hit) continue;
    a = true;
    let rec = null; try { rec = JSON.parse(await hit.text()); } catch {}
    const ok = !!rec && rec.confirmed !== false && !rec.recipeUsed;
    conf = conf === null ? ok : conf && ok;
  }
  return { assembleSent: a, assembleConfirmed: a ? !!conf : false, disassembleSent: !!(await durable.match(lockKey("disassembled", iid))),
    leftoverRemoved: !!(await durable.match(lockKey("emptied", iid))) };
}
// Has this item already started (any run record)? Then the job carries on from its records instead of re-planning.
async function itemStarted(itemId) {
  if (!RUN_KV) return false;
  for (const k of [doneKey(itemId), lockKey("disrec", itemId), lockKey("disassembled", itemId), lockKey("mixrun", itemId), lockKey("groups", itemId)])
    if (await durable.match(k)) return true;
  return false;
}
const SETUP_STEPS = new Set(["0.1 product", "empty source", "source kit", "put back source", "final kit"]);
// Each plan step is keyed by its kind and the product it's about (a single kit's lines often carry no SKU).
function planStepSku(s, plan) {
  const src = plan.source?.sku || s.from || "";
  switch (s.step) {
    case "0.1 product": return plan.mode === "mix" ? s.sku : src;
    case "empty source": case "put back source": case "source kit": case "disassemble": return s.sku || src;
    case "final kit": case "assemble": return s.sku || plan.final?.sku || "";
    default: return s.sku || "";
  }
}
const jobStepKey = (step, sku) => `${step}|${String(sku || "").toLowerCase()}`;
function jobLabel(s, plan) {
  const src = planStepSku(s, plan), fin = s.sku || plan.final?.sku || "";
  switch (s.step) {
    case "0.1 product": return `Creating 0.1 product ${s.bridgeSku || s.sku}`;
    case "empty source": return `Emptying ${src} to set its kit`;
    case "source kit": return `Setting ${src} as a kit`;
    case "put back source": return `Putting ${src} back`;
    case "final kit": return s.state === "to change" ? `Changing ${fin}'s recipe` : `Setting ${fin}'s recipe`;
    case "disassemble": return `Breaking down ${src}`;
    case "assemble": return plan.split ? `Assembling ${s.qty} × ${fin} into bin ${s.toBin}` : `Assembling ${plan.produced} × ${fin}`;
    case "empty leftover": return `Removing leftover ${s.sku || "0.1"}`;
    default: return s.step;
  }
}
// The job's step list from the plan: every step still to do (steps already in place are left out).
function jobStepsFrom(plan) {
  const out = [];
  for (const s of plan.steps) {
    if (["0.1 product", "source kit", "final kit", "disassemble"].includes(s.step) && s.action === "skip") continue;
    if (s.step === "empty leftover" && !(s.qty > 0)) continue;
    const keySku = planStepSku(s, plan);
    out.push({ key: jobStepKey(s.step, keySku), keySku, step: s.step, phase: SETUP_STEPS.has(s.step) ? "setup" : "produce",
      label: jobLabel(s, plan), sku: s.step === "0.1 product" ? (s.bridgeSku || s.sku) : keySku || null, status: "pending",
      ...(s.outKey ? { outKey: s.outKey } : {}) });
  }
  // In the order they run: all setup (the final's recipe included) before any break-down.
  return [...out.filter((x) => x.phase === "setup"), ...out.filter((x) => x.phase === "produce")];
}
// Setup steps that a fresh plan shows in place (or gone) are done. Emptying and putting back are done once the kit
// is (a plan only comes back when no source is still emptied).
function jobMarkFromPlan(job, plan) {
  const byKey = new Map(plan.steps.map((s) => [jobStepKey(s.step, planStepSku(s, plan)), s]));
  for (const st of job.steps) {
    if (st.phase !== "setup" || st.status === "done") continue;
    const p = byKey.get(st.step === "put back source" || st.step === "empty source" ? jobStepKey("source kit", st.keySku) : st.key);
    if (!p || p.action === "skip") st.status = "done";
  }
}
// Produce steps from the item's records (no Sellercloud calls).
async function jobMarkFromRecords(job) {
  const itemId = job.itemId;
  for (const st of job.steps) {
    if (st.phase !== "produce" || st.status === "done") continue;
    if (st.step === "disassemble") {
      const rec = job.mode === "mix" ? await readRec("disrec", mixKey(itemId, st.keySku)) : await readRec("disrec", itemId);
      if (rec) st.status = "done";
    } else if (st.step === "assemble") {
      const hit = await durable.match(doneKey(st.outKey || itemId));
      if (hit) { let rec = null; try { rec = JSON.parse(await hit.text()); } catch {} if (rec && rec.confirmed !== false && !rec.recipeUsed) st.status = "done"; }
    }
  }
}
function jobCurrent(job) {
  const i = job.steps.findIndex((s) => s.status !== "done");
  return i < 0 ? null : i;
}
function jobView(job) {
  const i = jobCurrent(job);
  const total = job.steps.length;
  return {
    jobId: job.id, itemId: job.itemId, state: job.state, phase: job.phase, mode: job.mode, final: job.final, produced: job.produced,
    sources: job.sources, fromBin: job.fromBin, toBin: job.toBin, waitingFor: job.waitingFor || null,
    step: i == null ? total : i + 1, total,
    current: job.state === "done" ? "Done" : job.state === "waiting" ? `Waiting for ${job.waitingForLabel || "another kit"} to finish`
      : i == null ? (job.state === "running" || job.state === "queued" ? "Finishing" : null) : job.steps[i].label,
    detail: job.detail || null,
    steps: job.steps.map((s) => ({ label: s.label, sku: s.sku, phase: s.phase, status: s.status, error: s.error || null })),
    result: job.result || null, error: job.error || null, failedStep: job.failedStep || null, critical: !!job.critical,
    needsClear: job.state === "needs-clear", sentFlags: job.sentFlags || null,
    startedAt: new Date(job.createdAt).toISOString(), updatedAt: new Date(job.updatedAt).toISOString(),
    finishedAt: job.finishedAt ? new Date(job.finishedAt).toISOString() : null, startedBy: job.startedBy || null, boardWritten: !!job.ackedAt,
    ...(job.outputs ? { split: true, outputs: jobOutputs(job) } : {}),
  };
}
// Each part of a split run: pending, assembling, assembled or failed (from its assemble step).
function jobOutputs(job) {
  const cur = jobCurrent(job);
  return job.outputs.map((o) => {
    const i = job.steps.findIndex((s) => s.step === "assemble" && s.outKey === o.key);
    const st = i >= 0 ? job.steps[i] : null;
    const state = job.state === "done" || st?.status === "done" ? "assembled" : st?.status === "failed" ? "failed"
      : i >= 0 && i === cur && job.state === "running" ? "assembling" : "pending";
    return { itemId: o.itemId, final: o.final, qty: o.qty, toBin: o.toBin, fba: !!o.fba, main: !!o.main, state };
  });
}
function jobStop(job, state, error, extra = {}) {
  const i = jobCurrent(job);
  if (i != null) { job.steps[i].status = "failed"; job.steps[i].error = error; job.failedStep = job.steps[i].label; }
  job.state = state; job.error = error; job.finishedAt = Date.now(); Object.assign(job, extra);
}
// One step of one job. Changes job in place; returns ms until its next step.
async function jobAdvance(env, job) {
  const now = Date.now();
  const before = job.steps.filter((s) => s.status === "done").length + "|" + job.phase;
  const body = { ...job.body, itemId: job.itemId };
  const busyWait = (e) => {
    const at = e.retryAt ? Date.parse(e.retryAt) : NaN;
    job.detail = `Sellercloud is busy${e.call ? ` (${e.call})` : ""}; trying again${Number.isFinite(at) ? " at " + timeET(at) : " in a minute"}.`;
    return Number.isFinite(at) && at > now ? Math.min(at - now + 1000, 15 * 60_000) : 60_000;
  };
  let wait = 1500;
  job.state = "running";
  if (job.phase === "setup") {
    let r;
    const outs = job.outputs || null, idx = job.setupIdx || 0;
    let sb = body;
    if (outs) { sb = { ...body, final: outs[idx].final, toBin: outs[idx].toBin, produced: job.produced, finalSize: outs[idx].finalSize }; delete sb.outputs; }
    try { r = await setupProduction(env, { ...sb, state: job.setupState || {} }); }
    catch (e) {
      if (e.busy) return busyWait(e);
      jobStop(job, "failed", e.message || String(e));
      return 0;
    }
    if (r.state) job.setupState = r.state;
    if (r.plan) jobMarkFromPlan(job, r.plan);
    job.detail = r.message || r.error || null;
    if (r.saved && outs && idx < outs.length - 1) {
      // A split run: the next final's recipe.
      job.setupIdx = idx + 1; job.pendingTries = 0;
    } else if (r.saved) {
      for (const s of job.steps) if (s.phase === "setup") s.status = "done";
      job.phase = "produce"; job.pendingTries = 0;
    } else if (r.continue) {
      wait = /Still working on the last step|Waiting for/.test(r.message || "") ? 4000 : 1500;
    } else if (r.pending) {
      job.pendingTries = (job.pendingTries || 0) + 1;
      if (job.pendingTries > 2) jobStop(job, "failed", r.message || "Sellercloud didn't show the kit.");
      else { job.detail = `${r.message} Trying again in a minute.`; wait = 60_000; }
    } else {
      jobStop(job, "failed", r.error || r.message || "Setup stopped.", { critical: !!r.critical });
      return 0;
    }
  } else {
    let r = null, err = null;
    try { r = await produceProduction(env, body); }
    catch (e) {
      if (e.busy) return busyWait(e);
      err = e.message || String(e);
    }
    const flags = await itemSentFlags(job.itemId).catch(() => null);
    job.sentFlags = flags;
    const prevDone = new Set(job.steps.filter((s) => s.status === "done").map((s) => s.key));
    await jobMarkFromRecords(job).catch(() => {});
    if (r?.done) {
      for (const s of job.steps) s.status = "done";
      job.state = "done"; job.finishedAt = Date.now(); job.detail = r.message;
      job.result = { qty: job.produced, final: job.final, destination: job.toBin, message: r.message,
        parts: r.parts || (r.assemble?.parts ?? null), removed: r.removed || null, ...(r.outputs ? { outputs: r.outputs } : {}) };
      return 0;
    }
    if (r?.removed) for (const x of r.removed) if (x.ok) { const st = job.steps.find((s) => s.step === "empty leftover" && s.keySku.toLowerCase() === String(x.sku).toLowerCase()); if (st) st.status = "done"; }
    if (r && r.continue) { job.detail = r.message || null; wait = /^Broke down \d+ so far|Carrying on/.test(r.message || "") ? 1500 : 4000; }
    else {
      const msg = err || r?.message || r?.error || "Stopped.";
      const sent = !!(flags && (flags.disassembleSent || flags.assembleSent)) || ["no break-down record", "partly changed"].includes(r?.status);
      // A break-down's record is saved before it's sent, so one that failed shows as the failed step, not as done.
      if (/disassembl|break-down|breaking down|numbers off/i.test(r?.status || ""))
        for (const st of job.steps) if (st.step === "disassemble" && !prevDone.has(st.key)) st.status = "pending";
      jobStop(job, sent ? "needs-clear" : "failed", msg, { status: r?.status || null });
      return 0;
    }
  }
  const after = job.steps.filter((s) => s.status === "done").length + "|" + job.phase;
  if (after !== before || !job.progressAt) job.progressAt = Date.now();
  else if (Date.now() - job.progressAt > JOB_STUCK_MS) {
    const last = job.detail || "no news from Sellercloud";
    const sent = !!(job.sentFlags && (job.sentFlags.disassembleSent || job.sentFlags.assembleSent));
    jobStop(job, sent ? "needs-clear" : "failed", `Stopped after ${Math.round(JOB_STUCK_MS / 60000)} minutes without a step finishing. Last: ${last}`);
    return 0;
  }
  return wait;
}
// Kits that can't run side by side: same source product (setup empties all its bins) or same final (its recipe).
const jobLocks = (job) => [...(job.sources || []).map((x) => "src:" + x.toLowerCase()),
  ...(job.finals && job.finals.length ? job.finals : [job.final]).map((f) => "fin:" + String(f || "").toLowerCase())];

export class JobQueue {
  constructor(state, env) { this.state = state; this.env = env; this.storage = state.storage; }
  async all() { return [...(await this.storage.list({ prefix: "job:" })).values()]; }
  async save(job) { job.updatedAt = Date.now(); await this.storage.put(jobKeyOf(job.id), job); }
  async latestFor(itemId) { const id = await this.storage.get(jobItemKey(itemId)); return id ? await this.storage.get(jobKeyOf(id)) : null; }
  // Waiting jobs: free to run once nothing earlier that shares a source or final is running or waiting to be cleared.
  async refreshWaiting(jobs) {
    const blocking = (j) => JOB_ACTIVE.has(j.state) || j.state === "needs-clear";
    for (const j of jobs.filter((x) => x.state === "queued" || x.state === "waiting").sort((a, b) => a.createdAt - b.createdAt)) {
      const mine = new Set(jobLocks(j));
      const blocker = jobs.find((o) => o.id !== j.id && o.createdAt < j.createdAt && blocking(o) && jobLocks(o).some((l) => mine.has(l)));
      const next = blocker ? "waiting" : "queued";
      if (j.state !== next || (j.waitingFor || null) !== (blocker?.itemId || null)) {
        j.state = next; j.waitingFor = blocker?.itemId || null;
        j.waitingForLabel = blocker ? `${blocker.final}${blocker.state === "needs-clear" ? " (stopped; clear it first)" : ""}` : null;
        if (!blocker) j.nextAt = Date.now();
        await this.save(j);
      }
    }
  }
  async schedule() {
    const jobs = await this.all();
    const runnable = jobs.filter((j) => j.state === "queued" || j.state === "running");
    if (!runnable.length) { await this.storage.deleteAlarm(); return; }
    const at = Math.max(Date.now() + 250, Math.min(...runnable.map((j) => j.nextAt || 0)));
    const cur = await this.storage.getAlarm();
    if (cur == null || cur > at || cur < Date.now() - 60_000) await this.storage.setAlarm(at);
  }
  async fetch(request) {
    const url = new URL(request.url);
    let body = {};
    if (request.method === "POST") { try { body = (await request.json()) || {}; } catch {} }
    const out = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
    switch (url.pathname) {
      case "/add": {
        const itemId = String(body.itemId || "").trim();
        const ids = [...new Set([itemId, ...(Array.isArray(body.itemIds) ? body.itemIds.map((x) => String(x).trim()) : [])].filter(Boolean))];
        for (const id of ids) {
          const prev = await this.latestFor(id);
          const card = id.toLowerCase() === itemId.toLowerCase() ? "" : ` (card ${id})`;
          if (prev && JOB_ACTIVE.has(prev.state)) {
            if (String(prev.itemId).toLowerCase() === itemId.toLowerCase()) return out({ job: jobView(prev), existing: true });
            return out({ error: `Card ${id} is already in another kit run that hasn't finished.`, job: jobView(prev) }, 409);
          }
          if (prev && prev.state === "needs-clear") return out({ error: `This kit stopped part way${card} (${prev.error}). Check Sellercloud, then Clear and allow retry before running it again.`, job: jobView(prev) }, 409);
          if (prev && prev.state === "done" && !body.again) return out({ error: `This kit was already assembled by a background run${card}.`, job: jobView(prev) }, 409);
        }
        const now = Date.now();
        const job = { id: "j" + now.toString(36) + Math.random().toString(36).slice(2, 7), itemId, body: body.body, mode: body.mode, final: body.final,
          sources: body.sources, fromBin: body.fromBin, toBin: body.toBin, produced: body.produced, startedBy: body.startedBy || null,
          steps: body.steps, phase: body.steps.some((s) => s.phase === "setup") ? "setup" : "produce", state: "queued", createdAt: now, updatedAt: now, nextAt: now,
          ...(body.outputs ? { outputs: body.outputs, itemIds: ids, finals: body.finals } : {}) };
        await this.save(job);
        for (const id of ids) await this.storage.put(jobItemKey(id), job.id);
        await this.refreshWaiting(await this.all());
        await this.schedule();
        return out({ job: jobView(await this.storage.get(jobKeyOf(job.id))) });
      }
      case "/get": {
        const ids = (body.jobIds || []).map(String), items = (body.itemIds || []).map(String);
        const jobs = [];
        for (const id of ids) { const j = await this.storage.get(jobKeyOf(id)); if (j) jobs.push(jobView(j)); }
        for (const it of items) { const j = await this.latestFor(it); if (j) jobs.push(jobView(j)); }
        return out({ jobs });
      }
      case "/list": {
        const jobs = (await this.all()).sort((a, b) => a.createdAt - b.createdAt);
        const pick = body.active ? jobs.filter((j) => JOB_ACTIVE.has(j.state) || !j.ackedAt) : jobs;
        return out({ jobs: pick.map(jobView) });
      }
      case "/cancel": {
        const j = body.jobId ? await this.storage.get(jobKeyOf(body.jobId)) : await this.latestFor(body.itemId || "");
        if (!j) return out({ error: "No background run for this kit." }, 404);
        if (j.state === "running") return out({ error: "This kit is already running; it can't be stopped part way. It stops by itself if a step fails.", job: jobView(j) }, 409);
        if (j.state !== "queued" && j.state !== "waiting") return out({ error: `This run is ${j.state}, not waiting.`, job: jobView(j) }, 409);
        j.state = "cancelled"; j.finishedAt = Date.now(); j.detail = "Cancelled before it started."; j.ackedAt = Date.now();
        await this.save(j);
        await this.refreshWaiting(await this.all());
        await this.schedule();
        return out({ job: jobView(j) });
      }
      case "/ack": {
        const done = [];
        for (const id of (body.jobIds || []).map(String)) {
          const j = await this.storage.get(jobKeyOf(id));
          if (j && !JOB_ACTIVE.has(j.state) && !j.ackedAt) { j.ackedAt = Date.now(); await this.save(j); done.push(id); }
        }
        return out({ acked: done });
      }
      case "/active": {
        const j = await this.latestFor(body.itemId || "");
        return out({ active: !!(j && JOB_ACTIVE.has(j.state)), job: j ? jobView(j) : null });
      }
      case "/forget": {
        // After Clear and allow retry: the item's stopped job goes, so the kit can run again and kits waiting on it go ahead.
        const j = await this.latestFor(body.itemId || "");
        if (j && JOB_ACTIVE.has(j.state)) return out({ error: "This kit is still running in the background.", job: jobView(j) }, 409);
        if (j) {
          await this.storage.delete(jobKeyOf(j.id));
          for (const id of j.itemIds || [j.itemId]) if ((await this.storage.get(jobItemKey(id))) === j.id) await this.storage.delete(jobItemKey(id));
        }
        await this.refreshWaiting(await this.all());
        await this.schedule();
        return out({ forgot: !!j });
      }
      case "/kick": { await this.refreshWaiting(await this.all()); await this.schedule(); return out({ ok: true }); }
    }
    return out({ error: "Unknown job call." }, 404);
  }
  async alarm() {
    const env = this.env;
    callInit(env, JOB_STEP_MS);
    try {
      let jobs = await this.all();
      await this.refreshWaiting(jobs);
      jobs = await this.all();
      const now = Date.now();
      const due = jobs.filter((j) => (j.state === "queued" || j.state === "running") && (j.nextAt || 0) <= now)
        .sort((a, b) => (a.lastRunAt || 0) - (b.lastRunAt || 0))[0];
      if (due) {
        await markHubActive(env).catch(() => {});
        let wait = 0;
        try { wait = await jobAdvance(env, due); }
        catch (e) { jobStop(due, "failed", e.message || String(e)); }
        due.lastRunAt = Date.now();
        due.nextAt = Date.now() + (wait || 0);
        await this.save(due);
        if (!JOB_ACTIVE.has(due.state)) await this.refreshWaiting(await this.all());
      }
      // Finished jobs the Hub has acked go after a few days.
      for (const j of await this.all())
        if (!JOB_ACTIVE.has(j.state) && j.ackedAt && Date.now() - (j.finishedAt || j.updatedAt) > JOB_KEEP_MS) {
          await this.storage.delete(jobKeyOf(j.id));
          for (const id of j.itemIds || [j.itemId]) if ((await this.storage.get(jobItemKey(id))) === j.id) await this.storage.delete(jobItemKey(id));
        }
    } finally {
      await tallyCalls(env).catch(() => {});
      await this.schedule();
    }
  }
}
const jobStub = (env) => env.JOBS.get(env.JOBS.idFromName("queue"));
async function jobCall(env, path, body) {
  if (!env.JOBS) throw new HttpError(501, "Background runs aren't set up on this worker yet (no JOBS Durable Object binding).");
  const r = await jobStub(env).fetch(new Request("https://jobs" + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) }));
  const o = await r.json();
  return { status: r.status, ...o };
}
// POST /assemble/job: checks the kit the way setup and produce would (read-only), then hands it to the queue.
async function startJob(env, body) {
  if (!assembleOn(env)) throw new HttpError(403, "Kit assembly is switched off. It turns on once ASSEMBLE_ENABLED is set to yes.");
  if (!RUN_KV) throw needKv();
  if (!env.JOBS) throw new HttpError(501, "Background runs aren't set up on this worker yet (no JOBS Durable Object binding).");
  const itemId = String(body.itemId || "").trim();
  if (!itemId) throw new HttpError(400, "itemId (the monday item) is needed.");
  const outs = splitOutputs(env, body);
  if (outs) return startSplitJob(env, body, outs);
  await splitGuard(itemId);
  const fromBin = String(body.fromBin || "").trim(), toBin = String(body.toBin || "").trim();
  if (!fromBin || !toBin) throw new HttpError(400, "fromBin and toBin are needed.");
  if (body.fba === true || body.fba === "yes") {
    const fbaBin = String(env.FBA_BIN || "FBA_manual_import").trim();
    if (toBin.toLowerCase() !== fbaBin.toLowerCase()) throw new HttpError(409, `FBA productions always assemble into bin ${fbaBin}, not ${toBin}.`);
  }
  const active = await jobCall(env, "/active", { itemId });
  if (active.active) return { job: active.job, existing: true };
  const mix = isMix(body);
  const clean = { ...body }; delete clean.state;
  await realBin(env, binName(fromBin), "From"); await realBin(env, binName(toBin), "To");
  const plan = mix ? await mixPlan(env, await withMixRun(clean)) : await productionPlan(env, await withRunPer(clean));
  const started = await itemStarted(itemId);
  if (!started) {
    const problems = [...plan.problems, ...(plan.unknownTypes?.length ? [`Pick bulk by lb or oz for ${plan.unknownTypes.join(", ")}.`] : [])];
    if (problems.length) throw Object.assign(new HttpError(409, problems.join(" ")), { plan });
  }
  const steps = jobStepsFrom(plan);
  const r = await jobCall(env, "/add", {
    itemId, body: clean, mode: mix ? "mix" : "single", final: plan.final?.sku || String(body.final || ""),
    sources: mix ? listParam(body.sources) : [String(body.source || "").trim()], fromBin, toBin, produced: plan.produced,
    startedBy: body.userId || body.startedBy || null, steps,
  });
  if (r.status !== 200) throw Object.assign(new HttpError(r.status, r.error || "Couldn't start the run."), { job: r.job });
  return { job: r.job, existing: !!r.existing };
}

// A split run in the background queue: every card of the run checked, marked and registered under the one job.
async function startSplitJob(env, body, outs) {
  const itemId = String(body.itemId).trim();
  const fromBin = String(body.fromBin || "").trim();
  if (!fromBin) throw new HttpError(400, "fromBin is needed.");
  for (const o of outs) {
    const a = await jobCall(env, "/active", { itemId: o.itemId });
    if (a.active) {
      const runMain = String(a.job?.itemId || "").toLowerCase();
      if (runMain && outs.some((x) => x.itemId.toLowerCase() === runMain)) return { job: a.job, existing: true };
      throw Object.assign(new HttpError(409, `Card ${o.itemId} is already in another kit run that hasn't finished.`), { job: a.job });
    }
  }
  for (const o of outs) {
    const m = await splitOf(o.itemId);
    if (o.main) { if (m) throw new HttpError(409, `Card ${o.itemId} is part of the split run on card ${m}.`); continue; }
    if (m && m.toLowerCase() !== itemId.toLowerCase()) throw new HttpError(409, `Card ${o.itemId} is part of the split run on card ${m}.`);
    if (!m && (await itemStarted(o.itemId))) throw new HttpError(409, `Card ${o.itemId} already has run records of its own. Check Sellercloud and clear that card first.`);
  }
  await realBin(env, binName(fromBin), "From");
  for (const b of new Set(outs.map((o) => o.toBin.toLowerCase()))) await realBin(env, binName(outs.find((o) => o.toBin.toLowerCase() === b).toBin), "To");
  const clean = splitBody({ ...body }, outs); delete clean.state;
  const plan = await splitPlan(env, await withRunPer(clean), outs);
  if (!(await itemStarted(itemId)) && plan.problems.length) throw Object.assign(new HttpError(409, plan.problems.join(" ")), { plan });
  // Every other card of the run points at the main card from here on, until the main card is cleared.
  for (const o of outs) if (!o.main) await durable.put(lockKey("splitof", o.itemId), itemId);
  const r = await jobCall(env, "/add", {
    itemId, itemIds: outs.map((o) => o.itemId), body: clean, mode: "single", final: outs[0].final, finals: outs.map((o) => o.final),
    outputs: outs, sources: [String(body.source || "").trim()], fromBin, toBin: outs[0].toBin, produced: plan.produced,
    startedBy: body.userId || body.startedBy || null, steps: jobStepsFrom(plan),
  });
  if (r.status !== 200) throw Object.assign(new HttpError(r.status, r.error || "Couldn't start the run."), { job: r.job });
  return { job: r.job, existing: !!r.existing };
}

async function setupProduction(env, body) {
  if (!RUN_KV) throw needKv();
  if (body?.outputs != null) throw new HttpError(400, "Split runs go through the background run (POST /assemble/job).");
  await splitGuard(body?.itemId);
  // One setup call at a time per final kit, so two quick presses can't both empty the source.
  const key = String(body.final || body.source || "").trim();
  if (key && (await isLocked("setupcall", key))) return { saved: false, continue: true, message: "Still working on the last step.", state: body.state || {} };
  if (key) await lock("setupcall", key, 60);
  try { return isMix(body) ? await mixSetupStep(env, await withMixRun(body)) : await setupStep(env, await withRunPer(body)); } finally { if (key) await unlock("setupcall", key); }
}
async function setupStep(env, body) {
  if (!assembleOn(env)) throw new HttpError(403, "Sellercloud writes are switched off. They turn on once ASSEMBLE_ENABLED is set to yes.");
  const state = {};   // records changed in this call, echoed to the Hub
  const sourceSku = String(body.source || "").trim();
  const tag = `monday item ${String(body.itemId || "").slice(0, 40) || "?"}`;
  const reply = (r) => ({ ...r, state: mergeState(body.state, state) });

  // 1. The source was emptied to make it a kit: carry that on until its stock is back.
  const cz = await continueZeroed(env, sourceSku, body, state, reply, tag, async () => {
    const plan = await productionPlan(env, body);
    return plan.steps.find((x) => x.step === "source kit")?.want || null;
  });
  if (cz) return cz;

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
    const logs = await jobLogs(env, job.jobId);
    if (x.state === "to change")
      return reply({ saved: false, error: `Sellercloud still shows ${kit}'s recipe as ${x.recipeFrom}, not ${x.recipeTo} ${x.want?.sku || ""} per kit, after sending the change twice. Nothing was broken down or assembled.${j.said ? ` Import job ${job.jobId}: ${j.said.slice(0, 200)}.` : ""}${logText(logs)} You can change it in its Kit tab, then press Run again.`, jobLog: logs, plan });
    return reply({ saved: false, pending: true, message: `Sellercloud hadn't shown ${kit}'s kit after 2 minutes.${j.said ? ` Import job ${job.jobId}: ${j.said.slice(0, 200)}.` : ""}${logText(logs)} Check its Kit tab in a minute, then press Run again.`, jobLog: logs, plan });
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
  if (r.change) {
    const e = await editKitParts(env, r.kit, [{ sku: r.part, perKit: r.perKit }], `Recipe for this run (${tag})`);
    if (e.ok) return reply({ saved: false, continue: true, message: `Changed ${r.kit}'s recipe in Sellercloud: ${r.change.from} → ${r.change.to} ${r.part} per kit.`, plan });
    if (e.error) return reply({ saved: false, critical: !!e.critical, error: `Changing ${r.kit}'s recipe: ${e.error} Nothing was broken down or assembled.`, plan });
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

// ── The web Kit tab's own calls on the delta host (Nov 23) ──
// Sign-in: POST {delta}/api/token with the worker's Sellercloud login (same body as the REST sign-in); the token is kept
// like the REST one (KV, until shortly before it expires) and is never shown or logged.
const DELTA_TOKEN_KEY = "sc-delta-token-v1";
let deltaToken = null;
async function deltaBase(env) {
  const code = new URL(await getBase(env)).hostname.split(".")[0];   // e.g. lgd
  return (env.SC_DELTA_URL || `https://${code}.delta.sellercloud.com`).trim().replace(/\/+$/, "");
}
async function deltaGetToken(env) {
  if (deltaToken && deltaToken.expiresAt > Date.now() + 60_000) return deltaToken.value;
  const kept = await sharedGet(env, DELTA_TOKEN_KEY);
  if (kept?.value && kept.expiresAt > Date.now() + 60_000) return (deltaToken = kept).value;
  if (!env.SC_USERNAME || !env.SC_PASSWORD) throw new HttpError(500, "SC_USERNAME or SC_PASSWORD is not set.");
  subrequests++; scCalls++;
  const r = await fetch((await deltaBase(env)) + "/api/token", {
    method: "POST", redirect: "manual", headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ Username: env.SC_USERNAME, Password: env.SC_PASSWORD }),
  });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch {}
  if (!r.ok || !j?.access_token) throw new HttpError(502, `Sellercloud's Kit tab sign-in failed (${r.status}).${j?.error_description || j?.Message ? " Sellercloud said: " + String(j.error_description || j.Message).slice(0, 200) : ""}`);
  const secs = Number(j.expires_in) > 0 ? Number(j.expires_in) : 1500;
  deltaToken = { value: j.access_token, expiresAt: Date.now() + secs * 1000 };
  await sharedPut(env, DELTA_TOKEN_KEY, deltaToken, secs - 120);
  return deltaToken.value;
}
// Only these Kit tab calls; Save is a write and needs ASSEMBLE_ENABLED = yes.
const KITTOOL_READS = new Set(["Load", "GetKitAssemblies"]);
async function kitTool(env, action, body) {
  const write = action === "Save";
  if (!write && !KITTOOL_READS.has(action)) throw new HttpError(500, `KitTool/${action} is not allowed.`);
  if (write && !assembleOn(env)) throw new HttpError(403, "Kit assembly is switched off.");
  const url = (await deltaBase(env)) + "/api/Toolbox/Product/KitTool/" + action;
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await deltaGetToken(env);
    subrequests++; scCalls++;
    const r = await fetch(url, {
      method: "POST", redirect: "manual",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", Accept: "application/json", "X-Requested-With": "XMLHttpRequest" },
      body: JSON.stringify(body),
    });
    // A refused token: sign in again once (reads and Save alike; a 401 means nothing was done).
    if (r.status === 401 && attempt === 0) { deltaToken = null; await sharedDel(env, DELTA_TOKEN_KEY); continue; }
    const text = await r.text();
    let j = null; try { j = JSON.parse(text); } catch {}
    if (!r.ok) throw new HttpError(502, `Sellercloud's Kit tab ${action} failed (${r.status}). ${(j ? kitToolSaid(j) : text.replace(/\s+/g, " ")).slice(0, 300)}`);
    if (!j) throw new HttpError(502, `Sellercloud's Kit tab ${action} didn't answer with data.`);
    return j;
  }
}
const kitToolSaid = (j) => [j?.Notification?.Title, j?.Notification?.Message, j?.Message, j?.ExceptionMessage].filter(Boolean).join(": ");
async function kitToolLoad(env, kit) {
  const j = await kitTool(env, "Load", { Id: kit });
  const dto = j?.Data?.DTO || j?.Data?.Dto || null;
  if (!dto || !Array.isArray(dto.Items)) throw new HttpError(502, `Sellercloud's Kit tab didn't load ${kit}.${kitToolSaid(j) ? " " + kitToolSaid(j) : ""}`);
  return dto;
}
const kitToolParts = (dto) => (dto.Items || []).map((i) => ({ sku: String(i.ChildProductID || ""), perKit: Number(i.Qty) || 0 })).filter((x) => x.sku);

// Changes the qty of parts a kit already has, the way the web Kit tab does: Load the kit, change only those parts' Qty
// (and the item count), leave every other field as loaded, Save, then Load again. Goes on only when the kit reads back
// with exactly the same parts and the new qtys. Never adds or drops a part: a recipe with a new or missing part goes
// through the import. { unsupported } when the parts differ; { ok, got } or { error, got } otherwise.
async function editKitParts(env, kit, want, note) {
  const lc = (x) => String(x).toLowerCase();
  const same = (a, b) => a.length === b.length && b.every((w) => a.some((c) => lc(c.sku) === lc(w.sku)));
  const exact = (got) => same(got, want) && want.every((w) => got.find((x) => lc(x.sku) === lc(w.sku)).perKit === w.perKit);
  const show = (got) => got.map((x) => `${x.perKit} ${x.sku}`).join(" + ") || "no parts";
  const dto = await kitToolLoad(env, kit);
  const cur = kitToolParts(dto);
  if (!same(cur, want)) return { unsupported: true, reason: "parts differ" };
  if (exact(cur)) return { ok: true, got: cur };
  if (new Set(cur.map((x) => lc(x.sku))).size !== cur.length) return { error: `${kit} has a part listed twice in its Kit tab; fix it there first.`, got: cur };

  // The Kit tab sends its kit assemblies list with Save; read it the same way when Load doesn't carry it.
  if (!("KitAssemblies" in dto)) {
    try {
      const a = await kitTool(env, "GetKitAssemblies", { Id: kit });
      const list = Array.isArray(a?.Data) ? a.Data : Array.isArray(a?.Data?.DTO) ? a.Data.DTO : Array.isArray(a?.Data?.Items) ? a.Data.Items : null;
      if (list) dto.KitAssemblies = list;
    } catch {}
  }
  for (const it of dto.Items) {
    const w = want.find((x) => lc(x.sku) === lc(it.ChildProductID));
    if (!w || (Number(it.Qty) || 0) === w.perKit) continue;
    it.Qty = String(w.perKit);               // the Kit tab sends an edited qty as text
    if (it.RowStatus == null) it.RowStatus = 0;
  }
  if (dto.General && typeof dto.General === "object")
    dto.General.ItemCount = dto.Items.reduce((n, it) => n + (Number(it.Qty) || 0), 0);

  let saved;
  try { saved = await kitTool(env, "Save", { ToolParameters: { Id: kit }, Dto: dto }); }
  catch (e) { return { error: `Sellercloud refused the new recipe: ${e.message}`, got: cur }; }
  if (saved?.Success === false) return { error: `Sellercloud refused the new recipe: ${kitToolSaid(saved) || "no reason given"}.`, got: cur };

  let got = [];
  for (let i = 0; i < 5; i++) {
    if (i) await sleep(2000);
    got = kitToolParts(await kitToolLoad(env, kit));
    if (exact(got)) return { ok: true, got };
  }
  return { error: `${kit} reads back as ${show(got)} after the save${kitToolSaid(saved) ? ` (Sellercloud said: ${kitToolSaid(saved)})` : ""}.`, got };
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
  const outs = body.outputs != null ? splitOutputs(env, body) : null;
  if (isMix(body)) return mixProduce(env, body);
  if (!outs) await splitGuard(body.itemId);
  if (body.source && (await durable.match(lockKey("zeroed", String(body.source).trim()))))
    return { done: false, status: "failed", message: `${String(body.source).trim()} was emptied for its kit setup and not put back yet. Press Run on the setup again first.` };
  const itemId = String(body.itemId || "").trim();
  if (!itemId) throw new HttpError(400, "itemId (the monday item) is needed so a production only runs once.");
  // Both bins must exist before anything moves (checked again inside the assemble).
  const fromBin = await realBin(env, binName(body.fromBin), "From"), toBin = await realBin(env, binName(outs ? outs[0].toBin : body.toBin), "To");
  const plan = outs ? await splitPlan(env, await withRunPer({ ...splitBody(body, outs), fromBin }), outs) : await productionPlan(env, await withRunPer({ ...body, fromBin }));
  // The 0.1 bin (pre-sized only): the break-down goes in, the assembly takes from it.
  const bBin = plan.mode === "pre-sized" ? await realBin(env, plan.bridgeBin, "0.1") : null;
  const notReady = plan.steps.filter((s) => ["create", "set", "stop"].includes(s.action));
  if (notReady.length) {
    const ch = notReady.find((s) => s.step === "final kit" && s.state === "to change");
    throw new HttpError(409, ch && notReady.length === 1
      ? `${ch.sku || plan.final.sku}'s kit recipe is ${ch.recipeFrom}, not this run's ${ch.recipeTo} per kit, so nothing was assembled. Run the setup again first; it changes the recipe.`
      : "Set up the 0.1 product and kits first.");
  }
  // The kits are assembled in at most two groups (some at N units of 0.1 each, the rest at N + 1, so the whole bin
  // is used). The split is saved on the first press, so later presses assemble the same groups even though the bin
  // has changed by then. Each group has its own once-only record (item id, or item id #g1 / #g2).
  const gSaved = await durable.match(lockKey("groups", itemId));
  let groups = null;
  if (gSaved) { try { groups = JSON.parse(await gSaved.text()); } catch { groups = null; } }
  const savedSplit = !!(groups && groups.length && groups[0].key);
  if (savedSplit && !outs) return { done: false, status: "split run", message: "This production is a split run. It runs from Kits with all its parts." };
  if (groups && outs && !savedSplit) return { done: false, status: "single run", message: "This production already started as a single run, so it can't be split now. Check Sellercloud, then clear it first." };
  if (savedSplit && outs && (groups.length !== outs.length || groups.some((g, i) => g.key !== outs[i].key || g.sku.toLowerCase() !== outs[i].final.toLowerCase() || g.kits !== outs[i].qty)))
    return { done: false, status: "split changed", message: "This split run started with other parts. Check Sellercloud, then clear it from the main card first." };
  const legacyDone = !groups && !!(await durable.match(doneKey(itemId))); // assembled before groups existed
  const asmStep = plan.steps.find((s) => s.step === "assemble");
  const fresh = !groups && !legacyDone;
  if (fresh) groups = outs ? plan.splitGroups : asmStep?.groups || null; // one assembly at bin total ÷ qty produced, either route
  const gKey = (i) => groups[i].key || (groups.length === 1 ? itemId : `${itemId}#g${i + 1}`);
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
      const gSku = g.sku || plan.final.sku, gTo = g.toBin ? await realBin(env, binName(g.toBin), "To") : toBin;
      asm = await assembleKit(env, {
        sku: gSku, qty: g.kits, itemId: key, fromBin: pBin, toBin: gTo, source: part, perKit: plan.perFinal,
        eachPerKit: g.perKit,
      });
      asms.push({ kits: g.kits, perKit: g.perKit, ...asm });
      if (!asm.done) return { done: false, continue: !!asm.continue, status: asm.status,
        message: (g.key ? `Part ${i + 1} of ${groups.length} (${g.kits} × ${gSku}): ` : groups.length > 1 ? `Group ${i + 1} of ${groups.length} (${g.kits} kits × ${g.perKit}): ` : "") + asm.message,
        disassemble: dis, assemble: asm, groups, leftover };
      if (i < groups.length - 1)
        return { done: false, continue: true, status: "assembling", message: g.key
            ? `Assembled ${g.kits} × ${gSku} into bin ${gTo}. Carrying on with ${groups[i + 1].kits} × ${groups[i + 1].sku}.`
            : `Assembled ${g.kits} × ${plan.final.sku} (${g.perKit} units each). Carrying on with the other ${groups[i + 1].kits}.`,
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
        `<reason>${xmlEsc(outs ? `Production leftover 0.1 after the split run of ${plan.produced} (${groups.map((g) => `${g.kits} x ${g.sku}`).join(", ")}) (monday item ${itemId})`.slice(0, 480)
          : `Production leftover 0.1 after assembling ${plan.produced} x ${plan.final.sku} (monday item ${itemId})`)}</reason>` +
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
  const msg = outs && groups
    ? `Assembled ${groups.map((g) => `${g.kits} × ${g.sku} into bin ${g.toBin}`).join(", ")} in Skustack, ${groups[0].perKit} units of ${plan.bridge.sku} each from bin ${bBin} (${total} in all).`
    : groups && groups.length > 1 && plan.mode === "pre-sized"
    ? `Assembled ${plan.produced} × ${plan.final.sku} in Skustack, from bin ${bBin || fromBin} to bin ${toBin}: ${groups.map((g) => `${g.kits} with ${g.perKit}`).join(" and ")} units of ${plan.bridge.sku} (${total} in all).`
    : asm?.message || `${plan.final.sku} was already assembled.`;
  const stays = plan.steps.find((s) => s.step === "assemble" && s.leftoverStays)?.leftover || 0;
  return { done: true, status: "assembled", message: msg + (empty ? ` Removed this run's ${leftover} leftover ${plan.bridge.sku} from bin ${bBin}.` : "") +
      (stays ? ` ${stays}${plan.mode === "pre-sized" ? ` ${plan.bridge.sku}` : ` lb of ${plan.source.sku}`} stay in bin ${fromBin}.` : ""),
    disassemble: dis, disassembledEarlier: !dis && plan.mode === "pre-sized" && !(plan.binQty > 0), assemble: asm, assembles: asms, groups, emptyLeftover: empty, leftover, leftInBin: stays,
    ...(outs && groups ? { outputs: groups.map((g) => ({ itemId: g.itemId, final: g.sku, qty: g.kits, toBin: g.toBin, perKit: g.perKit, state: "assembled" })) } : {}) };
}

// Lists the SOAP service's operations (from its own WSDL) whose name matches q, with their inputs.
// Read-only: it only downloads the service description.
// Read-only: the kit as the web Kit tab loads it (delta host, the worker's own sign-in). Never saves.
async function kitToolLoadTest(env, sku) {
  const dto = await kitToolLoad(env, sku);
  return { sku, works: true, items: (dto.Items || []).map((i) => ({ part: i.ChildProductID, qty: i.Qty, isMain: i.IsMainItem })),
    itemCount: dto.General?.ItemCount ?? null, inventoryQty: dto.General?.InventoryQty ?? null, availableQuantity: dto.AvailableQuantity ?? null,
    hasKitAssemblies: "KitAssemblies" in dto, hasRelatedKits: "RelatedKits" in dto, fields: Object.keys(dto) };
}

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
  // Labels: the label-buying AI uploads with its own key (LABELS_KEY); the Hub reads with its key (ASSEMBLE_KEY or APP_KEY).
  if (p0 === "/labels/upload") {
    if (request.method !== "POST") return json({ error: "Use POST for /labels/upload." }, 405);
    return labelsUpload(request, env);
  }
  if (p0 === "/mirror/status") {
    if (request.method !== "GET") return json({ error: "Only GET is allowed here." }, 405);
    const k = (url.searchParams.get("key") || request.headers.get("X-App-Key") || "").trim();
    const ok = !!k && ((env.ASSEMBLE_KEY && safeEqual(k, env.ASSEMBLE_KEY.trim())) || (env.APP_KEY && safeEqual(k, env.APP_KEY.trim())));
    if (!ok) return json({ error: "Missing or wrong key." }, 401);
    return json(await mirrorStatus(env));
  }
  if (p0 === "/bins/contents") {
    if (request.method !== "POST") return json({ error: "Use POST for /bins/contents." }, 405);
    const k = (url.searchParams.get("key") || request.headers.get("X-App-Key") || "").trim();
    const ok = !!k && ((env.APP_KEY && safeEqual(k, env.APP_KEY.trim())) || (env.ASSEMBLE_KEY && safeEqual(k, env.ASSEMBLE_KEY.trim())));
    if (!ok) return json({ error: "Missing or wrong key." }, 401);
    let body;
    try { body = await request.json(); } catch { return json({ error: "Send the details as JSON." }, 400); }
    try { return json(await binContents(env, body)); }
    catch (e) {
      const st = e instanceof HttpError ? e.status : 500;
      return json({ error: e.message || String(e), ...(e.busy ? { busy: true, retryAt: e.retryAt || null } : {}) }, st);
    }
  }
  if (p0 === "/temu-backlog") return temuBacklogRoute(env, url);
  if (p0 === "/labels-autoship") return autoshipRoute(env, url);
  if (p0 === "/labels/dl") {
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Only GET is allowed here.", { status: 405 });
    return labelsDirect(request, env, url);
  }
  // The scan station lives in the Production Hub's FBM printing tab (Nov 25, Shragy: "i need it in the hub only").
  if (p0 === "/scan") return new Response("The scan station is in the Production Hub, tab FBM printing.", { status: 410, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  if (p0.startsWith("/labels/")) {
    const wantPost = p0 === "/labels/downloaded" || p0 === "/labels/file-link" || p0 === "/labels/printed" || p0 === "/labels/link" || p0 === "/labels/check" || p0 === "/labels/aside" || p0 === "/labels/sku-link";
    if (request.method !== (wantPost ? "POST" : "GET")) return json({ error: wantPost ? `Use POST for ${p0}.` : "Only GET is allowed here." }, 405);
    const k = (url.searchParams.get("key") || request.headers.get("X-App-Key") || "").trim();
    const ok = !!k && ((env.ASSEMBLE_KEY && safeEqual(k, env.ASSEMBLE_KEY.trim())) || (env.APP_KEY && safeEqual(k, env.APP_KEY.trim())));
    if (!ok) return json({ error: "Missing or wrong key." }, 401);
    const scan = await scanRoute(request, env, p0, url);
    if (scan) return scan;
    return labelsRoute(request, env, p0, url);
  }
  const isAssemble = p0 === "/assemble";
  const isPost = isAssemble || p0 === "/assemble/setup" || p0 === "/assemble/produce" || p0 === "/assemble/refresh" || p0 === "/assemble/clear"
    || p0 === "/assemble/job/cancel" || p0 === "/assemble/job/ack" || p0 === "/assemble/create-product";
  const okMethod = p0 === "/assemble/job" || p0 === "/assemble/plan" ? ["GET", "POST"].includes(request.method) : isPost ? request.method === "POST" : request.method === "GET";
  if (!okMethod)
    return json({ error: isPost ? `Use POST for ${p0}.` : "Only GET is allowed here." }, 405);

  if (!env.APP_KEY)
    return json({ error: "APP_KEY is not set. Add it as a Secret in the worker's Variables and Secrets." }, 401);
  const key = url.searchParams.get("key") || request.headers.get("X-App-Key") || "";
  const path = url.pathname.replace(/\/+$/, "");
  // PULL_KEY (Secret, optional) is a second key that only works for /pull, so the Production Hub
  // button can carry it without giving out the main key.
  const pullOk = path === "/pull" && env.PULL_KEY && env.PULL_KEY.trim() && safeEqual(key.trim(), env.PULL_KEY.trim());
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

    case "/assemble/companies":
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

    case "/assemble/platforms":
      // Read-only: the platforms for "Create final SKU", with the SKU prefix and the Sellercloud company of each.
      return json({ platforms: platformList(env) });

    case "/assemble/create-product": {
      // Shragy's press in the Hub only: create ONE final product in a platform company. Never retried, never twice.
      let body = {};
      try { body = (await request.json()) || {}; } catch {}
      const { status, ...out } = await createFinalProduct(env, body);
      return json(out, status || 200);
    }

    case "/assemble/catalog": {
      // Read-only: products in ANY company (for the platform final-SKU feature).
      // ?company= id or name (contains, any case), &q= keyword, &sku= exact SKU, &page=, &raw=1 adds the field names.
      return json(await catalogLook(env, {
        company: (url.searchParams.get("company") || "").trim(),
        q: (url.searchParams.get("q") || "").trim(),
        sku: (url.searchParams.get("sku") || "").trim(),
        page: Math.max(1, parseInt(url.searchParams.get("page") || "1", 10)),
        raw: url.searchParams.get("raw") === "1",
      }));
    }

    case "/assemble/find": {
      // Final-SKU search for the assembly pop-up. Reads Sellercloud directly, so new SKUs with 0 stock
      // (which the board sync skips) can still be picked. Read-only.
      needCompany(env);
      const q = (url.searchParams.get("q") || "").trim();
      if (q.length < 2) return json({ error: "Type at least 2 characters." }, 400);
      const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
      // Nov 23: WAREHOUSE plus the platform companies (a final SKU may be under either).
      const searched = await finalCompanies(env);
      const companyId = warehouseCompanyId(env);
      const ids = [...new Set([companyId, ...searched.ids].filter((x) => x != null && x !== "").map(String))];
      let data;
      try {
        data = await scGet(env, "/catalog", { Keyword: q, companyID: ids.length ? ids : undefined, pageNumber: page, pageSize: 25 });
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
      let raw = (data.Items || []).filter((p) => finalCompanyOk(env, p));
      // An exact SKU the keyword search missed (page 1 only).
      if (page === 1 && !raw.some((p) => String(p.ID ?? p.ProductID ?? "").toLowerCase() === q.toLowerCase())) {
        try {
          const exact = await scGet(env, "/catalog", { SKU: [q], pageNumber: 1, pageSize: 5 });
          const hit = (exact.Items || []).find((p) => String(p.ID ?? p.ProductID ?? "").toLowerCase() === q.toLowerCase() && finalCompanyOk(env, p));
          if (hit) raw = [hit, ...raw];
        } catch {}
      }
      const urlTemplate = env.SC_PRODUCT_URL || "https://lgd.delta.sellercloud.com/catalog/catalog-details.aspx?ID={sku}";
      const items = raw.map((p) => {
        const x = slimProduct(p);
        return { ...x, warehouseCompany: companyMatches(env, p), link: x.sku ? urlTemplate.replace("{sku}", encodeURIComponent(x.sku)) : null };
      });
      return json({ q, page, pageSize: 25, totalResults: ids.length ? data.TotalResults ?? null : null, items,
        companies: searched.names, ...(searched.note ? { note: searched.note } : {}) });
    }

    case "/assemble/kit": {
      return json(await kitDefinition(env, (url.searchParams.get("sku") || "").trim(), { final: url.searchParams.get("final") === "1" }));
    }

    case "/assemble/plan": {
      let pb = null;
      if (request.method === "POST") { try { pb = (await request.json()) || {}; } catch { return json({ error: "Send the details as JSON." }, 400); } }
      const g = (k) => pb ? String(pb[k] ?? "").trim() : (url.searchParams.get(k) || "").trim();
      const outsRaw = pb ? pb.outputs : url.searchParams.get("outputs");
      if (outsRaw != null && outsRaw !== "") {
        const q = { source: g("source"), fromBin: g("fromBin"), itemId: g("itemId"), sourceSize: g("sourceSize"), finalSize: g("finalSize"), outputs: outsRaw,
          sources: pb ? pb.sources : url.searchParams.getAll("sources") };
        const outs = splitOutputs(env, q);
        const plan = await splitPlan(env, await withRunPer(splitBody(q, outs)), outs);
        plan.savedStepsWork = await cacheWorks();
        return json(plan);
      }
      const srcs = pb ? listParam(pb.sources) : url.searchParams.getAll("sources");
      const mixQ = { sources: srcs.length > 1 ? srcs : srcs[0] || "", types: g("types"), maxDiffPct: g("maxDiffPct") };
      if (isMix(mixQ)) {
        const plan = await mixPlan(env, await withMixRun({ ...mixQ, final: g("final"), fromBin: g("fromBin"), produced: g("produced"),
          finalSize: g("finalSize"), itemId: g("itemId") }));
        plan.savedStepsWork = await cacheWorks();
        plan.features = SPLIT_FEATURES;
        return json(plan);
      }
      const plan = await productionPlan(env, await withRunPer({ source: g("source"), final: g("final"), fromBin: g("fromBin"), produced: g("produced"),
        finalSize: g("finalSize"), sourceSize: g("sourceSize"), itemId: g("itemId") }));
      // Whether the worker can remember finished steps here (the double-run guards rely on it).
      plan.savedStepsWork = await cacheWorks();
      plan.features = SPLIT_FEATURES;
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
      const partOf = await splitOf(itemId);
      if (partOf) return json({ error: `This card is part of the split run on card ${partOf}. Clear that card; it clears the whole run.` }, 409);
      if (env.JOBS) {
        const a = await jobCall(env, "/active", { itemId });
        if (a.active) return json({ error: "This kit is still running in the background. Wait until it finishes or stops.", job: a.job }, 409);
      }
      const keys = [doneKey(itemId), doneKey(itemId + "#g1"), doneKey(itemId + "#g2"), doneKey(itemId + "#g3"),
        ...Array.from({ length: SPLIT_MAX }, (_, i) => doneKey(`${itemId}#o${i + 1}`)),
        ...["groups", "disassembled", "disrec", "emptied", "leftover", "mixrun"].map((k) => lockKey(k, itemId))];
      // A split run: the other cards' marks go too (from the saved parts, and the running job's cards).
      const gr = await readRec("groups", itemId);
      const partIds = new Set((Array.isArray(gr) ? gr : []).filter((x) => x && x.key && x.itemId).map((x) => String(x.itemId)));
      if (env.JOBS) { const lj = await jobCall(env, "/get", { itemIds: [itemId] }).catch(() => null); for (const o of lj?.jobs?.[0]?.outputs || []) partIds.add(String(o.itemId)); }
      for (const id of partIds) if (id.toLowerCase() !== itemId.toLowerCase()) keys.push(lockKey("splitof", id));
      // A mix run's records per source and per 0.1 product.
      const mr = await readRec("mixrun", itemId);
      for (const x of mr?.sources || []) keys.push(lockKey("disrec", mixKey(itemId, x.sku)), lockKey("disassembled", mixKey(itemId, x.sku)), lockKey("brbase", mixKey(itemId, "base:" + x.bridge)));
      for (const x of mr?.parts || []) keys.push(lockKey("emptied", mixKey(itemId, x.sku)));
      const had = [];
      for (const k of keys) { if (await durable.match(k)) had.push(new URL(k.url).pathname.split("/")[1]); await durable.delete(k); }
      if (env.JOBS) await jobCall(env, "/forget", { itemId }).catch(() => null);
      return json({ cleared: true, itemId, had: [...new Set(had)],
        message: had.length ? `Cleared this production's run records (${[...new Set(had)].join(", ")}). Check Sellercloud first: the next Run sends again.` : "This production had no run records." });
    }

    case "/assemble/job": {
      if (request.method === "GET") {
        const ids = (url.searchParams.get("jobIds") || "").split(",").map((x) => x.trim()).filter(Boolean);
        const items = [...url.searchParams.getAll("itemId"), ...(url.searchParams.get("itemIds") || "").split(",")].map((x) => x.trim()).filter(Boolean);
        if (!ids.length && !items.length) return json({ error: "Add ?itemId= or ?jobIds=." }, 400);
        const r = await jobCall(env, "/get", { jobIds: ids, itemIds: items });
        return json({ jobs: r.jobs || [] });
      }
      let body;
      try { body = await request.json(); } catch { return json({ error: "Send the details as JSON." }, 400); }
      try { return json(await startJob(env, body || {})); }
      catch (e) {
        const st = e instanceof HttpError ? e.status : 500;
        return json({ error: e.message || String(e), ...(e.busy ? { busy: true, call: e.call, said: e.said, retryAt: e.retryAt || null } : {}),
          ...(e.plan ? { plan: e.plan } : {}), ...(e.job ? { job: e.job } : {}) }, st);
      }
    }
    case "/assemble/jobs": {
      const r = await jobCall(env, "/list", { active: url.searchParams.get("active") === "1" });
      return json({ jobs: r.jobs || [] });
    }
    case "/assemble/job/cancel":
    case "/assemble/job/ack": {
      let body = {};
      try { body = (await request.json()) || {}; } catch {}
      const r = await jobCall(env, p0 === "/assemble/job/ack" ? "/ack" : "/cancel", body);
      const { status, ...rest } = r;
      return json(rest, status);
    }

    case "/assemble/setup":
    case "/assemble/produce": {
      let body;
      try { body = await request.json(); } catch { return json({ error: "Send the details as JSON." }, 400); }
      if (body?.outputs != null) return json({ error: "Split runs go through the background run (POST /assemble/job)." }, 400);
      if (p0 === "/assemble/setup") { const r = await setupProduction(env, body || {}); return json(r, r.saved || r.pending || r.continue ? 200 : 409); }
      // assembleSent / disassembleSent (for the Hub, Nov 19): true once that item's assembly or break-down has been
      // sent to Sellercloud, confirmed or not. The Hub stops calling by itself once assembleSent is true and not done.
      const iid = String(body?.itemId || "").trim();
      const sentFlags = () => itemSentFlags(iid);
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

    case "/kittool": {
      // Read-only test (Nov 23): does the web Kit tab's own JSON call (KitTool/Load) accept the worker's REST token?
      // Sends one Load per host, no Save. Answers each host's status and reply (long text trimmed).
      const sku = (url.searchParams.get("sku") || "").trim();
      if (!sku) return json({ error: "Add ?sku=KIT SKU." }, 400);
      return json(await kitToolLoadTest(env, sku));
    }

    case "/kitimport": {
      // Read-only troubleshooting for the Kits import: the template columns, recent jobs, and one job's status.
      const out = {};
      const short = (v) => JSON.parse(JSON.stringify(v ?? null, (k, x) => (typeof x === "string" && x.length > 2000 ? x.slice(0, 2000) + "…" : x)));
      try { out.template = short(await scGet(env, "/Catalog/Imports/Kits/Template")); } catch (e) { out.template = { error: e.message }; }
      try { const d = await scGet(env, "/QueuedJobs", { pageNumber: 1, pageSize: 10 }); out.recentJobs = short((d?.Items || d?.items || d || []).slice?.(0, 10) ?? d); }
      catch (e) { out.recentJobs = { error: e.message }; }
      const job = url.searchParams.get("job");
      if (job) {
        try { out.job = short(await scGet(env, "/QueuedJobs", { jobID: job })); } catch (e) { out.job = { error: e.message }; }
        try { out.jobDetail = short(await scGet(env, `/QueuedJobs/${encodeURIComponent(job)}`)); } catch (e) { out.jobDetail = { error: e.message }; }
        try { out.jobLog = short(await scGet(env, `/QueuedJobs/${encodeURIComponent(job)}/Logs`, { pageNumber: 1, pageSize: 50 })); } catch (e) { out.jobLog = { error: e.message }; }
        out.statusNames = JOB_STATUS;
      }
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

// ---- Platform catalog look-ups (read-only GETs). Nov 19: Shragy wants the Hub to make a production's final SKU in a
// platform company (Temu, LG DEALS LLC, EAST AND WEST SALES, Walmart company, WOOT); these read how those SKUs look.
async function companyList(env) {
  const data = await scGet(env, "/Companies", { pageNumber: 1, pageSize: 500 });
  return (Array.isArray(data) ? data : data?.Items || data?.Companies || []).map((c) => ({
    companyId: c.ID ?? c.Id ?? c.CompanyID ?? null,
    company: c.CompanyName ?? c.Name ?? null,
  }));
}
const normCo = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
// The platform companies' ids for the final-SKU search (/assemble/find), from Sellercloud's company list
// (1 call, kept 6 hours). If the list can't be read, the search falls back to WAREHOUSE only and says so.
let finalCoCache = null;
async function finalCompanies(env) {
  const want = [...new Set(platformList(env).map((x) => x.company).filter(Boolean))];
  const key = want.map(normCo).join("|");
  if (finalCoCache && finalCoCache.key === key && Date.now() - finalCoCache.at < 6 * 3600e3) return finalCoCache.v;
  let list;
  try { list = await companyList(env); } catch {
    return { ids: [], names: ["WAREHOUSE"], note: "Couldn't read Sellercloud's company list, so only WAREHOUSE was searched." };
  }
  const found = want.map((w) => (/^\d+$/.test(w) ? list.find((c) => String(c.companyId) === w) : list.find((c) => normCo(c.company) === normCo(w)))).filter(Boolean);
  const missing = want.filter((w) => !found.some((c) => String(c.companyId) === w || normCo(c.company) === normCo(w)));
  const v = { ids: found.map((c) => c.companyId), names: ["WAREHOUSE", ...found.map((c) => c.company)],
    note: missing.length ? `No Sellercloud company named ${missing.join(", ")}, so it wasn't searched.` : null };
  finalCoCache = { key, at: Date.now(), v };
  return v;
}
function pickCompany(list, want) {
  if (/^\d+$/.test(want)) return list.find((c) => String(c.companyId) === want) || { companyId: want, company: null };
  const w = normCo(want);
  return list.find((c) => normCo(c.company) === w) || list.find((c) => normCo(c.company).includes(w)) || null;
}
function catalogRow(p) {
  return {
    sku: p.ID ?? p.ProductID ?? null,
    name: p.ProductName ?? null,
    companyId: p.CompanyID ?? null,
    company: p.CompanyName ?? null,
    type: p.ProductType ?? p.ProductTypeName ?? null,
    kit: p.IsKit ?? p.Kit ?? null,
    created: p.CreatedOn ?? p.DateCreated ?? null,
    available: num(p.InventoryAvailableQty),
  };
}
async function catalogLook(env, { company, q, sku, page = 1, raw = false }) {
  let co = null;
  if (company) {
    co = pickCompany(await companyList(env), company);
    if (!co) throw new HttpError(404, `No Sellercloud company matches "${company}".`);
  }
  const params = { pageNumber: page, pageSize: 50, companyID: co ? [co.companyId] : undefined };
  if (q) params.Keyword = q;
  if (sku) params.SKU = [sku];
  const data = await scGet(env, "/catalog", params);
  const items = (data.Items || []).filter((p) => !co || String(p.CompanyID) === String(co.companyId));
  const out = { company: co, q: q || null, sku: sku || null, page, totalResults: data.TotalResults ?? null, items: items.map(catalogRow) };
  if (raw && items[0]) out.fieldsOfFirst = Object.keys(items[0]);
  return out;
}

// ---- Create final SKU (Nov 19, Shragy): a production from a WAREHOUSE listing gets a final SKU made in the platform's
// company. His rules: the platform's prefix goes at the start of the SKU, then the same SKU, short and simple.
// "you write FBA OR FBM IN THE SKU"; East and West is "EAW"; "wfs is wfs"; e.g. Woot: WOOT cookies and cream 1LB.
// The company is separate from the prefix. Each company can be changed with a Text variable (PLATFORM_COMPANY_<KEY>),
// e.g. PLATFORM_COMPANY_WFS (assumed "Walmart company" until he says otherwise).
const PLATFORMS = [
  { key: "TEMU", label: "Temu", prefix: "Temu", company: "Temu" },
  { key: "BB_FBA", label: "Amazon Betty Bet FBA", prefix: "FBA", company: "LG DEALS LLC" },
  { key: "BB_FBM", label: "Amazon Betty Bet FBM", prefix: "FBM", company: "LG DEALS LLC" },
  { key: "EAW_FBA", label: "Amazon East and West FBA", prefix: "EAW FBA", company: "EAST AND WEST SALES" },
  { key: "EAW_FBM", label: "Amazon East and West FBM", prefix: "EAW FBM", company: "EAST AND WEST SALES" },
  { key: "WALMART", label: "Walmart", prefix: "Walmart", company: "Walmart company" },
  { key: "WFS", label: "WFS", prefix: "WFS", company: "Walmart company" },
  { key: "WOOT", label: "Woot", prefix: "WOOT", company: "WOOT" },
];
function platformList(env) {
  return PLATFORMS.map((x) => {
    const c = String(env["PLATFORM_COMPANY_" + x.key] || "").trim();
    return { ...x, company: c || x.company, companySetting: "PLATFORM_COMPANY_" + x.key };
  });
}
const findPlatform = (env, v) => {
  const w = normCo(v);
  return w ? platformList(env).find((x) => normCo(x.key) === w || normCo(x.label) === w) || null : null;
};
const CREATED_KIND = "created-product";
async function createFinalProduct(env, body) {
  if (!assembleOn(env)) throw new HttpError(403, "Sellercloud writes are switched off. They turn on once ASSEMBLE_ENABLED is set to yes.");
  if (!RUN_KV) throw needKv();
  const sku = String(body.sku || "").trim().replace(/\s+/g, " ");
  const name = String(body.name || "").trim().replace(/\s+/g, " ") || sku;
  const sourceSku = String(body.sourceSku || "").trim();
  if (!sku) return { status: 400, created: false, error: "sku is needed." };
  if (sku.length > 100) return { status: 400, created: false, error: "That SKU is too long (over 100 characters)." };
  if (name.length > 255) return { status: 400, created: false, error: "That name is too long (over 255 characters)." };
  const platform = body.platform ? findPlatform(env, body.platform) : null;
  if (body.platform && !platform) return { status: 400, created: false, error: `Unknown platform "${body.platform}".` };
  const want = String(body.companyId || body.companyName || body.company || platform?.company || "").trim();
  if (!want) return { status: 400, created: false, error: "Pick a platform or a company." };
  const key = sku.toLowerCase();

  // Created before by this route: answer the same again, nothing is sent.
  const rec = await durable.match(lockKey(CREATED_KIND, key));
  if (rec) {
    let r = {}; try { r = JSON.parse(await rec.text()); } catch {}
    if (r && r.sku) return { created: true, already: true, ...r, message: `${r.sku} was already created in ${r.company || "Sellercloud"}. Nothing was sent again.` };
  }
  // Another press is creating it right now.
  if (await isLocked("creating-product", key))
    return { status: 409, created: false, busy: true, error: `${sku} is being created right now. Wait a minute, then look again.` };

  // Already in Sellercloud, in any company: refuse and show it.
  const found = await scGet(env, "/catalog", { SKU: [sku], pageNumber: 1, pageSize: 5 });
  const hit = (found.Items || []).find((p) => String(p.ID ?? p.ProductID ?? "").toLowerCase() === key);
  if (hit) return { status: 409, created: false, exists: true, existing: catalogRow(hit),
    error: `${hit.ID ?? sku} already exists in Sellercloud (company ${hit.CompanyName || hit.CompanyID || "?"}). Nothing was created.` };

  const companies = await companyList(env);
  const co = /^\d+$/.test(want) ? companies.find((c) => String(c.companyId) === want) : (companies.find((c) => normCo(c.company) === normCo(want)) || null);
  if (!co) return { status: 400, created: false, error: `No Sellercloud company named "${want}". Nothing was created.`, companies: companies.map((c) => c.company) };

  // Product type: copied from the source product (as for the 0.1 products); or given.
  let type = String(body.productType || "").trim();
  let source = null;
  if (sourceSku) {
    source = await findProduct(env, sourceSku);
    if (!source) return { status: 400, created: false, error: `Source ${sourceSku} isn't in Sellercloud. Nothing was created.` };
    type = type || String(source.ProductTypeName ?? source.ProductType ?? "").trim();
  }
  if (!type) return { status: 400, created: false, error: "Couldn't tell the product type (give sourceSku or productType). Nothing was created." };

  const warnings = [];
  if (platform && !sku.toLowerCase().startsWith(platform.prefix.toLowerCase()))
    warnings.push(`The SKU doesn't start with ${platform.prefix}, the ${platform.label} prefix.`);

  // One create per SKU: the lock holds for 2 minutes; a clear refusal from Sellercloud releases it so he can retry,
  // an unclear end keeps it, and the next press finds the product (if it was made) before sending anything.
  await lock("creating-product", key, 120);
  const payload = { CompanyId: Number(co.companyId), ProductSKU: sku, ProductName: name, ProductTypeName: type };
  try {
    await scPost(env, "/Products", payload);
  } catch (e) {
    if (e instanceof HttpError) await durable.delete(lockKey("creating-product", key)).catch(() => {});
    return { status: e.status || 502, created: false, error: `Sellercloud didn't create ${sku}: ${e.message}` };
  }
  const made = { sku, name, companyId: co.companyId, company: co.company, productType: type, sourceSku: sourceSku || null,
    platform: platform ? platform.key : null, at: new Date().toISOString(), itemId: body.itemId ? String(body.itemId).slice(0, 40) : null };
  await durable.put(lockKey(CREATED_KIND, key), JSON.stringify(made));
  let shows = null;
  try { shows = !!(await findProduct(env, sku)); } catch {}
  return { created: true, ...made, showsInCatalog: shows, warnings,
    message: `Created ${sku} in ${co.company}.${shows === false ? " Sellercloud may take a moment to show it." : ""}` };
}

// ---- Labels (Nov 24, Shragy: "i have a different AI that buys the labels and i want that ai to upload it here in the
// system for the right employee to download and ship / i also want in this tab a label dashboard which basicly shows
// how much was spent fro labels and how many we shipped of each product"). Nothing here calls Sellercloud.
// The PDF of each batch is kept in KV (TOKEN_KV, key labels:file:<batchId>, up to 25 MB); the batch and its lines are
// kept in a SQLite Durable Object (LabelStore, binding LABELS), so the dashboard can add them up.
const LABELS_MAX_BYTES = 25 * 1024 * 1024;
const LABELS_MAX_DAYS = 92;
const labelFileKey = (id) => "labels:file:" + id;
const isDay = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d + "T00:00:00Z"));
const dayShift = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
function labelsRange(url) {
  const today = new Date().toISOString().slice(0, 10);
  const to = url.searchParams.get("to") || today;
  const from = url.searchParams.get("from") || dayShift(to, -29);
  if (!isDay(from) || !isDay(to)) throw new HttpError(400, "from and to must be dates like 2026-11-24.");
  if (from > to) throw new HttpError(400, "from is after to.");
  if ((Date.parse(to) - Date.parse(from)) / 86400000 + 1 > LABELS_MAX_DAYS) throw new HttpError(400, `Pick at most ${LABELS_MAX_DAYS} days.`);
  return { from, to };
}
async function labelsCall(env, path, body) {
  if (!env.LABELS) throw new HttpError(501, "Labels aren't switched on yet (the LABELS store isn't deployed).");
  const stub = env.LABELS.get(env.LABELS.idFromName("labels"));
  const r = await stub.fetch("https://labels.internal" + path, { method: "POST", body: JSON.stringify(body || {}) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new HttpError(r.status, data.error || "Labels store error.");
  return data;
}
// Checks the uploaded data; returns { batch, lines, problems }.
function labelsCheck(d) {
  const problems = [];
  const str = (v, max) => (v == null ? "" : String(v)).trim().slice(0, max);
  if (!d || typeof d !== "object" || Array.isArray(d)) return { problems: ["data must be a JSON object."] };
  const batchId = str(d.batchId, 200);
  if (!batchId) problems.push("batchId is required.");
  else if (!/^[A-Za-z0-9._-]{1,80}$/.test(batchId)) problems.push("batchId may use only letters, digits, dot, dash and underscore, up to 80 characters.");
  const date = str(d.date, 20);
  if (!isDay(date)) problems.push("date is required as YYYY-MM-DD.");
  const list = Array.isArray(d.labels) ? d.labels : null;
  if (!list || !list.length) problems.push("labels must list at least one label.");
  else if (list.length > 5000) problems.push("labels holds more than 5000 entries; split it into batches.");
  const lines = (list || []).slice(0, 5000).map((l, i) => {
    const n = i + 1;
    if (!l || typeof l !== "object") { problems.push(`labels[${n}] is not an object.`); return null; }
    const sku = str(l.sku, 100);
    if (!sku) problems.push(`labels[${n}]: sku is required.`);
    const qty = Number(l.qty);
    if (!Number.isInteger(qty) || qty < 1) problems.push(`labels[${n}]: qty must be a whole number of 1 or more.`);
    const cost = Number(l.cost);
    if (l.cost == null || l.cost === "" || !Number.isFinite(cost) || cost < 0) problems.push(`labels[${n}]: cost must be a number of 0 or more.`);
    const page = l.page == null || l.page === "" ? null : Number(l.page);
    if (page !== null && (!Number.isInteger(page) || page < 1)) problems.push(`labels[${n}]: page must be a whole number of 1 or more.`);
    return { sku, productName: str(l.productName, 255), qty, carrier: str(l.carrier, 60), service: str(l.service, 100),
      tracking: str(l.tracking, 100), cost: Math.round(cost * 100) / 100, orderId: str(l.orderId, 100), page };
  });
  const batch = { batchId, date, platform: str(d.platform, 60), employee: str(d.employee, 100), note: str(d.note, 500), carrier: str(d.carrier, 60) };
  return { batch, lines: lines.filter(Boolean), problems };
}
// Carriers (Nov 24, Shragy: "it should always have carrier labels"). Names are matched case-insensitively to the
// known ones; anything else is kept as sent (trimmed); empty = "Unknown".
const CARRIERS = ["GOFO", "UPS", "USPS", "FedEx", "DHL", "OnTrac", "Amazon Shipping", "Veho", "LaserShip"];
const CARRIER_KEY = (v) => String(v || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const CARRIER_BY_KEY = new Map(CARRIERS.map((c) => [CARRIER_KEY(c), c]));
function normCarrier(v) {
  const t = String(v == null ? "" : v).trim();
  if (!t) return "";
  return CARRIER_BY_KEY.get(CARRIER_KEY(t)) || t;
}
// Batch carrier and per-carrier breakdown, from the batch-level carrier (if sent) and the lines' carriers.
// A package (same tracking, or a no-tracking line with a cost) takes its first line's carrier.
function carrierInfo(batchCarrier, lines) {
  const own = normCarrier(batchCarrier);
  const seen = [...new Set(lines.map((l) => normCarrier(l.carrier)).filter(Boolean))];
  const carrier = own || (seen.length === 1 ? seen[0] : seen.length > 1 ? "Mixed" : "Unknown");
  const fallback = carrier === "Mixed" ? "Unknown" : carrier;
  const per = new Map();
  const get = (c) => per.get(c) || (per.set(c, { carrier: c, labels: 0, units: 0, cost: 0 }), per.get(c));
  const pkg = new Map();
  const eff = [];
  for (const l of lines) {
    let c = normCarrier(l.carrier) || fallback;
    if (l.tracking) { if (pkg.has(l.tracking)) c = pkg.get(l.tracking); else { pkg.set(l.tracking, c); get(c).labels++; } }
    else if (l.cost > 0) get(c).labels++;
    const g = get(c);
    g.units += l.qty || 0; g.cost += l.cost || 0;
    eff.push(c);
  }
  const carriers = [...per.values()].map((x) => ({ ...x, cost: Math.round(x.cost * 100) / 100 })).sort((a, b) => b.cost - a.cost || b.labels - a.labels);
  return { carrier, carriers, lineCarriers: eff };
}
function labelsCarrierParam(url) {
  const raw = url.searchParams.get("carrier");
  if (raw == null || !raw.trim()) return "";
  const k = CARRIER_KEY(raw);
  return k === "unknown" ? "Unknown" : k === "mixed" ? "Mixed" : normCarrier(raw);
}
// Labels in a batch: one per package. Lines with the same tracking number are one package; a line without tracking
// counts as a package when it carries a cost (the guide puts a package's cost on its first line, 0 on the rest).
function labelsCount(lines) {
  const seen = new Set();
  let n = 0;
  for (const l of lines) {
    if (l.tracking) { if (!seen.has(l.tracking)) { seen.add(l.tracking); n++; } }
    else if (l.cost > 0) n++;
  }
  return n;
}
async function labelsUpload(request, env) {
  const want = String(env.LABELS_KEY || "").trim();
  if (!want) return json({ error: "Label uploads are not switched on." }, 501);
  const key = String(request.headers.get("X-Labels-Key") || "").trim();
  if (!key || !safeEqual(key, want)) return json({ error: "Missing or wrong labels key." }, 401);
  if (!env.TOKEN_KV || !env.LABELS) return json({ error: "Label uploads are not switched on." }, 501);
  let form;
  try { form = await request.formData(); } catch { return json({ error: "Send multipart/form-data with a file part and a data part." }, 400); }
  const file = form.get("file");
  const raw = form.get("data");
  const problems = [];
  if (!file || typeof file === "string") problems.push("file (the labels PDF) is required.");
  let data = null;
  if (raw == null) problems.push("data (the JSON text) is required.");
  else { try { data = JSON.parse(typeof raw === "string" ? raw : await raw.text()); } catch { problems.push("data is not valid JSON."); } }
  let bytes = null;
  if (file && typeof file !== "string") {
    if (file.size > LABELS_MAX_BYTES) problems.push("file is over 25 MB; split it into batches.");
    else {
      bytes = await file.arrayBuffer();
      const head = new TextDecoder().decode(new Uint8Array(bytes.slice(0, 5)));
      if (head !== "%PDF-") problems.push("file is not a PDF.");
    }
  }
  const checked = data ? labelsCheck(data) : { problems: [] };
  problems.push(...(checked.problems || []));
  if (problems.length) return json({ error: problems.join(" "), problems }, 400);
  const { batch, lines } = checked;
  batch.labels = labelsCount(lines);
  batch.units = lines.reduce((s, l) => s + l.qty, 0);
  batch.totalCost = Math.round(lines.reduce((s, l) => s + l.cost, 0) * 100) / 100;
  batch.fileSize = bytes.byteLength;
  batch.uploadedAt = new Date().toISOString();
  await env.TOKEN_KV.put(labelFileKey(batch.batchId), bytes, { metadata: { size: bytes.byteLength, at: batch.uploadedAt } });
  const saved = await labelsCall(env, "/put", { batch, lines });
  return json({ ok: true, batchId: batch.batchId, carrier: carrierInfo(batch.carrier, lines).carrier, labels: batch.labels, units: batch.units, totalCost: batch.totalCost, replaced: !!saved.replaced });
}
// PDF downloads. /labels/file (Hub key) honours Range: bytes=a-b for chunked downloads; /labels/dl serves a signed,
// 15-minute link (POST /labels/file-link) so the browser downloads straight from the worker, with no key in the link.
const labelsFilename = (batch) => `labels-${batch.date}-${batch.batchId}.pdf`;
const labelsLinkSecret = (env) => String(env.ASSEMBLE_KEY || env.APP_KEY || "").trim();
async function labelsSign(secret, batchId, exp) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode("labels-dl:" + secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(`${batchId}|${exp}`));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function labelsPdf(env, request, batchId, filename, cors) {
  const base = { "content-type": "application/pdf", "content-disposition": `attachment; filename="${filename}"`, "accept-ranges": "bytes",
    "cache-control": "private, no-store", ...(cors === "any" ? { "access-control-allow-origin": "*", "access-control-expose-headers": "Content-Disposition, Content-Range, Content-Length, Accept-Ranges" } : cors ? { ...corsHeaders(), "access-control-expose-headers": "Content-Disposition, Content-Range, Content-Length, Accept-Ranges" } : {}) };
  const range = (request.headers.get("Range") || "").trim();
  const m = range.match(/^bytes=(\d*)-(\d*)$/);
  if (m && (m[1] || m[2])) {
    const buf = await env.TOKEN_KV.get(labelFileKey(batchId), "arrayBuffer");
    if (!buf) return null;
    const total = buf.byteLength;
    let a, b;
    if (m[1]) { a = Number(m[1]); b = m[2] ? Math.min(Number(m[2]), total - 1) : total - 1; }
    else { a = Math.max(0, total - Number(m[2])); b = total - 1; }
    if (a >= total || a > b) return new Response(null, { status: 416, headers: { ...base, "content-range": `bytes */${total}` } });
    const part = buf.slice(a, b + 1);
    return new Response(request.method === "HEAD" ? null : part, { status: 206, headers: { ...base, "content-range": `bytes ${a}-${b}/${total}`, "content-length": String(part.byteLength) } });
  }
  const got = await env.TOKEN_KV.getWithMetadata(labelFileKey(batchId), "stream");
  if (!got || !got.value) return null;
  const size = got.metadata && got.metadata.size;
  const headers = { ...base, ...(size ? { "content-length": String(size) } : {}) };
  if (request.method === "HEAD") { try { await got.value.cancel(); } catch {} return new Response(null, { headers }); }
  return new Response(got.value, { headers });
}
async function labelsDirect(request, env, url) {
  const gone = () => new Response("This download link has expired. Open it again from the Hub.", { status: 403, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  const batchId = (url.searchParams.get("batchId") || "").trim();
  const exp = (url.searchParams.get("exp") || "").trim();
  const sig = (url.searchParams.get("sig") || "").trim().toLowerCase();
  const secret = labelsLinkSecret(env);
  if (!secret || !env.TOKEN_KV || !/^[A-Za-z0-9._-]{1,80}$/.test(batchId) || !/^\d{1,12}$/.test(exp) || !/^[0-9a-f]{64}$/.test(sig)) return gone();
  if (Number(exp) < Math.floor(Date.now() / 1000)) return gone();
  if (!safeEqual(sig, await labelsSign(secret, batchId, Number(exp)))) return gone();
  let batch;
  try { ({ batch } = await labelsCall(env, "/get", { batchId })); } catch { return new Response("That batch isn't there any more.", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } }); }
  // CORS (Nov 25): the FBM printing tab reads the PDF it was given a link to. The signed, 15-minute link is itself the
  // permission, so any origin may read it (the Hub's frame origin isn't always a monday.com / monday.app host).
  const res = await labelsPdf(env, request, batchId, labelsFilename(batch), "any");
  return res || new Response("That batch's PDF isn't there.", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "access-control-allow-origin": "*" } });
}
async function labelsRoute(request, env, path, url) {
  switch (path) {
    case "/labels/batches": {
      const { from, to } = labelsRange(url);
      return json(await labelsCall(env, "/list", { from, to, carrier: labelsCarrierParam(url) }));
    }
    case "/labels/batch": {
      const batchId = (url.searchParams.get("batchId") || "").trim();
      if (!batchId) return json({ error: "Add ?batchId=..." }, 400);
      return json(await labelsCall(env, "/get", { batchId }));
    }
    case "/labels/file": {
      const batchId = (url.searchParams.get("batchId") || "").trim();
      if (!/^[A-Za-z0-9._-]{1,80}$/.test(batchId)) return json({ error: "Add ?batchId=..." }, 400);
      if (!env.TOKEN_KV) return json({ error: "Labels aren't switched on yet." }, 501);
      const { batch } = await labelsCall(env, "/get", { batchId });
      const res = await labelsPdf(env, request, batchId, labelsFilename(batch), true);
      return res || json({ error: "That batch's PDF isn't there." }, 404);
    }
    case "/labels/file-link": {
      let body = {};
      try { body = (await request.json()) || {}; } catch {}
      const batchId = String(body.batchId || "").trim();
      if (!/^[A-Za-z0-9._-]{1,80}$/.test(batchId)) return json({ error: "batchId is needed." }, 400);
      const secret = labelsLinkSecret(env);
      if (!secret) return json({ error: "Download links aren't switched on." }, 501);
      const { batch } = await labelsCall(env, "/get", { batchId });
      const exp = Math.floor(Date.now() / 1000) + 15 * 60;
      const sig = await labelsSign(secret, batchId, exp);
      const link = new URL("/labels/dl", url.origin);
      link.searchParams.set("batchId", batchId); link.searchParams.set("exp", String(exp)); link.searchParams.set("sig", sig);
      return json({ url: link.toString(), expiresAt: new Date(exp * 1000).toISOString(), size: batch.fileSize || null, filename: labelsFilename(batch) });
    }
    case "/labels/downloaded": {
      let body = {};
      try { body = (await request.json()) || {}; } catch {}
      const batchId = String(body.batchId || "").trim();
      if (!batchId) return json({ error: "batchId is needed." }, 400);
      await labelsCall(env, "/downloaded", { batchId, by: String(body.by || "").trim().slice(0, 100) || "Someone" });
      return json({ ok: true });
    }
    case "/labels/stats": {
      const { from, to } = labelsRange(url);
      const groupBy = (url.searchParams.get("groupBy") || "day").toLowerCase();
      if (!["day", "week", "month"].includes(groupBy)) return json({ error: "groupBy is day, week or month." }, 400);
      return json(await labelsCall(env, "/stats", { from, to, groupBy, carrier: labelsCarrierParam(url) }));
    }
  }
  return json({ error: "Not found." }, 404);
}

// ---- Scan station (Nov 25, Shragy: "the system should work with a scan lets say you scan the first product it prints out
// all labels fro that product devided by qty and you move on to the next product", "lets start just with temu",
// "they are going to scan a UPC", "i need it in the hub only"). The Hub's FBM printing tab is the station. It reads the day's uploaded label batches, finds a scanned UPC's SKUs in Sellercloud (read-only), and
// prints that product's labels grouped by units per package, a header sheet before each group. Nothing here buys,
// changes or uploads labels, and nothing writes to Sellercloud. The only things it saves are in the labels store:
// which packages were printed (so they aren't printed twice) and UPC -> label SKU links picked on the station.
const SCAN_UPC_TTL = 7 * 24 * 60 * 60; // seconds a UPC's Sellercloud SKUs are kept in KV
const upcDigits = (v) => String(v == null ? "" : v).replace(/\D/g, "");
const upcKey = (v) => upcDigits(v).replace(/^0+/, "");
// The SKU without a platform prefix ("Temu - X", "FBM X", "EAW FBM X", "Walmart X", "WOOT X"), letters and digits only,
// so a label's "Temu X" and Sellercloud's "X" match.
function scanSkuKey(s) {
  let t = String(s == null ? "" : s).toLowerCase().trim();
  for (let i = 0; i < 2; i++) t = t.replace(/^(temu|eaw\s*fbm|eaw\s*fba|eaw|fbm|fba|walmart|wfs|woot)(?=[\s\-_:.]|$)[\s\-_:.]*/, "");
  return t.replace(/[^a-z0-9]/g, "");
}
// Sellercloud products whose UPC is the scanned one. Tries the catalog's UPC filter, then a keyword search, then the
// Sellercloud Products board (read-only); keeps only products whose UPC really matches. Found answers are kept 7 days.
async function scanUpcProducts(env, raw) {
  const key = upcKey(raw);
  if (key.length < 6) throw new HttpError(400, "That doesn't look like a UPC.");
  const ck = "labels:upc:" + key;
  if (env.TOKEN_KV) {
    const hit = await env.TOKEN_KV.get(ck, "json").catch(() => null);
    if (hit && Array.isArray(hit.products) && hit.products.length) return { ...hit, cached: true };
  }
  const digits = upcDigits(raw);
  const same = (p) => upcKey(p.UPC ?? p.upc) === key;
  const out = new Map();
  const add = (p, from) => {
    const x = p.sku ? p : slimProduct(p);
    if (!x.sku || out.has(String(x.sku).toLowerCase())) return;
    out.set(String(x.sku).toLowerCase(), { sku: String(x.sku), name: x.name || "", company: x.company || "", imageUrl: x.imageUrl || null, from });
  };
  let scError = null;
  const tries = [{ UPC: digits }, { Keyword: digits }];
  if (digits.length === 12) tries.push({ Keyword: "0" + digits });
  for (const params of tries) {
    try {
      const d = await scGet(env, "/catalog", { ...params, pageNumber: 1, pageSize: 50 });
      (d.Items || []).filter(same).forEach((p) => add(p, "sellercloud"));
    } catch (e) { scError = e; if (e.busy) break; }
    if (out.size) break;
  }
  if (!out.size && env.MONDAY_TOKEN && env.SYNC_BOARD_ID) {
    try {
      const boardId = syncBoardId(env);
      const vals = [...new Set([digits, key, key.padStart(12, "0"), key.padStart(13, "0")])];
      const d = await mondayApi(env, `query($b:[ID!],$c:[String!]){ boards(ids:$b){ items_page(limit:25, query_params:{rules:[{column_id:"${COLS.upc}", compare_value:${gql(vals)}, operator:any_of}]}){
        items{ id name column_values(ids:$c){ id text value } } } } }`, { b: [boardId], c: [COLS.sku, COLS.upc, COLS.photo] });
      for (const it of d.boards?.[0]?.items_page?.items || []) {
        const cv = Object.fromEntries(it.column_values.map((c) => [c.id, c]));
        let photo = null;
        try { photo = JSON.parse(cv[COLS.photo]?.value || "null")?.url || null; } catch {}
        if (upcKey(cv[COLS.upc]?.text) === key) add({ sku: (cv[COLS.sku]?.text || "").trim(), name: it.name, company: "WAREHOUSE", imageUrl: photo }, "board");
      }
    } catch {}
  }
  const products = [...out.values()];
  if (!products.length && scError) throw scError;
  const res = { upc: digits, products };
  if (products.length && env.TOKEN_KV) await env.TOKEN_KV.put(ck, JSON.stringify(res), { expirationTtl: SCAN_UPC_TTL }).catch(() => {});
  return res;
}
// A channel SKU without its platform name: "TEMU - M&Ms Peanut butter" -> "M&Ms Peanut butter".
function labelsBaseSku(sku) {
  return String(sku || "").replace(/^\s*(temu|eaw\s*fbm|eaw\s*fba|eaw|fbm|fba|walmart|wfs|woot)\s*[-_:.]\s*/i, "").trim();
}
const LABELS_TITLE_KEY = "labels:titlesku:v1";
const labelsTitle = (t) => String(t || "").trim().toLowerCase().replace(/\s+/g, " ").slice(0, 200);
// Read-only. Learns product title -> Sellercloud SKU from one Sellercloud order per title (kept in KV, so only new titles
// cost a lookup), then sets line.scSku on every line of the day. A title that can't be resolved is retried the next day.
async function labelsAddScSkus(env, day, date) {
  const all = [];
  for (const b of day.batches || []) for (const l of b.lines || []) all.push(l);
  if (!all.length) return;
  let map = {};
  try { map = JSON.parse((env.TOKEN_KV && (await env.TOKEN_KV.get(LABELS_TITLE_KEY))) || "{}") || {}; } catch { map = {}; }
  const known = (t) => typeof map[t] === "string" && map[t] && !map[t].startsWith("?");
  const byOrder = new Map();
  for (const l of all) {
    const oid = String(l.orderId || "").trim();
    if (!oid) continue;
    if (!byOrder.has(oid)) byOrder.set(oid, new Set());
    byOrder.get(oid).add(labelsTitle(l.sku));
  }
  const need = [...new Set(all.map((l) => labelsTitle(l.sku)))].filter((t) => t && !known(t) && map[t] !== "?" + date);
  if (need.length) {
    const picks = new Set();
    for (const t of need) {
      let singles = 0, any = null;
      for (const [oid, ts] of byOrder) {
        if (!ts.has(t)) continue;
        if (!any) any = oid;
        if (ts.size === 1) { picks.add(oid); if (++singles >= 5) break; }
      }
      if (!singles && any) picks.add(any);
    }
    const ids = [...picks].slice(0, 300);
    const orders = [];
    const stopAt = Date.now() + 12_000;
    for (let i = 0; i < ids.length && Date.now() < stopAt; i += 25) {
      const data = await scGet(env, "/Orders", { pageNumber: 1, pageSize: 25, orderSourceOrderIDList: ids.slice(i, i + 25) });
      orders.push(...(data?.Items || []));
    }
    const seen = new Map();
    // Two passes: single-product orders first, then mixed orders by elimination or matching name.
    for (let pass = 0; pass < 2; pass++) {
      for (const o of orders) {
        const titles = [...(byOrder.get(String(o.OrderSourceOrderID || "").trim()) || [])];
        const items = (o.Items || []).filter((i) => i?.ProductID);
        const pids = [...new Set(items.map((i) => String(i.ProductID)))];
        if (!titles.length || !pids.length) continue;
        if (titles.length === 1 && pids.length === 1) {
          // Nov 27: only learn a real SKU, and only when every single-product sample of the title agrees.
          const t0 = titles[0];
          if (lRealSku(pids[0]) && (!known(t0) || seen.has(t0))) {
            const prev = seen.get(t0);
            if (prev === undefined) { seen.set(t0, pids[0]); map[t0] = pids[0]; }
            else if (prev !== "!" && prev !== pids[0]) { seen.set(t0, "!"); delete map[t0]; }
          }
          continue;
        }
        for (const t of titles) {
          if (known(t) || seen.get(t) === "!") continue;
          const byName = items.filter((i) => labelsTitle(i.DisplayName) === t || labelsTitle(i.ProductName) === t);
          if (byName.length === 1) { map[t] = String(byName[0].ProductID); continue; }
          const used = new Set(titles.filter(known).map((x) => map[x]));
          const left = pids.filter((p) => !used.has(p));
          const open = titles.filter((x) => !known(x));
          if (pass === 1 && open.length === 1 && left.length === 1) map[t] = left[0];
        }
      }
    }
    for (const t of need) if (!known(t) && ids.length && Date.now() < stopAt) map[t] = "?" + date;
    if (env.TOKEN_KV) await env.TOKEN_KV.put(LABELS_TITLE_KEY, JSON.stringify(map)).catch(() => {});
  }
  for (const l of all) {
    const v = map[labelsTitle(l.sku)];
    l.scSku = v && !v.startsWith("?") && lRealSku(v) ? v : null;
  }
}
// A product's photo link: the catalog image (as the Hub's product search shows it), else Sellercloud's product images;
// the channel SKU first, then the same SKU without the platform name. Kept 7 days in KV (none: 1 hour).
// A Sellercloud image URL that is a real photo (Sellercloud shows NoImageAvailable.gif for products with none).
function labelsRealPhoto(u) {
  const s = String(u || "").trim();
  return /^https?:\/\//i.test(s) && !/NoImageAvailable|no[-_ ]?image/i.test(s) ? s : null;
}
async function labelsPhoto(env, sku, fresh = false) {
  const ck = `labels:photo3:${sku.toLowerCase()}`;
  const hit = env.TOKEN_KV && !fresh ? await env.TOKEN_KV.get(ck) : null;
  if (hit !== null) return { sku, url: hit || null, cached: true };
  let photo = null;
  const tried = [];
  try {
    // The SKU, then the SKU without its platform name, then (for kits) the first product inside the kit.
    const queue = [...new Set([sku, labelsBaseSku(sku)])].filter(Boolean);
    for (let n = 0; n < queue.length && n < 4 && !photo; n++) {
      const id = queue[n];
      const data = await scGet(env, "/catalog", { SKU: [id], pageNumber: 1, pageSize: 5 });
      const p = (data.Items || []).find((x) => String(x.ID ?? x.ProductID ?? "").toLowerCase() === id.toLowerCase());
      tried.push(id + (p ? "" : " (no product)"));
      if (!p) continue;
      photo = labelsRealPhoto(p.ImageUrl);
      if (photo) break;
      const img = await scGet(env, "/ProductImage", { productID: id }).catch(() => null);
      const list = Array.isArray(img) ? img : img?.Images || img?.Items || [];
      const pick = list.find((i) => i?.IsDefault && labelsRealPhoto(i?.Url)) || list.find((i) => labelsRealPhoto(i?.Url));
      photo = pick ? labelsRealPhoto(pick.Url) : null;
      if (!photo && p.IsKit && p.FirstKitChild && !queue.includes(p.FirstKitChild)) queue.push(String(p.FirstKitChild));
    }
  } catch (e) {
    return { sku, url: null, error: String(e?.message || e).slice(0, 200), tried };
  }
  if (photo) photo = photo.replace(/^http:\/\//i, "https://");
  if (env.TOKEN_KV) await env.TOKEN_KV.put(ck, photo || "", { expirationTtl: photo ? 7 * 86400 : 3600 });
  return { sku, url: photo, tried };
}
async function scanRoute(request, env, path, url) {
  const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};
  switch (path) {
    case "/labels/day": {
      const date = (url.searchParams.get("date") || "").trim();
      if (!isDay(date)) return json({ error: "Add ?date=YYYY-MM-DD." }, 400);
      const day = await labelsCall(env, "/day", { date });
      // Each line gets scSku, the Sellercloud SKU of its product (uploads carry the product title as sku).
      try { await labelsAddScSkus(env, day, date); } catch (e) { day.scSkuError = String(e?.message || e).slice(0, 200); }
      // Labels check results (Check button), by "batchId|pkg".
      day.checks = await labelsChecks(env, date);
      return json(day);
    }
    case "/labels/check": {
      // Read only in Sellercloud: checks the given label packages (or all of the day's) and keeps the results.
      const date = String(body.date || "").trim();
      if (!isDay(date)) return json({ error: "Add date as YYYY-MM-DD." }, 400);
      const items = Array.isArray(body.items) ? body.items.slice(0, 600).map((x) => ({ batchId: String(x?.batchId || "").trim(), pkg: String(x?.pkg || "").trim().slice(0, 120) })).filter((x) => x.batchId && x.pkg) : null;
      deadline = Date.now() + 25_000;
      const r = await labelsCheckRun(env, date, { want: items });
      return json({ date, results: r.results.map(({ scId, carrier, service, ...x }) => x), partial: r.partial, unchecked: r.unchecked });
    }
    case "/labels/aside": {
      // Sets aside (aside: true) or brings back not-good labels; good labels are never set aside.
      const date = String(body.date || "").trim();
      if (!isDay(date)) return json({ error: "Add date as YYYY-MM-DD." }, 400);
      const items = Array.isArray(body.items) ? body.items.slice(0, 2000).map((x) => ({ batchId: String(x?.batchId || "").trim(), pkg: String(x?.pkg || "").trim().slice(0, 120) })).filter((x) => x.batchId && x.pkg) : [];
      // { listed: true|false } instead of aside moves set-aside labels into (or out of) Today's products as a fixed line.
      const changed = typeof body.fixed === "boolean"
        ? await labelsAside(env, date, items, body.fixed, "fixed")
        : typeof body.listed === "boolean"
        ? await labelsAside(env, date, items, body.listed, "listed")
        : await labelsAside(env, date, items, body.aside !== false);
      return json({ ok: true, changed, checks: await labelsChecks(env, date) });
    }
    case "/labels/upc": {
      const upc = (url.searchParams.get("upc") || "").trim();
      const found = await scanUpcProducts(env, upc);
      const { links } = await labelsCall(env, "/links", { upc: upcKey(upc) });
      return json({ ...found, links, skuKeys: [...new Set([...found.products.map((p) => scanSkuKey(p.sku)), ...links.map(scanSkuKey)].filter(Boolean))] });
    }
    case "/labels/photo": {
      // Read-only: a product's photo for the Hub's FBM printing list.
      const sku = (url.searchParams.get("sku") || "").trim().slice(0, 100);
      if (!sku) return json({ error: "Add ?sku=..." }, 400);
      return json(await labelsPhoto(env, sku));
    }
    case "/labels/printed": {
      const items = Array.isArray(body.items) ? body.items.slice(0, 2000) : [];
      const clean = items.map((x) => ({ batchId: String(x?.batchId || "").trim(), pkg: String(x?.pkg || "").trim().slice(0, 120) }))
        .filter((x) => /^[A-Za-z0-9._-]{1,80}$/.test(x.batchId) && x.pkg);
      if (!clean.length) return json({ error: "items (batchId and pkg each) are needed." }, 400);
      const done = await labelsCall(env, "/printed", { items: clean, by: String(body.by || "").trim().slice(0, 100) || "Scan station" });
      // Auto mark shipped (switched off unless turned on): queue the printed packages for the timer.
      try { await autoshipEnqueue(env, clean, String(body.by || "").trim().slice(0, 100)); } catch (e) { console.log("autoship queue failed: " + e.message); }
      return json(done);
    }
    case "/labels/sku-link": {
      // Nov 27 (Shragy): links a line (a listing title) to its Sellercloud SKU, for lines the worker couldn't link itself.
      // Only a SKU Sellercloud shows for that line's own orders that day can be chosen. Remembered for the title.
      const date = String(body.date || "").trim();
      const title = labelsTitle(body.title);
      const sku = String(body.sku || "").trim().slice(0, 100);
      if (!isDay(date) || !title || !sku) return json({ error: "date, title and sku are needed." }, 400);
      const stored = await labelsChecks(env, date);
      const mine = Object.values(stored).filter((x) => labelsTitle(x.title) === title.slice(0, 200));
      const offered = new Set(mine.filter((x) => x.items && x.items.length === 1 && lRealSku(x.items[0].sku)).map((x) => x.items[0].sku));
      if (!offered.has(sku)) return json({ error: "Sellercloud doesn't show that SKU for this line's orders." }, 400);
      let map = {};
      try { map = JSON.parse((env.TOKEN_KV && (await env.TOKEN_KV.get(LABELS_TITLE_KEY))) || "{}") || {}; } catch { map = {}; }
      map[title] = sku;
      if (env.TOKEN_KV) await env.TOKEN_KV.put(LABELS_TITLE_KEY, JSON.stringify(map));
      // Re-judge this line's stored results against the new line SKU (no new Sellercloud call needed).
      const upd = [];
      for (const x of mine) {
        if (x.notInSc || !x.items || x.items.length !== 1) continue;
        // Only labels whose one problem was the line link: everything else Check found still stands.
        const lineOnly = x.kind === "unconfirmed" || (x.kind === "wrong" && (x.reasons || []).length === 1 && /^wrong line/.test(x.reasons[0]));
        if (!lineOnly && !x.good) continue;
        const it = x.items[0];
        if (!lRealSku(it.sku)) continue;
        const v = { ...x, labelSku: sku };
        if (it.sku === sku) Object.assign(v, { good: true, kind: x.kind === "shipped" ? "shipped" : "good", reasons: [] });
        else Object.assign(v, { good: false, kind: "wrong", reasons: [`wrong line: this line is ${sku} but Sellercloud has ${it.sku} for this order`] });
        upd.push(v);
      }
      if (upd.length) await labelsCall(env, "/checks-put", { date, items: upd });
      return json({ ok: true, sku, changed: upd.length, checks: await labelsChecks(env, date) });
    }
    case "/labels/link": {
      const upc = upcKey(body.upc);
      const sku = String(body.sku || "").trim().slice(0, 100);
      if (upc.length < 6 || !sku) return json({ error: "upc and sku are needed." }, 400);
      return json(await labelsCall(env, body.remove ? "/unlink" : "/link", { upc, sku, by: String(body.by || "").trim().slice(0, 100) }));
    }
  }
  return null;
}


// The labels store: one SQLite Durable Object holding every batch and its lines.
export class LabelStore {
  constructor(state) {
    this.sql = state.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS batches (batch_id TEXT PRIMARY KEY, date TEXT NOT NULL, platform TEXT, employee TEXT, note TEXT,
      uploaded_at TEXT, labels INTEGER, units INTEGER, total_cost REAL, file_size INTEGER, downloads TEXT DEFAULT '[]')`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS lines (batch_id TEXT NOT NULL, idx INTEGER NOT NULL, sku TEXT, product_name TEXT, qty INTEGER,
      carrier TEXT, service TEXT, tracking TEXT, cost REAL, order_id TEXT, page INTEGER, PRIMARY KEY (batch_id, idx))`);
    this.sql.exec("CREATE INDEX IF NOT EXISTS batches_date ON batches(date)");
    const cols = this.sql.exec("PRAGMA table_info(batches)").toArray().map((c) => c.name);
    if (!cols.includes("carrier")) this.sql.exec("ALTER TABLE batches ADD COLUMN carrier TEXT DEFAULT ''");
    // Scan station (Nov 25): printed packages (pkg = "t:" + tracking, or "i:" + the package's first line index) and
    // UPC -> label SKU links picked on the station.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS printed (batch_id TEXT NOT NULL, pkg TEXT NOT NULL, printed_at TEXT, by TEXT, times INTEGER DEFAULT 1,
      PRIMARY KEY (batch_id, pkg))`);
    this.sql.exec("CREATE TABLE IF NOT EXISTS upc_links (upc TEXT NOT NULL, sku TEXT NOT NULL, by TEXT, at TEXT, PRIMARY KEY (upc, sku))");
    // Label checks (Nov 26): one row per checked package, so several Checks running at once never overwrite each other.
    this.sql.exec("CREATE TABLE IF NOT EXISTS checks (date TEXT NOT NULL, id TEXT NOT NULL, v TEXT NOT NULL, PRIMARY KEY (date, id))");
  }
  lineRow(l) {
    return { sku: l.sku, productName: l.product_name, qty: l.qty, carrier: l.carrier, service: l.service, tracking: l.tracking, cost: l.cost, orderId: l.order_id, page: l.page };
  }
  linesFor(ids) {
    const by = new Map(ids.map((id) => [id, []]));
    for (let i = 0; i < ids.length; i += 50) {
      const part = ids.slice(i, i + 50);
      const rows = this.sql.exec(`SELECT * FROM lines WHERE batch_id IN (${part.map(() => "?").join(",")}) ORDER BY batch_id, idx`, ...part).toArray();
      for (const l of rows) by.get(l.batch_id).push(this.lineRow(l));
    }
    return by;
  }
  withCarrier(b, lines) {
    const { carrier, carriers } = carrierInfo(b.carrier, lines);
    return { ...this.row(b), carrier, carriers };
  }
  row(b) {
    let downloads = [];
    try { downloads = JSON.parse(b.downloads || "[]"); } catch {}
    return { batchId: b.batch_id, date: b.date, platform: b.platform || "", employee: b.employee || "", note: b.note || "", uploadedAt: b.uploaded_at,
      labels: b.labels, units: b.units, totalCost: b.total_cost, fileSize: b.file_size, downloads };
  }
  async fetch(request) {
    const path = new URL(request.url).pathname;
    const body = await request.json().catch(() => ({}));
    const out = (x, s = 200) => new Response(JSON.stringify(x), { status: s, headers: { "content-type": "application/json" } });
    if (path === "/put") {
      const { batch: b, lines } = body;
      const had = this.sql.exec("SELECT batch_id FROM batches WHERE batch_id = ?", b.batchId).toArray().length > 0;
      this.sql.exec("DELETE FROM lines WHERE batch_id = ?", b.batchId);
      this.sql.exec(`INSERT INTO batches (batch_id, date, platform, employee, note, uploaded_at, labels, units, total_cost, file_size, downloads)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]') ON CONFLICT(batch_id) DO UPDATE SET date = excluded.date, platform = excluded.platform,
        employee = excluded.employee, note = excluded.note, uploaded_at = excluded.uploaded_at, labels = excluded.labels, units = excluded.units,
        total_cost = excluded.total_cost, file_size = excluded.file_size`,
        b.batchId, b.date, b.platform, b.employee, b.note, b.uploadedAt, b.labels, b.units, b.totalCost, b.fileSize);
      this.sql.exec("UPDATE batches SET carrier = ? WHERE batch_id = ?", b.carrier || "", b.batchId);
      lines.forEach((l, i) => this.sql.exec(`INSERT INTO lines (batch_id, idx, sku, product_name, qty, carrier, service, tracking, cost, order_id, page)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, b.batchId, i, l.sku, l.productName, l.qty, l.carrier, l.service, l.tracking, l.cost, l.orderId, l.page));
      return out({ ok: true, replaced: had });
    }
    if (path === "/list") {
      const rows = this.sql.exec("SELECT * FROM batches WHERE date >= ? AND date <= ? ORDER BY date DESC, uploaded_at DESC", body.from, body.to).toArray();
      const lines = this.linesFor(rows.map((r) => r.batch_id));
      let batches = rows.map((r) => this.withCarrier(r, lines.get(r.batch_id)));
      if (body.carrier) batches = batches.filter((b) => b.carrier === body.carrier || b.carriers.some((c) => c.carrier === body.carrier));
      return out({ batches });
    }
    if (path === "/get") {
      const b = this.sql.exec("SELECT * FROM batches WHERE batch_id = ?", body.batchId).toArray()[0];
      if (!b) return out({ error: "No batch with that batchId." }, 404);
      const lines = this.sql.exec("SELECT * FROM lines WHERE batch_id = ? ORDER BY idx", body.batchId).toArray().map((l) => this.lineRow(l));
      return out({ batch: { ...this.withCarrier(b, lines), lines } });
    }
    if (path === "/downloaded") {
      const b = this.sql.exec("SELECT downloads FROM batches WHERE batch_id = ?", body.batchId).toArray()[0];
      if (!b) return out({ error: "No batch with that batchId." }, 404);
      let d = [];
      try { d = JSON.parse(b.downloads || "[]"); } catch {}
      d.push({ by: body.by, at: new Date().toISOString() });
      this.sql.exec("UPDATE batches SET downloads = ? WHERE batch_id = ?", JSON.stringify(d.slice(-200)), body.batchId);
      return out({ ok: true });
    }
    // Scan station (Nov 25): the day's batches with every line, which packages were printed, and UPC links.
    if (path === "/day") {
      const rows = this.sql.exec("SELECT * FROM batches WHERE date = ? ORDER BY uploaded_at", body.date).toArray();
      const ids = rows.map((r) => r.batch_id);
      const batches = rows.map((r) => {
        const lines = this.sql.exec("SELECT * FROM lines WHERE batch_id = ? ORDER BY idx", r.batch_id).toArray()
          .map((l) => ({ idx: l.idx, ...this.lineRow(l) }));
        return { ...this.withCarrier(r, lines), lines };
      });
      const printed = [];
      for (let i = 0; i < ids.length; i += 50) {
        const part = ids.slice(i, i + 50);
        printed.push(...this.sql.exec(`SELECT batch_id, pkg, printed_at, by, times FROM printed WHERE batch_id IN (${part.map(() => "?").join(",")})`, ...part)
          .toArray().map((x) => ({ batchId: x.batch_id, pkg: x.pkg, at: x.printed_at, by: x.by, times: x.times })));
      }
      const links = this.sql.exec("SELECT upc, sku FROM upc_links").toArray();
      return out({ date: body.date, batches, printed, links });
    }
    if (path === "/checks-get") {
      const checks = {};
      for (const r of this.sql.exec("SELECT id, v FROM checks WHERE date = ?", String(body.date || "")).toArray()) {
        try { checks[r.id] = JSON.parse(r.v); } catch {}
      }
      return out({ checks });
    }
    if (path === "/checks-put") {
      // raw: write as given. Otherwise keep a stored "aside" while the new result is still not good.
      const date = String(body.date || "");
      for (const c of body.items || []) {
        if (!c || !c.id) continue;
        let v = c;
        if (!body.raw) {
          const prev = this.sql.exec("SELECT v FROM checks WHERE date = ? AND id = ?", date, c.id).toArray()[0];
          let pv = {};
          try { pv = prev ? JSON.parse(prev.v) : {}; } catch {}
          v = { ...c, aside: !!pv.aside && !c.good, listed: !!pv.aside && !!pv.listed && !c.good,
            fixed: !!pv.fixed && !c.good && ((c.kind === "wrong" && (c.items || []).length === 1) || (c.kind === "mixed" && (c.items || []).length > 1)) };
        }
        this.sql.exec("INSERT INTO checks (date, id, v) VALUES (?, ?, ?) ON CONFLICT(date, id) DO UPDATE SET v = excluded.v", date, c.id, JSON.stringify(v));
      }
      const old = new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10);
      this.sql.exec("DELETE FROM checks WHERE date < ?", old);
      return out({ ok: true });
    }
    if (path === "/checks-aside") {
      const date = String(body.date || ""); const at = new Date().toISOString();
      let changed = 0;
      for (const id of body.ids || []) {
        const row = this.sql.exec("SELECT v FROM checks WHERE date = ? AND id = ?", date, id).toArray()[0];
        if (!row) continue;
        let c; try { c = JSON.parse(row.v); } catch { continue; }
        // field "listed" (Nov 26): a set-aside label moved back into Today's products as its own fixed line.
        // field "fixed" (Nov 26): a wrong-product / wrong-qty label moved onto the line of what Sellercloud says the order
        // holds, or a mixed order moved to the mixed orders print. Fixing takes it out of Needs fixing.
        const f = body.field === "listed" ? "listed" : body.field === "fixed" ? "fixed" : "aside";
        if (c.good || !!c[f] === !!body.aside || (f === "listed" && !c.aside)) continue;
        if (f === "fixed" && body.aside && !((c.kind === "wrong" && (c.items || []).length === 1) || (c.kind === "mixed" && (c.items || []).length > 1))) continue;
        c[f] = !!body.aside; c[f + "At"] = at;
        if (f === "aside" && !c.aside) c.listed = false;
        if (f === "aside" && c.aside) c.fixed = false;
        if (f === "fixed" && c.fixed) { c.aside = false; c.listed = false; }
        changed++;
        this.sql.exec("UPDATE checks SET v = ? WHERE date = ? AND id = ?", JSON.stringify(c), date, id);
      }
      return out({ changed });
    }
    if (path === "/printed") {
      const at = new Date().toISOString();
      for (const x of body.items || []) {
        this.sql.exec(`INSERT INTO printed (batch_id, pkg, printed_at, by, times) VALUES (?, ?, ?, ?, 1)
          ON CONFLICT(batch_id, pkg) DO UPDATE SET printed_at = excluded.printed_at, by = excluded.by, times = printed.times + 1`, x.batchId, x.pkg, at, body.by || "");
      }
      return out({ ok: true, printed: (body.items || []).length, at });
    }
    if (path === "/links") {
      const rows = this.sql.exec("SELECT sku FROM upc_links WHERE upc = ?", body.upc).toArray();
      return out({ links: rows.map((r) => r.sku) });
    }
    if (path === "/link") {
      this.sql.exec(`INSERT INTO upc_links (upc, sku, by, at) VALUES (?, ?, ?, ?) ON CONFLICT(upc, sku) DO NOTHING`, body.upc, body.sku, body.by || "", new Date().toISOString());
      return out({ ok: true });
    }
    if (path === "/unlink") {
      this.sql.exec("DELETE FROM upc_links WHERE upc = ? AND sku = ?", body.upc, body.sku);
      return out({ ok: true });
    }
    if (path === "/stats") {
      const { from, to, groupBy, carrier: only } = body;
      const days = this.sql.exec(`SELECT date, SUM(labels) AS labels, SUM(units) AS units, SUM(total_cost) AS spend, COUNT(*) AS batches
        FROM batches WHERE date >= ? AND date <= ? GROUP BY date ORDER BY date`, from, to).toArray();
      const periodOf = (d) => {
        if (groupBy === "month") return d.slice(0, 7);
        if (groupBy === "week") { const wd = (new Date(d + "T00:00:00Z").getUTCDay() + 6) % 7; return dayShift(d, -wd); }
        return d;
      };
      const r2 = (x) => Math.round((x || 0) * 100) / 100;
      const per = new Map();
      const totals = { spend: 0, labels: 0, units: 0, batches: 0 };
      for (const d of days) {
        const k = periodOf(d.date);
        const p = per.get(k) || { period: k, spend: 0, labels: 0, units: 0 };
        p.spend += d.spend || 0; p.labels += d.labels || 0; p.units += d.units || 0;
        per.set(k, p);
        totals.spend += d.spend || 0; totals.labels += d.labels || 0; totals.units += d.units || 0; totals.batches += d.batches || 0;
      }
      let products = this.sql.exec(`SELECT l.sku AS sku, MAX(l.product_name) AS productName, SUM(l.qty) AS units, COUNT(*) AS labels, SUM(l.cost) AS spend
        FROM lines l JOIN batches b ON b.batch_id = l.batch_id WHERE b.date >= ? AND b.date <= ? GROUP BY l.sku ORDER BY units DESC, sku`, from, to).toArray();
      // Per carrier, from each batch's lines (old batches included).
      const brows = this.sql.exec("SELECT * FROM batches WHERE date >= ? AND date <= ?", from, to).toArray();
      const blines = this.linesFor(brows.map((b) => b.batch_id));
      const cs = new Map();
      const fil = { per: new Map(), totals: { spend: 0, labels: 0, units: 0, batches: 0 }, products: new Map() };
      for (const b of brows) {
        const ls = blines.get(b.batch_id);
        const info = carrierInfo(b.carrier, ls);
        for (const c of info.carriers) {
          const t = cs.get(c.carrier) || { carrier: c.carrier, spend: 0, labels: 0, units: 0, batches: 0 };
          t.spend += c.cost; t.labels += c.labels; t.units += c.units; t.batches++;
          cs.set(c.carrier, t);
        }
        if (!only) continue;
        const mine = info.carriers.find((c) => c.carrier === only);
        if (!mine) continue;
        const k = periodOf(b.date);
        const p = fil.per.get(k) || { period: k, spend: 0, labels: 0, units: 0 };
        p.spend += mine.cost; p.labels += mine.labels; p.units += mine.units; fil.per.set(k, p);
        fil.totals.spend += mine.cost; fil.totals.labels += mine.labels; fil.totals.units += mine.units; fil.totals.batches++;
        ls.forEach((l, i) => {
          if (info.lineCarriers[i] !== only) return;
          const q = fil.products.get(l.sku) || { sku: l.sku, productName: "", units: 0, labels: 0, spend: 0 };
          if (l.productName && l.productName > q.productName) q.productName = l.productName;
          q.units += l.qty || 0; q.labels++; q.spend += l.cost || 0; fil.products.set(l.sku, q);
        });
      }
      const carriers = [...cs.values()].map((c) => ({ ...c, spend: r2(c.spend) })).sort((a, b) => b.spend - a.spend || b.labels - a.labels);
      if (only) {
        totals.spend = fil.totals.spend; totals.labels = fil.totals.labels; totals.units = fil.totals.units; totals.batches = fil.totals.batches;
        per.clear(); for (const [k, v] of [...fil.per.entries()].sort()) per.set(k, v);
        products = [...fil.products.values()].sort((a, b) => b.units - a.units || (a.sku < b.sku ? -1 : 1));
      }
      totals.spend = r2(totals.spend);
      return out({ totals, periods: [...per.values()].map((p) => ({ ...p, spend: r2(p.spend) })),
        products: products.map((p) => ({ sku: p.sku, productName: p.productName || "", units: p.units, labels: p.labels, spend: r2(p.spend) })),
        carriers, ...(only ? { carrier: only } : {}) });
    }
    return out({ error: "Not found." }, 404);
  }
}

// ---- Live-board copy (Nov 24, Shragy: "can we do something for now that all the products in production schedule also go
// onto this production hub untill we make the full switch over ?", "only productions that are not started or in progress
// not anyhting done already", and he picked "Just the 43"). One way only: the live Production Schedule is READ, the Hub
// board gets the copies. Every write goes through mirrorMutate, which only writes to the Hub board and its items.
const MIRROR_LIVE = "18410399966"; // READ ONLY
const MIRROR_HUB = "18439411777";
const MIRROR_CRON = "*/5 * * * *";
const MIRROR_MAP = "mirror:map";
const MIRROR_LOCK = "mirror:lock";
const MIRROR_LAST = "mirror:lastrun";
const MC = {
  status: "color_mm2tx0ce", liveRef: "text_mm9dhzy5", qtyProduced: "numeric_mm2tdq3c",
  shipmentId: "long_text_mm33g5nb", fbaLocation: "text_mm3590jg",
};
const MIRROR_GROUP = { live: "topics", hubCopy: "topics", hubNew: "group_mm97fda1", hubCompleted: "group_mm98anpr" };
// Synced live -> Hub when the LIVE value changes. type decides how the value is written.
const MIRROR_COLS = [
  ["text_mm2tm45r", "text"], ["numeric_mm2tqrq1", "numbers"], ["color_mm2tsp4x", "status"], ["color_mm2twbx1", "status"],
  ["color_mm2t69jg", "status"], ["date_mm2t81sa", "date"], ["numeric_mm3a7yka", "numbers"], ["color_mm2vam8n", "status"],
  ["date_mm2tdw74", "date"], ["color_mm2tyghr", "status"], ["numeric_mm2tdq3c", "numbers"], ["text_mm2t9k42", "text"],
  ["date_mm2t70kb", "date"], ["numeric_mm3bpfja", "numbers"], ["text_mm3bt14h", "text"], ["numeric_mm3b1zth", "numbers"],
];
const MIRROR_ONCE = [[MC.shipmentId, "long_text"], [MC.fbaLocation, "text"]];
const MIRROR_FILES = ["file_mm2tnx4a", "file_mm2tgk84", "file_mm2t70h5"];
const MIRROR_EARLY = new Set(["Unassigned", "Assigned", "Queued", "Next Up Manual", "Next Up Machine"]);
// Nov 26: Shragy asked to stop the copy. Off here in the code, whatever MIRROR_ENABLED says in the dashboard (the
// variable is kept by keep_vars, so a push can't change it). To turn the copy back on: set MIRROR_STOPPED to false and push.
const MIRROR_STOPPED = true;
const mirrorOn = (env) => !MIRROR_STOPPED && String(env.MIRROR_ENABLED || "").trim().toLowerCase() === "yes";
const mirrorSkip = (env) => new Set(String(env.MIRROR_SKIP ?? "13598232255").split(",").map((x) => x.trim()).filter(Boolean));

// Live board: reads only. Refuses anything that isn't a query.
async function liveRead(env, query, variables) {
  if (/\bmutation\b/i.test(query)) throw new Error("Refused: the live board is read only.");
  return mondayApi(env, query, variables);
}
// Hub board: the only way the copy writes. kind: create | change | move | file.
async function mirrorMutate(env, ctx, kind, a) {
  if (ctx.calls >= ctx.maxCalls) throw Object.assign(new Error("call budget used"), { budget: true });
  const okItem = (id) => /^\d+$/.test(String(id)) && ctx.hubIds.has(String(id)) && !ctx.liveIds.has(String(id));
  let q, v;
  if (kind === "create") {
    q = `mutation($b:ID!,$g:String!,$n:String!,$c:JSON!){ create_item(board_id:$b, group_id:$g, item_name:$n, column_values:$c, create_labels_if_missing:false){ id } }`;
    v = { b: MIRROR_HUB, g: a.group, n: a.name, c: JSON.stringify(a.cols) };
  } else if (kind === "change") {
    if (!okItem(a.itemId)) throw new Error(`Refused: ${a.itemId} isn't a Hub board item.`);
    q = `mutation($b:ID!,$i:ID!,$c:JSON!){ change_multiple_column_values(board_id:$b, item_id:$i, column_values:$c, create_labels_if_missing:false){ id } }`;
    v = { b: MIRROR_HUB, i: String(a.itemId), c: JSON.stringify(a.cols) };
  } else if (kind === "move") {
    if (!okItem(a.itemId)) throw new Error(`Refused: ${a.itemId} isn't a Hub board item.`);
    q = `mutation($i:ID!,$g:String!){ move_item_to_group(item_id:$i, group_id:$g){ id board{ id } } }`;
    v = { i: String(a.itemId), g: a.group };
  } else if (kind === "file") {
    if (!okItem(a.itemId) || !MIRROR_FILES.includes(a.column)) throw new Error(`Refused: ${a.itemId} isn't a Hub board item.`);
    ctx.calls++; countFetch();
    const fd = new FormData();
    fd.append("query", `mutation ($file: File!) { add_file_to_column (item_id: ${String(a.itemId)}, column_id: "${a.column}", file: $file) { id } }`);
    fd.append("variables[file]", a.blob, a.name);
    const r = await fetch("https://api.monday.com/v2/file", { method: "POST", headers: { Authorization: env.MONDAY_TOKEN }, body: fd });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.errors || d.error_message) throw new Error("monday file upload: " + JSON.stringify(d.errors || d.error_message || r.status).slice(0, 200));
    return d.data;
  } else throw new Error("Refused: unknown write.");
  if (JSON.stringify(v).includes(MIRROR_LIVE)) throw new Error("Refused: that write names the live board.");
  ctx.calls++;
  const d = await mondayApi(env, q, v);
  if (kind === "create") ctx.hubIds.add(String(d.create_item.id));
  await sleep(250);
  return d;
}

// A live column as stored in `last` (compared each run) and as written to the Hub.
function mirrorVal(cv, type) {
  if (!cv) return "";
  if (type === "date") { try { const j = JSON.parse(cv.value || "null"); return j?.date ? (j.time ? `${j.date} ${j.time}` : j.date) : ""; } catch { return ""; } }
  return (cv.text || "").trim();
}
function mirrorWriteVal(type, val) {
  if (val === "" || val == null) return "";
  if (type === "status") return { label: val };
  if (type === "date") { const [date, time] = val.split(" "); return time ? { date, time } : { date }; }
  if (type === "long_text") return { text: val };
  return val; // text, numbers
}
const mirrorAssets = (cv) => { try { return (JSON.parse(cv?.value || "null")?.files || []).map((f) => String(f.assetId)).filter((x) => x && x !== "undefined"); } catch { return []; } };

async function mirrorHubLabels(env) {
  const d = await mondayApi(env, `query($b:[ID!]){ boards(ids:$b){ columns{ id type settings_str } } }`, { b: [MIRROR_HUB] });
  const out = {};
  for (const c of d.boards?.[0]?.columns || []) {
    if (c.type !== "status") continue;
    try { out[c.id] = new Set(Object.values(JSON.parse(c.settings_str || "{}").labels || {}).filter(Boolean)); } catch { out[c.id] = new Set(); }
  }
  return out;
}
const LIVE_COL_IDS = [MC.status, ...MIRROR_COLS.map((c) => c[0]), ...MIRROR_ONCE.map((c) => c[0]), ...MIRROR_FILES];
async function mirrorLiveScope(env) {
  const items = [];
  let cursor = null, first = true;
  while (first || cursor) {
    const d = first
      ? await liveRead(env, `query($b:[ID!],$g:[String],$c:[String!]){ boards(ids:$b){ groups(ids:$g){ items_page(limit:100){ cursor items{ id name state group{ id } column_values(ids:$c){ id text value } } } } } }`,
        { b: [MIRROR_LIVE], g: [MIRROR_GROUP.live], c: LIVE_COL_IDS })
      : await liveRead(env, `query($cur:String!,$c:[String!]){ next_items_page(limit:100, cursor:$cur){ cursor items{ id name state group{ id } column_values(ids:$c){ id text value } } } }`,
        { cur: cursor, c: LIVE_COL_IDS });
    const page = first ? d.boards?.[0]?.groups?.[0]?.items_page : d.next_items_page;
    if (!page) break;
    items.push(...page.items);
    cursor = page.cursor; first = false;
  }
  return items;
}
async function mirrorLiveByIds(env, ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 100) {
    const d = await liveRead(env, `query($i:[ID!],$c:[String!]){ items(ids:$i, limit:100){ id name state board{ id } group{ id } column_values(ids:$c){ id text value } } }`,
      { i: ids.slice(i, i + 100), c: LIVE_COL_IDS });
    out.push(...(d.items || []).filter((x) => String(x.board?.id) === MIRROR_LIVE));
  }
  return out;
}
// Every Hub item (all groups) with its live-item tag, status and group.
async function mirrorHubItems(env) {
  const items = [];
  let cursor = null, first = true;
  const c = [MC.liveRef, MC.status];
  while (first || cursor) {
    const d = first
      ? await mondayApi(env, `query($b:[ID!],$c:[String!]){ boards(ids:$b){ items_page(limit:500){ cursor items{ id state group{ id } column_values(ids:$c){ id text } } } } }`, { b: [MIRROR_HUB], c })
      : await mondayApi(env, `query($cur:String!,$c:[String!]){ next_items_page(limit:500, cursor:$cur){ cursor items{ id state group{ id } column_values(ids:$c){ id text } } } }`, { cur: cursor, c });
    const page = first ? d.boards?.[0]?.items_page : d.next_items_page;
    if (!page) break;
    items.push(...page.items);
    cursor = page.cursor; first = false;
  }
  return items.map((it) => {
    const cv = Object.fromEntries(it.column_values.map((x) => [x.id, x.text || ""]));
    return { id: String(it.id), group: it.group?.id || "", status: cv[MC.status] || "", liveRef: (cv[MC.liveRef] || "").trim() };
  });
}
// Items that items_page didn't return: really gone, or only archived/deleted?
async function mirrorHubStates(env, ids) {
  const out = {};
  for (let i = 0; i < ids.length; i += 100) {
    const d = await mondayApi(env, `query($i:[ID!]){ items(ids:$i, limit:100){ id state board{ id } } }`, { i: ids.slice(i, i + 100) });
    for (const x of d.items || []) if (String(x.board?.id) === MIRROR_HUB) out[String(x.id)] = x.state;
  }
  return out;
}

async function mirrorCopyFiles(env, ctx, rec, hubId, cvs, log) {
  rec.files = rec.files || {};
  for (const col of MIRROR_FILES) {
    const want = mirrorAssets(cvs[col]);
    const done = new Set(rec.files[col] || []);
    const todo = want.filter((x) => !done.has(x));
    if (!todo.length) continue;
    const d = await liveRead(env, `query($i:[ID!]!){ assets(ids:$i){ id name public_url file_size } }`, { i: todo });
    for (const a of d.assets || []) {
      if (ctx.calls + 3 > ctx.maxCalls || Date.now() > ctx.until) return false;
      if (Number(a.file_size) > 25 * 1024 * 1024) { log.push(`skipped ${a.name} (over 25 MB) on live ${rec.liveId}`); done.add(String(a.id)); continue; }
      ctx.calls++; countFetch();
      const r = await fetch(a.public_url);
      if (!r.ok) { log.push(`couldn't download ${a.name} for live ${rec.liveId} (${r.status})`); continue; }
      const blob = await r.blob();
      await mirrorMutate(env, ctx, "file", { itemId: hubId, column: col, blob, name: a.name || "file" });
      done.add(String(a.id));
      ctx.counts.files++;
    }
    rec.files[col] = [...done];
  }
  return true;
}

async function runMirror(env) {
  if (!mirrorOn(env) || !env.TOKEN_KV || !env.MONDAY_TOKEN) return { skipped: "off" };
  const held = await env.TOKEN_KV.get(MIRROR_LOCK);
  if (held && Number(held) > Date.now()) return { skipped: "another run is going" };
  await env.TOKEN_KV.put(MIRROR_LOCK, String(Date.now() + 5 * 60_000), { expirationTtl: 360 });
  const started = Date.now();
  const ctx = { calls: 0, maxCalls: parseInt(env.MIRROR_MAX_CALLS || "350", 10) || 350, until: started + 200_000,
    hubIds: new Set(), liveIds: new Set(), counts: { created: 0, updated: 0, done: 0, left: 0, deleted: 0, adopted: 0, files: 0, errors: 0 } };
  const log = [];
  let map = {};
  try {
    map = (await env.TOKEN_KV.get(MIRROR_MAP, "json")) || {};
    const skip = mirrorSkip(env);
    const labels = await mirrorHubLabels(env);
    const hub = await mirrorHubItems(env);
    for (const h of hub) ctx.hubIds.add(h.id);
    const hubById = new Map(hub.map((h) => [h.id, h]));
    const hubByLive = new Map(hub.filter((h) => h.liveRef).map((h) => [h.liveRef, h]));
    const scope = await mirrorLiveScope(env);
    for (const it of scope) ctx.liveIds.add(String(it.id));
    const inScope = new Map();
    for (const it of scope) {
      const cvs = Object.fromEntries(it.column_values.map((x) => [x.id, x]));
      if (it.state && it.state !== "active") continue;
      if (skip.has(String(it.id))) continue;
      if (mirrorVal(cvs[MC.status], "status") === "Done") continue;
      inScope.set(String(it.id), { it, cvs });
    }
    // Active copies whose live item isn't in scope now: Done, moved, or gone.
    const missing = Object.values(map).filter((r) => r.state === "active" && !inScope.has(r.liveId)).map((r) => r.liveId);
    const elsewhere = new Map((await mirrorLiveByIds(env, missing)).map((x) => { ctx.liveIds.add(String(x.id)); return [String(x.id), x]; }));
    // Copies missing from the Hub board: deleted or archived there (never recreated).
    const gone = Object.values(map).filter((r) => ["active", "left", "done"].includes(r.state) && r.testId && !hubById.has(r.testId)).map((r) => r.testId);
    const hubStates = gone.length ? await mirrorHubStates(env, gone) : {};

    const setCols = (cvs, list, last, onlyChanged) => {
      const cols = {};
      for (const [id, type] of list) {
        const val = mirrorVal(cvs[id], type);
        if (onlyChanged && last && last[id] === val) continue;
        if (type === "status" && val && labels[id] && !labels[id].has(val)) { log.push(`label "${val}" isn't on the Hub's ${id}; left empty`); continue; }
        cols[id] = mirrorWriteVal(type, val);
      }
      return cols;
    };
    const lastOf = (it, cvs) => {
      const l = { name: it.name, [MC.status]: mirrorVal(cvs[MC.status], "status") };
      for (const [id, type] of MIRROR_COLS) l[id] = mirrorVal(cvs[id], type);
      return l;
    };

    // 1. Copies that left the Hub board.
    for (const r of Object.values(map)) {
      if (r.testId && !hubById.has(r.testId) && ["active", "left", "done"].includes(r.state)) {
        const s = hubStates[r.testId];
        if (s === "active") continue; // still there (another page), leave it
        r.state = "deleted"; r.updatedAt = new Date().toISOString(); ctx.counts.deleted++;
      }
    }
    // 2. Active copies whose live item is out of scope.
    for (const r of Object.values(map).filter((x) => x.state === "active" && !inScope.has(x.liveId))) {
      const x = elsewhere.get(r.liveId);
      const cvs = x ? Object.fromEntries(x.column_values.map((c) => [c.id, c])) : {};
      const liveStatus = x ? mirrorVal(cvs[MC.status], "status") : "";
      try {
        if (x && x.state === "active" && liveStatus === "Done") {
          const h = hubById.get(r.testId);
          if (h && (h.group === MIRROR_GROUP.hubCopy || h.group === MIRROR_GROUP.hubNew) && h.status !== "Done") {
            const cols = { [MC.status]: { label: "Done" } };
            const qp = mirrorVal(cvs[MC.qtyProduced], "numbers");
            if (qp) cols[MC.qtyProduced] = qp;
            await mirrorMutate(env, ctx, "change", { itemId: r.testId, cols });
            await mirrorMutate(env, ctx, "move", { itemId: r.testId, group: MIRROR_GROUP.hubCompleted });
          }
          r.state = "done"; ctx.counts.done++;
        } else { r.state = "left"; ctx.counts.left++; }
        r.updatedAt = new Date().toISOString();
      } catch (e) { if (e.budget) break; ctx.counts.errors++; log.push(`live ${r.liveId}: ${e.message}`); }
    }
    // 3. Items in scope: update copies, create new ones.
    for (const [liveId, { it, cvs }] of inScope) {
      if (Date.now() > ctx.until || ctx.calls >= ctx.maxCalls) { log.push("stopped early (time or call budget); the next run carries on"); break; }
      let r = map[liveId];
      if (r && (r.state === "deleted" || r.state === "left" || r.state === "done")) continue;
      try {
        if (!r) {
          const adopt = hubByLive.get(liveId);
          if (adopt) {
            r = map[liveId] = { liveId, testId: adopt.id, state: "active", last: lastOf(it, cvs), files: {}, createdAt: new Date().toISOString(), adopted: true };
            ctx.counts.adopted++;
          } else {
            const liveStatus = mirrorVal(cvs[MC.status], "status");
            const cols = { ...setCols(cvs, MIRROR_COLS, null, false), ...setCols(cvs, MIRROR_ONCE, null, false), [MC.liveRef]: liveId,
              [MC.status]: { label: liveStatus === "In Progress" ? "Started" : "Unassigned" } };
            for (const k of Object.keys(cols)) if (cols[k] === "") delete cols[k];
            const d = await mirrorMutate(env, ctx, "create", { group: MIRROR_GROUP.hubCopy, name: it.name, cols });
            const testId = String(d.create_item.id);
            r = map[liveId] = { liveId, testId, name: it.name, state: "active", last: lastOf(it, cvs), files: {}, createdAt: new Date().toISOString() };
            hubById.set(testId, { id: testId, group: MIRROR_GROUP.hubCopy, status: cols[MC.status].label, liveRef: liveId });
            ctx.counts.created++;
          }
        } else {
          const cols = setCols(cvs, MIRROR_COLS, r.last, true);
          if (r.last.name !== it.name) cols.name = it.name;
          const liveStatus = mirrorVal(cvs[MC.status], "status");
          const h = hubById.get(r.testId);
          if (liveStatus === "In Progress" && r.last[MC.status] !== "In Progress" && h && MIRROR_EARLY.has(h.status)) cols[MC.status] = { label: "Started" };
          if (Object.keys(cols).length) { await mirrorMutate(env, ctx, "change", { itemId: r.testId, cols }); ctx.counts.updated++; }
          r.last = lastOf(it, cvs);
        }
        r.name = it.name;
        await mirrorCopyFiles(env, ctx, r, r.testId, cvs, log);
        r.updatedAt = new Date().toISOString();
      } catch (e) {
        if (e.budget) { log.push("call budget used; the next run carries on"); break; }
        ctx.counts.errors++; log.push(`live ${liveId}: ${e.message}`);
      }
    }
    await env.TOKEN_KV.put(MIRROR_MAP, JSON.stringify(map));
    const out = { at: new Date().toISOString(), seconds: Math.round((Date.now() - started) / 1000), inScope: inScope.size, ...ctx.counts, calls: ctx.calls, log: log.slice(0, 50), error: null };
    await env.TOKEN_KV.put(MIRROR_LAST, JSON.stringify(out));
    return out;
  } catch (e) {
    try { await env.TOKEN_KV.put(MIRROR_MAP, JSON.stringify(map)); } catch {}
    const out = { at: new Date().toISOString(), ...ctx.counts, calls: ctx.calls, log: log.slice(0, 50), error: e.message };
    await env.TOKEN_KV.put(MIRROR_LAST, JSON.stringify(out)).catch(() => {});
    return out;
  } finally {
    await env.TOKEN_KV.delete(MIRROR_LOCK).catch(() => {});
  }
}
async function mirrorStatus(env) {
  const map = (env.TOKEN_KV && (await env.TOKEN_KV.get(MIRROR_MAP, "json"))) || {};
  const last = env.TOKEN_KV ? await env.TOKEN_KV.get(MIRROR_LAST, "json") : null;
  const counts = { active: 0, done: 0, left: 0, deleted: 0, skipped: mirrorSkip(env).size };
  const items = Object.values(map).map((r) => { counts[r.state] = (counts[r.state] || 0) + 1; return { liveId: r.liveId, testId: r.testId, name: r.name || "", state: r.state, updatedAt: r.updatedAt || r.createdAt || null }; });
  return { enabled: mirrorOn(env), lastRun: last, lastError: last?.error || null, counts, items };
}

// ── Labels check (Nov 25, Shragy: a Check button per product line in the Hub's Today's products). READ ONLY in Sellercloud.
// For each label package: the Temu order exists in Sellercloud, it is a Temu order, the product and qty on the label match
// what Sellercloud says the order holds, it is one product (not mixed), it is Unshipped and Processing (or already shipped
// with this same label's tracking), and it has no other tracking number and no second label today. Results are kept per
// day in KV (labels:check:<date>) and come back with /labels/day as "checks". A not-good label can be set aside
// (/labels/aside): the Hub then lists it under "Needs fixing" with a packing slip built from Sellercloud.
// Product match, in order: the order's product name in Sellercloud (Temu's title) starts with the same first six words as
// the label's product; else the products whose Sellercloud names match the label's title; else the label's mapped SKU;
// else most words shared; else the SKU most of this title's single-product orders have.
const LCHK_KEY = (d) => "labels:check:" + d;
const LNAMES_KEY = "labels:names:v1";
const LSTOP = new Set(["s", "m", "the", "and", "of", "for", "with", "a", "pack", "count", "oz", "bulk", "bag"]);
const lToks = (t) => String(t || "").toLowerCase().replace(/’/g, "'").replace(/[^a-z0-9]+/g, " ").split(" ").filter((w) => w.length > 1 && !LSTOP.has(w));
function lSame(a, b, n = 6) {
  const x = lToks(a), y = lToks(b);
  const k = Math.min(n, x.length, y.length);
  if (!k) return false;
  for (let i = 0; i < k; i++) if (x[i] !== y[i]) return false;
  return true;
}
function lOverlap(a, b) {
  const x = new Set(lToks(a)), y = new Set(lToks(b));
  let n = 0;
  for (const w of x) if (y.has(w)) n++;
  return n / Math.max(1, Math.min(x.size, y.size));
}
const LSPANISH = ["de", "en", "para", "con", "del", "la", "los", "las"];
const lSpanish = (t) => { const s = new Set(lToks(t)); return LSPANISH.filter((w) => s.has(w)).length >= 2; };
const lShort = (t, n = 7) => String(t || "").trim().split(/\s+/).slice(0, n).join(" ");
// Packages of one batch, grouped exactly as the Hub's packagesOfBatch: key -> lines.
function labelsPackages(batch) {
  const by = new Map(); let cur = null, ct = false;
  for (const l of [...(batch?.lines || [])].sort((a, c) => a.idx - c.idx)) {
    const t = autoshipNorm(l.tracking);
    if (t) { const k = "t:" + t; if (!by.has(k)) by.set(k, []); by.get(k).push(l); cur = k; ct = true; continue; }
    if (!cur || ct || (l.cost || 0) > 0) { const k = "i:" + l.idx; by.set(k, [l]); cur = k; ct = false; }
    else by.get(cur).push(l);
  }
  return by;
}
// Nov 26: checks live in the LABELS store (one row each). Checks from before that sat in one KV blob; they are moved over
// the first time their day is read.
async function labelsChecks(env, date) {
  try {
    const { checks } = await labelsCall(env, "/checks-get", { date });
    if (checks && Object.keys(checks).length) return checks;
    const old = (env.TOKEN_KV && (await env.TOKEN_KV.get(LCHK_KEY(date), "json"))) || {};
    const items = Object.values(old).filter((c) => c && c.id);
    if (items.length) {
      await labelsCall(env, "/checks-put", { date, raw: true, items });
      await env.TOKEN_KV.delete(LCHK_KEY(date)).catch(() => {});
    }
    return old;
  } catch { return {}; }
}
// opts: { want: [{batchId,pkg}] | null (all), batchId, onlyNew }. Returns { results, partial, unchecked (ids), found (ids) }.
// Nov 27 (Shragy: "i need a 100% fix"). A label is good only when Sellercloud confirms its line's product.
// - Sellercloud lists the order's product as UNKNOWN: can't be confirmed, not good.
// - The line has no known SKU (UNKNOWN or not learned): the line is its title, so every label of that title must be one
//   Sellercloud product. When the title holds more than one, only the clear majority product passes; the rest (or all,
//   on a tie) are on the wrong line. Orders Sellercloud doesn't have stay as Shragy set on Nov 26.
const lRealSku = (x) => !!x && String(x).trim().toUpperCase() !== "UNKNOWN";
function labelsLineRules(list, ctx, out = {}) {
  // Nov 27 (Shragy): "dont say good when you dont really know". Good needs Sellercloud to confirm the line's own SKU.
  // Nov 27 (Shragy): "if seller cloud does not have a order at all just mark it as good" — not-found orders stay good.
  const changed = [];
  const unsure = (x, why) => { Object.assign(x, { good: false, kind: "unconfirmed", reasons: [why] }); changed.push(x); };
  // Auto-link a line with no Sellercloud SKU: every one of its single-product orders (2 or more) has the same real
  // Sellercloud SKU, and that product's name matches the listing title. Saved in out.links (title -> sku).
  out.links = out.links || {};
  const byTitle = new Map();
  for (const x of ctx || []) {
    if (!x || lRealSku(x.labelSku) || x.notInSc || !x.items || x.items.length !== 1) continue;
    const t = labelsTitle(x.title);
    if (!t) continue;
    if (!byTitle.has(t)) byTitle.set(t, []);
    byTitle.get(t).push(x.items[0]);
  }
  for (const [t, its] of byTitle) {
    const skus = new Set(its.map((i) => i.sku));
    if (its.length < 2 || skus.size !== 1) continue;
    const sku = its[0].sku;
    if (!lRealSku(sku)) continue;
    const nm = its[0].name || sku;
    const shared = lToks(t).filter((w) => new Set([...lToks(nm), ...lToks(sku)]).has(w)).length;
    if (shared >= 2 && (lOverlap(t, nm) >= 0.5 || lOverlap(t, sku) >= 0.5)) out.links[t] = sku;
  }
  for (const x of list) {
    if (!x || !x.good) continue;
    if (x.notInSc) continue;
    if (!x.items || x.items.length !== 1) continue;
    const sku = x.items[0].sku;
    if (!lRealSku(sku)) { unsure(x, `can't confirm: Sellercloud has no SKU for this order's product ("${lShort(x.items[0].name || "unknown")}")`); continue; }
    if (!lRealSku(x.labelSku) && out.links[labelsTitle(x.title)]) x.labelSku = out.links[labelsTitle(x.title)];
    if (!lRealSku(x.labelSku)) { unsure(x, `can't confirm: this line isn't linked to a Sellercloud SKU (Sellercloud has ${sku} for this order)`); continue; }
    if (x.labelSku !== sku) {
      Object.assign(x, { good: false, kind: "wrong", reasons: [`wrong line: this line is ${x.labelSku} but Sellercloud has ${sku} for this order`] });
      changed.push(x);
    }
  }
  return changed;
}
// Saves auto-links from labelsLineRules into the title map, never over a SKU already there.
async function labelsSaveLinks(env, links) {
  const keys = Object.keys(links || {});
  if (!keys.length || !env.TOKEN_KV) return 0;
  let map = {};
  try { map = JSON.parse((await env.TOKEN_KV.get(LABELS_TITLE_KEY)) || "{}") || {}; } catch { map = {}; }
  let n = 0;
  for (const t of keys) { const v = map[t]; if (!(typeof v === "string" && v && !v.startsWith("?") && lRealSku(v))) { map[t] = links[t]; n++; } }
  if (n) await env.TOKEN_KV.put(LABELS_TITLE_KEY, JSON.stringify(map));
  return n;
}
async function labelsCheckRun(env, date, opts = {}) {
  const day = await labelsCall(env, "/day", { date });
  try { await labelsAddScSkus(env, day, date); } catch {}
  const all = [];
  const perOrder = new Map();
  for (const b of day.batches || []) {
    for (const [pkg, lines] of labelsPackages(b)) {
      all.push({ batchId: b.batchId, pkg, lines, carrier: b.carrier || "" });
      for (const o of new Set(lines.map((l) => String(l.orderId || "").trim()).filter(Boolean))) perOrder.set(o, (perOrder.get(o) || 0) + 1);
    }
  }
  const stored = await labelsChecks(env, date);
  const wantSet = opts.want ? new Set(opts.want.map((x) => x.batchId + "|" + x.pkg)) : null;
  let todo = all.filter((p) => (!wantSet || wantSet.has(p.batchId + "|" + p.pkg)) && (!opts.batchId || p.batchId === opts.batchId));
  if (opts.onlyNew) todo = todo.filter((p) => !stored[p.batchId + "|" + p.pkg]);
  if (opts.title) todo = todo.filter((p) => !p.lines.some((l) => labelsTitle(l.sku) !== labelsTitle(p.lines[0]?.sku)) && String(p.lines[0]?.productName || p.lines[0]?.sku || "").toLowerCase().includes(opts.title.toLowerCase()));
  const ids = [...new Set(todo.flatMap((p) => p.lines.map((l) => String(l.orderId || "").trim())).filter(Boolean))];
  const sc = new Map(); const asked = new Set(); let partial = false;
  for (let i = 0; i < ids.length; i += 25) {
    if (Date.now() > deadline - 5000) { partial = true; break; }
    const part = ids.slice(i, i + 25);
    const data = await scGet(env, "/Orders", { pageNumber: 1, pageSize: 25, orderSourceOrderIDList: part });
    for (const o of data.Items || []) sc.set(String(o.OrderSourceOrderID || "").trim(), o);
    for (const x of part) asked.add(x);
  }
  const itemsOf = (o) => {
    const m = new Map();
    for (const i of o.Items || o.OrderItems || []) {
      const sku = String(i.ProductID || i.SKU || "").trim();
      if (!sku) continue;
      const q = Number(i.Qty ?? i.Quantity) || 0;
      const prev = m.get(sku);
      if (prev) prev.qty += q; else m.set(sku, { sku, name: String(i.DisplayName || i.ProductName || "").trim().slice(0, 200), qty: q });
    }
    return [...m.values()];
  };
  // Names Sellercloud gives each SKU (kept across checks, so a short product line can still be compared).
  let names = {};
  try { names = (env.TOKEN_KV && (await env.TOKEN_KV.get(LNAMES_KEY, "json"))) || {}; } catch { names = {}; }
  let namesChanged = false;
  for (const o of sc.values()) for (const it of itemsOf(o)) {
    if (!it.name) continue;
    const ns = names[it.sku] || [];
    if (!ns.includes(it.name) && ns.length < 8) { names[it.sku] = [...ns, it.name]; namesChanged = true; }
  }
  const titleSkus = new Map();
  const skusForTitle = (t) => {
    if (titleSkus.has(t)) return titleSkus.get(t);
    const s = new Set();
    for (const [sku, ns] of Object.entries(names)) if (ns.some((n) => lSame(t, n))) s.add(sku);
    titleSkus.set(t, s);
    return s;
  };
  const titleOf = (p) => String(p.lines[0]?.productName || p.lines[0]?.sku || "");
  const majority = new Map();
  for (const p of todo) {
    const o = sc.get(String(p.lines[0]?.orderId || "").trim());
    if (!o) continue;
    const it = itemsOf(o);
    if (it.length !== 1) continue;
    const t = labelsTitle(titleOf(p));
    const m = majority.get(t) || new Map();
    m.set(it[0].sku, (m.get(it[0].sku) || 0) + 1);
    majority.set(t, m);
  }
  const at = new Date().toISOString();
  const results = []; const unchecked = [];
  for (const p of todo) {
    const id = p.batchId + "|" + p.pkg;
    const orders = [...new Set(p.lines.map((l) => String(l.orderId || "").trim()).filter(Boolean))];
    const tracks = [...new Set(p.lines.map((l) => autoshipNorm(l.tracking)).filter(Boolean))];
    const labelQty = p.lines.reduce((s, l) => s + (Number(l.qty) || 0), 0);
    const title = titleOf(p);
    const labelSkus = [...new Set(p.lines.map((l) => l.scSku || labelsTitle(l.sku)))];
    const r = { id, batchId: p.batchId, pkg: p.pkg, po: orders[0] || "", title: title.slice(0, 200), labelSku: p.lines[0]?.scSku || "",
      labelQty, tracking: String(p.lines.find((l) => autoshipNorm(l.tracking))?.tracking || "").trim(), carrier: autoshipCarrier(p.lines[0]?.carrier || p.carrier), service: String(p.lines[0]?.service || "").slice(0, 60),
      good: false, kind: "", shipped: false, reasons: [], items: [], scId: null, at };
    const other = (t) => { r.reasons.push(t); r.kind = "other"; };
    if (orders.length === 1 && !asked.has(orders[0])) { unchecked.push(id); continue; }
    if (!orders.length) other("no Temu order number on this label");
    else if (orders.length > 1) other("one label for " + orders.length + " orders");
    const o = orders.length === 1 ? sc.get(orders[0]) : null;
    // Nov 26 (Shragy): an order Sellercloud doesn't have yet is not a bad label; it prints normally and auto mark
    // shipped skips it (nothing to mark). r.notInSc tells the two apart.
    if (orders.length === 1 && !o) r.notInSc = true;
    if (o) {
      r.scId = o.ID;
      r.items = itemsOf(o);
      if (Number(o.CompanyID) !== TEMUSHIP_COMPANY) other("not a Temu order in Sellercloud");
      // Nov 26 (Shragy): whether Sellercloud already shows the order shipped doesn't matter here, because Sellercloud
      // isn't connected to Temu. The check is about the box holding the right product and qty. An order already
      // shipped in Sellercloud is still good when its product and qty match; auto mark shipped just leaves it alone.
      if (!temuUnshipped(o.ShippingStatus)) r.shipped = true;
      if (o.StatusCode === -1 || /cancel/i.test(String(o.StatusCode))) other("the order is cancelled in Sellercloud");
      if ((perOrder.get(orders[0]) || 0) > 1) other("this order has " + perOrder.get(orders[0]) + " labels today");
      if (r.items.length > 1) {
        r.reasons.push("mixed order: " + r.items.length + " different products in one box, pack by hand");
        if (r.kind !== "other") r.kind = "mixed";
      } else if (r.items.length === 1) {
        const it = r.items[0];
        if (labelSkus.length > 1) {
          r.reasons.push("the label lists " + labelSkus.length + " products but Sellercloud has only " + it.sku);
          if (!r.kind) r.kind = "wrong";
        } else {
          // Nov 27 (Shragy): the label must also sit under the right packing slip. A label carries only the listing
          // title, and Temu variants (1 vs 2 bars, 3 vs 6 pack, 16 vs 32 oz) share one title, so the line (and its slip)
          // is the SKU learned for that title. When Sellercloud's SKU is a different one, the label is on the wrong line.
          const rowSku = r.labelSku && r.labelSku !== "UNKNOWN" ? r.labelSku : "";
          let ok = rowSku ? rowSku === it.sku : lSame(title, it.name);
          if (rowSku && !ok) {
            r.reasons.push(`wrong line: this line is ${rowSku} but Sellercloud has ${it.sku} for this order`);
            if (!r.kind) r.kind = "wrong";
            ok = true; // reason already given
          }
          if (!ok) {
            const s = skusForTitle(labelsTitle(title));
            if (s.size) ok = s.has(it.sku);
            else if (r.labelSku) ok = r.labelSku === it.sku;
            else if (lOverlap(title, it.name) >= 0.7) ok = true;
            else {
              const m = [...(majority.get(labelsTitle(title)) || new Map())].sort((a, b) => b[1] - a[1])[0];
              ok = !!m && m[0] === it.sku && m[1] >= 2;
            }
          }
          if (!ok) {
            r.reasons.push(lSpanish(it.name)
              ? `check product: the label is for "${lShort(title)}" but Sellercloud has ${it.sku} (Temu gave the order name in Spanish, so it could not be compared)`
              : `wrong product: the label is for "${lShort(title)}" but the Temu order is for "${lShort(it.name)}" (${it.sku})`);
            if (!r.kind) r.kind = "wrong";
          }
          if (it.qty !== labelQty) {
            r.reasons.push("qty: the label is for " + labelQty + ", Sellercloud has " + it.qty);
            if (!r.kind) r.kind = "wrong";
          }
        }
      } else other("Sellercloud shows no products on this order");
    }
    r.good = r.reasons.length === 0;
    if (r.good) r.kind = r.shipped ? "shipped" : "good";
    results.push(r);
  }
  if (results.length) {
    const byId = new Map(Object.values(stored).map((x) => [x.id, x]));
    for (const x of results) byId.set(x.id, x);
    const lr = {};
    labelsLineRules(results, [...byId.values()], lr);
    await labelsSaveLinks(env, lr.links).catch(() => {});
    await labelsChecks(env, date); // moves an older KV blob over first, so its "aside" marks are kept
    await labelsCall(env, "/checks-put", { date, items: results.map(({ scId, carrier, service, ...keep }) => keep) }).catch(() => {});
  }
  if (env.TOKEN_KV) {
    if (namesChanged) {
      const keys = Object.keys(names);
      if (keys.length > 4000) for (const k of keys.slice(0, keys.length - 4000)) delete names[k];
      await env.TOKEN_KV.put(LNAMES_KEY, JSON.stringify(names)).catch(() => {});
    }
  }
  return { results, partial, unchecked, found: new Set(all.map((p) => p.batchId + "|" + p.pkg)) };
}
// Sets aside (or brings back) checked labels that are not good. Returns how many changed.
async function labelsAside(env, date, items, aside, field = "aside") {
  await labelsChecks(env, date);
  const { changed } = await labelsCall(env, "/checks-aside", { date, aside: !!aside, field, ids: items.map((x) => x.batchId + "|" + x.pkg) });
  return Number(changed) || 0;
}

// ── Labels auto mark shipped (Nov 25, Shragy's ask): when the Hub marks a Temu label printed, mark that order shipped in
// Sellercloud with the label's carrier, service and tracking. SWITCHED OFF until turned on (KV labels:autoship, on:false).
// Uses the shared scMarkShipped helper (see Temu backlog). Only orders that are ALL of: Temu company (372), Unshipped,
// Processing, and with no other tracking number in Sellercloud. The print call only queues; the 2-minute timer ships.
// Control: GET /labels-autoship?t=<token>&api=status|preview|ship1|on|off  (preview/ship1 take &po=<Temu order>&date=YYYY-MM-DD).
// ship1 marks exactly one order and works while switched off: it is the one-order test.
const AUTOSHIP_HASH = "5f6bb20f1d2334550c1c37fd9019b2332978a137f1122ed259aac0b404c1927c";
const AUTOSHIP_STATE = "labels:autoship";
const AUTOSHIP_QUEUE = "labels:autoship:queue";
const AUTOSHIP_TICK_MAX = 60;
const autoshipNorm = (t) => String(t || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
async function autoshipState(env) { return (env.TOKEN_KV && (await env.TOKEN_KV.get(AUTOSHIP_STATE, "json"))) || { on: false, shipped: 0, skipped: [], failed: [], log: [] }; }
async function autoshipSave(env, st) { if (env.TOKEN_KV) await env.TOKEN_KV.put(AUTOSHIP_STATE, JSON.stringify(st)); }
async function autoshipEnqueue(env, items, by) {
  const st = await autoshipState(env);
  if (!st.on || !env.TOKEN_KV) return;
  const q = (await env.TOKEN_KV.get(AUTOSHIP_QUEUE, "json")) || [];
  const at = new Date().toISOString();
  for (const x of items) q.push({ batchId: x.batchId, pkg: x.pkg, at, by: by || "" });
  await env.TOKEN_KV.put(AUTOSHIP_QUEUE, JSON.stringify(q.slice(-5000)));
}
const autoshipCarrier = (c) => (/^ups$/i.test(c) ? "UPS" : /^usps$/i.test(c) ? "USPS" : /^fedex$/i.test(c) ? "FedEx" : "Other");
const autoshipLines = (batch, pkg) => labelsPackages(batch).get(pkg) || [];
// Plan for a list of {batchId,pkg}: the labels check decides; only good, not yet shipped labels get shipped.
async function autoshipPlan(env, pkgs) {
  const out = [];
  const byDate = new Map();
  for (const p of pkgs) {
    const date = String(p.batchId || "").slice(0, 10);
    if (!isDay(date)) { out.push({ ...p, skip: "batch has no date" }); continue; }
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(p);
  }
  for (const [date, list] of byDate) {
    const { results, unchecked, found } = await labelsCheckRun(env, date, { want: list });
    const got = new Map(results.map((r) => [r.id, r]));
    const stored = await labelsChecks(env, date);
    const later = new Set(unchecked);
    for (const p of list) {
      const id = p.batchId + "|" + p.pkg;
      const r = got.get(id);
      if (!r) { out.push(later.has(id) ? { ...p, skip: "not checked yet", retry: true } : { ...p, skip: found.has(id) ? "not checked" : "label not found in the day's file" }); continue; }
      if (r.shipped) { out.push({ ...p, po: r.po, skip: "already shipped in Sellercloud" }); continue; }
      if (r.good && !r.scId) { out.push({ ...p, po: r.po, skip: "order not in Sellercloud" }); continue; }
      // A wrong-product or mixed label that was set aside is printed from Needs fixing with a packing slip built from
      // Sellercloud, so the box holds what the order holds: that one may ship. Anything else not good does not.
      const fixed = (r.kind === "wrong" || r.kind === "mixed") && (!!stored[id]?.aside || !!stored[id]?.fixed);
      if (!r.good && !fixed) { out.push({ ...p, po: r.po, skip: "check: " + r.reasons.join("; ") }); continue; }
      out.push({ ...p, po: r.po, tracking: r.tracking, carrier: r.carrier, service: r.service, scId: r.scId, items: r.items.map((i) => i.sku + " x" + i.qty).join(" + ") });
    }
  }
  return out;
}
async function autoshipShip(env, x) {
  const r = await scMarkShipped(env, x.scId, { carrier: x.carrier, service: x.service, tracking: x.tracking });
  let after = null;
  try {
    const data = await scGet(env, "/Orders", { pageNumber: 1, pageSize: 5, orderSourceOrderIDList: [x.po] });
    const o = (data.Items || [])[0];
    if (o) after = { shippingStatus: o.ShippingStatus, tracking: o.TrackingNumber || "", carrier: o.ShippingCarrier ?? o.CarrierName ?? null, service: o.ShippingService ?? o.ShippingMethod ?? null };
  } catch {}
  return { ...x, ok: !!r.ok && !!after && !temuUnshipped(after.shippingStatus), status: r.status, said: r.said, after };
}
async function autoshipTick(env) {
  const st = await autoshipState(env);
  if (!st.on || !env.TOKEN_KV) return;
  const q = (await env.TOKEN_KV.get(AUTOSHIP_QUEUE, "json")) || [];
  if (!q.length) return;
  const take = q.slice(0, AUTOSHIP_TICK_MAX);
  await env.TOKEN_KV.put(AUTOSHIP_QUEUE, JSON.stringify(q.slice(take.length)));
  const plan = await autoshipPlan(env, take);
  const again = plan.filter((x) => x.retry).map(({ batchId, pkg, at, by }) => ({ batchId, pkg, at, by }));
  if (again.length) { const q2 = (await env.TOKEN_KV.get(AUTOSHIP_QUEUE, "json")) || []; await env.TOKEN_KV.put(AUTOSHIP_QUEUE, JSON.stringify([...q2, ...again].slice(-5000))); }
  for (const x of plan) {
    if (x.retry) continue;
    if (x.skip) { st.skipped = [...(st.skipped || []), { po: x.po || null, pkg: x.pkg, why: x.skip, at: new Date().toISOString() }].slice(-500); continue; }
    const r = await autoshipShip(env, x).catch((e) => ({ ...x, ok: false, said: String(e.message || e).slice(0, 200) }));
    if (r.ok) st.shipped = (st.shipped || 0) + 1;
    else st.failed = [...(st.failed || []), { po: x.po, tracking: x.tracking, status: r.status || null, said: (r.said || "").slice(0, 200), after: r.after || null }].slice(-300);
    st.log = [...(st.log || []), { po: x.po, tracking: x.tracking, ok: !!r.ok, at: new Date().toISOString() }].slice(-300);
  }
  const fresh = await autoshipState(env);
  await autoshipSave(env, { ...st, on: fresh.on });
}
async function autoshipRoute(env, url) {
  const t = (url.searchParams.get("t") || "").trim();
  const h = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (!t || !safeEqual(h, AUTOSHIP_HASH)) return new Response("Not found.", { status: 404 });
  deadline = Date.now() + 25_000;
  const api = url.searchParams.get("api") || "status";
  if (api === "status") {
    const st = await autoshipState(env);
    const q = (env.TOKEN_KV && (await env.TOKEN_KV.get(AUTOSHIP_QUEUE, "json"))) || [];
    return Response.json({ ...st, queued: q.length });
  }
  if (api === "on" || api === "off") { const st = await autoshipState(env); st.on = api === "on"; await autoshipSave(env, st); return Response.json(st); }
  if (api === "preview" || api === "ship1") {
    const po = (url.searchParams.get("po") || "").trim();
    const date = (url.searchParams.get("date") || "").trim();
    if (!po || !isDay(date)) return Response.json({ error: "add &po=<Temu order>&date=YYYY-MM-DD" }, { status: 400 });
    const day = await labelsCall(env, "/day", { date });
    const pk = [];
    for (const b of day.batches || []) for (const l of b.lines || []) if (String(l.orderId || "").trim() === po) {
      const k = autoshipNorm(l.tracking) ? "t:" + autoshipNorm(l.tracking) : (() => { for (const c of b.lines) { const kk = "i:" + c.idx; if (autoshipLines(b, kk).includes(l)) return kk; } return "i:" + l.idx; })();
      if (!pk.some((p) => p.batchId === b.batchId && p.pkg === k)) pk.push({ batchId: b.batchId, pkg: k });
    }
    if (pk.length !== 1) return Response.json({ error: pk.length ? "this order has " + pk.length + " labels; ship1 only takes one" : "no label for this order on " + date }, { status: 400 });
    const [x] = await autoshipPlan(env, pk);
    if (api === "preview" || x.skip) return Response.json({ plan: x });
    const r = await autoshipShip(env, x);
    const st = await autoshipState(env);
    st.log = [...(st.log || []), { po: x.po, tracking: x.tracking, ok: !!r.ok, test: true, at: new Date().toISOString() }].slice(-300);
    if (r.ok) st.shipped = (st.shipped || 0) + 1;
    await autoshipSave(env, st);
    return Response.json({ result: r });
  }
  if (api === "reline") {
    // Writes only to the labels check store (never Sellercloud): applies the Nov 27 wrong-line rule to stored checks.
    const date = (url.searchParams.get("date") || "").trim();
    if (!isDay(date)) return Response.json({ error: "add &date=YYYY-MM-DD" }, { status: 400 });
    const vals = Object.values(await labelsChecks(env, date));
    // Labels marked "can't confirm" are judged again from scratch (they were good before the line rules).
    const was = new Set(vals.filter((x) => x.kind === "unconfirmed").map((x) => x.id));
    const base = vals.filter((x) => x.good || was.has(x.id)).map((x) => (was.has(x.id) ? { ...x, good: true, kind: "good", reasons: [] } : { ...x }));
    const lr = {};
    const ch = new Set(labelsLineRules(base, vals, lr).map((x) => x.id));
    const hit = base.filter((x) => ch.has(x.id) || (was.has(x.id) && x.good));
    if (url.searchParams.get("go") === "1") await labelsSaveLinks(env, lr.links);
    for (const x of vals) {
      if (hit.some((h) => h.id === x.id)) continue;
      const rowSku = x.labelSku && x.labelSku !== "UNKNOWN" ? x.labelSku : "";
      if (!x.good || !rowSku || !x.items || x.items.length !== 1 || x.items[0].sku === rowSku) continue;
      const v = { ...x, good: false, kind: "wrong", reasons: [`wrong line: this line is ${rowSku} but Sellercloud has ${x.items[0].sku} for this order`] };
      hit.push(v);
    }
    if (url.searchParams.get("go") === "1" && hit.length) await labelsCall(env, "/checks-put", { date, items: hit });
    return Response.json({ wrote: url.searchParams.get("go") === "1", n: hit.length, links: lr.links, nowGood: hit.filter((x) => x.good).length, list: hit.map((x) => [x.po, x.labelSku || String(x.title || "").slice(0, 40), (x.items && x.items[0] ? x.items[0].sku + " x" + x.items[0].qty : "-"), x.kind]) });
  }
  if (api === "unlinked") {
    // Read only: the day's listing titles with no Sellercloud SKU (the Hub shows them red).
    const date = (url.searchParams.get("date") || "").trim();
    if (!isDay(date)) return Response.json({ error: "add &date=YYYY-MM-DD" }, { status: 400 });
    const day = await labelsCall(env, "/day", { date });
    try { await labelsAddScSkus(env, day, date); } catch {}
    const m = new Map();
    for (const b of day.batches || []) for (const l of b.lines || []) if (!l.scSku) { const t = String(l.productName || l.sku || "").slice(0, 70); m.set(t, (m.get(t) || 0) + 1); }
    return Response.json({ titles: m.size, lines: [...m].sort((a, b) => b[1] - a[1]) });
  }
  if (api === "rows") {
    // Read only: stored checks grouped by the label's product; lists groups holding more than one Sellercloud product.
    const date = (url.searchParams.get("date") || "").trim();
    if (!isDay(date)) return Response.json({ error: "add &date=YYYY-MM-DD" }, { status: 400 });
    const vals = Object.values(await labelsChecks(env, date));
    const g = new Map();
    for (const x of vals) {
      const k = (x.labelSku || "") + " | " + String(x.title || "").slice(0, 50);
      const e = g.get(k) || { n: 0, sc: {} };
      e.n++;
      const sk = !x.items || !x.items.length ? "(not in Sellercloud)" : x.items.map((i) => i.sku + " x" + i.qty).join(" + ");
      (e.sc[sk] = e.sc[sk] || []).push([x.po, x.good, x.kind]);
      g.set(k, e);
    }
    const q = (url.searchParams.get("q") || "").toLowerCase();
    if (q) return Response.json({ recs: vals.filter((x) => String(x.title || "").toLowerCase().includes(q) || String(x.labelSku || "").toLowerCase() === q).map((x) => [x.po, x.labelSku, x.good, x.kind, x.labelQty, (x.items || []).map((i) => i.sku + " x" + i.qty + " " + String(i.name || "").slice(0, 50)).join(" + ")]) });
    const out = [...g].filter(([, e]) => Object.keys(e.sc).length > 1).map(([k, e]) => ({ row: k, n: e.n, sc: Object.fromEntries(Object.entries(e.sc).map(([a, b]) => [a, b.length > 6 ? b.length : b])) }));
    return Response.json({ groups: g.size, mixedRows: out.length, rows: out });
  }
  if (api === "lookup") {
    // Read only: what Sellercloud holds now for some Temu orders (&pos=PO-1,PO-2, up to 25).
    const pos = (url.searchParams.get("pos") || "").split(",").map((x) => x.trim()).filter(Boolean).slice(0, 25);
    const data = await scGet(env, "/Orders", { pageNumber: 1, pageSize: 25, orderSourceOrderIDList: pos });
    const found = new Map((data.Items || []).map((o) => [String(o.OrderSourceOrderID || "").trim(), o]));
    return Response.json({ orders: pos.map((po) => { const o = found.get(po); return o ? [po, o.ID, o.ShippingStatus, (o.Items || o.OrderItems || []).map((i) => String(i.ProductID || i.SKU) + " x" + (i.Qty ?? i.Quantity)).join(" + ")] : [po, null]; }) });
  }
  if (api === "check") {
    // Read only: run the labels check for a day (optionally one batch, optionally only labels not checked yet).
    const date = (url.searchParams.get("date") || "").trim();
    if (!isDay(date)) return Response.json({ error: "add &date=YYYY-MM-DD" }, { status: 400 });
    const r = url.searchParams.get("dry") === "1" ? { results: [], partial: false, unchecked: [] } : await labelsCheckRun(env, date, { batchId: url.searchParams.get("batch") || "", onlyNew: url.searchParams.get("new") === "1", title: (url.searchParams.get("title") || "").trim().slice(0, 80) });
    const stored = await labelsChecks(env, date);
    const vals = Object.values(stored);
    const count = (f) => vals.filter(f).length;
    const ranGood = r.results.filter((x) => x.good);
    return Response.json({ ran: r.results.length, ranGood: ranGood.length, ranShipped: r.results.filter((x) => x.shipped).length, partial: r.partial, unchecked: r.unchecked.length,
      ranBad: url.searchParams.get("title") ? r.results.filter((x) => !x.good).map((x) => [x.po, x.kind, x.reasons.join(" / ").slice(0, 160)]) : undefined,
      stored: { total: vals.length, good: count((x) => x.good), notGood: count((x) => !x.good), wrong: count((x) => x.kind === "wrong"), mixed: count((x) => x.kind === "mixed"), other: count((x) => x.kind === "other"), shipped: count((x) => x.shipped) },
      notInSc: url.searchParams.get("list") === "1" ? vals.filter((x) => x.notInSc).map((x) => [x.id, x.po, x.good, x.kind, String(x.title || "").slice(0, 60), x.labelQty]) : undefined,
      bad: url.searchParams.get("list") === "1" ? vals.filter((x) => !x.good).map((x) => [x.id, x.po, x.kind, x.reasons.join(" / ").slice(0, 160), x.items.map((i) => i.sku + " x" + i.qty).join(" + ")]) : undefined });
  }
  return Response.json({ error: "api must be status, preview, ship1, check, on or off" }, { status: 400 });
}

// ── Temu backlog: mark old unshipped Temu orders shipped in Sellercloud (Nov 25, Shragy's ask) ──
// Sellercloud isn't linked back to Temu, so this only changes Sellercloud's own record. Carrier Other, method Freight,
// no tracking (none is held for these orders). Only orders that are ALL of: company Temu (372), Unshipped, Processing,
// and ordered before the cutoff day (New York time). One REST call per order (PUT Orders/ShippingStatus/SinglePackage);
// Sellercloud has no bulk ship call. Runs on the 2-minute timer while switched on (KV temuship:state), a few hundred
// orders a tick so the Hub and the sync keep room under Sellercloud's 10,800 calls an hour.
// Control: GET /temu-backlog?t=<token>&api=status|keys|dry|ship|start|stop (token: only its SHA-256 is here).
// mark-shipped helper is shared: scMarkShipped(env, orderId, { carrier, service, tracking, shipDate }).
const TEMUSHIP_HASH = "b347c84d14d86fea749ba28fb67a0b6743b5b76238da1cbb21ce5de11a49bd4b";
const TEMUSHIP_STATE = "temuship:state";
const TEMUSHIP_COMPANY = 372;
const TEMUSHIP_TICK_MAX = 180;
async function scMarkShipped(env, orderId, o = {}) {
  const base = await getBase(env);
  const path = "/Orders/ShippingStatus/SinglePackage";
  const body = {
    OrderID: Number(orderId),
    ShipDate: o.shipDate || new Date(Date.now() - 60_000).toISOString(),
    ShippingCarrier: o.carrier || "Other", CarrierName: o.carrier || "Other",
    ShippingService: o.service || "Freight", ShippingMethod: o.service || "Freight",
    TrackingNumber: o.tracking || "",
  };
  for (let attempt = 0; attempt < 6; attempt++) {
    await waitIfBusy();
    const token = await getToken(env, base);
    subrequests++; scCalls++;
    const r = await fetch(base + path, {
      method: "PUT",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
    if (r.status === 401 && attempt === 0) { await dropToken(env); continue; }
    const text = (await r.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 300);
    if (r.status === 409 || r.status === 429) {
      noteRefusal(path, r.status, text, r);
      const ms = busyWait(r, attempt, text); noteBusy(ms);
      if (Date.now() + ms < deadline) { await sleep(ms); continue; }
      return { ok: false, status: r.status, said: text, busy: true };
    }
    return { ok: r.ok, status: r.status, said: text };
  }
  return { ok: false, status: 409, said: "too many requests", busy: true };
}
// Sellercloud's REST times come without an offset and are already New York time (checked Nov 25 against the web
// grid, which shows the same clock time with -04:00/-05:00), so the day is the first 10 characters.
const temuNyDay = (t) => { const s = String(t || ""); if (!/(Z|[+-]\d\d:?\d\d)$/.test(s)) return s.slice(0, 10); try { return new Date(s).toLocaleDateString("en-CA", { timeZone: "America/New_York" }); } catch { return ""; } };
const temuUnshipped = (v) => v === 1 || /^unshipped$/i.test(String(v));
const temuProcessing = (v) => v === 2 || /^(processing|inprocess)$/i.test(String(v));
function temuEligible(o, cutoff) {
  return Number(o.CompanyID) === TEMUSHIP_COMPANY && temuUnshipped(o.ShippingStatus) && temuProcessing(o.StatusCode)
    && /^PO-211-/.test(String(o.OrderSourceOrderID || "")) && temuNyDay(o.TimeOfOrder || o.CreatedOn) < cutoff;
}
// One page of unshipped Temu orders created before the cutoff (midnight New York of the cutoff day, +1 day slack;
// the TimeOfOrder check above decides).
let temuExtra = {};
// The exact list Shragy approved: Sellercloud's own "TEMU Shipping" view (Company Temu, Unshipped, Processing,
// Fully Picked), read through the web app's grid call with the worker's own login (delta token, as the Kit tab does),
// oldest first. The REST order list can't filter on Fully Picked, so it isn't used to pick orders.
const TEMUSHIP_FILTERS = [
  { FilterSelectedValues: [String(TEMUSHIP_COMPANY)], HasValue: true, FilterId: "lstCompanies", FilterPropertyName: "CompanyID", IsDefaultFilter: true, DependencyFilterIDs: [] },
  { FilterSelectedValues: ["1"], HasValue: true, FilterId: "ddlShipStatus", FilterPropertyName: "ShippingStatus", IsDefaultFilter: true, DependencyFilterIDs: [] },
  { FilterSelectedValues: ["2"], HasValue: true, FilterId: "ddlOrderStatus", FilterPropertyName: "OrderStatus", IsDefaultFilter: true, DependencyFilterIDs: [] },
  { FilterSelectedValues: ["2"], HasValue: true, FilterId: "lstPicked", FilterPropertyName: "Picked", IsDefaultFilter: false, DependencyFilterIDs: [] },
];
// Shragy's yes (Nov 26): the unshipped Temu orders outside the view that are Processing but not fully picked.
// Company and Unshipped filters only (temuEligible checks Processing); temuWant keeps only
// not picked (0) and partly picked (1), so the fully picked ones outside the view stay open.
const TEMUSHIP_OUTSIDE_FILTERS = TEMUSHIP_FILTERS.slice(0, 2); // with the Processing filter but no Picked one the grid returned only recent orders
function temuFilters(st) { return st && st.scope === "outside" ? TEMUSHIP_OUTSIDE_FILTERS : TEMUSHIP_FILTERS; }
function temuWant(o, st) { return temuEligible(o, st.cutoff) && (st.scope !== "outside" || [0, 1].includes(Number(o.Picked))); }
async function temuListPage(env, cutoff, page, pageSize = 50, desc = false, filters = TEMUSHIP_FILTERS) {
  const url = (await deltaBase(env)) + "/api/Manage/ManageEntity/GetGridData";
  const body = { GlobalSearchKeyWord: null, IncludeTotals: true, Key: null, Kind: 1, PageNumber: page, ResultsPerPage: pageSize,
    SelectedFilters: filters, SortColumn: "ID", SortDirection: !desc, ExcludeGridData: false, ...temuExtra };
  for (let attempt = 0; attempt < 5; attempt++) {
    await waitIfBusy();
    const token = await deltaGetToken(env);
    subrequests++; scCalls++;
    const r = await fetch(url, { method: "POST", redirect: "manual",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", Accept: "application/json", "X-Requested-With": "XMLHttpRequest" },
      body: JSON.stringify(body) });
    if (r.status === 401 && attempt === 0) { deltaToken = null; await sharedDel(env, DELTA_TOKEN_KEY); continue; }
    const text = await r.text();
    if (r.status === 409 || r.status === 429) { const ms = busyWait(r, attempt, text); noteBusy(ms); if (Date.now() + ms < deadline) { await sleep(ms); continue; } }
    let j = null; try { j = JSON.parse(text); } catch {}
    if (!r.ok || !j) throw new HttpError(502, `Sellercloud's order grid failed (${r.status}). ${text.replace(/\s+/g, " ").slice(0, 200)}`);
    const d = j.Data || j.data || {};
    const items = (d.Grid || []).map((o) => ({ ...o, ID: o.ID ?? o.OrderID ?? o.Id }));
    const total = d.TotalResults ?? d.Total ?? d.TotalCount ?? d.Totals?.TotalResults ?? null;
    return { total, items, dataKeys: Object.keys(d) };
  }
  throw new HttpError(503, "Sellercloud's order grid is busy.");
}
async function temuFresh(env, poIds) {
  const data = await scGet(env, "/Orders", { pageNumber: 1, pageSize: 25, orderSourceOrderIDList: poIds });
  const m = {}; for (const o of data.Items || []) m[o.ID] = o; return m;
}
// Ships up to max eligible orders now; checks each one's status again right after.
// Temu order IDs that have a label (with tracking) in the LABELS store in the last 30 days, New York days.
// The backlog run leaves those open, so the label flow can mark them shipped with their real tracking.
async function temuLabelPos(env) {
  const ck = "temuship:labelpos";
  const hit = env.TOKEN_KV ? await env.TOKEN_KV.get(ck, "json").catch(() => null) : null;
  if (hit && Date.now() - hit.at < 10 * 60_000) return new Set(hit.pos);
  const pos = new Set();
  for (let d = 0; d < 30; d++) {
    const date = new Date(Date.now() - d * 86400_000).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const day = await labelsCall(env, "/day", { date }); // throws if the store is missing: then nothing ships
    for (const b of day.batches || []) for (const l of b.lines || []) { const po = String(l.orderId || "").trim(); if (po) pos.add(po); }
  }
  if (env.TOKEN_KV) await env.TOKEN_KV.put(ck, JSON.stringify({ at: Date.now(), pos: [...pos] }), { expirationTtl: 3600 }).catch(() => {});
  return pos;
}
// Temu order -> its label's tracking, from the same 30 days of label files. Only an order with exactly one
// tracking number across its labels gets one; anything else is left alone ("bad").
async function temuLabelMap(env) {
  const ck = "temuship:labelmap:v2";
  const hit = env.TOKEN_KV ? await env.TOKEN_KV.get(ck, "json").catch(() => null) : null;
  if (hit && Date.now() - hit.at < 10 * 60_000) return new Map(Object.entries(hit.map));
  const acc = new Map();
  for (let d = 0; d < 30; d++) {
    const date = new Date(Date.now() - d * 86400_000).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const day = await labelsCall(env, "/day", { date });
    for (const b of day.batches || []) for (const l of b.lines || []) {
      const po = String(l.orderId || "").trim(); if (!po) continue;
      const a = acc.get(po) || { tr: new Set(), carrier: "", service: "" };
      const t = String(l.tracking || "").trim();
      if (t) { a.tr.add(t); a.carrier = a.carrier || autoshipCarrier(l.carrier || b.carrier); a.service = a.service || String(l.service || "").slice(0, 60); }
      acc.set(po, a);
    }
  }
  // Labels the FBM check set aside (wrong product, mixed box, or another problem) keep their order open here.
  const flagged = new Map();
  for (let d = 0; d < 30; d++) {
    const date = new Date(Date.now() - d * 86400_000).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const chk = await labelsChecks(env, date);
    for (const r of Object.values(chk || {})) if (r && r.po && ["wrong", "mixed", "other"].includes(r.kind)) flagged.set(String(r.po).trim(), r.kind);
  }
  const map = {};
  for (const [po, a] of acc) map[po] = flagged.has(po) ? { bad: "label check: " + flagged.get(po) } : a.tr.size === 1 ? { tracking: [...a.tr][0], carrier: a.carrier || "Other", service: a.service || a.carrier || "Other" } : { bad: a.tr.size ? "several tracking numbers" : "no tracking on the label" };
  if (env.TOKEN_KV) await env.TOKEN_KV.put(ck, JSON.stringify({ at: Date.now(), map }), { expirationTtl: 3600 }).catch(() => {});
  return new Map(Object.entries(map));
}
async function temuShipSome(env, st, max, stopAt) {
  const res = { shipped: 0, failed: [], skipped: 0, seen: 0, left: null, hasLabel: 0 };
  const labelMode = st.mode === "label";
  const labelPos = await temuLabelPos(env);
  const labelMap = labelMode ? await temuLabelMap(env) : null;
  const poOf = (o) => String(o.OrderSourceOrderID || "").trim();
  // The label pass starts a page before where the old orders began last time (the newest orders sit on top).
  let page = labelMode ? Math.max(1, (st.labelStart || 1) - 1) : 1;
  while (res.shipped + res.failed.length < max && Date.now() < stopAt) {
    // The label pass reads newest first in big pages: labelled orders are recent, the oldest are Freight ones.
    const { total, items } = await temuListPage(env, st.cutoff, page, labelMode || st.scope === "outside" ? 250 : 50, labelMode, temuFilters(st));
    if (res.left === null) res.left = total;
    if (!items.length) { res.reachedEnd = true; break; }
    if (labelMode && !res.firstOldPage && items.some((o) => temuWant(o, st))) res.firstOldPage = page;
    const want = labelMode
      ? items.filter((o) => temuWant(o, st) && !(st.failedIds || []).includes(o.ID) && labelMap.get(poOf(o))?.tracking)
      : items.filter((o) => temuWant(o, st) && !(st.failedIds || []).includes(o.ID) && !labelPos.has(poOf(o)));
    res.hasLabel += items.filter((o) => temuWant(o, st) && labelPos.has(poOf(o))).length;
    if (labelMode) res.labelBad = (res.labelBad || 0) + items.filter((o) => temuWant(o, st) && labelMap.get(poOf(o))?.bad).length;
    res.skipped += items.length - want.length; res.seen += items.length;
    if (!want.length) { page++; if (page > (labelMode ? 90 : 60)) { res.reachedEnd = true; break; } continue; }
    for (let i = 0; i < want.length && res.shipped + res.failed.length < max && Date.now() < stopAt; i += 25) {
      const part = want.slice(i, Math.min(i + 25, i + (max - res.shipped - res.failed.length)));
      const out = [];
      for (let j = 0; j < part.length; j += 3) {
        out.push(...await Promise.all(part.slice(j, j + 3).map(async (o) => ({ o, r: await scMarkShipped(env, o.ID, labelMode ? labelMap.get(poOf(o)) : undefined).catch((e) => ({ ok: false, said: e.message })) }))));
        if (Date.now() > stopAt) break;
      }
      const fresh = await temuFresh(env, out.map((x) => x.o.OrderSourceOrderID)).catch(() => ({}));
      for (const { o, r } of out) {
        const f = fresh[o.ID];
        if (r.ok && f && !temuUnshipped(f.ShippingStatus)) { res.shipped++; if (labelMode) res.withTracking = (res.withTracking || 0) + 1; }
        else if (r.busy) { /* not tried; next tick picks it up */ }
        else res.failed.push({ id: o.ID, po: o.OrderSourceOrderID, status: r.status || null, said: (r.said || "").slice(0, 160), after: f ? f.ShippingStatus : null });
      }
      if (out.some((x) => x.r.busy)) return res;
    }
    // shipped orders drop out of the Unshipped list, so page 1 again (unless the whole page was skipped)
  }
  return res;
}
async function temuState(env) { return (env.TOKEN_KV && (await env.TOKEN_KV.get(TEMUSHIP_STATE, "json"))) || null; }
async function temuSave(env, st) { if (env.TOKEN_KV) await env.TOKEN_KV.put(TEMUSHIP_STATE, JSON.stringify(st)); }
function temuMerge(st, res) {
  st.shipped = (st.shipped || 0) + res.shipped;
  st.failed = [...(st.failed || []), ...res.failed].slice(-300);
  st.failedIds = [...new Set([...(st.failedIds || []), ...res.failed.map((f) => f.id)])].slice(-2000);
  st.lastTick = new Date().toISOString(); st.lastLeft = res.left; st.lastSeen = res.seen; st.lastHasLabel = res.hasLabel || 0;
  if (st.limit && st.shipped >= st.limit) { st.on = false; st.stopped = "limit reached"; }
  if (res.left === 0 || (res.seen > 0 && res.shipped === 0 && res.failed.length === 0 && res.skipped === res.seen && (st.mode !== "label" || res.reachedEnd))) { st.on = false; st.stopped = st.stopped || "no more orders before the cutoff"; }
  if (st.mode === "label" && res.firstOldPage) st.labelStart = res.firstOldPage;
  if (st.mode === "label") { st.labelShipped = (st.labelShipped || 0) + res.shipped; st.lastLabelBad = res.labelBad || 0; }
  // A queued run (start with &after=1) begins once this one's label pass is through.
  if (!st.on && st.mode === "label" && st.next && st.stopped === "no more orders before the cutoff") {
    st.runs = [...(st.runs || []), { scope: st.scope || "view", cutoff: st.cutoff, shipped: st.shipped, labelShipped: st.labelShipped || 0, freightDone: st.freightDone || null, at: new Date().toISOString() }].slice(-10);
    const n = st.next; st.next = null;
    st.scope = n.scope; st.cutoff = n.cutoff; st.then = "label"; st.mode = null; st.labelStart = 1;
    st.limit = 0; st.on = true; st.stopped = null; st.failedIds = []; st.nextBase = { shipped: st.shipped, labelShipped: st.labelShipped || 0, at: new Date().toISOString() };
    return st;
  }
  // Freight pass done: go on to the orders with a label, with their own tracking (when started with &then=label).
  if (!st.on && st.mode !== "label" && st.then === "label" && st.stopped === "no more orders before the cutoff") {
    st.freightDone = { shipped: st.shipped, at: new Date().toISOString() };
    st.mode = "label"; st.then = null; st.limit = 0; st.on = true; st.stopped = null; st.failedIds = [];
  }
  return st;
}
async function temuBacklogTick(env) {
  const st = await temuState(env);
  if (!st || !st.on) return;
  if (st.busyTick && Date.now() - Date.parse(st.busyTick) < 170_000) return; // last tick still running
  st.busyTick = new Date().toISOString(); await temuSave(env, st);
  let res;
  try { res = await temuShipSome(env, st, Math.min(TEMUSHIP_TICK_MAX, st.limit ? st.limit - (st.shipped || 0) : TEMUSHIP_TICK_MAX), Date.now() + 100_000); }
  catch (e) { const s2 = (await temuState(env)) || st; s2.lastError = String(e.message || e).slice(0, 300); s2.busyTick = null; await temuSave(env, s2); return; }
  const s2 = (await temuState(env)) || st;
  if (!s2.on) { s2.busyTick = null; temuMerge(s2, res); s2.on = false; await temuSave(env, s2); return; }
  temuMerge(s2, res); s2.busyTick = null; s2.lastError = null; await temuSave(env, s2);
}
async function temuBacklogRoute(env, url) {
  const t = (url.searchParams.get("t") || "").trim();
  const h = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (!t || !safeEqual(h, TEMUSHIP_HASH)) return new Response("Not found.", { status: 404 });
  deadline = Date.now() + 25_000;
  const api = url.searchParams.get("api") || "status";
  temuExtra = {};
  if (api === "keys" || api === "dry") for (const [k, v] of url.searchParams) if (k.startsWith("p_")) temuExtra[k.slice(2)] = v;
  const cutoff = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get("cutoff") || "") ? url.searchParams.get("cutoff") : "2026-11-23";
  if (api === "status") return Response.json(await temuState(env));
  if (api === "newtoken") { await dropToken(env); return Response.json({ ok: true, note: "Sellercloud sign-in dropped; next call signs in fresh" }); }
  if (api === "overlap") {
    // Orders with a label in the last 30 days: how they stand in Sellercloud now.
    const pos = [...(await temuLabelPos(env))];
    const out = { labelOrders: pos.length, unshipped: 0, shippedWithTracking: 0, shippedNoTracking: [], notFound: 0, other: 0 };
    const from = Math.max(0, parseInt(url.searchParams.get("from") || "0", 10) || 0); out.from = from;
    for (let i = from; i < pos.length && Date.now() < deadline - 3000; i += 25) {
      const data = await scGet(env, "/Orders", { pageNumber: 1, pageSize: 25, orderSourceOrderIDList: pos.slice(i, i + 25) });
      const got = new Map((data.Items || []).map((o) => [String(o.OrderSourceOrderID), o]));
      for (const po of pos.slice(i, i + 25)) {
        const o = got.get(po);
        if (!o) { out.notFound++; continue; }
        if (Number(o.CompanyID) !== TEMUSHIP_COMPANY) { out.other++; continue; }
        if (temuUnshipped(o.ShippingStatus)) { out.unshipped++; continue; }
        const tr = [o.TrackingNumber, ...(o.AllTrackingNumbers || [])].filter((x) => String(x || "").trim());
        if (tr.length) out.shippedWithTracking++; else out.shippedNoTracking.push({ id: o.ID, po, time: o.TimeOfOrder });
      }
      out.checked = Math.min(pos.length, i + 25);
    }
    return Response.json(out);
  }
  if (api === "outside") {
    // Read only: every unshipped Temu order (company and Unshipped filters only), tallied by order status,
    // picked state and New York month, so the orders outside the TEMU Shipping view can be counted.
    const page = parseInt(url.searchParams.get("page") || "1", 10) || 1;
    const size = Math.min(500, parseInt(url.searchParams.get("size") || "500", 10) || 500);
    const { total, items } = await temuListPage(env, cutoff, page, size, false, TEMUSHIP_FILTERS.slice(0, 2));
    const tally = {};
    for (const o of items) {
      const k = ["status" + o.StatusCode, "picked" + o.Picked, temuNyDay(o.TimeOfOrder || o.CreatedOn).slice(0, 7), /^PO-211-/.test(String(o.OrderSourceOrderID || "")) ? "po" : "nopo"].join("/");
      tally[k] = (tally[k] || 0) + 1;
    }
    return Response.json({ total, page, size, rows: items.length, tally });
  }
  if (api === "outsidepage") {
    return new Response(`<!doctype html><title>outside</title><pre id=o>working</pre><script>
(async()=>{const T=${JSON.stringify(t)};let p=1,seen=0,tot=0;const all={};
for(;;){let j;try{j=await (await fetch('?t='+T+'&api=outside&size=500&page='+p)).json();}catch(e){await new Promise(r=>setTimeout(r,3000));continue;}
if(j.error){document.getElementById('o').textContent='ERROR '+JSON.stringify(j);return;}
tot=j.total;seen+=j.rows;for(const k in j.tally)all[k]=(all[k]||0)+j.tally[k];
document.getElementById('o').textContent=(j.rows<500||seen>=tot?'DONE ':'')+'seen '+seen+' of '+tot+'\n'+Object.entries(all).sort().map(e=>e[0]+' '+e[1]).join('\n');
if(j.rows<500||seen>=tot)break;p++;}})();
</script>`, { headers: { "content-type": "text/html" } });
  }
  if (api === "whoami") return Response.json({ sellercloudUser: env.SC_USERNAME || null });
  if (api === "reset") { const st = (await temuState(env)) || {}; if (st.on) return Response.json({ error: "stop the run first" }, { status: 409 }); st.failed = []; st.failedIds = []; await temuSave(env, st); return Response.json(st); }
  if (api === "keys") {
    const { total, items, dataKeys } = await temuListPage(env, cutoff, 1, 3);
    const o = items[0] || {};
    return Response.json({ total, dataKeys, keys: Object.keys(o), itemKeys: Object.keys((o.Items || [])[0] || {}), item0: (o.Items || [])[0] || null, sample: items.map((x) => ({ ID: x.ID, CompanyID: x.CompanyID, OrderSource: x.OrderSource, ShippingStatus: x.ShippingStatus, StatusCode: x.StatusCode, TimeOfOrder: x.TimeOfOrder, CreatedOn: x.CreatedOn, Picked: x.Picked ?? x.PickedStatus ?? x.IsPicked ?? null, po: x.OrderSourceOrderID })) });
  }
  if (api === "dry") {
    const page = parseInt(url.searchParams.get("page") || "1", 10) || 1;
    const size = Math.min(500, parseInt(url.searchParams.get("size") || "500", 10) || 500);
    const dst = { cutoff, scope: url.searchParams.get("scope") === "outside" ? "outside" : null };
    const { total, items } = await temuListPage(env, cutoff, page, size, false, temuFilters(dst));
    const days = {}; let elig = 0; const why = {};
    for (const o of items) {
      if (temuWant(o, dst)) { elig++; const d = temuNyDay(o.TimeOfOrder).slice(0, 7); days[d] = (days[d] || 0) + 1; }
      else { const k = [o.CompanyID, o.ShippingStatus, o.StatusCode, "picked" + o.Picked, temuNyDay(o.TimeOfOrder) < cutoff ? "old" : "new"].join("/"); why[k] = (why[k] || 0) + 1; }
    }
    return Response.json({ total, page, size, rows: items.length, eligible: elig, byMonth: days, notEligible: why });
  }
  if (api === "overlappage") {
    return new Response(`<!doctype html><title>overlap</title><pre id=o>starting</pre><script>
(async()=>{const T=${JSON.stringify(t)};let from=0,tot={unshipped:0,shippedWithTracking:0,notFound:0,other:0,noTr:[]},n=0;
for(;;){let j;try{j=await (await fetch('?t='+T+'&api=overlap&from='+from)).json();}catch(e){await new Promise(r=>setTimeout(r,3000));continue;}
tot.unshipped+=j.unshipped;tot.shippedWithTracking+=j.shippedWithTracking;tot.notFound+=j.notFound;tot.other+=j.other;tot.noTr.push(...j.shippedNoTracking);n=j.labelOrders;
document.getElementById('o').textContent=(j.checked>=n?'DONE ':'')+'checked '+j.checked+' of '+n+' '+JSON.stringify({unshipped:tot.unshipped,withTracking:tot.shippedWithTracking,notFound:tot.notFound,other:tot.other,shippedNoTracking:tot.noTr.length,sample:tot.noTr.slice(0,10)});
if(!j.checked||j.checked>=n)break;from=j.checked;}})();
</script>`, { headers: { "content-type": "text/html" } });
  }
  if (api === "drypage") {
    const html = `<!doctype html><meta charset="utf-8"><title>dry</title><pre id="o">working…</pre><script>
const q=new URLSearchParams(location.search);const o=document.getElementById('o');const T=q.get('t');const C=q.get('cutoff')||'2026-11-23';
(async()=>{let el=0,rows=0,tot=null;const m={},nw={};for(let p=1;p<=200;p++){let j=null;for(let i=0;i<4&&!j;i++){const r=await fetch('/temu-backlog?api=dry&size=250&page='+p+'&cutoff='+C+'&t='+encodeURIComponent(T));j=r.ok?await r.json():null;if(!j)await new Promise(z=>setTimeout(z,4000));}
if(!j){o.textContent='FAILED at page '+p;return;}tot=j.total;rows+=j.rows;el+=j.eligible;for(const[k,v]of Object.entries(j.byMonth))m[k]=(m[k]||0)+v;for(const[k,v]of Object.entries(j.notEligible))nw[k]=(nw[k]||0)+v;
o.textContent='DRY page '+p+' rows '+rows+' of '+tot+' eligible '+el+'\\nby month '+JSON.stringify(m)+'\\nnot eligible '+JSON.stringify(nw);if(j.rows<250)break;}o.textContent='DONE '+o.textContent;})();
<\/script>`;
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }
  if (api === "ship") { // a few now, for the test
    const n = Math.min(10, Math.max(1, parseInt(url.searchParams.get("n") || "1", 10) || 1));
    const st = (await temuState(env)) || { cutoff, shipped: 0, failed: [], failedIds: [] };
    if (st.on) return Response.json({ error: "The background run is on; stop it first." }, { status: 409 });
    st.cutoff = cutoff;
    const keep = st.mode || null, keepScope = st.scope || null;
    if (url.searchParams.has("scope")) st.scope = url.searchParams.get("scope") === "outside" ? "outside" : null;
    if (url.searchParams.get("mode") === "freight") st.mode = null;
    if (url.searchParams.get("mode") === "label") { st.mode = "label"; if (url.searchParams.get("page")) st.labelStart = parseInt(url.searchParams.get("page"), 10) || st.labelStart; }
    const res = await temuShipSome(env, st, n, Date.now() + 20_000);
    temuMerge(st, res); st.on = false; st.mode = keep; st.scope = keepScope; await temuSave(env, st);
    return Response.json({ res, state: st });
  }
  if (api === "start") {
    const st = (await temuState(env)) || { shipped: 0, failed: [], failedIds: [] };
    const scope = url.searchParams.get("scope") === "outside" ? "outside" : null;
    if (url.searchParams.get("after") === "1" && st.on) { // queue it behind the run that is going now
      st.next = { scope, cutoff }; await temuSave(env, st); return Response.json(st);
    }
    if (url.searchParams.has("scope")) st.scope = scope;
    st.cutoff = cutoff; st.on = true; st.stopped = null; st.startedAt = st.startedAt || new Date().toISOString();
    st.limit = parseInt(url.searchParams.get("limit") || "0", 10) || 0;
    if (url.searchParams.has("then")) st.then = url.searchParams.get("then") === "label" ? "label" : null;
    if (url.searchParams.has("mode")) { st.mode = url.searchParams.get("mode") === "label" ? "label" : null; st.labelStart = 1; }
    await temuSave(env, st);
    return Response.json(st);
  }
  if (api === "stop") { const st = (await temuState(env)) || {}; st.on = false; st.stopped = "stopped by hand"; await temuSave(env, st); return Response.json(st); }
  return new Response("Not found.", { status: 404 });
}

export default {
  async scheduled(event, env, ctx) {
    // The live-board copy has its own 5-minute timer and does nothing else.
    if (event && event.cron === MIRROR_CRON) {
      ctx.waitUntil(runMirror(env).then((r) => console.log("mirror: " + JSON.stringify(r).slice(0, 500))).catch((e) => console.log("mirror failed: " + e.message)));
      return;
    }
    callStart = Date.now();
    deadline = callStart + 150_000; // the sync's own time box is 120 s
    readCacheOn = false;
    quickBusy = false;
    ctx.waitUntil(runSync(env, { seconds: 120, scheduled: true }).catch((e) => console.log("sync failed: " + e.message))
      .finally(() => tallyCalls(env)));
    // Temu backlog (Nov 25): ships a few hundred old Temu orders a tick while switched on.
    ctx.waitUntil(temuBacklogTick(env).catch((e) => console.log("temu backlog failed: " + e.message)));
    // Labels auto mark shipped (Nov 25): ships orders whose labels were printed, only while switched on.
    ctx.waitUntil(autoshipTick(env).catch((e) => console.log("labels autoship failed: " + e.message)));
    // Background kit runs: a nudge so the queue's alarm is never lost.
    if (env.JOBS) ctx.waitUntil(jobCall(env, "/kick", {}).catch(() => {}));
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
