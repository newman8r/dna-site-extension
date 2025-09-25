# DNA Site Import — GEDmatch Browser Extension (Phase 1)

Last updated: 2025-09-25

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
  - Background service worker: lightweight session state and message hooks.
  - Side Panel UI: CSV upload, segments upload, queue, capture controls, auto modes, ZIP/JSON export.
  - Content script (domain‑scoped): basic auto‑navigation to pedigree pages and a placeholder toolbar; capture is triggered from the Side Panel.
  - Options page: planned for future (feature flags, domain settings, Enformion key).

Permissions:
- `activeTab`, `tabs`, `scripting`, `storage`, `downloads`, `unlimitedStorage`, `sidePanel`.
- Host permissions: `https://pro.gedmatch.com/*` and `https://*.gedmatch.com/*`.

State storage:
- `chrome.storage.local` for working sessions.
- JSON export via `chrome.downloads.download`.

---

## User Flow

1) Open the Side Panel and upload the GEDmatch one‑to‑many CSV.
2) Optionally upload the one‑to‑one segments CSV and click “Parse Segments CSV”.
3) Click “Parse CSV”. The extension parses rows into `profiles[]` and filters to those with GEDmatch tree links.
4) For each profile, click “Open Next” (or click a specific Open button). The content script auto‑navigates from list/individual pages to the pedigree chart.
   - Alternatively, use “Get All (auto)” for the focused kit or “Get All (auto) across CSV” to iterate kits end‑to‑end.
5) On the pedigree chart, click “Capture Tree” (in the Side Panel). The panel extracts the `<pre>` ASCII chart via `chrome.scripting`, builds families (V9), and stores the capture for the kit.
6) Use “Get All Trees (auto)” to capture every pedigree detected for the focused kit (when a list page enumerates multiple individuals/trees).
7) When done, download outputs:
   - Per‑kit GEDCOM via “Download GEDCOM”, or all kits via “Download All GEDCOMs (zip)”.
   - Optional “floating individuals” GEDCOM: include matches with no captured tree, filtered by cM thresholds, with DNA/kit metadata.
   - JSON session export is also available.
8) Import the GEDCOMs or JSON into ATLAS to analyze overlaps and plan merges.

---

## Parsing the ASCII Pedigree

This section documents the implementation currently in the extension. The parser runs in two phases: an intermediary “Rows JSON” extraction and a deterministic family builder. The builder has been hardened to correctly connect long pipe stacks and diagonal deflections.

### Phase 1 — Intermediary Rows JSON

The content script extracts the `<pre>` block and emits a line‑oriented structure used by the builder. Key points:

- We capture both `innerHTML` (to read link `href` and color) and `innerText` (to compute columns).
- Whitespace‑only lines are dropped.
- Person rows (type `person`) include:
  - `persons[0]` with: `name, label, url, sex, birth, death, col, leadingSpaces, indent` (indent is quantized by `indentBase` + `indentStep`).
  - `pipes[]` and `pipeCount` (person rows can pass vertical rails).
- Connector rows (type `char`) include:
  - `lefts[]` (columns of `/`), `rights[]` (columns of `\`), `pipes[]`, `pipeCount`.
  - Optional `segments[]: [{L,R,mid}]` when slash pairs are detectable on that row.
- The converter exposes a “Download Rows JSON” button for debugging.

### Phase 2 — Family Builder (V9)

Parameters: `TOL = 3` columns, `OFFSET = indentStep/2`.

#### 2.1 People map
We build `people[]` and a `rowToId` map `{idx → personId}` with `{ id, name, sex, birth, death, url, indent, col, label, line, parents:[], children:[] }` per person.

#### 2.2 Column tracer
Two primitives traverse the ASCII lanes:

- `traceUpFromChar(charArrIdx, col)` and `traceDownFromChar(charArrIdx, col)` walk connector rows above/below while maintaining the current column and, when needed, a span window `[L,R]` when inside an explicit segment.
- At each connector row:
  - If a segment spans `col`, carry its `[L,R]` window and continue.
  - Else if a pipe exists within `±TOL` of `col`, continue straight.
  - Else if a nearby slash exists, perform a diagonal step to `mid ± OFFSET` and continue (resets the window).
  - Otherwise the path breaks.
- At person rows:
  - Accept when `|col(person) − col| ≤ TOL` or the person falls inside the active `[L,R]` window.
  - Treat person rows with nearby pipes as pass‑through to support `/ – person(with '|') – /` chains.

This enables `/ | | … | \` and `\ | | … | /` across many rows, including deflections.

#### 2.3 Robust segment pairing
For each connector row we construct span candidates `[{L,R,mid}]`:

1) Use provided `segments[]` when present.
2) Additionally scan the raw text to pair:
   - For each `/` at `L`, pair with the nearest `\` to its right.
   - For each `\` at `R`, pair with the nearest `/` to its right.

These spans yield stable `mid` columns even when `lefts[]/rights[]` arrays are incomplete.

#### 2.4 Parent–child links
For every span on row `i` we attempt both orientations:

1) Up orientation (parents above, child below)
   - `parent = traceUpFromChar(i, mid + OFFSET)`
   - `child  = traceDownFromChar(i, mid − OFFSET)`
2) Down orientation (parent below, child above)
   - `parent = traceDownFromChar(i, mid + OFFSET)`
   - `child  = traceUpFromChar(i, mid − OFFSET)`

If both endpoints exist we add the `parent → child` edge. In addition, for every pipe column on a row we perform a **deep bridge**: follow the same column up to the first aligned person and down to the last aligned person (allowing coverage by pipes or segment spans). If both endpoints are found, connect the lower as child of the higher (by `indent`). This closes extremely long rails such as the Hidden (F) → Mary Grace Crose link.

#### 2.5 Parent‑set consolidation and spouse inference

- After tracing, a child can (temporarily) accumulate several candidate parents from different connectors. We strictly cap this to a maximum of two parents per child.
- Selection rule when >2 candidates exist:
  - Prefer higher‑generation parents (greater `indent`).
  - Tie‑break by nearest column to the child (`|Δcol|` ascending).
  - Drop the rest and remove their back‑links to the child (prevents cycles).
- We then group children by their exact parent set (unordered, size 1 or 2). Spouses are inferred only from two‑parent groups: if two parents co‑occur for any child, they are spouses of each other for family emission. No adjacency‑only guesses are used.

This eliminates cases where adjacency heuristics accidentally merged neighboring branches, and it guarantees that a child can belong to only one family.

#### 2.6 Families array

Families are materialized directly from the parent‑set groups. For each unique parent set `(p1)`, `(p2)`, or `(p1,p2)` we create exactly one family and attach all grouped children to it. Single‑parent families are created for one‑parent sets. The builder returns `{ people, families, logs }` where `logs` includes trace diagnostics (e.g., `marriage-junction`, `long-pipe-connect`, `parent-set-trim`).

### Why this works
- Lane continuity is enforced: no edge is created without a real path across pipes and/or spans.
- Diagonal steps at slashes are supported, so `/|/` and `\|\` patterns resolve across many rows.
- Orientation fallback prevents directional blind spots (e.g., Jesse → Lydia).

### Practical tuning
- `TOL = 3` columns everywhere (pipes, span bounds, person match).
- `OFFSET = indentStep / 2` to project from span midpoints to endpoints.
- Guard limits (`≤100` rows in deep bridge) keep traces bounded.

### Debugging
- “Download Rows JSON” and “View Parser Log” allow inspection of inputs and trace decisions.
- The rows JSON is part of the saved capture so we can re‑build later without page access.

---

## Data Model (Extension JSON)

Top‑level export:
```json
{
  "exportedAt": "2025-09-09T12:34:56Z",
  "source": {
    "site": "GEDmatch",
    "referenceKit": "WA4131462",
    "dateExported": "2025-09-08 11:56"
  },
  "profiles": [ /* Profile[] */ ],
  "captures": [ /* Capture[] */ ]
}
```

Types:
```ts
// CSV row → Profile
interface Profile {
  id: string;                 // stable UUID generated client-side
  kit: string;                // CSV.Kit
  nameRaw: string;            // CSV.Name (could be handle like *Junebug Harris)
  email?: string;             // CSV.Email
  treeUrl?: string;           // resolved from CSV."GED WikiTree" if present
  sex?: "M"|"F"|"U";        // CSV.Sex or inferred later
  sourceRow: Record<string, string>; // full raw row values for audit
  enrichment?: {
    enformion?: EnformionHit[];    // optional enrichment results
    resolvedName?: string;         // best-guess real name
  };
}

// One capture per page clicked; may include multiple subtrees merged locally
interface Capture {
  id: string;
  profileId: string;           // foreign key to Profile.id
  url: string;                 // page where capture occurred
  asciiHtml: string;           // innerHTML of <pre> block (to preserve colors/links)
  asciiText: string;           // innerText for alignment
  parsedTree: ParsedTree;      // normalized structure
  subtrees: SubtreeCapture[];  // optional additional charts merged by user
}

interface SubtreeCapture {
  id: string;
  url: string;
  asciiHtml: string;
  asciiText: string;
  overlap: OverlapAnchor;      // how this subtree attaches to the main
}

interface OverlapAnchor { nameNorm: string; href?: string; }

interface ParsedTree {
  nodes: ParsedNode[];         // includes anchor person and ancestors
  edges: Array<{ parentId: string; childId: string; }>;
}

interface ParsedNode {
  id: string;                  // stable within capture
  gen: number;                 // 0 = focus person, 1 = parents, 2 = grandparents, ...
  displayName: string;
  nameNorm: string;            // lowercase, no diacritics/slashes
  sex: "M"|"F"|"U";
  href?: string;
  birth?: { date?: string; place?: string };
  death?: { date?: string; place?: string };
  isPrivate?: boolean;
}

interface EnformionHit {
  query: { email?: string; name?: string };
  candidateName?: string;
  confidence?: number;         // 0..1 heuristic confidence
  notes?: string;
}
```

---

## Content Script — Navigation & Signals; Extraction via Side Panel

- Auto‑navigation:
  - On GEDmatch list pages (`/tools/gedcom/find-gedcoms-by-kit`), collect internal links, compute pedigree URLs, emit `gm-trees-detected`, and navigate to the first pedigree.
  - On an “individual” page (`/tools/gedcom/individual`), compute the pedigree URL from `id_family`/`id_ged` and navigate.
- Extraction is triggered from the Side Panel. The panel uses `chrome.scripting.executeScript` against the active tab to extract the `<pre>` block (`innerHTML`, `innerText`, anchor metadata), then builds rows JSON and families (V9) in‑panel.
- WikiTree and other external links are ignored for now (planned in Phase 2).
- “Capture Subtree” UI exists as a stub; subtree capture/merge is planned in a subsequent phase.

Performance: the `<pre>` block is small; parsing runs in milliseconds.

---

## Name Normalization & Matching

- `nameNorm = toLower(unaccent(stripSurnameSlashes(trimWhitespace(name))))`.
- Accept handles like `*Junebug Harris` by stripping leading `*` and preserving trailing surname tokens.
- When correlating Enformion results: compare full tokens and surname matches; keep fuzzy threshold conservative (e.g., Jaro‑Winkler ≥ 0.93) and record as `candidateName` only (no auto‑replace).

---

## Enrichment (Optional, user‑opt‑in)

- User enters Enformion API key in Options.
- For profiles where `nameRaw` looks like a handle or where `resolvedName` is empty, query Enformion by email.
- Store top result with confidence; never overwrite `nameRaw` — set `resolvedName` only.
- Rate‑limit and allow cancel; all enrichment happens client‑side in the extension.

---

## Export & Import

- ZIP export: Side Panel can download all captured per‑kit GEDCOMs as a single ZIP. Filenames: `gedmatch-capture-<KIT>.ged`. When enabled, a `gedmatch-floating-individuals.ged` is added containing matches without captured trees.
- JSON export: a single `.json` bundle of the current session is also available. Filename suggestion: `gedmatch-import-<referenceKit>-<yyyyMMdd-HHmm>.json`.
- Import to backend:
  - ATLAS importer endpoint (Phase 1): `POST /atlas/external/gedmatch` accepting the JSON bundle or GEDCOM files.
  - Backend validates schema, stores bundle metadata, and schedules overlap analysis.

---

## ATLAS Integration (Phase 1)

- Create an “External Trees” library (ATLAS) where each imported bundle becomes a file entry with:
  - `meta.numProfiles`, `meta.numCaptures`, `meta.numNodes`, `meta.referenceKit`, and top surnames from parsed nodes.
- Overlap detection (bundle‑local):
  - Build `nameNorm + year bands` indices across all captures.
  - Detect shared individuals across captures (and between main/subtrees) by `(nameNorm, birthYear?)` and `href` equality.
  - Produce report listing probable overlaps grouped by anchor name.
- Merge planning (Phase 2):
  - Convert ParsedTree to minimal GEDCOM fragments per capture and run ATLAS merge planner (see ATLAS Module Plan: Merge section) to stitch overlapping identities.

---

## UI Specifications (Extension)

Popup panels:
- CSV Upload: drag/drop, shows header summary (kit count, with/without tree links).
- Queue: list of profiles with tree URLs; “Open Next”, “Skip”, “Mark Done”.
- Current Profile: name, email, link; capture count; buttons: “Open Tree Tab”, “Export JSON”.
- Settings: Enformion key, site host overrides, advanced options.

In‑page toolbar (content script):
- Floating bottom‑right box with two buttons:
  - “Capture Tree” (primary)
  - “Capture Subtree” (secondary)
- Shows a small toast on success with profile name and capture count.

---

## Validation & Testing

- Unit: ASCII parser (generation inference, person parsing, color→sex).
- Integration: end‑to‑end with a saved HTML pedigree file (fixture) and sample CSV.
- Manual: run extension on GEDmatch, navigate to pedigree, verify captures and export.

---

## Security & Privacy

- Store data only in `chrome.storage.local`; no automatic uploads.
- Enformion use is optional; API key stored locally; calls executed from the extension only when triggered by the user.
- Do not harvest unrelated page data; only capture the `<pre>` tree content and current URL when the user clicks capture.

---

## Roadmap

- Phase 1 (this doc): CSV ingest, manual capture, subtree merge via overlap anchor, JSON export, ATLAS import endpoint.
- Phase 1.1: Basic overlap report in ATLAS UI; per‑bundle summary view.
- Phase 2: Automated subtree crawling helpers (safe prompts), WikiTree support, batch export directly into ATLAS via signed POST.
- Phase 3: Name resolution improvements, Enformion batching, and cross‑bundle merge suggestions.

---

## Open Questions

- Stable anchor detection across different GEDmatch view templates — do we have a reliable `href` for the focal person on all pedigree pages?
- Column width heuristic for generation inference: fix at N columns or learn per page from `|` rails?
- Handling very deep pedigrees that require multiple subtree captures — how to present and reconcile in the popup UX?

---

## GEDCOM Generation & Export (5.5.1‑compatible)

We will emit a valid GEDCOM 5.5.1 file for every exported bundle so ATLAS can ingest it directly and external tools can open it. Refer to `reference/GEDCOM551.pdf` for exact tag semantics.

### HEAD Template

Use a compact, standards‑compliant header with UTF‑8 and lineage‑linked form, plus custom `_OM_*` provenance tags.

```
0 HEAD
1 SOUR GedMapper
2 NAME GedMapper DNA Site Import
2 VERS 0.1
2 CORP GedMapper
1 DEST ANY
1 DATE <YYYY-MM-DD>
2 TIME <HH:MM:SS>
1 SUBM @SUB1@
1 FILE <gedmatch-import-<referenceKit>.ged>
1 GEDC
2 VERS 5.5.1
2 FORM LINEAGE-LINKED
1 CHAR UTF-8
1 _OM_EXPORT GEDMATCH_ASCII_PEDIGREE
1 _OM_REFERENCE_KIT <referenceKit>
1 _OM_SOURCE GEDmatch
0 @SUB1@ SUBM
1 NAME GEDmatch Importer User
1 _EMAIL <optional-user-email>
```

Notes:
- `CHAR UTF-8` is widely supported with 5.5.1.
- Long values (e.g., URLs) MUST be wrapped using `CONC` (and `CONT` for newlines) to keep line length ≤ 255.

### Mapping JSON → GEDCOM

Given a `Capture.parsedTree`, emit INDIs and FAMs as follows:

- Individual (each `ParsedNode`):
  - `0 @I{n}@ INDI`
  - `1 NAME <displayName>`
  - `1 SEX M|F|U`
  - `1 BIRT` → `2 DATE <text>` if available; `2 PLAC <text>` if available
  - `1 DEAT` → same structure as BIRT when present
  - `_OM_SOURCE_URL` is emitted as a level‑1 custom tag: `1 _OM_SOURCE_URL <absoluteUrl>` (wrap using CONC if needed)
  - `1 NOTE _OM_HREF <href>` if an in‑page link was captured
  - `1 NOTE _OM_PRIVATE true` when `isPrivate` was detected on the page
  - Optional: `1 RESN privacy` for private/hidden entries

- Families (parentage):
  - For every child that has 1 or 2 parents in the parsed graph, create/reuse a family keyed by the unordered pair of parents.
  - Emit `0 @F{n}@ FAM` with:
    - `1 HUSB @I#@` when the parent’s `sex == M`
    - `1 WIFE @I#@` when the parent’s `sex == F`
    - If parent sex is unknown, still attach using the best guess; add `2 NOTE Sex unknown (role ambiguous)` under that line
    - `1 CHIL @I#@` for the child
  - Each child `INDI` receives `1 FAMC @F#@`; each parent receives `1 FAMS @F#@`.

- Focus/anchor person: generation `0` becomes the “subject” of the capture; no special tag required, but we can add `1 NOTE _OM_ANCHOR true` for traceability.

- Subtrees: merged in memory prior to emission so each export contains a single unified set of `INDI`/`FAM` records per capture.

### Hidden Names and Known Names Injection

Problem: GEDmatch pedigrees often render the focal person as `HIDDEN HIDDEN, b. HIDDEN, HIDDEN` due to privacy. We usually know the real name from CSV (and possibly Enformion).

Rules:
- Root anchor override (level 0): At GEDCOM build time we replace the level‑0 person’s `1 NAME` with the CSV `Name` for that kit.
  - If `Name` starts with `*` (handle), we strip the star and use the handle as the entire GEDCOM name (given name only).
  - Otherwise we parse tokens and render as `Given Middle /Surname/` (last token treated as surname). Missing parts are omitted gracefully.
  - Only the level‑0 person is overridden; all other names come from the page.
- If a node’s visible label indicates hidden and we have another known/resolved name, we may also set `1 NAME <resolvedName>` and record:
  - `1 NOTE _OM_VISIBLE_LABEL "HIDDEN HIDDEN"`
  - `1 NOTE _OM_NAME_SOURCE csv|enformion|page`
- If the real name is unknown, leave `1 NAME HIDDEN /HIDDEN/` (or `HIDDEN HIDDEN`) and add `1 RESN privacy`.

### Dates and Places

- Keep dates as free text consistent with 5.5.1 (e.g., `ABT 1869`, `02 MAR 1863`). Do not over‑canonicalize.
- Place lines use `1 BIRT / 2 PLAC <raw>` with minimal normalization.

### URL and Long Text Handling

- Any URL (source page, href) goes into custom `_OM_*` lines under `INDI` or as a HEAD‑level `_OM_SOURCE_URL` when relevant.
- Wrap lines longer than ~245 characters using `1 NOTE ...` + `2 CONC ...` or direct `_OM_*` + `CONC` continuation.

#### Root annotations
- For the level‑0 individual we add:
  - `1 NOTE _OM_NAME_SOURCE gedmatch-csv`
  - `1 NOTE Root name inferred from kit CSV: <Name>`
  - `_OM_ATDNA` as a level‑1 custom tag: `1 _OM_ATDNA <Total cM - Autosomal>` when present in the CSV row.

#### DNA Source block and Segment data
- For the root individual (the CSV kit) we include a DNA source block:
  - `1 _OM_DNA_SOURCE`
  - `2 _OM_KIT_ID <Kit>`
  - `2 _OM_KIT_SITE GEDMATCH`
  - `2 _OM_SUBMITTER_EMAIL <Email>` when available from CSV
- When a Segments CSV is loaded, we embed per‑row segment metadata for the root kit as repeated blocks:
  - `1 _OM_SEGMENT_DATA`
  - `2 _OM_PRIMARY_KIT <primary>`
  - `2 _OM_MATCHED_KIT <matched>`
  - `2 _OM_CHROMOSOME <chr>`
  - `2 _OM_BUILD B37`
  - `2 _OM_SEGMENT_START <b37Start>`
  - `2 _OM_SEGMENT_END <b37End>`
  - `2 _OM_SEGMENT_CM <cM>`
  - `2 _OM_KIT_SOURCE GEDMATCH`

#### Floating individuals GEDCOM
- When exporting floating individuals, we emit minimal `INDI` records (no `FAM`) for matches without captured trees, including `1 NAME`, `1 SEX`, `_OM_ATDNA`, `_OM_DNA_SOURCE`, and any available `_OM_SEGMENT_DATA` entries referencing the kit.

### Pointer Allocation

- Deterministic allocation within each export: assign pointers in breadth‑first order from the anchor (subject) to ancestors.
- Maintain a local map `{ nameNorm|href → @I#@ }` to avoid duplicates across subtrees.
- Families keyed by parent pair pointer tuple ensure idempotent FAM creation.

### File Layout

- Emit all `INDI` records, then all `FAM` records, then `0 TRLR`.
- Filename suggestion aligns with HEAD `FILE` value: `gedmatch-import-<referenceKit>.ged`.

### Validation Checklist (per GEDCOM 5.5.1)

- HEAD contains `GEDC/VERS 5.5.1`, `GEDC/FORM LINEAGE-LINKED`, `CHAR UTF-8`.
- Every pointer referenced exists exactly once; no dangling `FAMC/FAMS`.
- Line length ≤ 255 with proper `CONC`/`CONT` usage.
- Custom tags prefixed with `_` (`_OM_*`).

### Example (truncated)

```
0 HEAD
1 SOUR GedMapper
2 NAME GedMapper DNA Site Import
2 VERS 0.1
1 DATE 2025-09-09
2 TIME 12:00:00
1 SUBM @SUB1@
1 FILE gedmatch-import-WA4131462.ged
1 GEDC
2 VERS 5.5.1
2 FORM LINEAGE-LINKED
1 CHAR UTF-8
1 _OM_EXPORT GEDMATCH_ASCII_PEDIGREE
0 @SUB1@ SUBM
1 NAME GEDmatch Importer User
0 @I1@ INDI
1 NAME Seán /Harris/
1 SEX M
1 NOTE _OM_SOURCE_URL https://www.gedmatch.com/tools/gedcom/... 
0 @I2@ INDI
1 NAME Mary /Grace Crose/
1 SEX F
0 @F1@ FAM
1 HUSB @I1@
1 WIFE @I2@
1 CHIL @I3@
0 TRLR
```

---

## Chrome Extension (Unpacked) — Quickstart

Folder contents (root):

- `manifest.json` — MV3 manifest
- `sidepanel.html` / `sidepanel.js` — primary UI (CSV/segments upload, capture, auto, ZIP/JSON export)
- `background.js` — session wiring and message hooks
- `content.js` — auto‑navigation and placeholder toolbar
- `popup.html` / `popup.js`, `import.html` / `import.js` — legacy/minimal UIs
- `README.md` — load instructions

Load steps:
1. Chrome → `chrome://extensions/` → enable Developer mode
2. Load unpacked → select the project folder
3. Click the extension icon to open the Side Panel → upload CSV (and optional Segments CSV) → Parse → capture trees (or auto‑capture)
4. Download ZIP (with optional floating individuals) and/or export JSON
