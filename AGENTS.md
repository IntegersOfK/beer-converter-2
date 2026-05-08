# Beer Converter — Agent Instructions

A standard-drink tracker for BC Liquor products. Users log drinks by volume + ABV or by scanning a barcode. Shared sessions allow multiple people to contribute to a live tally via a shared link.

## Local dev

Single process for both API and static files:

```bash
npm install                        # one-time, installs better-sqlite3
node server/index.js               # listens on :8787
```

Open `http://localhost:8787` to access the app. The server serves the frontend files from the repository root.

## Architecture

### Frontend (`/js/`, `index.html`, `report.html`, `styles.css`)

Plain ES modules, no framework, no bundler. State is hydrated from the server.

| File | Role |
|------|------|
| `js/app.js` | Entry point — wires all events, orchestrates scanner flow and comment inputs |
| `js/ui.js` | All rendering + modal logic + comment log rendering |
| `js/state.js` | State management and API client. Hydrates from `/api/sessions/:sid` |
| `js/calc.js` | Pure ethanol math — `ethanolOf`, `personStats`, `STD_DRINK_ML = 17.05` |
| `js/products.js` | Loads BC Liquor CSV + fetches `/catalog.json`; merges into UPC index |
| `js/scanner.js` | `BarcodeDetector` API wrapper |
| `js/util.js` | `$`, `$$`, `fmt(n, digits)`, `escapeHtml`, `vibe` |

**Cache busting:** `import` statements carry `?v=...`. Bump the version when deploying behaviour changes.

### Backend (`/server/`)

Node HTTP server backed by SQLite via `better-sqlite3`.

| File | Role |
|------|------|
| `server/index.js` | Router for static files, public session API, and admin API |
| `server/db.js` | SQLite schema + DAO + data migrations |
| `server/data.db` | SQLite file (gitignored). Holds catalogue and session data |

### Shared Sessions & Comments

- **Sessions:** Identified by a random ID in the URL (`?s=xyz`). Data is stored server-side.
- **Comments:** Session-wide log with free-text author names and emoji reactions.
- **Reactions:** Standard emojis (🍻, 🥃, 🧊, 🤮, 🍕). Tracked by `deviceId` (stored in `localStorage`) for toggling.

## Coding conventions

- `fmt(n, digits)` for all number display.
- `escapeHtml` on all user-provided strings before inserting into innerHTML.
- No build, no TypeScript, no linter config.
- No comments explaining what code does; only comments for non-obvious constraints.
