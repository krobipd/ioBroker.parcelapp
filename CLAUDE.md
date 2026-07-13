# CLAUDE.md — ioBroker.parcelapp

> Gemeinsame ioBroker-Wissensbasis: `../CLAUDE.md` (lokal, nicht im Git). Standards dort, Projekt-Spezifisches hier.

## Projekt

**ioBroker Parcel Tracking Adapter** — Paketverfolgung über [parcel.app](https://parcelapp.net) API. Alle Carrier die parcel.app unterstützt, ein API-Key (Premium).

- **Version: 0.10.1 (2026-07-13)** — Follow-up-Audit, rein intern → patch, Changelog „Internal refactoring. No user-facing changes." **Echte Findings = 2: L1 + L2.** **L1:** `parseStatus` per-Delivery-**WeakMap-Memo** (`statusMemo`, kein Reset) → Parse + Drift-Debug-Log genau 1× pro Delivery statt 2-4× (Poll parst dieselbe Delivery an Aktiv-Filter/updateDelivery/isToday/combinedWindow); `computeStatus` als reine Sub-Funktion. **L2:** In-Flight-Guard `testConnectionInFlight` auf `handleCheckConnection` — ein *gleichzeitiger* zweiter Test-Connection-Klick antwortet „already running" statt einen zweiten GET aufs 20/h-Budget zu feuern (sequenzielle Re-Tests laufen normal). **KEIN Finding, Add-on:** `calculateCombinedWindow` `Math.min/max(...spread)` → `reduce` (fleet-konsistent beszel, unbounded-safe) — hatte ich im Audit selbst als sicher abgehakt und dann fälschlich als „L3-Finding" erfunden; committed + ehrlich als Add-on gelabelt (Doku-Lehre im Report). 286 unit (+2 TDD: Cross-Call-Drift-Log-1×, Concurrent-Test-1-Call) + 57 package, tsc/lint/build/state-role/consistency clean, Integration-Boot ok. Report: `Ressourcen/parcelapp/v0.10.0-audit.md`.
- **Version: 0.10.0 (2026-07-08)** — Voll-Audit-Umsetzung, alle 80 Findings. Hinweis: repochecker E4002/E4022 stehen befristet in `REPOCHECKER_KNOWN_FINDINGS_PER_ADAPTER` (pre-release.py), bis ioBroker.repositories#6279 (type→misc-data) gemergt ist — danach BEIDE Codes wieder entfernen. **H1:** Admin-„Test Connection" antwortet jetzt `{result}`/`{error}` (ConfigSendto liest NUR diese Keys — vorher zeigte der Button IMMER „Ok"; beszel-Vorbild; totes `okText/errorText`-Dict aus jsonConfig entfernt). **H2:** `test:unit`-Script-Alias — die vitest-Suite läuft jetzt auch in der CI (testing-action-adapter@v1 triggert auf `test:unit`; vorher liefen 253 Unit-Tests NUR lokal). **M1:** typisierter Fehler-Vertrag `ApiErrorCode`/`ApiError` (types.ts); Client codiert ALLE Failures (TIMEOUT/PARSE_ERROR/ABORTED); classifyError: code gewinnt, kein message-Sniffing; ABORTED→debug (kein „Poll failed"-error beim Stop). **M2:** cleanup/summary-Fehler = warn, info.connection bleibt API-Wahrheit. **M3:** Log-Dedup für INVALID_API_KEY/FORBIDDEN/RATE_LIMITED (1× error/warn, Wiederholung debug). **M4:** harte 60s-Request-Deadline (Trickle-Response kann isPolling nicht mehr ewig halten); isPolling-Guard loggt debug. **M5:** `valuesSig` ERSETZT durch `setStateChangedAsync`-Rückgabe `{id, notChanged}` (Runtime js-controller ≥7.2.2 verifiziert; types 7.1.2 sagen fälschlich `string` → lokales Narrowing in createAndSet) — lastUpdated restart-stabil, Doppel-Liste weg. **L20:** STATUS_LABELS-Tabelle (122 Z.) → admin/i18n `status_0…status_8`; StateManager OHNE language-Param, resolveLanguage/SUPPORTED_LANGUAGES/FALLBACK_LANGUAGE entfernt (I18n.init liest system.config.language selbst); estimateDays nutzt `%s`+translate-args; `tText`/`statusLabel`/`packageName`-Wrapper in i18n.ts. **DP-5:** deviceWritten-Sig-Map → `deviceEnsured`-Set (preserve:name machte den Sig-Rewrite wirkungslos). **L1:** deprecated `setStateAsync`/`extendObjectAsync` → `setState`/`extendObject`. **L2:** `unloaded`-Flag (kein Timer-Arming nach Stop, Shutdown-warns→debug). **L3:** cancelAll terminal (`cancelled`-Flag). **L4:** onReady-Fehler → `terminate(START_IMMEDIATELY_AFTER_STOP)` statt Zombie. **L5:** force-Poll-Option KOMPLETT entfernt (addDelivery-Poll respektiert 60s-Gap → 20/h-Budget nie reißbar). **L11:** updateDelivery-pkgId required (Tests: `updateDeliveryT`-Helper). **L19:** common.type → misc-data. Weitere: replyAddError/handleCheckConnection/handleAddDelivery/handlePollError-Extraktion (M9), oneLine +NUL/VT/FF/U+2028/29 (I10), NETWORK_ERROR_CODES-Set +EPIPE/ECONNABORTED/EPROTO, isTrueish auf addResult (L9), Pick<>-Seams (L12), pkgIdOf (L15), DELIVERED_STATUS_CODE (L16), mapHttpStatusError (L17), lokalisierter Fallback-Name `packageName` mit %s (L18), ParcelEvent-Felder optional (L10), Retry-After-Konstanten geteilt (L7), Delete-Fanout 25er-Batches (I2), tote Configs raus (test/.eslintrc.json, widgets-exclude, *.mjs-allowDefaultProject, dependabot-eslint-ignore), README: statusCode-Tabelle inkl. −1, addDelivery-Limits (512 Zeichen/Feld, 20/min), Cache-Zeiten vereinheitlicht. **Bewusst belassen:** cleanupObsoleteStates bis zum nächsten Major; device-Objekttyp; Tests-ungelintet (Fleet-Entscheidung); Deadline nicht end-to-end getestet (60s-Realzeit — über ABORTED/classifyError-Pfade gedeckt).
- **Version:** 0.9.0 (2026-06-23, stable) — Datenverlust-Cluster: Keep-Set = ALLE API-pkgIds (transienter Write-Fehler löscht kein präsentes Paket mehr); präsente falsch-getypte `deliveries` → throw, `null`/absent = leer (KEIN throw); Mehrtages-`deliveryWindow` mit Datum beidseitig + `end>start`-Guard; `oneLine()`-Sanitizer; addDelivery Längen-Cap + 20/min-Throttle; O(n²)-cleanup de-nested; Poll-Fan-out 25er-Batches. Vorgänger **0.8.0** (2026-06-19) — `deliveryWindow` + `summary.deliveryWindow` werden jetzt auch aus den String-Feldern `date_expected`/`date_expected_end` gebaut (neuer geteilter `parseExpectedToMs`-Parser: lokale Komponenten, `hasTime`-Flag, Mitternacht/date-only = kein Fenster, mehrdeutige Carrier-Formate werden NICHT geraten → kein Fenster statt falschem Datum), nicht mehr nur aus `timestamp_expected/_end` — Carrier ohne Unix-Timestamp (Normalfall laut API) zeigen das Fenster nun. **Carrier-agnostisch** (`windowBoundsMs` liest `carrier_code` nicht), kein Amazon-Sonderweg; keine Regression (das Fenster nutzte seit dem ersten Release nur Epochs). Parser geteilt mit `computeDiffDays` (DRY). Aus In-Depth-Analyse Adapter↔API (12 Findings): `addDelivery` reicht `language`+`send_push_confirmation` durch, `description` Pflicht (API: required); `status_code:number` (API=int, parseStatus bleibt drift-tolerant); `error_code` entfernt (nicht Teil der API — ungültiger Key = HTTP-401); rohes Null-Byte in `rawIdKey` als Unicode-Escape ersetzt; JSDoc-Drift + Force-Poll-Kommentar (GET cached, 45–90 min) korrigiert. krobi-Entscheidungen: `event.additional` nicht aufgenommen, `TRACKABLE {2,4,8}` belassen, kein Event-Datum-Fallback. +8 Tests (242 unit), Live-Bestätigung deferred (kein Paket im Fenster-Zustand). API-Recherche: `Ressourcen/parcelapp/api-clients-und-feldformate.md`. Vorgänger **0.7.2** (2026-06-12) — Audit-Welle 2 (Hot-Path-Writes + ehrliche Coverage). **Event-Spam-Fixes:** (1) Device-`extendObjectAsync` lief bei JEDEM Poll (~1.440 Object-Writes/Tag bei 10 Paketen) → Signatur-Cache (`deviceWritten`, description+tracking), Write nur bei Änderung; (2) `lastUpdated` schrieb jeden Poll einen frischen ISO-Timestamp (1 garantiertes Event/Paket/Poll, hebelte v0.5.3-skip-unchanged aus) → `valuesSig`-Map, Schreiben nur wenn sich mindestens ein Sibling-Wert änderte. **Semantik jetzt:** „wann haben sich Tracking-Daten geändert", nicht „wann wurde gepollt". (3) `cleanupDeliveries`: Object-View nur 1× nach Start (Zombie-Reconcile), danach in-memory-Set (`knownDeliveryIds`, beszel-v0.7.2-Kostenmodell). **Hygiene:** totes `systemLang`-Feld raus (Debug-Log behauptete „using X", funktional lief alles über `resolveLanguage` im StateManager — Log zeigt jetzt die echte resolved Sprache); `getCarrierNames` In-Flight-Mutex (erste Poll mit N Paketen feuerte N parallele identische Fetches der statischen 447-Einträge-Datei; quell-verifiziert NICHT rate-limitiert → reine Effizienz); `addDelivery`-Message-Härtung (null/non-object → klare Validierungs-Meldung statt TypeError-über-catch); vitest `coverage.include` + eslint `coverage`-ignore. **Test-Welle:** Export + makeClient/makeStateManager-Seams ([[reference_orchestration_test_harness]]) + neue `src/main.test.ts` (44 Tests: classifyError-Matrix, onReady-Gates, onUnload, Throttle/Force/Rate-Limit-Interplay, autoRemove- vs. keep-Modus, Fehler-Dedup + cleanup-Ausschluss, Error-Routing inkl. Cooldown-Clamps, alle onMessage-Pfade) + 9 Regressionen (Device-Cache, lastUpdated-on-change, View-1×, Carrier-Mutex inkl. shared-failure). Coverage ehrlich 61,1 % (main.ts 0 %) → **95,8 %** (main.ts 93,3 %). 181→234 unit. Vorgänger **0.7.1** — date-only `date_expected` wird als LOKALE Mitternacht geparst (timezone-stabiler `deliveryEstimate`/`todayCount`; vorher via `new Date("YYYY-MM-DD")` = UTC-Mitternacht, kombiniert mit dem lokalen Tages-Diff → Off-by-one-Tag im Fallback-Pfad bei UTC-negativen Zeitzonen). Reachability unverifiziert (primärer `timestamp_expected`-Epoch-Pfad war immer TZ-sicher), Fix deckt zugleich den vorher TZ-fragilen Today-Boundary-Test ab. Vorgänger **0.7.0** (released 2026-06-07) optional Sentry → power-dreams. Vorgänger **0.6.0** (released 2026-05-31, in-depth audit — combined-window max-end fix, status-drift kept visible (`-1`/Unknown), addDelivery `force`-poll, process-handler removal + local poll guard, dead coerce exports removed, `apiError` helper, deterministic packageId pre-pass, parcel-client tests exercise the real `request()` + fix latent BODY_TOO_LARGE, repochecker action pin `@v2`). Vorgänger **0.5.3** memory/perf audit (setStateChangedAsync). **0.5.2** changelog rewrite. **0.5.1** CI Node 24. **0.5.0** Preserve + i18n migration. v0.4.9 community-standard handler. v0.4.8 NUT-Konsistenz. v0.4.7 cleanup. v0.4.6 instanceObjects i18n. v0.4.5 Toolchain-Parity.
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
src/main.ts              → Adapter (Polling, Lifecycle, sendTo-Handler, handlePollError, Pick<>-Seams)
src/lib/types.ts         → API-Interfaces + ApiErrorCode/ApiError (Fehler-Vertrag) + DELIVERED/UNKNOWN_STATUS_CODE
src/lib/coerce.ts        → errText, coerceFiniteNumber strict, coerceClampedInt, isTrueish, oneLine (inkl. NUL/U+2028)
src/lib/parcel-client.ts → HTTPS-Client (Node.js built-in); baseUrl-Seam (Tests), apiError (typisiert), 60s-Deadline, cancelled-Flag, RETRY_AFTER_*-Konstanten
src/lib/state-manager.ts → State CRUD + Cleanup + Berechnungen; createdIds/deviceEnsured-Caches; lastUpdated via setStateChangedAsync-notChanged
src/lib/i18n.ts          → tName/tText/statusLabel/packageName: type-safe Wrapper (keys aus admin/i18n/en.json; Status-Labels status_0…status_8)
../scripts/sync-iopackage-from-i18n.py → hält io-package.json:instanceObjects synchron mit admin/i18n (zentral, source: admin-i18n)
```

## Design-Entscheidungen

1. **Polling mit Guard** — `isPolling` Flag + `MIN_POLL_GAP_MS` (60s) Throttle
2. **autoRemoveDelivered** — true: API `active` + filter status 0; false: API `recent`, zugestellte bleiben
3. **Carrier-Cache** — Geladen beim ersten `getCarrierName()`, bei Fehler leere Map (Retry nächster Aufruf)
4. **Error-Dedup** — `classifyError()` + `lastErrorCode` (RATE_LIMITED, INVALID_API_KEY, NETWORK, TIMEOUT)
5. **Rate Limit** — Retry-After Header, Cooldown-Timer, Polls übersprungen
6. **sendTo** — `checkConnection` (Admin-Button, antwortet `{result}`/`{error}` — ConfigSendto-Kontrakt) und `addDelivery` (Script-API, antwortet `{success, error_message}` — dokumentiert, NICHT ändern). Nach erfolgreichem Add läuft ein normaler `poll()` — KEIN force mehr (v0.10.0): Einzel-Add pollt sofort (Gap >60s), Bursts kollabieren aufs 60s-Raster.
7. **pkgId** — `sanitize(tracking_number)` + optional `_sanitize(extra_information)`
8. **Sprache** — komplett über adapter-core `I18n` (init liest `system.config.language` selbst, Fallback en). Status-Texte via `statusLabel()` aus admin/i18n (`status_0…status_8`), Estimates via `tText()` mit `%s`-Args. Kein language-Feld mehr im StateManager, kein per-Instanz-Setting. Sprachwechsel wirkt auf State-WERTE nach Adapter-Neustart.
9. **Intermediate Objects** — `deliveries` (folder) + `summary` (channel) sind in io-package.json `instanceObjects` deklariert; `StateManager` legt nur die States darunter an.

## Status-Codes

0=Zugestellt, 1=Eingefroren, 2=Unterwegs, 3=Abholung, 4=In Zustellung, 5=Nicht gefunden, 6=Zustellversuch, 7=Ausnahme, 8=Registriert

Unparsebarer/driftender `status_code` → `-1` (`UNKNOWN_STATUS_CODE`): bleibt sichtbar (Aktiv-Filter ist `status !== 0`), rendert als „Unknown (-1)" — wird NICHT fälschlich als „zugestellt" versteckt und im autoRemove-Modus gelöscht.

## Tests (284 unit + 57 package + 1 integration = 342)

```
src/main.test.ts               → Orchestrierung: classifyError-Matrix (inkl. TIMEOUT/PARSE_ERROR/ABORTED, code-gewinnt-über-Message), onReady (Key-Validierung/happy/L4-terminate/L2-unload-Race/obsolete-cleanup), onUnload, Poll (in-flight-guard MIT debug, 60s-Gap ohne force, Rate-Limit-Cooldown, autoRemove/keep, M10-Batch-Pairing 30 Deliveries, M2 cleanup-Fehler ≠ connection-false, Fehler-Dedup M3 inkl. 429/401-Wiederholung→debug, ABORTED→debug, Keep-Set), onMessage komplett (checkConnection {result}/{error} H1, addDelivery inkl. L24-language-Cap, L25-Fenster-Ablauf, L9-Drift-success, L5-Gap, throw-Pfade je Envelope). Stub Adapter-base + injected makeClient/makeStateManager (Pick<>-kompatibel, drift-treue Fakes L21)
src/lib/coerce.test.ts         → errText, coerceFiniteNumber strict, coerceClampedInt, isTrueish, oneLine inkl. NUL/VT/FF/U+2028/29 (I10)
src/lib/parcel-client.test.ts  → echte request() gegen lokalen HTTP-Mock-Server: Transport-Härtung (abort→ABORTED, cancelled-Flag terminal L3, retry-after clamp, oversize, URL), PARSE_ERROR + Body-NICHT-in-Message (L26), API-drift (String UND Objekt L22, error_message-Sanitizing M6), Carrier-Mutex
src/lib/state-manager.test.ts  → Deliveries, summary, cleanup (inkl. 30er-Batch-Delete I2), formatting (inkl. end==start L23), API-drift, Status-Labels aus i18nData (echte Dateien), lokalisierter Fallback-Name L18, translation-objects, createdIds-Cache, deviceEnsured-once (DP-5), lastUpdated notChanged-basiert inkl. RESTART-Regression (M5), View-1×-Modell
src/lib/i18n.test.ts           → tName/tText/statusLabel/packageName-Delegation + i18n-Vollständigkeit (11 Sprachen, identische Keysets, status_*/packageName-Keys)
vitest.config.ts               → globals: true, coverage.include src/**/*.ts (ehrliche Headline), pool: forks
test/package.js                → @iobroker/testing packageFiles (mocha)
test/integration.js            → @iobroker/testing integration (mocha)
test/tsconfig.json             → Editor-Support für integration.js/package.js (läuft in KEINEM Gate — npm run check prüft nur src/)
```

Run: `npm test` (vitest unit + mocha @iobroker/testing packageFiles). CI: `test:unit`-Alias triggert die vitest-Suite in testing-action-adapter@v1 (H2).

## Versionshistorie (letzte 7)

| Version | Highlights                                                                                                                                                                                              |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.9.0 | **Datenverlust-Cluster gefixt:** keep-set = alle API-pkgIds (transienter Write-Fehler löscht kein präsentes Paket mehr); falsch-getypte `deliveries` → throw, null/absent = leer; Mehrtages-Fenster mit Datum beidseitig; oneLine-Sanitizer; addDelivery-Caps (512 Zeichen, 20/min); Batch-Fan-out 25. |
| 0.8.0 | Delivery window now also derived from the string fields `date_expected`/`date_expected_end` (shared local `parseExpectedToMs`; midnight/date-only = no window; ambiguous formats not guessed), not only Unix timestamps — carriers without an epoch now show a window (carrier-agnostic, no Amazon special case). `addDelivery` passes `language`/`send_push_confirmation`, `description` required; `status_code:number`; `error_code` removed (HTTP-401 is the detector); raw NUL-byte in `rawIdKey` escaped; JSDoc + force-poll comments fixed. In-depth API analysis (12 findings). |
| 0.7.2 | Audit-Welle 2: Device-Objekt-Write nur bei Änderung (vorher jeden Poll), `lastUpdated` nur bei Daten-Änderung (Semantik: „Daten geändert" statt „gepollt"; killt 1 Pflicht-Event/Paket/Poll), cleanupDeliveries View nur 1×/Start, Carrier-Fetch-Mutex, addDelivery-Message-Härtung, totes systemLang-Feld raus. 53 neue Tests (main.ts-Orchestrierung via Seams), Coverage ehrlich 61→95,8 %. |
| 0.7.1 | Timezone-stable delivery estimates: a calendar-date-only `date_expected` is now read as a local day, fixing a one-day-early estimate in UTC-negative zones (fallback path; the primary timestamp path was always safe). |
| 0.7.0 | Optional Sentry error reporting (`common.plugins.sentry` → eigener power-dreams-Sentry; README-Badge + `## Sentry`-Abschnitt). |
| 0.6.0   | **In-depth audit**: combined-window max-end fix (+nested-window test); status-drift kept visible (`-1`/Unknown) instead of hidden as delivered; addDelivery `force`-poll bypasses the 60s throttle; process-level handlers removed + local poll guard; `apiError` helper + deterministic packageId pre-pass; parcel-client tests exercise the real `request()` (fixed latent BODY_TOO_LARGE); dead coerce exports + unused interface fields removed; repochecker action pin `@v2`. |
| 0.5.3   | Memory/Perf-Audit: `setStateAsync`→`setStateChangedAsync` in state-manager `createAndSet` + main.ts `info.connection`. |

## Befehle

```bash
npm run build        # Production (esbuild)
npm test             # vitest run (284 unit) + mocha (57 package)
npm run lint         # ESLint + Prettier
npm run check        # tsc --noEmit (TS 6)
npm run coverage     # vitest coverage report
```
