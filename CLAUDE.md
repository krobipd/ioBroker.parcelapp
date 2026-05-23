# CLAUDE.md — ioBroker.parcelapp

> Gemeinsame ioBroker-Wissensbasis: `../CLAUDE.md` (lokal, nicht im Git). Standards dort, Projekt-Spezifisches hier.

## Projekt

**ioBroker Parcel Tracking Adapter** — Paketverfolgung über [parcel.app](https://parcelapp.net) API. Alle Carrier die parcel.app unterstützt, ein API-Key (Premium).

- **Version:** 0.5.1 (released 2026-05-23, CI check-and-lint updated to Node.js 24). Vorgänger **0.5.0** Preserve + i18n migration. v0.4.9 community-standard handler. v0.4.8 NUT-Konsistenz. v0.4.7 Internal cleanup. v0.4.6 instanceObjects i18n. v0.4.5 Toolchain-Parity. v0.4.4 testClient cancelAll-Latency-Fix. v0.4.3 Debug-Coverage-Welle. v0.4.2 17-Finding Hardening.
- **GitHub:** https://github.com/krobipd/ioBroker.parcelapp
- **npm:** https://www.npmjs.com/package/iobroker.parcelapp
- **Repository PR:** ioBroker/ioBroker.repositories#5667 (MERGED 2026-05-10, im Latest-Repo)
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
src/lib/i18n.ts          → tName: type-safe I18n.getTranslatedObject wrapper (keys from admin/i18n/en.json)
../scripts/sync-iopackage-from-i18n.py → hält io-package.json:instanceObjects synchron mit admin/i18n (zentral, source: admin-i18n)
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

## Tests (180 unit + 57 package + 1 integration = 238)


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

| Version | Highlights                                                                                                                                                                                              |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.5.1   | CI check-and-lint updated to Node.js 24 (repochecker S3021). |
| 0.5.0   | **Preserve + i18n (mcm-Feedback)**: `extendObjectAsync` with `{ preserve: { common: ["name"] } }`. Private `i18n-states.ts` replaced by adapter-core `I18n.getTranslatedObject()` + `I18n.translate()`. `admin/i18n` migrated from Pattern A (subdirs) to flat files (38 keys × 11 langs). ESTIMATE_LABELS migrated to `I18n.translate()`. Tests 175→180 unit. |
| 0.4.9   | Community-standard event handler pattern (.bind + try/catch). |
| 0.4.8   | **NUT-Konsistenz:** prettier ioBroker-Standard, dependabot double-quotes + TS-6-Kommentar, CI `fail_level: error`, `.releaseconfig.json` 2-Space, vitest `singleFork: false`, README Claude-footer-Fix. |
| 0.4.7   | Internal cleanup: dead tsconfig settings entfernt. |
| 0.4.6   | `scripts/sync-iopackage-from-i18n.py`. instanceObjects mit 11-Sprachen-Translations. |
| 0.4.5   | **Toolchain-Parity:** TS ~6.0.3, vitest, eslint-config 2.3.4, release-script 5.2.0. Code-Cleanup. extIcon CSP-Fix. |
| 0.4.4   | testClient cancelAll-Latency-Fix. |

## Befehle

```bash
npm run build        # Production (esbuild)
npm test             # vitest run (180 unit) + mocha (57 package)
npm run lint         # ESLint + Prettier
npm run check        # tsc --noEmit (TS 6)
npm run coverage     # vitest coverage report
```
