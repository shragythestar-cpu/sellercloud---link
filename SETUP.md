# Sellercloud link: setup

worker.js only reads from Sellercloud. Its only writes go to one monday board,
"Sellercloud Products" (id 18440651605) in the test workspace, never the Production Schedule boards.
Every call needs your key, and only monday.com pages can call it from a browser.

## Already done
- Sellercloud employee, worker, SC_TEAM, SC_USERNAME, SC_PASSWORD, APP_KEY.

## New steps for the hourly copy
1. Cloudflare: open the worker, Edit code, replace everything with the new worker.js, Deploy.
2. monday: your profile picture > Developers > My access tokens, copy the token.
3. Cloudflare worker > Settings > Variables and Secrets > Add:
   - MONDAY_TOKEN, type Secret: that monday token
   - SYNC_BOARD_ID, type Text: 18440651605
4. Cloudflare worker > Settings > Trigger events > Add > Cron Triggers: every 30 minutes (*/30 * * * *)
5. Test, adding &key=YOUR_APP_KEY (or ?key= when it's the first part) to each:
   - /sync         runs one ~20-second batch and shows progress; the board fills in.
                   Open it again to copy the next batch sooner, or let the 30-minute trigger continue.
                   The board description shows how far the copy has got.
   - /sync?dry=1   counts one batch without writing anything
   - /qty?sku=A_WAREHOUSE_SKU   countedAvailable is the Skustack Warehouse qty

## Optional settings (Text)
- SUBREQUEST_LIMIT: only if /sync says the request limit was reached (Cloudflare free plan): 45
- WAREHOUSE_COMPANY: 317 (the "WAREHOUSE" company id; also the default in the code)
- COUNT_WAREHOUSES: 3232 (Skustack Warehouse, the only warehouse that counts; also the default
  in the code). A comma list of warehouse ids or names if that ever changes.
- SC_PRODUCT_URL: product page link with {sku} in it, for the board's Sellercloud link column
  (default, built into the code: https://lgd.delta.sellercloud.com/catalog/catalog-details.aspx?ID={sku})

## Board columns
SKU (sc_sku), Available (Skustack) (sc_sellable, Skustack Warehouse only), Total available (sc_total), Physical qty (sc_physical),
Photo (sc_photo), Sellercloud link (sc_link), UPC (sc_upc), Last checked (sc_synced).
Groups: In stock (topics, Skustack qty above 0), Out of stock (group_mm97awn3). Products with no
Skustack stock, or that leave stock, go to Out of stock; nothing is deleted. The copy runs in batches
and keeps its place in the board description; a full pass re-checks every product.

## Ask the crew for items (Google Chat)
1. Google Chat: open the crew space > space name > Apps & integrations > Webhooks > Add webhook.
   Name it "Production Hub", Save, and copy the webhook link.
2. Cloudflare worker > Settings > Variables and Secrets > Add:
   - CHAT_WEBHOOK, type Secret: that webhook link (the worker posts only to a chat.googleapis.com link)
   - PULL_KEY, type Secret: a second long random string you make up (letters and numbers only).
     It works only for /pull, so it's the one the Production Hub button uses.
3. Paste the new worker.js, Deploy.
4. Test: /pull?sku=A_WAREHOUSE_SKU&qty=10&key=YOUR_PULL_KEY  posts one message to the space.
   The same SKU can't be posted again for one minute.
5. Bins: open /apidocs?key=YOUR_APP_KEY and send a screenshot, so the bin lookup can be added.

## Kit assembly (off until you say yes)

The worker can assemble kits in Sellercloud with the same call Sellercloud's own SellerHub app uses. It stays switched off until you turn it on.

1. **Permission:** the Sellercloud user the worker signs in with needs rights to assemble kits. Sellercloud's help doesn't name the exact permission. The closest are Edit on Catalog and on Inventory, under Settings > Employees > Manage Employees > that employee > Toolbox > Permissions. If it's still missing, Sellercloud refuses the first test with a message, and nothing changes.
2. **Add these in Cloudflare** (Settings > Variables and Secrets):
   - ASSEMBLE_KEY (Secret): a long random string you make up. The Production Hub uses it; the main key can't assemble.
   - ASSEMBLE_ENABLED (Text): leave it unset for now. Setting it to `yes` turns real assembly on.
   - ASSEMBLE_MAX_QTY (Text, optional): most kits per press. The default is 1, for the first test.
3. **Deploy** the new worker.js.
4. **Check (read-only):** open /assemble/preview?sku=KIT_SKU&qty=1, sending the ASSEMBLE_KEY as ?key=. It shows the kit's parts and whether Skustack has enough.
5. **Bins:** open /soapops?q=bin with your main key. It lists the SOAP calls that mention bins, which shows whether bin qty can be read.

### Kit reads (read-only, assemble key)
- /assemble/kit?sku=SKU shows a product's kit parts and qty per kit.
- /assemble/bridge?sku=SOURCE shows the source's 0.1 oz bridge product: from its kit parts, and products named like it with 0.1oz.
- Neither changes anything in Sellercloud.

### 0.1 flow (assemble key)
- /assemble/plan?source=&final=&fromBin=&produced= checks each step and says skip, create or set. Read-only.
- POST /assemble/setup creates the 0.1 product and sets the kits only where they're missing. It changes kit parts, never stock. Off until ASSEMBLE_ENABLED = yes.
- POST /assemble/produce disassembles, assembles, then removes the small 0.1 leftover from the From bin. Off until ASSEMBLE_ENABLED = yes.

## Final SKU search (Nov 19)
- GET /assemble/find?q=WORD (ASSEMBLE_KEY): searches the WAREHOUSE company's products in Sellercloud directly, 0-stock ones included, for the final pick in the assembly pop-up. Read-only, 1-2 Sellercloud calls per search. Returns items with sku, name, imageUrl, available, physical, link.
- The board sync is unchanged: it still copies only products with physical stock, so the New Request stock check is unchanged.
- GET /kitimport[?job=ID] (main key, read-only): Sellercloud's Kits import template columns, the last 10 queued jobs, and one job's full status. Use it when a kit setup saves nothing.
- 0.1 bin (Nov 19, his words): the break-down puts the 0.1 units into one bin, 0.1oz_Bulk_Bin (Cloudflare variable BRIDGE_BIN to change it), and the assembly takes them from there into the To bin. A run uses only the units its own break-down made ("don't mix in anything else"): it saves the bin's qty before the break-down and works only from the difference. Other stock of that 0.1 product in the bin (e.g. cookies and cream's 581) is never used or removed. The leftover removal takes only this run's leftover from that bin.
- Kit recipe shows the real number (Nov 19, his words: "its importent fro me to see the trie numbers"): before each run the final's kit recipe is set to that run's units per kit (bin total ÷ qty produced, e.g. 160 → 161), sent as a Kits import that overwrites the existing qty; skipped when it already matches. If Sellercloud hasn't shown it after 2 minutes, it's sent once more the other way; if it still shows the old number, nothing is broken down or assembled. The 10% check compares with the size in the final's name (16 oz = 160), never with the last run's recipe.
- Source with stock (Nov 19): Sellercloud won't make a stocked product a kit, so Setup empties the source's Skustack bins, sets its kit, and puts the exact qty back right after (adjustments with a reason). If the put-back fails it says IMPORTANT and what to put back; the next Setup press puts it back first. It won't empty stock that sits in another warehouse or is reserved.
- Mix kits (Nov 19, his rules): one final made from 2 or more products. Each product breaks down into its own 0.1 product in the 0.1 bin; the final's recipe gets one line per 0.1 product, set to that product's run units ÷ qty produced (rounded down); one assembly into the To bin; each 0.1 product's leftover is removed with one adjustment naming the run. Only this run's units count. Weight check before Run: weight in (bulk by lb = pounds; others = the oz in the SKU or name × qty) against final size × qty produced; more than 10% apart (Hub setting, sent as maxDiffPct) blocks, no override. A product whose type isn't clear blocks until the person assembling picks lb or oz (sent as types). All sources come from one From bin. Single kits work as before.
- Background kit runs (Nov 19, his words: "close a kit while its assembling and move on to the next"): the Hub hands a kit to the worker once (POST /assemble/job) and can close the pop-up. A Durable Object (JobQueue, binding JOBS, declared in wrangler.toml) keeps the queue and runs each kit's setup and produce steps by itself with its alarm, a step of each kit in turn, using the same once-only records as before. A kit that shares a source product or its final with an earlier kit that's still running (or stopped and waiting to be cleared) waits for it. Clear is refused while a kit is still running in the background. The Hub reads each job's steps and writes the board when a job is done. The cron every 2 minutes also nudges the queue. Cloudflare creates the Durable Object on the first deploy from GitHub (wrangler.toml has its binding and migration); nothing to set in the dashboard.
- Create final SKU (Nov 19, his rules): POST /assemble/create-product makes ONE product in a platform's company (only when ASSEMBLE_ENABLED = yes). The prefix goes at the start of the SKU, then the same SKU: Temu, FBA or FBM (Betty Bet, company LG DEALS LLC), EAW FBA or EAW FBM (East and West, company EAST AND WEST SALES), Walmart, WFS, WOOT. GET /assemble/platforms lists them. Each platform's company can be changed with a Text variable PLATFORM_COMPANY_<KEY>, e.g. PLATFORM_COMPANY_WFS (assumed "Walmart company"). It refuses an SKU that already exists in any company and shows that product; the product type is copied from the source product; one create per SKU, never sent twice. Read-only helpers: GET /assemble/companies and /assemble/catalog?company=&q=&sku=.
- Labels (Nov 24, his words: "i have a different AI that buys the labels and i want that ai to upload it here"): the label AI sends each batch to POST /labels/upload (multipart: file = the PDF, data = JSON with batchId, date, platform and the labels with sku, qty, cost) with header X-Labels-Key. Uploads stay off (501) until you add a Secret named LABELS_KEY in Cloudflare (Variables and Secrets) and give the same text to the label AI. The Hub reads with its own key: /labels/batches, /labels/batch, /labels/file (the PDF), /labels/stats (spend, labels and units per day, week or month and per product) and POST /labels/downloaded. PDFs are kept in KV (up to 25 MB each); batches in a Durable Object (LabelStore, binding LABELS) that Cloudflare creates on deploy from wrangler.toml. Nothing here calls Sellercloud.
- Scan station (Nov 25, his words: "scan the first product it prints out all labels fro that product devided by qty and you move on to the next product", "lets start just with temu", "they are going to scan a UPC"): the station is the Production Hub's FBM printing tab (his words: "i need it in the hub only", "as a separate tab called FBM printing"); GET /scan only points there. The tab calls these routes with the Hub key on the Hub's server and reads label PDFs through /labels/file-link (the /labels/dl link answers CORS for monday origins). It reads the day's uploaded label batches, and a UPC scan finds that product's SKUs in Sellercloud (read-only, kept 7 days), then prints all its labels for the day, grouped by units per package, smallest first, with a header sheet before each group. Labels are matched to PDF pages by the line's page, else by finding the tracking number (or order number) in the page text, else (a batch of one product and one qty) any page. Printed packages are remembered so a second scan doesn't print them again (Reprint button per group). A UPC with no match lets the station pick one of the day's label SKUs once (saved as a UPC link). Orders with more than one product print from "Print mixed orders". For printing with no print window, start Chrome with --kiosk-printing and make the label printer the default. Nothing here buys or uploads labels, and nothing writes to Sellercloud; new tables (printed, upc_links) live in the LabelStore Durable Object.

- **Live-board copy (Nov 24).** Every 5 minutes (cron `*/5 * * * *`) the worker reads the live Production Schedule
  (18410399966, read only) and copies its open productions (group Production Schedule, not Done) to the Hub board
  18439411777, tagged in "Live board item". Turn on with Text variable `MIRROR_ENABLED` = `yes`; anything else = off.
  Optional: `MIRROR_SKIP` (comma list of live ids, default 13598232255), `MIRROR_MAX_CALLS` (writes per run, default 350).
  Check it at `GET /mirror/status?key=` (Hub key). Nothing is ever written to the live board.
- **Label carriers (Nov 24).** Upload `data` takes a batch-level `carrier` (GOFO, UPS, USPS, FedEx, DHL, OnTrac, Amazon
  Shipping, Veho, LaserShip, or any other name). Batches show `carrier` (or Mixed / Unknown) and a `carriers` breakdown;
  `?carrier=` filters /labels/batches and /labels/stats; /labels/stats adds spend per carrier. Old batches get theirs from
  their lines.
- **Label downloads (Nov 24).** `/labels/file` answers `Range: bytes=a-b` with 206 for chunked downloads. `POST
  /labels/file-link` `{ batchId }` (Hub key) returns a signed link to `/labels/dl` that works for 15 minutes and carries
  no key; the browser downloads the PDF straight from the worker.
- **Split runs (Nov 24).** `POST /assemble/job` (and `/assemble/plan`, GET or POST) take `outputs: [{ itemId, final,
  qty, toBin, fba? }]`, 2 to 6 parts, main card first among them. One break-down into 0.1oz_Bulk_Bin, every final at
  run's 0.1 units ÷ total produced (rounded down), one assembly per part into its own bin, leftover removed once. Every
  card of the run is locked to the main card; Clear only from the main card. Every plan answer carries
  `features: { splitOutputs: true, maxOutputs: 6 }`. Mix kits can't split yet (400).
- **Bin contents (Nov 25).** `POST /bins/contents` `{ bins: [names] }` (APP_KEY or ASSEMBLE_KEY, up to 25) answers
  `{ warehouseId, bins: [{ bin, exists, totalQty, skus: [{ sku, qty }] }] }` for Skustack Warehouse only. Read-only
  (WarehouseBin_ListAll and ProductWarehouseBin_All_ByBinName); each bin is kept 60 s. `debug: true` adds the reply's
  field names per bin, uncached.
