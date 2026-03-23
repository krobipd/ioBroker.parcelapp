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

Track your packages from 300+ carriers in ioBroker via [parcel.app](https://parcelapp.net).

---

## Features

- Track deliveries from **300+ carriers** (DHL, FedEx, UPS, Amazon, Hermes, GLS, DPD, and many more)
- Automatic polling with configurable interval (5-60 minutes)
- Delivery time window and estimate (today, tomorrow, in X days)
- Combined delivery window for all packages arriving today
- Summary states (active count, today count, JSON data)
- Automatic cleanup of delivered packages
- Add deliveries via sendTo message
- Connection test in Admin UI
- Multilingual status labels (German/English)

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
| **Filter Mode** | Active (current only) or Recent (includes completed) | Active |
| **Status Language** | Language for status labels (German/English) | German |

---

## State Tree

```
parcelapp.0.
├── info.connection              — Connection status (bool)
├── summary.
│   ├── activeCount              — Number of active deliveries
│   ├── todayCount               — Number of deliveries expected today
│   ├── deliveryWindow           — Combined delivery window for today
│   └── json                     — All active deliveries as JSON
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
- Try changing the filter mode to "Recent" to see completed deliveries

### Rate limit
- The parcel.app API allows 20 requests per hour
- The minimum poll interval is 5 minutes to stay within limits

---

## Changelog

### 0.1.1 (2026-03-23)
- Redesigned adapter logo
- Fixed repochecker issues

### 0.1.0 (2026-03-23)
- Initial release

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

MIT License - see [LICENSE](LICENSE)

Copyright (c) 2026 krobi <krobi@power-dreams.com>

---

*Developed with assistance from Claude.ai*
