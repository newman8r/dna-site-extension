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

### Tab targeting and reliability
- Results sometimes open in a new tab. We ensure we act on the correct tab using several tactics:
  - Background watchers:
    - `webNavigation.onCommitted/onCompleted` store `gmSegmentResultsTabId` when URL matches `.../tools/multi-kit-analysis/segment-search`.
    - `tabs.onCreated/onUpdated` watch child tabs via `openerTabId` and URL updates.
  - Side panel adopts the detected results tab id (`gmSegmentResultsTabId`) after segment search, and closes the parent tab to avoid regressions.
  - Fallbacks:
    - `getActiveGedmatchTabId()` reads the last‑focused window’s active tab if it’s on GEDmatch.
    - `findSegmentResultsTabId()` scans tabs by URL and presence of known controls (`#edit-download-csv`).

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

### Progress UI and file management
- The Reports tab shows a “Downloaded reports” list with each file and actions:
  - Download (save to disk)
  - Delete (trashcan) — removes the entry from storage and updates status
- A Progress row shows two dots (One‑to‑Many CSV, Segments CSV):
  - Red → pending; Green → file detected in `gmReportsFiles`

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
