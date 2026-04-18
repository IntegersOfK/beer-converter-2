# Beer Converter

A two-person standard-drink comparison tool. Inputs volume + ABV, tells you who drank more ethanol and what that amount equals in a benchmark drink of your choice. All data stays in the browser via `localStorage`.

## Hosting

Plain static files. No build step, no backend. Works behind any static server:

```
python3 -m http.server 8080
# or
npx serve
# or
caddy file-server --listen :8080
```

**Note:** ES modules require an actual HTTP server (not `file://`). The Open Food Facts lookup requires internet; the rest works offline once loaded.

## Structure

```
beer-converter/
├── index.html      — shell
├── styles.css      — all styling
└── js/
    ├── app.js      — entry point, event wiring
    ├── ui.js       — rendering & modals
    ├── state.js    — localStorage + migrations + UPC cache
    ├── calc.js     — ethanol math (pure functions)
    ├── scanner.js  — camera scanning + Open Food Facts lookup
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

Lookups go to the free [Open Food Facts](https://world.openfoodfacts.org) JSON API over CORS. Coverage for alcohol is imperfect — when it misses, the user fills in the blanks and the UPC is cached locally. Subsequent scans of the same product are instant.

Calorie data (`kcalPer100ml`) is captured when available but not yet shown in the UI — it's there for future features.

## LocalStorage keys

- `beerConverter.v1` — people, presets, benchmark
- `beerConverter.upcCache.v1` — UPC → preset-id map
