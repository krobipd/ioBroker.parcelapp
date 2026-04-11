# CLAUDE.md — ioBroker.parcelapp

> Gemeinsame ioBroker-Wissensbasis: `../CLAUDE.md` (lokal, nicht im Git). Standards dort, Projekt-Spezifisches hier.

## Projekt

**ioBroker Parcel Tracking Adapter** — Paketverfolgung über [parcel.app](https://parcelapp.net) API. 400+ Carrier, ein API-Key.

- **Version:** 0.2.10 (April 2026)
- **GitHub:** https://github.com/krobipd/ioBroker.parcelapp
- **npm:** https://www.npmjs.com/package/iobroker.parcelapp
- **Repository PR:** ioBroker/ioBroker.repositories#5667
- **Runtime-Deps:** nur `@iobroker/adapter-core` (HTTPS via Node.js built-in)

## API

- **Base URL:** `https://api.parcel.app/external/`
- **Auth:** Header `api-key: <key>` (Premium-Abo nötig)
- **Rate Limits:** GET 20/Stunde, POST 20/Tag
- **Doku:** https://parcelapp.net/help/api.html
- **Kein DELETE-Endpoint** — nur über parcel.app UI löschbar

## Architektur

```
src/main.ts              → Adapter (Polling, Lifecycle, sendTo)
src/lib/types.ts         → Interfaces, Status-Labels
src/lib/parcel-client.ts → HTTPS-Client (Node.js built-in)
src/lib/state-manager.ts → State CRUD + Cleanup + Berechnungen
```

## Design-Entscheidungen

1. **Polling mit Guard** — `isPolling` Flag + `MIN_POLL_GAP_MS` (60s) Throttle
2. **autoRemoveDelivered** — true: API `active` + filter status 0; false: API `recent`, zugestellte bleiben
3. **Carrier-Cache** — Geladen beim ersten `getCarrierName()`, bei Fehler leere Map (Retry nächster Aufruf)
4. **Error-Dedup** — `classifyError()` + `lastErrorCode` (RATE_LIMITED, INVALID_API_KEY, NETWORK, TIMEOUT)
5. **Rate Limit** — Retry-After Header, Cooldown-Timer, Polls übersprungen
6. **sendTo** — `checkConnection` (Admin-UI Button), `addDelivery` (triggert sofortigen Poll)
7. **pkgId** — `sanitize(tracking_number)` + optional `_sanitize(extra_information)`

## Status-Codes

0=Zugestellt, 1=Eingefroren, 2=Unterwegs, 3=Abholung, 4=In Zustellung, 5=Nicht gefunden, 6=Zustellversuch, 7=Ausnahme, 8=Registriert

## Tests (147)

```
test/testParcelClient.ts  → API client, errors, rate limiting (26)
test/testStateManager.ts  → Deliveries, summary, cleanup, formatting (64)
test/package.js           → @iobroker/testing packageFiles (57)
test/integration.js       → @iobroker/testing integration
```

## Versionshistorie

| Version | Highlights |
|---------|------------|
| 0.2.10 | Test-Timezone-Fix, unused Deps entfernt, no-floating-promises, CI checkout entfernt |
| 0.2.9 | Standard-ioBroker-Testsuite, optimierte Test-Build-Konfiguration |
| 0.2.8 | Leere Eltern-Ordner nach State-Cleanup löschen |
| 0.2.7 | Konsistente UI-Labels über alle Adapter |
| 0.2.6 | Redundante Scripts entfernt, CLAUDE.md komprimiert |
| 0.2.5 | Fix toLocaleTimeString Timeout auf Windows |
| 0.2.4 | Dev-Tooling modernisiert (esbuild, TS 5.9 Pin) |
| 0.2.3 | Fix Carrier-Cache Retry |
| 0.2.2 | Adapter-Timer, Windows/macOS CI, MIT-Volltext README |
| 0.2.1 | Rate Limit Detection, Error-Dedup, Poll-Throttling |
| 0.2.0 | autoRemoveDelivered, Single Page Admin, summary.json entfernt |

## Befehle

```bash
npm run build        # Production (esbuild)
npm run build:test   # Test build (tsc)
npm test             # Build + mocha
npm run lint         # ESLint + Prettier
```
