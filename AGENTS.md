# Beer Converter — Agent Instructions

A standard-drink tracker for BC Liquor products. Users log drinks by volume + ABV or by scanning a barcode against the bundled BC Liquor CSV. 

Primary data (people, drinks, presets) lives in **server-side shared sessions** backed by SQLite. The app always operates on a session identified by `?s=<sid>`.

## Local dev

Two processes, no build step:

```bash
# Frontend (any static server — ES modules need HTTP, not file://)
python3 -m http.server 8080        # or: npx serve, caddy file-server …

# Backend (required for sessions + catalogue)
npm install                        # one-time, installs better-sqlite3
node server/index.js               # listens on :8787
```

Frontend at `http://localhost:8080`, backend at `http://localhost:8787`.
Both are detected automatically by `IS_LOCAL` checks.

Production host: `https://bc.ajwest.ca`. The host reverse-proxies `/submit`, `/catalog.json`, and `/api/*` to the Node backend.

## Architecture

### Frontend (`/js/`, `index.html`, `styles.css`)

Plain ES modules, no framework, no bundler.

| File | Role |
|------|------|
| `js/app.js` | Entry point — wires all events, orchestrates boot/session flow |
| `js/state.js` | Session state management — hydrates from API + polling |
| `js/api.js` | Thin `fetch` wrapper for the sessions API |
| `js/ui.js` | All rendering + modal logic |
| `js/calc.js` | Pure ethanol math — `ethanolOf`, `personStats`, `STD_DRINK_ML = 17.05` |
| `js/products.js` | Loads BC Liquor CSV + fetches `/catalog.json`; merges into UPC index |
| `js/scanner.js` | `BarcodeDetector` API wrapper + volume string parser |
| `js/submit.js` | Fire-and-forget POST to `/submit` for crowdsourcing the catalogue |
| `js/util.js` | `$`, `$$`, `fmt(n, digits)`, `escapeHtml`, `vibe` |

**Cache busting:** every internal `import` carries `?v=37`. Bump this version number across all files when deploying changes.

`localStorage` keys (preferences only):
- `beerConverter.recentSessions` — `[{ sid, name, lastSeen }]` for the session picker
- `beerConverter.unit` — `'ml'` \| `'oz'` display preference
- `beerConverter.theme` — `'bar'` (dark) \| `'beach'` (light)

### Backend (`/server/`)

Node HTTP server backed by SQLite via `better-sqlite3`.

| File | Role |
|------|------|
| `server/index.js` | Routes: `/submit`, `/catalog.json`, `/api/sessions/*`, and admin |
| `server/db.js` | SQLite schema + DAO (prepared statements, transactions) |
| `server/admin/` | Single-file admin SPA for catalogue curation |
| `server/data.db` | SQLite file (gitignored). WAL mode. |

**On first boot**, `server/db.js` imports legacy JSON/JSONL files (`products.json`, etc.) if found, then renames them to `*.migrated`.

Admin path defaults to `/_admin_8f3k9qz4/` — override with `ADMIN_PATH` env var.
Data directory defaults to `server/` — override with `DATA_DIR` env var.

## BC Liquor catalogue

Source: `bc_liquor_store_product_price_list_december_2025.csv`

To update: replace the CSV and update `CSV_PATH` in `js/products.js`. Curated entries from the database override CSV entries.

## Coding conventions

- `fmt(n, digits)` for all number display — returns `'—'` for non-finite.
- `escapeHtml` on all user-provided strings before inserting into innerHTML.
- ABV display: always `toFixed(1)` (e.g., `5.0%`).
- Backend normalisation: ABV and volume always stored as `+value.toFixed(2)`.
- No build step, no TypeScript, no linter config.
- No comments explaining *what* code does; only comments for constraints or non-obvious logic.

## What's not wired yet

- `kcalPer100ml` is captured in presets but not shown in the UI.
- `group` field on products is used for variant matching but not exposed in UI.
