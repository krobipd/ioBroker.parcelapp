# CLAUDE.md — ioBroker.parcelapp

## Adapter-Übersicht

Paketverfolgung über die [parcel.app](https://parcelapp.net) API. 300+ Carrier über einen einzigen API-Key.

## API-Details

- **Base URL:** `https://api.parcel.app/external/`
- **Auth:** Header `api-key: <key>` (Premium-Abo nötig)
- **Rate Limits:** GET 20/Stunde, POST 20/Tag
- **Doku:** https://parcelapp.net/help/api.html
- **Kein DELETE-Endpoint** — Pakete nur über parcel.app Web-UI/App löschbar

### Endpoints
| Endpoint | Methode | Beschreibung |
|----------|---------|--------------|
| `/deliveries/?filter_mode=active` | GET | Aktive Lieferungen |
| `/deliveries/?filter_mode=recent` | GET | Kürzliche Lieferungen (inkl. zugestellte) |
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

**Pattern:** Polling mit Guard-Flag, extendObjectAsync + setStateAsync, getObjectViewAsync für Cleanup.

## Konfiguration (native)

| Feld | Typ | Default | Beschreibung |
|------|-----|---------|--------------|
| apiKey | string | "" | parcel.app API-Key (verschlüsselt) |
| pollInterval | number | 10 | Abfrageintervall in Minuten (5-60) |
| language | string | "de" | Status-Sprache ("de" oder "en") |
| autoRemoveDelivered | boolean | true | Zugestellte Pakete automatisch aus States entfernen |

### autoRemoveDelivered-Logik
- **true (Default):** API-Filter `active`, status_code 0 wird ausgefiltert, States werden gelöscht
- **false:** API-Filter `recent`, zugestellte Pakete bleiben als "Zugestellt" in States. Werden erst entfernt wenn sie in parcel.app gelöscht werden (dann liefert die API sie nicht mehr)

## Admin-UI

Einseiten-Layout (kein Tabs) mit Sektionen:
1. **parcel.app API** — API-Key + Verbindungstest
2. **Abfrage** — Poll-Intervall
3. **Lieferungen** — Auto-Remove Checkbox
4. **Anzeige** — Status-Sprache
5. **Unterstützung** — Ko-fi + PayPal (beide konsistent ohne Icons)

## States

### Per Delivery (`deliveries.{pkgId}`)
| State | Typ | Beschreibung |
|-------|-----|-------------|
| carrier | string | Carrier-Name |
| status | string | Status-Text (sprachabhängig) |
| statusCode | number | Status-Code (0-8) |
| description | string | Paketbeschreibung |
| trackingNumber | string | Sendungsnummer (Original-Schreibweise) |
| extraInfo | string | Zusatzinfo (z.B. Amazon Sub-Tracking-ID) |
| deliveryWindow | string | Zeitfenster (HH:MM - HH:MM) |
| deliveryEstimate | string | Lieferschätzung (heute/morgen/in X Tagen) |
| lastEvent | string | Letztes Tracking-Event |
| lastLocation | string | Letzter Standort |
| lastUpdated | string | ISO-Timestamp letztes Update |

### Summary (`summary`)
| State | Typ | Beschreibung |
|-------|-----|-------------|
| activeCount | number | Anzahl aktiver Lieferungen |
| todayCount | number | Lieferungen heute erwartet |
| deliveryWindow | string | Kombiniertes Zeitfenster für heute |

## sendTo-Kommandos

| Kommando | Parameter | Beschreibung |
|----------|-----------|--------------|
| `checkConnection` | `{ apiKey }` | API-Key testen |
| `addDelivery` | `{ tracking_number, carrier_code, description }` | Lieferung hinzufügen |

## Obsolete States (Cleanup in onReady)
- `summary.json` — entfernt in 0.2.0, war redundanter JSON-Dump aller Deliveries

## Herkunft

Basiert auf einem JavaScript-Adapter-Script (`ioBorker.parcelapp.parcel/script.txt`), das unter `0_userdata.0.KI-Java-Geräte.parcel` lief. Zu einem vollwertigen Adapter umgebaut.
