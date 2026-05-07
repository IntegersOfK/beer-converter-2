# Beer Converter — Agent Instructions

A standard-drink tracker for BC Liquor products. Users log drinks by volume + ABV or by scanning a barcode against the bundled BC Liquor CSV. All user data lives in `localStorage`; the optional Node backend only collects crowdsourced UPC→product submissions.

## Local dev

Two processes, no build step:

```bash
# Frontend (any static server — ES modules need HTTP, not file://)
python3 -m http.server 8080        # or: npx serve, caddy file-server …

# Backend (optional — only needed for submit/catalog/admin)
npm install                        # one-time, installs better-sqlite3
node server/index.js               # listens on :8787
```

Frontend at `http://localhost:8080`, backend at `http://localhost:8787`.
Both are detected automatically by `IS_LOCAL` checks in `js/products.js` and `js/submit.js`.

Production host: `https://bc.ajwest.ca`. The host reverse-proxies `/submit` and `/catalog.json` to the Node backend.

## Architecture

### Frontend (`/js/`, `index.html`, `styles.css`)

Plain ES modules, no framework, no bundler.

| File | Role |
|------|------|
| `js/app.js` | Entry point — wires all events, orchestrates scanner flow |
| `js/ui.js` | All rendering + modal logic (`submitCustomDrink`, `openAddModal`, `render`) |
| `js/state.js` | `localStorage` persistence — people, presets, UPC cache, migrations |
| `js/calc.js` | Pure ethanol math — `ethanolOf`, `personStats`, `STD_DRINK_ML = 17.05` |
| `js/products.js` | Loads BC Liquor CSV + fetches `/catalog.json`; merges into UPC index |
| `js/scanner.js` | `BarcodeDetector` API wrapper |
| `js/submit.js` | Fire-and-forget POST to `/submit`; dedupes by `upc|abv|volumeMl` per session |
| `js/util.js` | `$`, `$$`, `fmt(n, digits)`, `escapeHtml`, `vibe` |

**Cache busting:** every `import` carries `?v=14`. Bump the version number when deploying changes so browsers pick up the new files. Update it in every `import` statement across `app.js`, `ui.js`, `state.js`, etc. — they all reference each other with the same version suffix.

**ABV is always stored as 0–100 (percentage), never as a 0–1 fraction.**

`localStorage` keys:
- `beerConverter.v1` — people, drinks, presets, benchmark
- `beerConverter.upcCache.v1` — UPC string → preset id

### Backend (`/server/`)

Node HTTP server backed by SQLite via `better-sqlite3`. One npm dependency.

| File | Role |
|------|------|
| `server/index.js` | All routes — submit, catalog, admin API, deploy |
| `server/db.js` | SQLite schema + DAO (prepared statements, transactions, JSON-import migration) |
| `server/admin/index.html` | Single-file admin SPA (no external deps) |
| `server/data.db` | SQLite file (gitignored). WAL mode. Holds products, upcs, submissions, rejected_upcs |
| `server/*.migrated` | Old JSON/JSONL files renamed after one-shot import on first SQLite boot |
| `server/curated.legacy.json` | Pre-products+upcs archive, kept for rollback only |

**On first boot of the SQLite version**, `server/db.js` reads any existing `products.json`, `upcs.json`, `submissions.jsonl`, `rejected.jsonl` in `DATA_DIR`, imports them in a single transaction, and renames the source files to `*.migrated` so the import is idempotent. `data.db` is not tracked in git so a `git pull` won't touch it.

Admin path defaults to `/_admin_8f3k9qz4/` — override with `ADMIN_PATH` env var.
Data directory defaults to `server/` — override with `DATA_DIR` env var.
DB path defaults to `${DATA_DIR}/data.db` — override with `DB_PATH` env var.

Run locally with `node server/index.js`. The server depends on `better-sqlite3` — run `npm install` once after pulling. The deploy endpoint runs `npm install --omit=dev` after each git pull so prod stays in sync.

### Admin endpoints

```
GET  <admin>/api/queue     — pending submissions aggregated by UPC
POST <admin>/api/curated   — upsert a curated entry { upc, name, abv, volumeMl? }
DEL  <admin>/api/curated/:upc
POST <admin>/api/reject    — { upc, reason? }
POST <admin>/api/deploy    — git pull --ff-only with data-file preservation
```

## BC Liquor catalogue

Source: `bc_liquor_store_product_price_list_december_2025.csv`

To update: replace the CSV file and update `CSV_PATH` in `js/products.js`. The CSV column `PRODUCT_ALCOHOL_PERCENT` is a plain 0–100 percentage. Volume comes from `PRODUCT_LITRES_PER_CONTAINER` × 1000 = ml.

Curated entries from `/catalog.json` override BC Liquor entries for the same UPC.

## Coding conventions

- `fmt(n, digits)` for all number display — returns `'—'` for non-finite, handles small values.
- `escapeHtml` on all user-provided strings before inserting into innerHTML.
- ABV display: always `toFixed(1)` so `5.0%` and `50.0%` are visually distinct.
- Backend normalisation: ABV and volume always stored as `+value.toFixed(2)` (number, 2 dp).
- No build, no TypeScript, no linter config — keep it that way unless the user asks.
- No comments explaining what code does; only comments for non-obvious constraints or workarounds.

## What's not wired yet

- `kcalPer100ml` is captured in presets but not shown in the UI (future feature).
- `group` field on curated entries is parsed but unused in the frontend.
