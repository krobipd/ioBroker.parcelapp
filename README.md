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

ioBroker adapter that connects to the [parcel.app](https://parcelapp.net) API and exposes package tracking data from 300+ carriers as ioBroker states — including delivery status, time windows, and tracking events.

---

## Features

- **300+ carriers** — DHL, FedEx, UPS, Amazon, Hermes, GLS, DPD, and many more via parcel.app
- **Per-package ioBroker states** — carrier, status, tracking number, delivery window, last event, last location
- **Summary states** — active count, today count, combined delivery window
- **Delivery time estimates** — today, tomorrow, in X days with combined time window
- **Automatic polling** with configurable interval (5–60 minutes)
- **Configurable cleanup** — auto-remove delivered packages or keep them until deleted in parcel.app
- **Add deliveries** via sendTo message from scripts or other adapters
- **Admin UI** with connection test, polling settings, and status language selection
- **Multilingual status labels** (German/English)

---

## Requirements

- **Node.js >= 20**
- **ioBroker js-controller >= 7.0.0**
- **ioBroker Admin >= 7.6.20**
- **parcel.app Premium subscription** — required for API access

---

## Configuration

| Option | Description | Default |
|--------|-------------|---------|
| **API Key** | Your parcel.app API key (get it at [web.parcelapp.net](https://web.parcelapp.net)) | — |
| **Poll Interval** | How often to fetch updates (minutes) | 10 |
| **Auto-remove delivered** | Remove delivered packages from states automatically. When disabled, they stay until deleted in parcel.app. | Yes |
| **Status Language** | Language for status labels (German/English) | German |

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

## Troubleshooting

### Connection test fails
- Verify your API key at [web.parcelapp.net](https://web.parcelapp.net)
- Ensure you have an active Premium subscription
- Check if your ioBroker instance has internet access

### No deliveries shown
- The API returns cached data — new deliveries may take a few minutes to appear
- Check if you have active deliveries in the parcel.app

### Rate limit
- The parcel.app API allows 20 requests per hour
- The minimum poll interval is 5 minutes to stay within limits

---

## Changelog

### 0.2.2 (2026-03-28)
- Adapter-managed timers, CI on Windows/macOS, consistent i18n keys, full MIT license in README

### 0.2.1 (2026-03-25)
- Robust error handling: rate limit detection, connection error deduplication, poll throttling

### 0.2.0 (2026-03-25)
- Added option to keep delivered packages in states
- Simplified admin UI to single page
- Removed redundant summary.json state

### 0.1.5 (2026-03-24)
- Added auto-merge config, weekly Dependabot schedule

### 0.1.4 (2026-03-24)
- Improved README

### 0.1.3 (2026-03-24)
- Added Dependabot automerge workflow

### 0.1.2 (2026-03-23)
- Updated devDependencies

Older changelog: [CHANGELOG.md](CHANGELOG.md)

---

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
