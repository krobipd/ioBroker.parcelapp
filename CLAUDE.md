# CLAUDE.md — ioBroker.parcelapp

> **Hinweis:** Dieses Projekt nutzt die gemeinsame ioBroker-Wissensbasis unter `../CLAUDE.md` (lokal, nicht im Git-Repo). Diese enthält allgemeine Best Practices, Standard-Konfigurationen und Workflows für alle ioBroker-Adapter-Projekte. **Bitte beide Dateien aktuell halten** — Änderungen an Standards gehören in die globale Datei, projekt-spezifisches Wissen hierher.

## Projekt-Übersicht

**ioBroker Parcel Tracking Adapter** — Paketverfolgung über die [parcel.app](https://parcelapp.net) API. 300+ Carrier über einen einzigen API-Key.

**Keine extra Runtime-Dependencies** — nur `@iobroker/adapter-core` + Node.js built-in `https`.

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
| `/supported_carriers.json` | GET | Carrier-Liste (öffentlich, kein API-Key nötig) |

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
├── main.ts              → Adapter-Klasse (Polling, Lifecycle, sendTo)
└── lib/
    ├── types.ts          → Interfaces, Status-Labels, AdapterConfig
    ├── parcel-client.ts  → HTTPS-Client (Node.js built-in https)
    └── state-manager.ts  → State CRUD + Cleanup + Berechnungen
build/                   → Kompilierter JavaScript Code (gitignored außer build/test/)
admin/
├── jsonConfig.json      → Admin UI (Single Page, 5 Sektionen)
├── parcelapp.svg        → Adapter Icon
└── i18n/                → Übersetzungen (alle 11 Sprachen)
.github/workflows/
└── test-and-release.yml → Einziger Workflow: CI + Release bei Tag-Push
test/
└── testPackageFiles.ts  → @iobroker/testing Package-Validierung
```

**Pattern:** Polling mit Guard-Flag (`isPolling`), `extendObjectAsync` + `setStateAsync`, `getObjectViewAsync` für Cleanup.

## Konfiguration (native)

| Feld | Typ | Default | Beschreibung |
|------|-----|---------|--------------|
| apiKey | string | "" | parcel.app API-Key (verschlüsselt via encryptedNative) |
| pollInterval | number | 10 | Abfrageintervall in Minuten (5-60) |
| language | string | "de" | Status-Sprache ("de" oder "en") |
| autoRemoveDelivered | boolean | true | Zugestellte Pakete automatisch aus States entfernen |

### autoRemoveDelivered-Logik
- **true (Default):** API-Filter `active`, status_code 0 wird ausgefiltert, States werden gelöscht
- **false:** API-Filter `recent`, zugestellte Pakete bleiben als "Zugestellt" in States. Werden erst entfernt wenn sie in parcel.app gelöscht werden (dann liefert die API sie nicht mehr)

## Admin-UI

Einseiten-Layout (keine Tabs) mit Sektionen:
1. **parcel.app API** — API-Key + Verbindungstest (sendTo `checkConnection`)
2. **Abfrage** — Poll-Intervall
3. **Lieferungen** — Auto-Remove Checkbox
4. **Anzeige** — Status-Sprache (de/en)
5. **Unterstützung** — Ko-fi + PayPal (beide konsistent ohne Icons)

## States

### Per Delivery (`deliveries.{pkgId}`)

pkgId = `sanitize(tracking_number)` + optional `_sanitize(extra_information)`

| State | Typ | Beschreibung |
|-------|-----|-------------|
| carrier | string | Carrier-Name (aus Cache aufgelöst) |
| status | string | Status-Text (sprachabhängig, de/en) |
| statusCode | number | Status-Code (0-8) |
| description | string | Paketbeschreibung |
| trackingNumber | string | Sendungsnummer (Original-Schreibweise) |
| extraInfo | string | Zusatzinfo (z.B. Amazon Sub-Tracking-ID) |
| deliveryWindow | string | Zeitfenster (HH:MM - HH:MM), nur bei Status 2/4/8 |
| deliveryEstimate | string | Lieferschätzung (heute/morgen/in X Tagen/überfällig) |
| lastEvent | string | Letztes Tracking-Event + Datum |
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
| `checkConnection` | `{ apiKey }` | API-Key testen (Admin-UI Button) |
| `addDelivery` | `{ tracking_number, carrier_code, description }` | Lieferung hinzufügen, triggert sofortigen Poll |

## Error Handling & Rate Limiting

- **Rate Limit (HTTP 429):** `Retry-After` Header ausgewertet, Fallback 5 Min Cooldown. Polls werden übersprungen solange Cooldown aktiv.
- **Netzwerk-Fehler:** ENOTFOUND, ECONNREFUSED, ECONNRESET, ENETUNREACH, EAI_AGAIN → einmal `warn`, danach nur `debug` (kein Log-Spam)
- **Error-Dedup:** `lastErrorCode` trackt den letzten Fehlertyp. Gleicher Fehler → `debug`. Neuer Fehler → `warn`/`error`.
- **Poll-Throttling:** `MIN_POLL_GAP_MS = 60_000` — verhindert zu häufige Requests (z.B. addDelivery direkt nach regulärem Poll)
- **Recovery:** Bei erfolgreicher Abfrage nach Fehler → `info: Connection restored`, `lastErrorCode` reset
- **Carrier-Cache:** Wird beim ersten `getCarrierName` geladen. Bei Fehler → leere Map, kein Cache → Retry beim nächsten Aufruf.

## Obsolete States (Cleanup in onReady)
- `summary.json` — entfernt in 0.2.0, war redundanter JSON-Dump aller Deliveries

## Git Repository

- **URL:** https://github.com/krobipd/ioBroker.parcelapp (großes P!)
- **Branch:** main
- **Autor:** krobi

## Status

**Auf npm veröffentlicht** ✅ — `iobroker.parcelapp@0.2.5`
**ioBroker Repository PR** ✅ — https://github.com/ioBroker/ioBroker.repositories/pull/5667 (ausstehend)
**Release-Pipeline** ✅ — vollautomatisch via `test-and-release.yml` (einziger Workflow!)

## i18n

- Struktur: `admin/i18n/{lang}/translations.json` (Unterordner pro Sprache)
- Alle 11 Sprachen vollständig übersetzt: en, de, ru, pt, nl, fr, it, es, pl, uk, zh-cn
- Kurze semantische Keys (z.B. `header_connection`, `label_apiKey`, `supportHeader`)

## Test-Abdeckung

```
test/
├── testParcelClient.ts  → API client (response parsing, errors, rate limiting) (26 Tests)
├── testStateManager.ts  → StateManager (deliveries, summary, cleanup, status labels, formatting) (64 Tests)
└── testPackageFiles.ts  → @iobroker/testing Package-Validierung (57 Tests)

Total: 147 Tests (alle TypeScript)
```

Tests werden mit `tsconfig.test.json` kompiliert und aus `build/test/` ausgeführt.

## Versionshistorie (Kurzfassung)

| Version | Änderungen |
|---------|------------|
| 0.2.5 | Fix toLocaleTimeString Timeout auf Windows (deterministische Zeitformatierung) |
| 0.2.4 | Dev-Tooling modernisiert (esbuild, TS 5.9 Pin, testing-action-check v2) |
| 0.2.3 | Fix Carrier-Cache Retry nach initialem Fehler |
| 0.2.2 | Adapter-Timer, Windows/macOS CI, konsistente i18n-Keys, MIT-Volltext README |
| 0.2.1 | Rate Limit Detection, Error-Dedup, Poll-Throttling |
| 0.2.0 | autoRemoveDelivered Option, Single Page Admin, summary.json entfernt |
| 0.1.5 | Auto-Merge Config, Dependabot, actions/checkout v6 |
| 0.1.4 | README Verbesserung |

## Befehle

```bash
# Build (TypeScript → JavaScript)
npm run build
npm run watch        # Watch mode

# Lint & Format
npm run lint
npm run lint:fix

# Tests
npm test                  # Alle Tests
npm run test:package      # Nur Package-Tests (für CI check-phase)
npm run test:integration  # Alle Tests (für CI test-phase)
npm run check             # TypeScript Typ-Prüfung ohne Build

# Release (via @alcalzone/release-script mit manual-review Plugin)
# → manual-review blockiert interaktiv, daher manueller Workaround:
# 1. CHANGELOG.md unter ## **WORK IN PROGRESS** befüllen
# 2. npm run build   (NICHT npm test — zerstört Production-Build!)
# 3. Version in package.json + io-package.json manuell bumpen
# 4. CHANGELOG: ## **WORK IN PROGRESS** → ## X.Y.Z (datum)
# 5. README: Changelog-Section aktualisieren
# 6. git add ... && git commit -m "chore: release vX.Y.Z"
# 7. git tag vX.Y.Z && git push && git push origin vX.Y.Z
```

## Herkunft

Basiert auf einem JavaScript-Adapter-Script (`ioBorker.parcelapp.parcel/script.txt`), das unter `0_userdata.0.KI-Java-Geräte.parcel` lief. Zu einem vollwertigen Adapter umgebaut.
