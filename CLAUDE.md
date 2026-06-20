# CLAUDE.md — ioBroker.parcelapp

> Gemeinsame ioBroker-Wissensbasis: `../CLAUDE.md` (lokal, nicht im Git). Standards dort, Projekt-Spezifisches hier.

## Projekt

**ioBroker Parcel Tracking Adapter** — Paketverfolgung über [parcel.app](https://parcelapp.net) API. Alle Carrier die parcel.app unterstützt, ein API-Key (Premium).

- **Version:** 0.8.0 (2026-06-19) — `deliveryWindow` + `summary.deliveryWindow` werden jetzt auch aus den String-Feldern `date_expected`/`date_expected_end` gebaut (neuer geteilter `parseExpectedToMs`-Parser: lokale Komponenten, `hasTime`-Flag, Mitternacht/date-only = kein Fenster, mehrdeutige Carrier-Formate werden NICHT geraten → kein Fenster statt falschem Datum), nicht mehr nur aus `timestamp_expected/_end` — Carrier ohne Unix-Timestamp (Normalfall laut API) zeigen das Fenster nun. **Carrier-agnostisch** (`windowBoundsMs` liest `carrier_code` nicht), kein Amazon-Sonderweg; keine Regression (das Fenster nutzte seit dem ersten Release nur Epochs). Parser geteilt mit `computeDiffDays` (DRY). Aus In-Depth-Analyse Adapter↔API (12 Findings): `addDelivery` reicht `language`+`send_push_confirmation` durch, `description` Pflicht (API: required); `status_code:number` (API=int, parseStatus bleibt drift-tolerant); `error_code` entfernt (nicht Teil der API — ungültiger Key = HTTP-401); rohes Null-Byte in `rawIdKey` als Unicode-Escape ersetzt; JSDoc-Drift + Force-Poll-Kommentar (GET cached, 45–90 min) korrigiert. krobi-Entscheidungen: `event.additional` nicht aufgenommen, `TRACKABLE {2,4,8}` belassen, kein Event-Datum-Fallback. +8 Tests (242 unit), Live-Bestätigung deferred (kein Paket im Fenster-Zustand). API-Recherche: `Ressourcen/parcelapp/api-clients-und-feldformate.md`. Vorgänger **0.7.2** (2026-06-12) — Audit-Welle 2 (Hot-Path-Writes + ehrliche Coverage). **Event-Spam-Fixes:** (1) Device-`extendObjectAsync` lief bei JEDEM Poll (~1.440 Object-Writes/Tag bei 10 Paketen) → Signatur-Cache (`deviceWritten`, description+tracking), Write nur bei Änderung; (2) `lastUpdated` schrieb jeden Poll einen frischen ISO-Timestamp (1 garantiertes Event/Paket/Poll, hebelte v0.5.3-skip-unchanged aus) → `valuesSig`-Map, Schreiben nur wenn sich mindestens ein Sibling-Wert änderte. **Semantik jetzt:** „wann haben sich Tracking-Daten geändert", nicht „wann wurde gepollt". (3) `cleanupDeliveries`: Object-View nur 1× nach Start (Zombie-Reconcile), danach in-memory-Set (`knownDeliveryIds`, beszel-v0.7.2-Kostenmodell). **Hygiene:** totes `systemLang`-Feld raus (Debug-Log behauptete „using X", funktional lief alles über `resolveLanguage` im StateManager — Log zeigt jetzt die echte resolved Sprache); `getCarrierNames` In-Flight-Mutex (erste Poll mit N Paketen feuerte N parallele identische Fetches der statischen 447-Einträge-Datei; quell-verifiziert NICHT rate-limitiert → reine Effizienz); `addDelivery`-Message-Härtung (null/non-object → klare Validierungs-Meldung statt TypeError-über-catch); vitest `coverage.include` + eslint `coverage`-ignore. **Test-Welle:** Export + makeClient/makeStateManager-Seams ([[reference_orchestration_test_harness]]) + neue `src/main.test.ts` (44 Tests: classifyError-Matrix, onReady-Gates, onUnload, Throttle/Force/Rate-Limit-Interplay, autoRemove- vs. keep-Modus, Fehler-Dedup + cleanup-Ausschluss, Error-Routing inkl. Cooldown-Clamps, alle onMessage-Pfade) + 9 Regressionen (Device-Cache, lastUpdated-on-change, View-1×, Carrier-Mutex inkl. shared-failure). Coverage ehrlich 61,1 % (main.ts 0 %) → **95,8 %** (main.ts 93,3 %). 181→234 unit. Vorgänger **0.7.1** — date-only `date_expected` wird als LOKALE Mitternacht geparst (timezone-stabiler `deliveryEstimate`/`todayCount`; vorher via `new Date("YYYY-MM-DD")` = UTC-Mitternacht, kombiniert mit dem lokalen Tages-Diff → Off-by-one-Tag im Fallback-Pfad bei UTC-negativen Zeitzonen). Reachability unverifiziert (primärer `timestamp_expected`-Epoch-Pfad war immer TZ-sicher), Fix deckt zugleich den vorher TZ-fragilen Today-Boundary-Test ab. Vorgänger **0.7.0** (released 2026-06-07) optional Sentry → power-dreams. Vorgänger **0.6.0** (released 2026-05-31, in-depth audit — combined-window max-end fix, status-drift kept visible (`-1`/Unknown), addDelivery `force`-poll, process-handler removal + local poll guard, dead coerce exports removed, `apiError` helper, deterministic packageId pre-pass, parcel-client tests exercise the real `request()` + fix latent BODY_TOO_LARGE, repochecker action pin `@v2`). Vorgänger **0.5.3** memory/perf audit (setStateChangedAsync). **0.5.2** changelog rewrite. **0.5.1** CI Node 24. **0.5.0** Preserve + i18n migration. v0.4.9 community-standard handler. v0.4.8 NUT-Konsistenz. v0.4.7 cleanup. v0.4.6 instanceObjects i18n. v0.4.5 Toolchain-Parity.
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

## Tests (234 unit + 57 package + 1 integration = 292)

```
src/main.test.ts               → Orchestrierung (44): classifyError-Matrix, onReady-Gates (Key-Validierung/happy/boundary-catch/obsolete-cleanup), onUnload (Timer+cancelAll prod/test-clients), Poll (in-flight-guard, Throttle vs. Force vs. Rate-Limit-Cooldown, autoRemove/keep-Modus, Fehler-Dedup + cleanup-Ausschluss, failedDeliveries-Pruning, Error-Routing RATE_LIMITED-Clamp/INVALID_API_KEY-immer-error/FORBIDDEN/NETWORK-Dedup+Recovery/TIMEOUT), onMessage komplett (checkConnection, addDelivery inkl. v0.7.2-Härtung, unknown, throw-Pfad). Stub Adapter-base + injected makeClient/makeStateManager
src/lib/coerce.test.ts         → errText, coerceFiniteNumber strict (HEX/Exp rejected), coerceClampedInt, isTrueish (~19)
src/lib/parcel-client.test.ts  → echte request() gegen lokalen HTTP-Mock-Server (Transport-Härtung: abort/cancelAll, retry-after clamp, oversize→BODY_TOO_LARGE, URL-Validierung), errors, rate limiting, API-drift, v0.7.2 Carrier-Mutex (shared fetch + shared failure) (42)
src/lib/state-manager.test.ts  → Deliveries, summary (inkl. nested-window), cleanup, formatting, API-drift (drift→unknown), multilang, translation-objects (T1), createdIds cache (T4), setStateChanged skip-unchanged (seit v0.7.2 exakt 0 Writes bei identischen Daten), v0.7.2 Device-Write-Cache + lastUpdated-on-change + View-1×-Modell (118)
vitest.config.ts               → globals: true, coverage.include src/**/*.ts (ehrliche Headline), pool: forks
test/package.js                → @iobroker/testing packageFiles (mocha)
test/integration.js            → @iobroker/testing integration (mocha)
test/tsconfig.json             → für integration.js + package.js JSDoc-Type-Check
```

Run: `npm test` (vitest unit + mocha @iobroker/testing packageFiles).

## Versionshistorie (letzte 7)

| Version | Highlights                                                                                                                                                                                              |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.8.0 | Delivery window now also derived from the string fields `date_expected`/`date_expected_end` (shared local `parseExpectedToMs`; midnight/date-only = no window; ambiguous formats not guessed), not only Unix timestamps — carriers without an epoch now show a window (carrier-agnostic, no Amazon special case). `addDelivery` passes `language`/`send_push_confirmation`, `description` required; `status_code:number`; `error_code` removed (HTTP-401 is the detector); raw NUL-byte in `rawIdKey` escaped; JSDoc + force-poll comments fixed. In-depth API analysis (12 findings). |
| 0.7.2 | Audit-Welle 2: Device-Objekt-Write nur bei Änderung (vorher jeden Poll), `lastUpdated` nur bei Daten-Änderung (Semantik: „Daten geändert" statt „gepollt"; killt 1 Pflicht-Event/Paket/Poll), cleanupDeliveries View nur 1×/Start, Carrier-Fetch-Mutex, addDelivery-Message-Härtung, totes systemLang-Feld raus. 53 neue Tests (main.ts-Orchestrierung via Seams), Coverage ehrlich 61→95,8 %. |
| 0.7.1 | Timezone-stable delivery estimates: a calendar-date-only `date_expected` is now read as a local day, fixing a one-day-early estimate in UTC-negative zones (fallback path; the primary timestamp path was always safe). |
| 0.7.0 | Optional Sentry error reporting (`common.plugins.sentry` → eigener power-dreams-Sentry; README-Badge + `## Sentry`-Abschnitt). |
| 0.6.0   | **In-depth audit**: combined-window max-end fix (+nested-window test); status-drift kept visible (`-1`/Unknown) instead of hidden as delivered; addDelivery `force`-poll bypasses the 60s throttle; process-level handlers removed + local poll guard; `apiError` helper + deterministic packageId pre-pass; parcel-client tests exercise the real `request()` (fixed latent BODY_TOO_LARGE); dead coerce exports + unused interface fields removed; repochecker action pin `@v2`. |
| 0.5.3   | Memory/Perf-Audit: `setStateAsync`→`setStateChangedAsync` in state-manager `createAndSet` + main.ts `info.connection`. |
| 0.5.2   | Changelog user-centric rewrite (README + CHANGELOG_OLD + io-package.json news audited against Hard-Negativ-Liste). |

## Befehle

```bash
npm run build        # Production (esbuild)
npm test             # vitest run (181 unit) + mocha (57 package)
npm run lint         # ESLint + Prettier
npm run check        # tsc --noEmit (TS 6)
npm run coverage     # vitest coverage report
```
