# CLAUDE.md — ioBroker.parcelapp

> Gemeinsame ioBroker-Wissensbasis: `../CLAUDE.md` (lokal, nicht im Git). Standards dort, Projekt-Spezifisches hier.

## Projekt

**ioBroker Parcel Tracking Adapter** — Paketverfolgung über [parcel.app](https://parcelapp.net) API. Alle Carrier die parcel.app unterstützt, ein API-Key (Premium).

- **Version:** 0.3.0 (in progress — DRY-Cleanup: STATUS_LABELS_DE/EN-Aliases raus + Tests auf STATUS_LABELS.de/en umgestellt; format/format:check npm-scripts ergänzt; Master-Sync für dependabot.yml + repochecker-version-gate Job-Block (M1000 → sources-dist-stable))
- **GitHub:** https://github.com/krobipd/ioBroker.parcelapp
- **npm:** https://www.npmjs.com/package/iobroker.parcelapp
- **Repository PR:** ioBroker/ioBroker.repositories#5667 (re-review pending bei mcm1957)
- **Runtime-Deps:** nur `@iobroker/adapter-core` (HTTPS via Node.js built-in)
- **Test-Setup:** offizieller ioBroker.example/TypeScript-Standard — Tests unter `src/**/*.test.ts` direkt mit `ts-node/register`, kein separater Build (siehe globales `reference_iobroker_test_setup_standard`)
- **`@types/node` an `engines.node`-Min gekoppelt:** `^20.x` weil `engines.node: ">=20"`. Dependabot ignoriert Major-Bumps (siehe `dependabot.yml`).

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
8. **Sprache** — `system.config.language` einmalig in `onReady` gelesen und an `StateManager` übergeben. Unbekannte Codes fallen via `resolveLanguage()` auf `en` zurück. Kein per-Instanz Language-Setting.
9. **Intermediate Objects** — `deliveries` (folder) + `summary` (channel) sind in io-package.json `instanceObjects` deklariert; `StateManager` legt nur die States darunter an.

## Status-Codes

0=Zugestellt, 1=Eingefroren, 2=Unterwegs, 3=Abholung, 4=In Zustellung, 5=Nicht gefunden, 6=Zustellversuch, 7=Ausnahme, 8=Registriert

## Tests

```
src/lib/parcel-client.test.ts  → API client, errors, rate limiting, API-drift
src/lib/state-manager.test.ts  → Deliveries, summary, cleanup, formatting, API-drift, multilang, resolveLanguage, isToday-regression
test/package.js                → @iobroker/testing packageFiles
test/integration.js            → @iobroker/testing integration
test/mocharc.custom.json       → Mocha-Config mit ts-node/register (lädt mocha.setup.js)
test/mocha.setup.js            → chai/sinon-Setup
test/tsconfig.json             → für integration.js + package.js JSDoc-Type-Check
```

Run: `npm test` (mocha auf src/\*_/_.test.ts via ts-node + @iobroker/testing packageFiles, kein separater Build).

## Versionshistorie (letzte 7)

| Version | Highlights                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.3.0   | DRY-Cleanup: tote `STATUS_LABELS_DE`/`STATUS_LABELS_EN`-Aliases aus `types.ts` raus, Tests auf `STATUS_LABELS.de`/`STATUS_LABELS.en` direkt umgestellt. `format` + `format:check` npm-scripts ergänzt (analog hassemu). Master-Sync: `.github/dependabot.yml` (ignore-Block für `actions/checkout` + `actions/setup-node` Major-Bumps) + `repochecker-version-gate` Job-Block in `test-and-release.yml` von M1000-Logik auf sources-dist-stable Master-Snippet umgestellt. |
| 0.2.18  | Audit-Cleanup gegen ioBroker.example/TypeScript-Vollstandard: `@types/node` von `^25.6.0` auf `^20.19.24` zurück (an `engines.node: ">=20"` gekoppelt), dependabot blockt Major-Bumps für `@types/node` + `typescript` + `eslint`, `nyc`-Config + `coverage`-Script ergänzt, `prettier.config.mjs` analog hassemu, verwaiste `auto-merge.yml` gelöscht                                                                                                                     |
| 0.2.17  | Test-Setup auf upstream `ioBroker.example/TypeScript`-Standard zurückgeführt: `tsconfig.test.json` + `build-test/` raus, Tests unter `src/**/*.test.ts` direkt mit `ts-node/register`, neue `test/mocharc.custom.json` + `test/mocha.setup.js` + `test/tsconfig.json` + `test/.eslintrc.json`                                                                                                                                                                              |
| 0.2.16  | Hotfix js-controller-Min in 0.2.15 versehentlich auf `>=7.0.23` gesetzt (Recherche-Synthese statt Repochecker-Source). Korrigiert auf `>=6.0.11` (`recommendedJsControllerVersion`)                                                                                                                                                                                                                                                                                        |
| 0.2.15  | Process-level `unhandledRejection`/`uncaughtException`-Handler als last-line-of-defence. `manual-review`-release-script-Plugin raus. Audit-driven Konsistenz-Cleanup                                                                                                                                                                                                                                                                                                       |
| 0.2.14  | Latest-repo review round 2: separate `build-test/` from `build/` (später durch v0.2.17 vollständig ersetzt), `deliveries`+`summary` als instanceObjects, 11 Sprachen via `system.config.language`, async-handler `.catch()`-Hardening                                                                                                                                                                                                                                      |
| 0.2.13  | Latest-repo review round 1: `common.messagebox=true`                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 0.2.12  | API-Drift-Härtung in parcel-client + state-manager: typeof-Guards, Array.isArray, coerceNumber, +38 Regression-Tests                                                                                                                                                                                                                                                                                                                                                       |

## Befehle

```bash
npm run build        # Production (esbuild)
npm test             # mocha src/**/*.test.ts (via ts-node) + @iobroker/testing packageFiles
npm run lint         # ESLint + Prettier
npm run check        # tsc --noEmit (Type-Check)
```
