# CLAUDE.md — ioBroker.parcelapp

> Gemeinsame ioBroker-Wissensbasis: `../CLAUDE.md` (lokal, nicht im Git). Standards dort, Projekt-Spezifisches hier.

## Projekt

**ioBroker Parcel Tracking Adapter** — Paketverfolgung über [parcel.app](https://parcelapp.net) API. Alle Carrier die parcel.app unterstützt, ein API-Key (Premium).

- **Version:** 0.7.1 — date-only `date_expected` wird als LOKALE Mitternacht geparst (timezone-stabiler `deliveryEstimate`/`todayCount`; vorher via `new Date("YYYY-MM-DD")` = UTC-Mitternacht, kombiniert mit dem lokalen Tages-Diff → Off-by-one-Tag im Fallback-Pfad bei UTC-negativen Zeitzonen). Reachability unverifiziert (primärer `timestamp_expected`-Epoch-Pfad war immer TZ-sicher), Fix deckt zugleich den vorher TZ-fragilen Today-Boundary-Test ab. Vorgänger **0.7.0** (released 2026-06-07) optional Sentry → power-dreams. Vorgänger **0.6.0** (released 2026-05-31, in-depth audit — combined-window max-end fix, status-drift kept visible (`-1`/Unknown), addDelivery `force`-poll, process-handler removal + local poll guard, dead coerce exports removed, `apiError` helper, deterministic packageId pre-pass, parcel-client tests exercise the real `request()` + fix latent BODY_TOO_LARGE, repochecker action pin `@v2`). Vorgänger **0.5.3** memory/perf audit (setStateChangedAsync). **0.5.2** changelog rewrite. **0.5.1** CI Node 24. **0.5.0** Preserve + i18n migration. v0.4.9 community-standard handler. v0.4.8 NUT-Konsistenz. v0.4.7 cleanup. v0.4.6 instanceObjects i18n. v0.4.5 Toolchain-Parity.
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
src/lib/coerce.ts        → errText, coerceFiniteNumber strict, coerceClampedInt, isTrueish
src/lib/parcel-client.ts → HTTPS-Client (Node.js built-in); baseUrl-Seam (Tests), apiError-Helper
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
6. **sendTo** — `checkConnection` (Admin-UI Button), `addDelivery` (triggert via `poll({ force: true })` einen sofortigen Poll, der den 60s-Throttle umgeht; die Rate-Limit-Sperre bleibt aktiv)
7. **pkgId** — `sanitize(tracking_number)` + optional `_sanitize(extra_information)`
8. **Sprache** — `system.config.language` einmalig in `onReady` gelesen und an `StateManager` übergeben. Unbekannte Codes fallen via `resolveLanguage()` auf `en` zurück. Kein per-Instanz Language-Setting.
9. **Intermediate Objects** — `deliveries` (folder) + `summary` (channel) sind in io-package.json `instanceObjects` deklariert; `StateManager` legt nur die States darunter an.

## Status-Codes

0=Zugestellt, 1=Eingefroren, 2=Unterwegs, 3=Abholung, 4=In Zustellung, 5=Nicht gefunden, 6=Zustellversuch, 7=Ausnahme, 8=Registriert

Unparsebarer/driftender `status_code` → `-1` (`UNKNOWN_STATUS_CODE`): bleibt sichtbar (Aktiv-Filter ist `status !== 0`), rendert als „Unknown (-1)" — wird NICHT fälschlich als „zugestellt" versteckt und im autoRemove-Modus gelöscht.

## Tests (181 unit + 57 package + 1 integration = 239)


```
src/lib/coerce.test.ts         → errText, coerceFiniteNumber strict (HEX/Exp rejected), coerceClampedInt, isTrueish (~19)
src/lib/parcel-client.test.ts  → echte request() gegen lokalen HTTP-Mock-Server (Transport-Härtung: abort/cancelAll, retry-after clamp, oversize→BODY_TOO_LARGE, URL-Validierung), errors, rate limiting, API-drift (40)
src/lib/state-manager.test.ts  → Deliveries, summary (inkl. nested-window), cleanup, formatting, API-drift (drift→unknown), multilang, translation-objects (T1), createdIds cache (T4), setStateChanged skip-unchanged (107)
vitest.config.ts               → globals: true, pool: forks, include src/**/*.test.ts
test/package.js                → @iobroker/testing packageFiles (mocha)
test/integration.js            → @iobroker/testing integration (mocha)
test/tsconfig.json             → für integration.js + package.js JSDoc-Type-Check
```

Run: `npm test` (vitest unit + mocha @iobroker/testing packageFiles).

## Versionshistorie (letzte 7)

| Version | Highlights                                                                                                                                                                                              |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.7.1 | Timezone-stable delivery estimates: a calendar-date-only `date_expected` is now read as a local day, fixing a one-day-early estimate in UTC-negative zones (fallback path; the primary timestamp path was always safe). |
| 0.7.0 | Optional Sentry error reporting (`common.plugins.sentry` → eigener power-dreams-Sentry; README-Badge + `## Sentry`-Abschnitt). |
| 0.6.0   | **In-depth audit**: combined-window max-end fix (+nested-window test); status-drift kept visible (`-1`/Unknown) instead of hidden as delivered; addDelivery `force`-poll bypasses the 60s throttle; process-level handlers removed + local poll guard; `apiError` helper + deterministic packageId pre-pass; parcel-client tests exercise the real `request()` (fixed latent BODY_TOO_LARGE); dead coerce exports + unused interface fields removed; repochecker action pin `@v2`. |
| 0.5.3   | Memory/Perf-Audit: `setStateAsync`→`setStateChangedAsync` in state-manager `createAndSet` + main.ts `info.connection`. |
| 0.5.2   | Changelog user-centric rewrite (README + CHANGELOG_OLD + io-package.json news audited against Hard-Negativ-Liste). |
| 0.5.1   | CI check-and-lint updated to Node.js 24 (repochecker S3021). |
| 0.5.0   | **Preserve + i18n (mcm-Feedback)**: `extendObjectAsync` with `{ preserve: { common: ["name"] } }`. Private `i18n-states.ts` replaced by adapter-core `I18n.getTranslatedObject()` + `I18n.translate()`. `admin/i18n` migrated from Pattern A (subdirs) to flat files (38 keys × 11 langs). ESTIMATE_LABELS migrated to `I18n.translate()`. Tests 175→180 unit. |

## Befehle

```bash
npm run build        # Production (esbuild)
npm test             # vitest run (181 unit) + mocha (57 package)
npm run lint         # ESLint + Prettier
npm run check        # tsc --noEmit (TS 6)
npm run coverage     # vitest coverage report
```
