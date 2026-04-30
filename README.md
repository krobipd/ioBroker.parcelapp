# ioBroker.parcelapp

[![npm version](https://img.shields.io/npm/v/iobroker.parcelapp)](https://www.npmjs.com/package/iobroker.parcelapp)
![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![npm downloads](https://img.shields.io/npm/dt/iobroker.parcelapp)](https://www.npmjs.com/package/iobroker.parcelapp)
![Installations](https://iobroker.live/badges/parcelapp-installed.svg)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-Support-ff5e5b?logo=ko-fi)](https://ko-fi.com/krobipd)
[![PayPal](https://img.shields.io/badge/Donate-PayPal-blue.svg)](https://paypal.me/krobipd)

<img src="https://raw.githubusercontent.com/krobipd/ioBroker.parcelapp/main/admin/parcelapp.svg" width="100" />

ioBroker adapter that connects to the [parcel.app](https://parcelapp.net) API and exposes package tracking data as ioBroker states — including delivery status, time windows, and tracking events. Supports all carriers that parcel.app tracks.

---

## Features

- **All parcel.app carriers** — DHL, FedEx, UPS, Amazon, Hermes, GLS, DPD, and everything else parcel.app supports
- **Per-package ioBroker states** — carrier, status, tracking number, delivery window, last event, last location
- **Summary states** — active count, today count, combined delivery window
- **Delivery time estimates** — today, tomorrow, in X days with combined time window
- **Automatic polling** with configurable interval (5–60 minutes)
- **Configurable cleanup** — auto-remove delivered packages or keep them until deleted in parcel.app
- **Add deliveries** via sendTo message from scripts or other adapters
- **Admin UI** with connection test and polling settings
- **Status labels follow the ioBroker system language** — all 11 supported languages (de, en, ru, pt, nl, fr, it, es, pl, uk, zh-cn), English fallback for unknown codes

---

## Requirements

- **Node.js >= 20**
- **ioBroker js-controller >= 7.0.7**
- **ioBroker Admin >= 7.7.22**
- **parcel.app Premium subscription** — required for API access

---

## Configuration

| Option                    | Description                                                                                                | Default |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- | ------- |
| **API Key**               | Your parcel.app API key (get it at [web.parcelapp.net](https://web.parcelapp.net))                         | —       |
| **Poll Interval**         | How often to fetch updates (minutes)                                                                       | 10      |
| **Auto-remove delivered** | Remove delivered packages from states automatically. When disabled, they stay until deleted in parcel.app. | Yes     |

Status labels (`Delivered`, `In Transit`, …) and delivery estimates (`today`, `tomorrow`, `in X days`) are rendered in the ioBroker system language.

---

## State Tree

```
parcelapp.0.
├── info.connection              — Connection status (bool)
├── summary.
│   ├── activeCount              — Number of active deliveries
│   ├── todayCount               — Number of deliveries expected today
│   └── deliveryWindow           — Combined delivery window for today
└── deliveries.
    └── {packageId}.             — One device per package
        ├── carrier              — Carrier name (e.g. DHL Express)
        ├── status               — Status text (e.g. In Transit)
        ├── statusCode           — Status code (0-8)
        ├── description          — Package description
        ├── trackingNumber       — Tracking number
        ├── extraInfo            — Extra information (postal code, email)
        ├── deliveryWindow       — Expected delivery time window
        ├── deliveryEstimate     — Human-readable estimate (today, tomorrow)
        ├── lastEvent            — Latest tracking event
        ├── lastLocation         — Last known location
        └── lastUpdated          — Last update timestamp
```

---

## Add Deliveries via Script

You can add new deliveries from JavaScript/Blockly scripts:

```javascript
sendTo("parcelapp.0", "addDelivery", {
  tracking_number: "1234567890",
  carrier_code: "dhl",
  description: "My package",
});
```

The delivery is added to your parcel.app account and immediately appears in ioBroker after an automatic poll.

**Notes:**

- **POST rate limit: 20 deliveries per day** — failed attempts (e.g. wrong `carrier_code`) also count against this limit.
- Fresh deliveries usually have no tracking events for **45–90 minutes** after they are added. That's a parcel.app-side delay, not an adapter issue.
- **Deleting packages is only possible in the parcel.app app/web UI** — the API has no delete endpoint. With `autoRemoveDelivered` enabled, the adapter still drops delivered packages from ioBroker states automatically.

---

## Troubleshooting

### Connection test fails

- Verify your API key at [web.parcelapp.net](https://web.parcelapp.net)
- Ensure you have an active Premium subscription
- Check if your ioBroker instance has internet access

### No deliveries shown

- The API returns cached data — new deliveries may take a few minutes to appear
- Check if you have active deliveries in the parcel.app

### Rate limit

- GET (polling): **20 requests per hour** — the minimum poll interval is 5 minutes to stay within this limit
- POST (adding deliveries): **20 requests per day**, failed attempts count too

---

## Changelog
### 0.3.0 (2026-04-30)

- DRY: dead `STATUS_LABELS_DE` + `STATUS_LABELS_EN` aliases removed from `types.ts`; tests rewritten to use `STATUS_LABELS.de` / `STATUS_LABELS.en` directly.
- New `format` + `format:check` npm-scripts (run prettier — matches the other krobi adapters).
- Master-sync against `.consistency-master/`: `.github/dependabot.yml` ignore-block for `actions/checkout` + `actions/setup-node` major bumps, and the `repochecker-version-gate` workflow job moved from the legacy M1000 check to the sources-dist-stable check (now identical to hassemu).

### 0.2.18 (2026-04-28)

- Audit cleanup against the upstream `ioBroker.example/TypeScript` full standard:
  - `@types/node` rolled back from `^25.6.0` to `^20.19.24` so type defs match `engines.node: ">=20"` (otherwise Node 21+-only APIs would type-check on Node 20 and crash at runtime)
  - Dependabot now ignores major bumps for `@types/node`, `typescript`, `eslint` so the runtime/toolchain pinning cannot drift via auto-merge
  - `nyc` config + `coverage` script added (matches upstream template)
  - `prettier.config.mjs` made explicit with project-style overrides (Spaces 2-wide, double quotes) instead of relying on missing config
  - Orphan `.github/auto-merge.yml` removed (the active workflow is `automerge-dependabot.yml` using `gh pr merge`, the old yml was never read)

### 0.2.17 (2026-04-28)

- Test setup migrated to the upstream `ioBroker.example/TypeScript` standard: tests now live next to source as `src/**/*.test.ts` and run directly via `ts-node/register`, no separate test-build. Removes `tsconfig.test.json` + `build-test/` per latest-repo review feedback.

### 0.2.16 (2026-04-26)

- Min js-controller correction: was incorrectly bumped to `>=7.0.23` in 0.2.15 (Wert kam aus Recherche-Synthese, nicht aus Repochecker-Source). Repochecker-recommended value is `>=6.0.11` — restored.

### 0.2.15 (2026-04-26)

- Process-level `unhandledRejection` / `uncaughtException` handlers added as last-line-of-defence against fire-and-forget rejections.
- Stop shipping the `manual-review` release-script plugin — adapter-only consequence.
- Bump min js-controller to `>=7.0.23` (matches latest-repo recommendation).
- Audit-driven boilerplate sync with the other krobi adapters (`.vscode` json5 schemas, `tsconfig.test` looser test rules).
- README footer-link to `CHANGELOG_OLD.md` restored, `CHANGELOG_OLD.md` cleaned up to consistent compact style.

## Support

- [ioBroker Forum](https://forum.iobroker.net/)
- [GitHub Issues](https://github.com/krobipd/ioBroker.parcelapp/issues)

### Support Development

This adapter is free and open source. If you find it useful, consider buying me a coffee:

[![Ko-fi](https://img.shields.io/badge/Ko--fi-Support-ff5e5b?style=for-the-badge&logo=ko-fi)](https://ko-fi.com/krobipd)
[![PayPal](https://img.shields.io/badge/Donate-PayPal-blue.svg?style=for-the-badge)](https://paypal.me/krobipd)

---

## License

MIT License

Copyright (c) 2026 krobi <krobi@power-dreams.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

---

*Developed with assistance from Claude.ai*
