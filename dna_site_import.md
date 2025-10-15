# DNA Site Import — GEDmatch Browser Extension (Phase 1)

Last updated: 2025-09-27

This document specifies a Chrome/Chromium browser extension and backend integration to ingest GEDmatch One‑to‑Many CSVs, semi‑manually capture pedigree trees from linked pages (ASCII pedigree views), stitch sub‑trees, enrich identities via Enformion, export a normalized JSON bundle, and load results into ATLAS for overlap detection and merge planning. The design intentionally leaves room to add other sources later (WikiTree, FamilyTreeDNA, etc.).

---

## Goals

- Ingest GEDmatch one‑to‑many CSV and optional one‑to‑one segments CSV; normalize rows into profile records.
- Drive a guided capture flow that helps the user open each match’s pedigree page and “Capture Tree” at the right time, with an additional “Capture Subtree” for deeper ancestral branches.
- Merge overlapping captures coming from the same person across multiple pages (shared anchor individual).
- Produce a single JSON bundle containing: CSV metadata, profiles, per‑profile captures, subtrees, and cross‑references to source URLs.
- Integrate with ATLAS: upload/import JSON bundles; detect cross‑file overlap; plan safe merges.
- Enrich select identities by correlating emails/usernames with Enformion to infer probable real names for triangulation.

Out of scope (Phase 1): fully autonomous crawling beyond pedigree pages; direct WikiTree scrape; background workers; ATLAS per‑name index/search.

---

## Source Input: GEDmatch CSV (observed)

Example header (sample provided):

- Reference Kit, Date Exported (top rows)
- Columns: `Kit, Name, Email, "GED WikiTree", Age - Days, Sex, Total cM - Autosomal, Largest - Autosomal, Gen - Autosomal, Mt - Haplogroup, Y - Haplogroup, Total cM - X-DNA, Largest - X-DNA, Source, Overlap`
- `GED WikiTree` often contains an internal path like `/tools/gedcom/find-gedcoms-by-kit?kit_num=A501906` which leads to a chain of pages before the pedigree chart.
- `Name` can be a real name, partial, or a handle prefixed with `*`.
- Fields may include embedded newlines within quoted values (observed in `GED WikiTree`), so CSV parsing must support multiline fields.

CSV ingestion must:
- Preserve raw values (no destructive normalization).
- Parse `GED WikiTree` into an absolute URL based on the active site origin.
- Store `Source` and `Overlap` as hints only; do not rely on them for identity.
- Emit consistent `profiles[]` with stable UUIDs.

### Optional: GEDmatch One‑to‑One Segments CSV

- Expected columns (observed across exports; case/spacing varies): `PrimaryKit, MatchedKit, Chr, B37 Start, B37 End, Segment cM, SNPs, MatchedName, Matched Sex, MatchedEmail`.
- Used for two purposes:
  - Embed per‑kit segment metadata into GEDCOM under `_OM_SEGMENT_DATA` for the root kit individual.
  - Filter and enrich “floating individuals” (matches without captured trees) when generating a standalone GEDCOM of floating INDIs.

---

## Extension Architecture (Chrome MV3)

- Manifest V3 with Side Panel as the primary UI; a minimal action popup/import page exists for legacy/prototyping.
- Components:
  - Background service worker: lightweight session state and message hooks; tab tracking and URL watchers for results tabs.
  - Side Panel UI: CSV upload, segments upload, queue, capture controls, auto modes, ZIP/JSON export, reports automation status.
  - Content script (domain‑scoped): basic auto‑navigation to pedigree pages and placeholder; capture is triggered from the Side Panel.
  - Options page: planned for future (feature flags, domain settings, Enformion key).

Permissions:
- `activeTab`, `tabs`, `scripting`, `storage`, `downloads`, `unlimitedStorage`, `sidePanel`, `webNavigation`, `debugger`.
- Host permissions: `https://pro.gedmatch.com/*` and `https://*.gedmatch.com/*`.

State storage:
- `chrome.storage.local` for working sessions and downloaded reports list.
- ZIP/JSON export via `chrome.downloads.download`.

---

## Reports Automation (One‑to‑Many and Segment Match)

A new Reports tab in the side panel orchestrates:
- Navigate to one‑to‑many (segment‑based) by kit; auto‑click the Search button.
- Click “Download CSV” for one‑to‑many results, fetch the CSV, and store locally.
- Select all rows, click “Visualization Options”, then run the segment search.
- On the segment results page, click the “Download CSV” button to reveal the link, then (optionally) download the segments CSV.

### LEO opt‑out handling and “additional segments” capture (NEW)

Some kits produce an error immediately upon arriving at the “Visualization Options” page (before the Search button is available):

- Example error (Drupal message on the visualization page):
  “The following kits have opted out of Law Enforcement and cannot be used when violent offender kits are present: … (Use the back button to edit kits)”

We now handle this flow automatically:

1) Detect the Drupal error on the visualization page and parse the list of opted‑out kit IDs.
   - We extract everything after the colon and before “(Use the back button to edit kits)”, split on commas/whitespace, and keep only valid kit tokens.
   - Parsed set is kept as `optedOutKits`.

2) First‑attempt retry (still for the current kit):
   - Navigate back to the one‑to‑many results page.
   - Reselect rows: uncheck nothing by default, then uncheck rows belonging to `cases@othram.com` (our Othram rows) for the primary run.
   - Click “Visualization Options” again. If the error persists on the second check, we log to Atlas and skip the kit.

3) Primary segments CSV capture proceeds normally (segments CSV saved with `kind: 'segments'`).

4) “Additional segments” capture (second pass; NEW):
   - Triggered only if we previously encountered the opt‑out error and the primary segments CSV was captured successfully.
   - Navigate directly to the one‑to‑many results page for the same kit (explicit URL), click Search to refresh results.
   - Selection strategy for the second pass:
     - Check all `cases@othram.com` rows (Othram internal kits), and
     - Additionally check up to 10 kit IDs that are NOT present in `optedOutKits`.
   - Click “Visualization Options” again, run the segment search, and download this second CSV.
   - Store as `additional-segments.csv` with `kind: 'additional-segments'`.
   - This file is optional; if any step fails, we log the situation and continue with Auto‑Kinship as normal.

Notes:
- We never download the one‑to‑many CSV a second time during the additional‑segments pass.
- The “additional segments” flow is strictly sequential; Auto‑Kinship starts only after this second pass completes (or is skipped on failure).

### Tab targeting and reliability
- Results sometimes open in a new tab. We ensure we act on the correct tab using several tactics:
  - Background watchers:
    - `webNavigation.onCommitted/onCompleted` store `gmSegmentResultsTabId` when URL matches `.../tools/multi-kit-analysis/segment-search`.
    - `tabs.onCreated/onUpdated` watch child tabs via `openerTabId` and URL updates.
  - Side panel adopts the detected results tab id (`gmSegmentResultsTabId`) after segment search, and closes the parent tab to avoid regressions.
  - Fallbacks:
    - `getActiveGedmatchTabId()` reads the last‑focused window’s active tab if it’s on GEDmatch.
    - `findSegmentResultsTabId()` scans tabs by URL and presence of known controls (`#edit-download-csv`).

Enhancements (NEW):
- After both visualization navigation and segment search, we verify the tab still exists via `chrome.tabs.get(tab.id)` and, if missing, recover the correct tab with `findSegmentResultsTabId()`.
- When adopting `gmSegmentResultsTabId`, we now log the parent/child switch, close the parent tab, and prefer the active GEDmatch tab again to avoid stale `tab.id`.

### Drupal form click handling
- The “Download CSV” button is bound to Drupal AJAX; plain `.click()` is often ignored. We attempt in order:
  1) Re‑attach Drupal behaviors (`Drupal.attachBehaviors`) when available.
  2) Resolve a bound `Drupal.ajax` instance (from `$(button).data('drupal-ajax')`, `Drupal.ajax.instances`, or `Drupal.ajax({ base, element })`) and call `ajaxInst.execute()`.
  3) Form submission helpers: `form.requestSubmit(button)` then `form.submit()`.
  4) Event synthesis: dispatch pointer/mouse events and `button.click()`.

### Physical click fallback (DevTools Protocol)
- As a last resort, we perform a “physical” click using the Chrome DevTools Protocol (`chrome.debugger`):
  - Focus the target window/tab.
  - Find the element’s center via `getBoundingClientRect()`.
  - Send `Input.dispatchMouseEvent` (move/press/release) at those coordinates.
- This requires `"debugger"` permission and is only used on explicit user action.

### Post‑submit link rendering and download
- When the button reveals a link rather than triggering a download, we wait briefly and scan the DOM for:
  - Exact “Click here to download file.” anchor; or
  - Any link ending with `.csv`.
- If not found (some responses are Drupal AJAX JSON), we also parse the POST response body in page context:
  - If it’s a Drupal AJAX array of commands, we parse `insert` markup and extract the CSV href.
  - Else, parse returned HTML to find `<a href=...csv>`.
- When a link is resolved, we fetch and store the CSV in `chrome.storage.local` under `gmReportsFiles` with bytes and metadata.

Additional notes (NEW):
- The same POST/JSON/HTML extraction logic is used for both the primary and the additional segments CSV.
- We always fetch with `credentials: 'include'` and normalize relative links against the current origin.

### Progress UI and file management
- The Reports tab shows a “Downloaded reports” list with each file and actions:
  - Download (save to disk)
  - Delete (trashcan) — removes the entry from storage and updates status
- A Progress row shows two dots (One‑to‑Many CSV, Segments CSV):
  - Red → pending; Green → file detected in `gmReportsFiles`

Updates (NEW):
- Each saved file includes a `kind` field (`one`, `segments`, `additional-segments`, `autokinship`).
- `additional-segments.csv` appears in the downloaded files list when present; it is optional and not required to proceed.

---

## User Flow

1) Open the Side Panel and upload the GEDmatch one‑to‑many CSV.
2) Optionally upload the one‑to‑one segments CSV and click “Parse Segments CSV”.
3) Click “Parse CSV”. The extension parses rows into `profiles[]` and filters to those with GEDmatch tree links.
4) For each profile, click “Open Next” (or click a specific Open button). The content script auto‑navigates from list/individual pages to the pedigree chart.
   - Alternatively, use “Get All (auto)” for the focused kit or “Get All (auto) across CSV” to iterate kits end‑to‑end.
5) On the pedigree chart, click “Capture Tree” (in the Side Panel). The panel extracts the `<pre>` ASCII chart via `chrome.scripting`, builds families (V9), and stores the capture for the kit.
6) Use “Get All Trees (auto)” to capture every pedigree detected for the focused kit.
7) In the Reports tab, run one‑to‑many and segment workflows; when CSVs are captured, the Progress dots turn green and the files appear in the list with Download/Delete.
8) When done, download outputs (GEDCOM ZIP and/or JSON) and load into ATLAS.

Addendum (error handling & LEO cases):
- If a visualization‑page error appears (“opted out of Law Enforcement…”), we perform the retry + additional‑segments flow described above.
- If other visualization errors appear (e.g., “Kit number not found in public DNA database.”), we log error status to Atlas (see below) and skip the kit.

---

## Parsing the ASCII Pedigree (updates)

### Internationalization/Unicode fixes
- Anchor label handling now supports non‑Latin scripts:
  - Normalize non‑breaking spaces (NBSP) to standard space for matching.
  - Use Unicode letter detection (`\p{L}` with the `u` flag) instead of `[A-Za-z]` to classify a row as a person vs. control anchor.
  - Use `labelNorm` (NBSP‑normalized text) when scanning `innerText` to find the anchor’s column.
- These fixes ensure Cyrillic and other non‑Latin anchors are recognized as people and parsed correctly.

### Robust family builder (V9)
- Unchanged in goals; still relies on rows JSON with pipes, slashes, segments; supports diagonal steps across slash pairs and deep bridging across long pipe stacks.

---

## Name Normalization & Matching

- `nameNorm = toLower(unaccent(stripSurnameSlashes(trimWhitespace(name))))`.
- Accepts handles (e.g., `*Junebug Harris`) and preserves surname tokens.

---

## Enrichment (Optional, user‑opt‑in)

- User enters Enformion API key in Options (planned).

---

## Export & Import

- ZIP export: Side Panel can download all captured per‑kit GEDCOMs as a single ZIP. Filenames:
  - `{OCN}_{KIT}_gmp_{M-D-YYYY}.zip` (if OCN and Reference Kit captured), falling back gracefully if absent.
- JSON export: a single `.json` bundle of the current session is also available.
- Import to backend: ATLAS importer endpoint accepts JSON or GEDCOM files.

---

## GEDCOM Generation & Export (5.5.1‑compatible)

### HEAD additions
- We emit custom tags for case and reference:
  - `1 _OM_REFERENCE_KIT <referenceKit>` (from one‑to‑many CSV top rows parsing)
  - `1 _OM_OCN <OCN>` (from the Side Panel input)

### DNA Source block and Segment data
- For the root individual (the CSV kit) we include a DNA source block and, when available, repeated `_OM_SEGMENT_DATA` entries.

---

## UI/UX Updates

- Advanced panel toggle hides rarely used controls (Parse ASCII, Export JSON, Open Next).
- Reports tab:
  - Kit runner for one‑to‑many and segments workflows
  - Downloaded files list with Download/Delete actions
  - Progress dots that flip green when CSVs are captured
- Side panel current person/status dots remain for capture flows.

Additional UI/behavior changes (NEW):
- Reports (beta) defaults: When loading the one‑to‑many page, we set Limit=1000 and cM size=10 programmatically and re‑attach Drupal behaviors so the form recognizes the change.
- A “Skipped (errors)” counter in the Reports tab increments when a kit is skipped due to errors and is reflected in the panel.
- Error messages sent to Atlas are truncated to the first 200 characters to keep payloads bounded.

---

## Lessons Learned (and why it was hard)

- Chrome extension contexts are isolated: side panel, content scripts, and background do not share consoles or DOM; we added live log rendering and used background listeners for tab adoption.
- New tab targeting is brittle when sites open tabs via `target`/window policies:
  - We used `openerTabId`, `webNavigation` URL watchers, and active tab scans to adopt the correct results tab id and close the parent ASAP.
- Drupal AJAX forms may ignore plain `.click()`/`.submit()` unless the associated `Drupal.ajax` instance is invoked. We programmatically:
  - Re‑attached behaviors, looked up instances, and called `ajaxInst.execute()` when available.
  - Used `requestSubmit(button)`/`submit()` fallbacks when AJAX wasn’t bound.
- Some responses only reveal the CSV link in the AJAX/HTML response body, not immediately in the current DOM. We added response parsing to extract the link when needed.
- As a last resort, we used DevTools Protocol mouse events (`chrome.debugger` + `Input.dispatchMouseEvent`) to dispatch a “physical” click at the element’s coordinates.
- Unicode support mattered: NBSP and Unicode letter classification were necessary to correctly parse non‑Latin anchors.
- User‑facing UX: deferred file appearance required in‑panel progress indicators; we added dot status and made file list deletable.

---

## Recent Changes (Auto‑Kinship & Bundling)

- Auto‑Kinship capture:
  - After both One‑to‑Many and Segments CSVs are saved, the extension can auto‑run the Auto‑Kinship workflow for the current kit (a manual button remains for retries).
  - The flow navigates to `tools/auto-kinship`, fills `edit-kit1`, submits, and waits up to 120s.
  - We specifically resolve a presigned S3 `.zip` URL (anchors ending in `.zip` only). If the page initially shows a generic “Download Results” button, we wait and gently click it until the `.zip` appears.
  - Defensive checks: a HEAD request verifies `Content-Type: ...zip`; if a non‑zip page is encountered, we attempt to extract a `.zip` from HTML as fallback.
  - We store an `autokinship` entry in `gmReportsFiles` with `kind: 'autokinship'` and the presigned URL. We avoid auto‑downloading.

- Reports status & files:
  - Each saved file now includes a `kind` to avoid name heuristics.
  - Status dots include a third dot for Auto‑Kinship ZIP.
  - The downloaded files list supports both in‑memory bytes (CSVs) and URL‑backed ZIPs.

Additional changes (NEW):
- LEO opt‑out handling: parsed opted‑out kit lists, “primary” and “additional” segments passes, sequentialized with Auto‑Kinship.
- Optional “additional‑segments.csv” saved with `kind: 'additional-segments'`; its absence does not block Auto‑Kinship or bundling.
- Atlas error uploads: we post `status=error` with a truncated 200‑char message and current `ocn/kit/site`; used for early visualization errors and other failures.
- Manual vs auto‑run gating: we added `autoRunState.userInitiated` so manual OCN edits or manual clicks do not unintentionally trigger the auto‑runner. The next‑kit auto‑runner still works when enabled and explicitly started.
- Tab adoption hardening: verify tab existence, recover results tab if the parent was closed, and prefer the active GEDmatch tab.

- Bundle assembly (on demand):
  - When all three artifacts exist, the Bundle section shows “Ready” and enables a Download button.
  - Clicking Download bundles the two CSV byte arrays plus the Auto‑Kinship ZIP (fetched only if response is actually a ZIP; else a `AutoKinship_URL.txt` placeholder) into `{OCN}_{KIT}_gmp_{M-D-YYYY}.zip`.
  - ZIP creation uses stored (no‑compression) entries with valid CRC32 values (fixes prior CRC errors).
  - We do not persist large bundles in `chrome.storage.local`; bundles are generated in memory on demand to avoid quota and memory issues.

- OCN support (reports):
  - Added an OCN input on the Reports tab; it mirrors the main OCN storage and prefixes the bundle filename when present.

---

## Potential Improvements

- Reports: Drupal click fallbacks
  - Re-attach Drupal behaviors (`Drupal.attachBehaviors`) when available.
  - Use `Drupal.ajax` instance `execute()` if bound to the button.
  - Fallback to `form.requestSubmit(button)`/`form.submit()` and synthetic events.
  - As a last resort, perform a CDP "physical" click via `chrome.debugger` (user-initiated only).

- Reports: unify one-to-many CSV link extraction
  - If the link is not in the DOM, POST the form in page context and parse the response:
    - Parse Drupal AJAX JSON commands to extract inserted markup containing the `.csv` href.
    - Fallback to parsing returned HTML for `<a href="...csv">`.
  - Fetch with `credentials: 'include'`, mirror the segments flow, and store in `gmReportsFiles`.

- Reports: status and file management
  - Refresh progress dots immediately after each save (call `refreshReportStatus()`).
  - Add "Clear reports" and optionally "Download all (zip)" for `gmReportsFiles`.

- Reports: cross-origin fetch fallback
  - If extension-context fetch lacks cookies, fetch in page context and return bytes to the panel.

- Reports: multi‑kit runner
  - Batch run one‑to‑many and segments across a kit list with pacing, progress, and stop/resume.

- Side Panel: wire CDP fallback
  - Automatically invoke `physicalClickViaDebugger` when all soft attempts fail (explicit user action only).

- Parsing/i18n
  - Preserve NBSP normalization; consider Unicode letter classification when anchors are absent.

- Observability
  - Per‑kit run summaries, exportable logs, and additional timeouts/diagnostic breadcrumbs.

- Planned: autoclustering data capture
  - Automate downloading autoclustering outputs (click sequence + link parsing), store alongside reports with status indicator.

---

## Phase 2 — Bulk Automation Plan

### Goals

- Fully automate the per‑kit workflow at scale (≈1000 kits) with safety, resumability, and politeness.
- Driver loop obtains work items (OCN, Kit) from a backend endpoint, runs the existing capture/automation steps, builds the bundle, uploads it to the backend/S3, reports success/failure, clears memory, waits a randomized delay (1–2 minutes), and repeats.
- Be robust to session expiration, timeouts, transient throttling, and permanently removed kits.

### High‑Level Flow

1. Fetch next job from backend (kit, ocn, jobId, run limits).
2. Set OCN+Kit in panel state; ensure we’re logged in (see Session Detection).
3. Run Reports pipeline:
   - One‑to‑Many: navigate → click Search → click Download CSV → resolve link/POST body → save bytes.
   - Segments: select all → Visualization Options → Search → resolve download via POST/JSON/HTML → save bytes.
   - Auto‑Kinship: navigate → fill `edit-kit1` → submit → wait for `.zip` anchor → store URL.
4. Bundle on demand in memory; do not persist bundle in storage.
5. Upload bundle and metadata to backend; await confirmation.
6. Mark job complete/failed via backend; persist minimal local log (for diagnostics), purge large files from storage.
7. Sleep random delay between 60–120s; continue until limit reached or stop requested.

### Backend API (proposed)

- `GET /api/om/jobs/next?agent={id}` → `{ jobId, kit, ocn, attempt, runLimit?, delayMin?, delayMax? }` or `{ jobId: null }` when empty.
- `POST /api/om/jobs/{jobId}/upload` — options:
  - Direct upload: `multipart/form-data` with `bundle.zip` and JSON fields `{ kit, ocn, filename, sizes, hashes }`.
  - Or presigned upload: `GET /api/om/jobs/{jobId}/presign` returns `{ url, fields }`; extension `fetch`es to S3, then calls complete.
- `POST /api/om/jobs/{jobId}/complete` → `{ status: 'success'|'fail', error?: string, metrics }`.
- Auth/signature: minimal HMAC header: `X-OM-TS` (unix), `X-OM-SIG = HMAC_SHA256(secret, method+path+ts+bodySha256)`; plus `X-OM-Agent`.

### Extension Runner (Automation tab)

- Config:
  - Backend base URL, Agent ID, API key/secret.
  - Max items per run; delay window (default 60–120s); emergency stop threshold (# consecutive errors).
  - “Start”/“Pause”/“Stop & Clear” controls; current job/kit/ocn display.
- State (persist in `chrome.storage.local` under `gmAutoRunner`):
  - `{ running, paused, currentJob: { id, kit, ocn, step }, completedCount, failedCount, consecutiveErrors, lastError, startedAt }`.
  - Steps: `fetchJob → oneCsv → segCsv → autoKinship → bundle → upload → complete`.
  - Resumable: on reopen, continue from `step`.
- Memory hygiene:
  - Use `gmReportsFiles` only for the three small artifacts; purge after successful upload.
  - Never persist bundle bytes; build before upload only.

### Session Detection & Pause

- Detect logout/expired session and pause runner with a prompt to log in:
  - URL redirect to `/user/login` or presence of `form[action*="/user/login"]`, `#edit-name`, `#edit-pass`, `button#edit-submit` on page.
  - HTML markers: text like “You must log in”, “Access denied”, or `drupalSettings.user.uid === 0` (if readable).
  - Fetch/HEAD returning 401/403, or HTML login form instead of CSV/ZIP.
- Behavior: set `gmAutoRunner.paused = true; reason = 'login-required'` and surface “Open Login” button; resume after user confirms logged in.

### Permanent Removal vs Temporary Failure

- Permanent (kit unavailable):
  - One‑to‑Many page shows “Kit not found”, “This kit is not available”, or returns a result page without a results table repeatedly within timeout.
  - Auto‑Kinship page returns specific message or no `.zip` after extended timeout.
  - Mark job `fail` with `reason: 'kit-unavailable'` (do not retry automatically).
- Temporary (throttle/timeout):
  - HTTP 429/503, or placements like “Please try again later”.
  - Exponential backoff (e.g., 5m → 10m → 20m) or emergency stop after N consecutive errors.

### Rate Limiting & Politeness

- Per‑item delay randomized in `[delayMin, delayMax]` (default 60–120s).
- Single concurrency (one active item at a time).
- Optional jitter inside a step (e.g., random 500–2000ms before clicks) to mimic human pacing.

### Upload Strategy

- Prefer presigned S3 upload from backend to avoid cross‑origin/session constraints.
- Alternative: POST bundle to backend, which verifies contents and writes to private S3 over VPN.
- Include metadata JSON with: kit, ocn, filename, sizes, sha256/sha1 of each inner file, start/end timestamps, durations, and pages used (URLs).

### Logging & Observability

- Per‑kit logs already exist (`gmLogsByKit`). Add `gmAutoRunLog` with high‑level events (job start, step transitions, upload, backoff, pause); cap retention.
- Expose a compact “Last N events” view in Automation tab; allow JSON export.

### Error Handling & Emergency Stop

- Threshold `N` consecutive errors → auto “Emergency Stop” (runner paused; prominent banner).
- Surfaces last error, last step, and a “Resume” button once operator intervenes.

### UI Wireframe (Automation tab)

- Controls: Start, Pause, Stop & Clear; Limit (items), Delay min/max; Endpoint, Agent, Secret.
- Status: Current kit/ocn/jobId; Step; Dots (One, Seg, AK); Next run in T‑seconds.
- Logs: last N lines; link to full JSON export.

### Security Notes

- Keep API secret only in local extension storage; do not include in per‑request logs.
- Rotate secret periodically; include timestamp and limited validity in signatures.
- Optionally pin TLS via VPN; treat presigned URLs as short‑lived.

### Implementation Roadmap

1) Add Automation tab UI and `gmAutoRunner` state machine.
2) Backend config and HMAC helper; test `GET /jobs/next` happy path.
3) Integrate existing Reports/Auto‑Kinship pipeline as callable steps; ensure idempotent per step (resume from partial).
4) Build in‑memory bundle and upload to backend/presigned S3; mark complete.
5) Delay/jitter and polite pacing; close tabs promptly.
6) Session detection/pause; login prompt path; resume on confirmation.
7) Error classification/backoff; emergency stop threshold.
8) Logging and export; cap retention.
9) End‑to‑end test with small limit (e.g., 3 items); then ramp.

---

## Chrome Extension (Unpacked) — Quickstart

Folder contents (root):

- `manifest.json` — MV3 manifest
- `sidepanel.html` / `sidepanel.js` — primary UI (CSV/segments upload, capture, auto, ZIP/JSON export, reports automation)
- `background.js` — session wiring, tab/url watchers, child tab adoption
- `content.js` — auto‑navigation and placeholder toolbar (no longer injects the old “coming soon” button)
- `popup.html` / `popup.js`, `import.html` / `import.js` — legacy/minimal UIs
- `README.md` — load instructions

Load steps:
1. Chrome → `chrome://extensions/` → enable Developer mode
2. Load unpacked → select the project folder
3. Click the extension icon to open the Side Panel → upload CSV (and optional Segments CSV) → Parse → capture trees (or run Reports)
4. Download ZIP (with optional floating individuals) and/or export JSON
