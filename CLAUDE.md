# CLAUDE.md — ioBroker.parcelapp

> Gemeinsame ioBroker-Wissensbasis: `../CLAUDE.md` (lokal, nicht im Git). Standards dort, Projekt-Spezifisches hier.

## Projekt

**ioBroker Parcel Tracking Adapter** — Paketverfolgung über [parcel.app](https://parcelapp.net) API. Alle Carrier die parcel.app unterstützt, ein API-Key (Premium).

- **Version:** 0.4.6 (WIP) — `scripts/sync-iopackage-from-i18n.py` (hassemu/beszel-Linie). `info` + `info.connection` instanceObjects jetzt mit 11-Sprachen-Translations (vorher nur English). Vorgänger v0.4.5 (2026-05-17) Toolchain-Parity: TS ~6.0.3, vitest, eslint-config 2.3.4, release-script 5.2.0. Code-Cleanup: `asName()` entfernt (14 callsites), `ESTIMATE_LABELS`→i18n-states.ts, `getLatestEvent()` DRY-Helper. extIcon CSP-Fix. v0.4.4 testClient cancelAll-Latency-Fix. v0.4.3 Debug-Coverage-Welle. v0.4.2 17-Finding Hardening.
- **GitHub:** https://github.com/krobipd/ioBroker.parcelapp
- **npm:** https://www.npmjs.com/package/iobroker.parcelapp
- **Repository PR:** ioBroker/ioBroker.repositories#5667 (re-review pending bei mcm1957)
- **Runtime-Deps:** nur `@iobroker/adapter-core` (HTTPS via Node.js built-in)
- **Test-Setup:** vitest (ab v0.4.5) — Tests unter `src/**/*.test.ts` mit `vitest run`, globals enabled. Package-Tests via mocha/@iobroker/testing bleiben separat
- **`@types/node` + `@tsconfig/nodeXX` an `engines.node`-Min gekoppelt:** `^22.x` / `@tsconfig/node22` weil `engines.node: ">=22"`. Dependabot ignoriert Major-Bumps.

## API

- **Base URL:** `https://api.parcel.app/external/`
- **Auth:** Header `api-key: <key>` (Premium-Abo nötig)
- **Rate Limits:** GET 20/Stunde, POST 20/Tag
- **Doku:** https://parcelapp.net/help/api.html
- **Kein DELETE-Endpoint** — nur über parcel.app UI löschbar

## Architektur

```
src/main.ts              → Adapter (Polling, Lifecycle, sendTo, systemLang)
src/lib/types.ts         → Interfaces, Status-Labels (11 Sprachen)
src/lib/coerce.ts        → errText, coerceFiniteNumber strict, coerceString, coerceBoolean, isPlainObject, isTrueish
src/lib/parcel-client.ts → HTTPS-Client (Node.js built-in)
src/lib/state-manager.ts → State CRUD + Cleanup + Berechnungen + createdIds-Cache
src/lib/i18n-states.ts   → 18 STATE_NAMES × 11 Sprachen + ESTIMATE_LABELS + tName(key) für common.name
scripts/sync-iopackage-from-i18n.py → hält io-package.json:instanceObjects synchron mit i18n-states.ts
```

## Design-Entscheidungen

1. **Polling mit Guard** — `isPolling` Flag + `MIN_POLL_GAP_MS` (60s) Throttle
2. **autoRemoveDelivered** — true: API `active` + filter status 0; false: API `recent`, zugestellte bleiben
3. **Carrier-Cache** — Geladen beim ersten `getCarrierName()`, bei Fehler leere Map (Retry nächster Aufruf)
4. **Error-Dedup** — `classifyError()` + `lastErrorCode` (RATE_LIMITED, INVALID_API_KEY, NETWORK, TIMEOUT)
5. **Rate Limit** — Retry-After Header, Cooldown-Timer, Polls übersprungen
6. **sendTo** — `checkConnection` (Admin-UI Button), `addDelivery` (triggert sofortigen Poll)
7. **pkgId** — `sanitize(tracking_number)` + optional `_sanitize(extra_information)`
8. **Sprache** — `system.config.language` einmalig in `onReady` gelesen und an `StateManager` übergeben. Unbekannte Codes fallen via `resolveLanguage()` auf `en` zurück. Kein per-Instanz Language-Setting.
9. **Intermediate Objects** — `deliveries` (folder) + `summary` (channel) sind in io-package.json `instanceObjects` deklariert; `StateManager` legt nur die States darunter an.

## Status-Codes

0=Zugestellt, 1=Eingefroren, 2=Unterwegs, 3=Abholung, 4=In Zustellung, 5=Nicht gefunden, 6=Zustellversuch, 7=Ausnahme, 8=Registriert

## Tests (175 unit + 57 package + 1 integration = 233)

```
src/lib/coerce.test.ts         → errText, coerceFiniteNumber strict (HEX/Exp rejected), coerceString, coerceBoolean, isPlainObject, isTrueish (~25)
src/lib/parcel-client.test.ts  → API client gegen lokalen HTTP-Mock-Server, errors, rate limiting, API-drift (36)
src/lib/state-manager.test.ts  → Deliveries, summary, cleanup, formatting, API-drift, multilang, translation-objects (T1), createdIds cache (T4) (105)
vitest.config.ts               → globals: true, pool: forks, include src/**/*.test.ts
test/package.js                → @iobroker/testing packageFiles (mocha)
test/integration.js            → @iobroker/testing integration (mocha)
test/tsconfig.json             → für integration.js + package.js JSDoc-Type-Check
```

Run: `npm test` (vitest unit + mocha @iobroker/testing packageFiles).

## Versionshistorie (letzte 7)

| Version | Highlights |
| ------- | ---------- |
| 0.4.6   | `scripts/sync-iopackage-from-i18n.py` (hassemu/beszel-Linie). `info` + `info.connection` instanceObjects jetzt mit 11-Sprachen-Translations. |
| 0.4.5   | **Toolchain-Parity:** TypeScript ~5.9→~6.0.3, mocha+chai→vitest (175 unit tests), eslint-config 2.2→2.3.4, release-script 5.2.0. Code-Cleanup: `asName()` no-op wrapper entfernt (14 callsites), `ESTIMATE_LABELS` nach `i18n-states.ts` verschoben, `getLatestEvent()` DRY-Helper. `io-package.json` extIcon raw→jsdelivr (CSP-Fix). `pre-release.py --audit-current` Hook. nyc/source-map-support/ts-node aus devDeps raus. |
| 0.4.4   | **testClient cancelAll-Latency-Fix:** short-lived `testClient` aus `checkConnection` admin-message wird in `this.testClients = new Set<ParcelClient>()` getrackt + im `onUnload` mit aborted. Cross-Adapter parallel zu beszel v0.4.5. |
| 0.4.3   | **Debug-Coverage-Welle** nach 8-Klassen-Audit (1786 LOC + 21 Sites). Score 4.6→9.0, 7/8 Klassen auf 9/10. Reine `log.debug`-Inserts + optionaler `ParcelClientLogger`-Param. README header-icon raw→jsdelivr (CSP-sandbox-Fix), CHANGELOG_OLD konsolidiert. |
| 0.4.2   | 17-Finding 4-Pass-Hardening: cancelAll, AbortController, FORBIDDEN distinct, collision-suffix via FNV-1a, coerceClampedInt shared, Retry-After clamp, body-size cap. |
| 0.4.1   | Adapter logs zurück auf Englisch (mcm1957-Linie). `lib/i18n-logs.ts` gelöscht, direkte EN-Template-Strings. |
| 0.4.0   | Multi-Language: 14 datapoint-Namen in 11 Sprachen. `lib/coerce.ts` mit shared Helpers. `createdIds`-Cache. Node 22 + Admin 7.8.23 Baseline. |
| 0.3.0   | DRY-Cleanup: tote STATUS_LABELS-Aliases raus. Master-Sync dependabot + repochecker-version-gate. |

## Befehle

```bash
npm run build        # Production (esbuild)
npm test             # vitest run (175 unit) + mocha (57 package)
npm run lint         # ESLint + Prettier
npm run check        # tsc --noEmit (TS 6)
npm run coverage     # vitest coverage report
```
