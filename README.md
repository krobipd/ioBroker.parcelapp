# <img src="https://cdn.jsdelivr.net/gh/krobipd/ioBroker.parcelapp@main/admin/parcelapp.svg" width="48" align="top" /> ioBroker.parcelapp

**Release:** [![npm version](https://img.shields.io/npm/v/iobroker.parcelapp)](https://www.npmjs.com/package/iobroker.parcelapp) ![stable](https://iobroker.live/badges/parcelapp-stable.svg) ![Installations](https://iobroker.live/badges/parcelapp-installed.svg) [![npm downloads](https://img.shields.io/npm/dt/iobroker.parcelapp)](https://www.npmjs.com/package/iobroker.parcelapp)

**Build:** [![Test and Release](https://github.com/krobipd/ioBroker.parcelapp/actions/workflows/test-and-release.yml/badge.svg)](https://github.com/krobipd/ioBroker.parcelapp/actions/workflows/test-and-release.yml) ![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen) ![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue) [![License](https://img.shields.io/badge/license-MIT-green)](LICENSE) [![Sentry](https://img.shields.io/badge/error%20reporting-Sentry-362d59?logo=sentry&logoColor=white)](https://github.com/ioBroker/plugin-sentry#plugin-sentry)

**Support:** [![Ko-fi](https://img.shields.io/badge/Ko--fi-Support-ff5e5b?logo=ko-fi)](https://ko-fi.com/krobipd) [![PayPal](https://img.shields.io/badge/Donate-PayPal-blue.svg)](https://paypal.me/krobipd)

ioBroker adapter for the [parcel.app](https://parcelapp.net) API. Supports all carriers that parcel.app tracks.

📖 **Full user documentation:** [English](docs/en/README.md) · [Deutsch](docs/de/README.md) — setup step by step, every datapoint explained, scripting and FAQ.

---

## Features

- **All parcel.app carriers** — DHL, FedEx, UPS, Amazon, Hermes, GLS, DPD, and everything else parcel.app supports
- **Per-package ioBroker states** — carrier, status, tracking number, delivery window, last event, last location
- **Carrier pictogram on every package** in the object tree — theme-aware, with a delivery van for carriers without a mark of their own
- **Summary states** — active count, today count, combined delivery window
- **Delivery time estimates** — today, tomorrow, in X days with combined time window
- **Configurable poll interval** (5–60 minutes)
- **Configurable cleanup** — auto-remove delivered packages, or keep them as long as parcel.app lists them
- **Add deliveries** via sendTo message from scripts or other adapters
- **Admin UI** with connection test and polling settings

---

## Sentry / Error reporting

**This adapter uses Sentry libraries to automatically report exceptions and code errors to the developers.** Reporting is active by default. It stays off when the ioBroker diagnostics setting is `none` (`diag` in the system configuration), when data reporting is disabled for this instance or its host (`disableDataReporting`), and on CI systems. A report contains the error with its stack trace and technical context such as versions and platform, plus an anonymous installation ID.

For details and how to disable it, see the [Sentry plugin documentation](https://github.com/ioBroker/plugin-sentry#plugin-sentry). Error reporting requires js-controller 3.0 or newer.

---

## Requirements

- **Node.js >= 22**
- **ioBroker js-controller >= 7.2.2**
- **ioBroker Admin >= 8.0.11**
- **parcel.app Premium subscription** — required for API access

> The adapter CANNOT be installed via GitHub: The adapter must be installed via the ioBroker repository (stable or latest).

---

## Configuration

| Option                    | Description                                                                                                                                                                                                                   | Default |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| **API Key**               | Your parcel.app API key (get it at [web.parcelapp.net](https://web.parcelapp.net))                                                                                                                                            | —       |
| **Poll Interval**         | How often to fetch updates (minutes). parcel.app itself is on average 45 and at most about 90 minutes behind the carrier's website, so shorter intervals only shorten the delay until ioBroker notices what parcel.app knows. | 10      |
| **Auto-remove delivered** | Remove delivered packages from states automatically. When disabled, they stay until parcel.app no longer lists them as recent.                                                                                                | Yes     |

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
        ├── statusCode           — Status code (0-8, -1 = unknown)
        ├── description          — Package description
        ├── trackingNumber       — Tracking number
        ├── extraInfo            — Extra information (postal code, email)
        ├── deliveryWindow       — Expected delivery time window
        ├── deliveryEstimate     — Human-readable estimate (today, tomorrow)
        ├── lastEvent            — Latest tracking event
        ├── lastLocation         — Last known location
        └── lastUpdated          — Timestamp of the last tracking-data change
```

**Status codes** (`statusCode` — the primary datapoint for automations):

| Code | Meaning          | Code | Meaning                                                |
| ---- | ---------------- | ---- | ------------------------------------------------------ |
| 0    | Delivered        | 5    | Not Found                                              |
| 1    | Frozen           | 6    | Delivery Attempt Failed                                |
| 2    | In Transit       | 7    | Exception                                              |
| 3    | Awaiting Pickup  | 8    | Info Received                                          |
| 4    | Out for Delivery | -1   | Unknown (unexpected API value — package stays visible) |

---

## Add Deliveries via Script

You can add new deliveries from JavaScript/Blockly scripts:

```javascript
sendTo("parcelapp.0", "addDelivery", {
  tracking_number: "1234567890",
  carrier_code: "dhl",
  description: "My package",
  // optional:
  language: "de", // tracking language as an ISO 639-1 code, default "en"
  send_push_confirmation: true, // send a push once the delivery is added, default false
  postcode: "10115", // some carriers (e.g. bpost, DPD Germany) cannot track without it
  email: "you@example.com", // some services (e.g. Apple Store orders) require it
});
```

`tracking_number`, `carrier_code` and `description` are required; `language`, `send_push_confirmation`, `postcode` and `email` are optional. Some carriers need the postcode or the e-mail address of the order to track at all — parcel.app tells you in the reply when one is missing, and its carrier list (`https://api.parcel.app/external/supported_carriers.json`) marks them. The callback is optional — without one the delivery is added all the same and the result is logged at info level. The delivery is added to your parcel.app account and one extra poll follows right away (at most one per poll interval, at least 60 seconds after the previous poll, and only within the hourly request budget) — but freshly added deliveries usually have no tracking data yet (see the note below).

**Notes:**

- **POST rate limit: 20 deliveries per day** — failed attempts (e.g. wrong `carrier_code`) also count against this limit.
- **Each field may be at most 512 characters**, and the adapter accepts at most **20 addDelivery calls in any 24 hours** — beyond either limit the call returns `success: false` with an explanatory `error_message` instead of reaching parcel.app.
- Fresh deliveries usually have no tracking events for **45–90 minutes** after they are added — parcel.app is on average 45 and at most about 90 minutes behind the carrier's website. That's a parcel.app-side delay, not an adapter issue.
- **Deleting packages is only possible in the parcel.app app/web UI** — the API has no delete endpoint. With `autoRemoveDelivered` enabled, the adapter still drops delivered packages from ioBroker states automatically.

---

## Troubleshooting

### Connection test fails

- Verify your API key at [web.parcelapp.net](https://web.parcelapp.net)
- Ensure you have an active Premium subscription
- Check if your ioBroker instance has internet access

### No deliveries shown

- parcel.app is on average 45 and at most about 90 minutes behind the carrier's website — new deliveries and fresh tracking events can take that long to appear
- Amazon shipments are updated by parcel.app only on an iPhone with the parcel.app app (open, or through its background refresh)
- Check if you have active deliveries in the parcel.app

### Rate limit

- GET (polling, the extra poll after an `addDelivery`, the connection test): **20 requests per hour** — the adapter keeps count and never asks for the 21st; the minimum poll interval is 5 minutes to stay within this limit
- POST (adding deliveries): **20 requests per day**, failed attempts count too

---

## Changelog

<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->

### **WORK IN PROGRESS**

- Fixed: A package expected over several days turned overdue after the first one — every day of the range now counts as today.
- Fixed: A parcel out for delivery with an outdated date counts as today when the carrier scanned it today.
- Improved: Scan dates in the weekday form of all app languages and the UPS dotted form are read, so today's deliveries are recognised more often.
- New: Tomorrow turns into today right after midnight, without waiting for the next poll.
- Fixed: lastUpdated no longer moves every day — a moving estimate or a renamed carrier is not a tracking change; a new carrier code is.
- Fixed: Three packages with the same tracking number no longer overwrite each other, and a restart never swaps the ids of two packages.
- Improved: Correcting the carrier of a shipment in parcel.app keeps its datapoints instead of deleting and recreating them.
- New: statusCode shows the meaning of every code in the admin, and an unknown status is shown in the system language.
- Changed: The adapter keeps parcel.app's limits itself — at most 20 addDelivery calls a day and never more than 20 requests an hour.
- Changed: A network outage shows in the connection indicator only, not as a warning; a rejected API key is retried less and less often.
- Fixed: addDelivery without a callback now adds the delivery; the result is written to the log.
- Fixed: One damaged entry from parcel.app no longer stops the whole poll, and a garbled status is never taken for delivered.
- Improved: The carrier list is refreshed daily; FedEx and InPost have their own pictogram, PostNL, PostNord and Bring the envelope.
- Fixed: The documentation said error reporting is off by default — it is on unless switched off in the system settings.

### 0.13.0 (2026-09-15) — stable

- Fixed: Every package showed the carrier's short code instead of its name — parcel.app changed the format of its carrier list, and the adapter could no longer read it.
- New: Each package now carries the pictogram of its carrier in the object tree, drawn to read in the light and the dark theme.
- New: Deliveries added from a script can pass a postcode or an e-mail address — some carriers cannot track a shipment without one.
- Fixed: When parcel.app rejects a request, the reply now carries its own explanation instead of only the HTTP status line.
- Changed: The device name of a package follows the description in parcel.app again; a rename in the ioBroker admin no longer survives, use an alias for your own label.
- Fixed: The same tracking number under two carriers is two packages again — one of them used to be invisible in the object tree.
- Fixed: A failed removal of a delivered package no longer kept the count of active packages and the combined delivery window a poll behind.
- Improved: A package the carrier reports as out for delivery counts towards today even when no delivery date is reported.
- Fixed: Stopping the instance while it was still starting no longer spends one more request of the hourly parcel.app budget on a poll nobody reads.
- Fixed: The setting for delivered packages promised they stay until you delete them in parcel.app — they stay while parcel.app still lists them.

### 0.12.1 (2026-09-07)

- New: Carrier, status and description of a package now carry a short explanation in the object tree, in all eleven languages — including why scripts should read the status code, not the text.

### 0.12.0 (2026-09-06)

- Fixed: A package that reappeared after a database hiccup kept datapoints without a name or description until the adapter was restarted.
- Fixed: A delivery window written as "September 6, 2026 14:30" was ignored, so window, estimate and the count of packages expected today stayed empty for those carriers.
- New: The documentation explains why a delivery window can stay empty, and an unreadable date from the carrier can now be reported so the format gets added.
- New: The last known location of a package explains itself in the object tree: it is where the carrier last scanned it, not a live position.

### 0.11.1 (2026-09-04)

- Fixed: The last-changed timestamp of a package kept its old label and had no description as long as the package did not move.

### 0.11.0 (2026-09-04)

- Fixed: Since version 0.10.3 the Test Connection button gave no response at all, and packages added from a script never showed up — both work again.
- Fixed: On installations that already existed, the summary datapoints and the connection state kept their old English names — an update now reaches every datapoint.
- New: Datapoints whose name alone does not explain them now carry a short description in the object tree, in all eleven languages.
- New: Detailed user documentation in English and German, shown in the ioBroker documentation portal.
- Fixed: Two settings from much older versions were still listed in the instance configuration although nothing used them any more.

[Older changelogs can be found there](CHANGELOG_OLD.md)

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

_Developed with assistance from Claude.ai_
