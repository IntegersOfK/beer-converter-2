# Beer Converter

A multi-person standard-drink comparison tool with shared session support. Inputs volume + ABV, tells you who drank more ethanol and what that amount equals in a benchmark drink of your choice.

## Features

- **Shared Sessions:** Create a session and share the link with friends to contribute to a live, shared tally.
- **Session Log:** Add comments to the session and react with emojis (🍻, 🥃, 🧊, 🤮, 🍕).
- **Offline-First:** Product catalogue and core logic work offline; data syncs to the server when connected.
- **UPC Scanning:** Scan barcodes to instantly lookup volume and ABV from a bundled catalogue.

## Architecture

The app is backed by a single Node.js process using a SQLite database (`server/data.db`).

- **Frontend:** Plain ES modules and CSS.
- **Backend:** Node.js + `better-sqlite3`.
- **API:** RESTful endpoints for sessions, people, drinks, and comments.

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
    ├── products.js — BC Liquor CSV loader + UPC index
    └── scanner.js  — camera scanning wrapper
```

## Standards

- **Canadian standard drink** = 17.05 ml pure ethanol (13.45 g). Source: [Health Canada](https://www.canada.ca/en/health-canada/services/substance-use/alcohol/low-risk-alcohol-drinking-guidelines.html).
- **Imperial fluid ounce** = 28.4131 ml (Canada/UK standard).
