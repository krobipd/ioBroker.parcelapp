# ioBroker.parcelapp — User documentation

Track parcels from every carrier [parcel.app](https://parcelapp.net) supports, with one API key.
The adapter polls your parcel.app account and mirrors every shipment into the ioBroker object tree.

Chapters: **this page** · [Scripting and automation](scripting.md) · [Frequently asked questions](faq.md)

---

## Before you start

You need a **parcel.app Premium subscription**. The API is a Premium feature — without it every
request comes back as HTTP 403 and the adapter cannot read anything. The adapter never creates or
manages your parcel.app account; it only reads (and, on request, adds) deliveries.

The adapter does not talk to carriers directly. Everything you see in ioBroker is what parcel.app
itself knows about a shipment, so a carrier parcel.app cannot reach will stay empty here too.

---

## Setting it up

### 1. Get your API key

1. Open [web.parcelapp.net](https://web.parcelapp.net) and sign in with your parcel.app account.
2. Open the **API** panel.
3. Copy the key. It is a long string — copy it whole, without surrounding spaces.

### 2. Create the instance

In ioBroker, go to **Adapters**, search for `parcelapp` and add an instance. The configuration
dialog opens by itself.

### 3. Fill in the settings

| Setting                                     | What it does                                                                                                                      |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **API Key**                                 | The key from step 1. It is stored encrypted in the instance object and is never written to the log.                               |
| **Poll Interval**                           | How often the adapter asks parcel.app for an update, in minutes (5–60, default 10).                                               |
| **Automatically remove delivered packages** | On: a delivered package disappears from the object tree. Off: it stays with status _Delivered_ until you delete it in parcel.app. |

### 4. Test the connection

Press **Test Connection**. The button performs one real request against the API and reports the
actual result — a wrong key, an expired subscription or a network problem is named, not hidden
behind a green "Ok". Save afterwards; the instance starts and the first poll follows immediately.

> Note: the test uses the same request budget as polling (20 requests per hour). Pressing it a few
> times while setting up is fine; hammering it is not.

### Choosing a poll interval

parcel.app serves the delivery list from a server-side cache that is roughly **45 to 90 minutes**
old. A shorter interval therefore does not make tracking data fresher — it only shortens the delay
between parcel.app refreshing its cache and ioBroker noticing. The default of 10 minutes is a good
compromise; anything below 5 minutes would break the hourly request budget and is refused.

---

## What appears in the object tree

```
parcelapp.0.
├── info.connection              Connection to the parcel.app API
├── summary.
│   ├── activeCount              Packages not yet delivered
│   ├── todayCount               Packages expected today
│   └── deliveryWindow           Combined window of today's packages
└── deliveries.
    └── <packageId>.             One device per package
        ├── carrier
        ├── status
        ├── statusCode
        ├── description
        ├── trackingNumber
        ├── extraInfo
        ├── deliveryWindow
        ├── deliveryEstimate
        ├── lastEvent
        ├── lastLocation
        └── lastUpdated
```

### Connection

| Datapoint         | Type    | Meaning                                                                                                                                                      |
| ----------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `info.connection` | boolean | True while the adapter can reach the parcel.app API. A short database hiccup on the ioBroker side does **not** turn it false — only a real API failure does. |

### Summary

| Datapoint                | Type   | Meaning                                                                                                                                                |
| ------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `summary.activeCount`    | number | Packages that have not been delivered yet.                                                                                                             |
| `summary.todayCount`     | number | Packages whose expected delivery date is today.                                                                                                        |
| `summary.deliveryWindow` | string | The combined window of all packages expected today: earliest start to latest end, e.g. `09:15 - 18:30`. Empty when no package reports a usable window. |

The summary values are **not** reset when the instance is stopped. The number of packages on their
way does not change just because nobody is looking.

### Per package

Each package becomes a **device** under `deliveries.`. The device name is the description you gave
the shipment in parcel.app — and if you rename the device in the ioBroker admin, your name wins and
is never overwritten by an update.

| Datapoint          | Type   | Meaning                                                                                                                                                                                     |
| ------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `carrier`          | string | Display name of the carrier (e.g. `DHL Express`). Falls back to the uppercase carrier code when parcel.app has no name for it.                                                              |
| `status`           | string | The status as readable text, in your ioBroker system language.                                                                                                                              |
| `statusCode`       | number | The status as a number — **this is the datapoint to use in scripts**, because it does not change with the language. See the table below.                                                    |
| `description`      | string | The description from parcel.app. Unlike the device name, this always shows the current value.                                                                                               |
| `trackingNumber`   | string | The tracking number.                                                                                                                                                                        |
| `extraInfo`        | string | Additional detail the carrier needs, such as a postal code or e-mail address. Empty for most shipments.                                                                                     |
| `deliveryWindow`   | string | Expected delivery time window, e.g. `14:00 - 16:00`. A window spanning several days carries the date on both sides (`12-06 14:30 - 12-08 18:30`). Empty when the carrier reports no window. |
| `deliveryEstimate` | string | The same information in words: _today_, _tomorrow_, _in 3 days_, _overdue_. Rendered in the system language.                                                                                |
| `lastEvent`        | string | The most recent tracking event with its date, e.g. `Arrived at delivery depot - 2026-09-02`.                                                                                                |
| `lastLocation`     | string | Where that event happened, when the carrier reports a location.                                                                                                                             |
| `lastUpdated`      | string | When the tracking data last **changed** — not when the adapter last polled. A package that sits still for two days keeps a two-day-old timestamp; that is intentional.                      |

### Status codes

| Code | Meaning          | Code | Meaning                 |
| ---- | ---------------- | ---- | ----------------------- |
| 0    | Delivered        | 5    | Not Found               |
| 1    | Frozen           | 6    | Delivery Attempt Failed |
| 2    | In Transit       | 7    | Exception               |
| 3    | Awaiting Pickup  | 8    | Info Received           |
| 4    | Out for Delivery | -1   | Unknown                 |

`-1` is not a parcel.app status. The adapter uses it when parcel.app sends a status value it cannot
interpret — for example because a future app version introduced a new code. Such a package stays
**visible** instead of being mistaken for "delivered" and silently removed.

Only packages in status 2, 4 and 8 can have an expected delivery date, so `deliveryWindow` and
`deliveryEstimate` are empty for all other statuses.

---

## Language

Every text the adapter writes — status labels, delivery estimates, object names and descriptions —
follows the **ioBroker system language** (_System settings → Language_). There is no per-instance
language setting. Changing the system language takes effect for the object names right away and for
the state values after the next adapter restart.

---

## Removing packages

There is no delete endpoint in the parcel.app API, so the adapter **cannot** remove a shipment from
your parcel.app account. Delete it in the parcel.app app or on the web, and it disappears from
ioBroker with the next poll.

What the adapter does do: with _Automatically remove delivered packages_ enabled, a delivered
package and all of its states are removed from the object tree — the shipment itself stays in your
parcel.app account.
