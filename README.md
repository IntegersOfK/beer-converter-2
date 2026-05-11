# Beer Converter

A multi-person standard-drink comparison tool with shared session support. Inputs volume + ABV, tells you who drank more ethanol and what that amount equals in a benchmark drink of your choice.

## Features

- **Shared Sessions:** Create a session and share the link with friends to contribute to a live, shared tally.
- **Session Log:** Add comments to the session and react with emojis (🍻, 🥃, 🧊, 🤮, 🍕).
- **Server Catalogue:** Product catalogue data hydrates from the SQLite-backed server.
- **UPC Scanning:** Scan barcodes to instantly lookup volume and ABV from the server catalogue.

## Architecture

The app is backed by a single Node.js process using a SQLite database (`server/data.db`).

- **Frontend:** Plain ES modules and CSS.
- **Backend:** Node.js + `better-sqlite3`.
- **API:** RESTful endpoints for sessions, people, drinks, and comments.

## BC Liquor Catalogue Seed

The normalized seed at `server/bc_liquor_catalog_seed.json` is imported into SQLite once on server boot. Existing curated UPCs win during import. After a successful import, the server deletes the seed automatically when it lives in `DATA_DIR` (the default); set `DELETE_CATALOGUE_SEED=1` to force cleanup for custom layouts or `KEEP_CATALOGUE_SEED=1` to keep it.

## Hosting & Local Development

Install dependencies and start the server:

```bash
npm install
node server/index.js
```

The app will be available at `http://localhost:8787`.

## Structure

```
.
├── index.html      — frontend shell
├── styles.css      — all styling
├── report.html     — session summary report
├── server/
│   ├── index.js    — Node.js server & API router
│   └── db.js       — SQLite schema & DAO
└── js/
    ├── app.js      — entry point, event wiring
    ├── ui.js       — rendering & modals
    ├── state.js    — state management & API client
    ├── calc.js     — ethanol math (pure functions)
    ├── products.js — server catalogue loader + UPC index
    └── scanner.js  — camera scanning wrapper
```

## Standards

- **Canadian standard drink** = 17.05 ml pure ethanol (13.45 g). Source: [Health Canada](https://www.canada.ca/en/health-canada/services/substance-use/alcohol/low-risk-alcohol-drinking-guidelines.html).
- **Imperial fluid ounce** = 28.4131 ml (Canada/UK standard).
