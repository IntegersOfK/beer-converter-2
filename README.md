# Beer Converter

A multi-person standard-drink comparison tool. Inputs volume + ABV, tells you who drank more ethanol and what that amount equals in a benchmark drink of your choice. All data stays in the browser via `localStorage`.

## Hosting

Plain static files. No build step, no backend. Works behind any static server:

```
python3 -m http.server 8080
# or
npx serve
# or
caddy file-server --listen :8080
```

**Note:** ES modules require an actual HTTP server (not `file://`). Everything is fully offline once loaded — the BC Liquor catalogue ships with the app.

## Structure

```
.
├── index.html      — shell
├── styles.css      — all styling
├── bc_liquor_store_product_price_list_december_2025.csv
│                   — bundled product catalogue (UPC source of truth)
└── js/
    ├── app.js      — entry point, event wiring
    ├── ui.js       — rendering & modals
    ├── state.js    — localStorage + migrations + UPC cache
    ├── calc.js     — ethanol math (pure functions)
    ├── products.js — BC Liquor CSV loader + UPC index
    ├── scanner.js  — camera scanning (BarcodeDetector wrapper)
    └── util.js     — shared helpers
```

## Standards

- **Canadian standard drink** = 17.05 ml pure ethanol (13.45 g). Source: [Health Canada](https://www.canada.ca/en/health-canada/services/substance-use/alcohol/low-risk-alcohol-drinking-guidelines.html).

## UPC scanning

Uses the native `BarcodeDetector` API. Supported on:
- Chrome for Android
- Chrome / Edge on desktop
- Safari on iOS 17+

Firefox doesn't ship it; the UI falls back to a manual UPC text input.

Lookups hit the bundled [BC Liquor Stores price list](https://www.bcldb.com/publications/bc-liquor-stores-product-price-list-current) CSV — fully offline, no API keys, no third-party requests. When the catalogue misses (a beer not stocked at BCL, an out-of-province import, etc.), the user fills in the blanks and the UPC is cached locally. Subsequent scans of the same product are instant — saved to *that* device only.

To refresh the catalogue, replace `bc_liquor_store_product_price_list_december_2025.csv` with a newer monthly export and update `CSV_PATH` in `js/products.js`.

Calorie data (`kcalPer100ml`) is captured on user-added presets but not yet shown in the UI — it's there for future features.

## LocalStorage keys

- `beerConverter.v1` — people, presets, benchmark
- `beerConverter.upcCache.v1` — UPC → preset-id map
