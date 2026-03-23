# CLAUDE.md — ioBroker.parcelapp

## Adapter-Übersicht

Paketverfolgung über die [parcel.app](https://parcelapp.net) API. 300+ Carrier über einen einzigen API-Key.

## API-Details

- **Base URL:** `https://api.parcel.app/external/`
- **Auth:** Header `api-key: <key>` (Premium-Only, $4.99/Jahr)
- **Rate Limits:** GET 20/Stunde, POST 20/Tag
- **Doku:** https://parcelapp.net/help/api.html

### Endpoints
| Endpoint | Methode | Beschreibung |
|----------|---------|--------------|
| `/deliveries/?filter_mode=active` | GET | Aktive Lieferungen |
| `/add-delivery/` | POST | Lieferung hinzufügen |
| `/supported_carriers.json` | GET | Carrier-Liste (öffentlich) |

### Status-Codes
| Code | DE | EN |
|------|----|----|
| 0 | Zugestellt | Delivered |
| 1 | Eingefroren | Frozen |
| 2 | Unterwegs | In Transit |
| 3 | Abholung erwartet | Awaiting Pickup |
| 4 | In Zustellung | Out for Delivery |
| 5 | Nicht gefunden | Not Found |
| 6 | Zustellversuch gescheitert | Delivery Attempt Failed |
| 7 | Ausnahme | Exception |
| 8 | Registriert | Info Received |

## Architektur

```
src/
├── main.ts              — Adapter-Klasse (Polling, Lifecycle, sendTo)
└── lib/
    ├── types.ts          — Interfaces + Status-Labels
    ├── parcel-client.ts  — HTTPS-Client (Node.js built-in)
    └── state-manager.ts  — State CRUD + Cleanup + Berechnungen
```

**Pattern:** Wie beszel — Polling mit Guard-Flag, extendObjectAsync + setStateAsync, getObjectViewAsync für Cleanup.

## Konfiguration (native)

| Feld | Typ | Default | Beschreibung |
|------|-----|---------|--------------|
| apiKey | string | "" | parcel.app API-Key (verschlüsselt) |
| pollInterval | number | 10 | Abfrageintervall in Minuten (5-60) |
| filterMode | string | "active" | "active" oder "recent" |
| language | string | "de" | Status-Sprache ("de" oder "en") |

## sendTo-Kommandos

| Kommando | Parameter | Beschreibung |
|----------|-----------|--------------|
| `checkConnection` | `{ apiKey }` | API-Key testen |
| `addDelivery` | `{ tracking_number, carrier_code, description }` | Lieferung hinzufügen |

## Herkunft

Basiert auf einem JavaScript-Adapter-Script (`ioBorker.parcelapp.parcel/script.txt`), das unter `0_userdata.0.KI-Java-Geräte.parcel` lief. Zu einem vollwertigen Adapter umgebaut.
