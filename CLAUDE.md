# CLAUDE.md — ioBroker.parcelapp

> Gemeinsame ioBroker-Wissensbasis: `../CLAUDE.md` (lokal, nicht im Git). Standards dort, Projekt-Spezifisches hier.

## Projekt

**ioBroker Parcel Tracking Adapter** — Paketverfolgung über [parcel.app](https://parcelapp.net) API. Alle Carrier die parcel.app unterstützt, ein API-Key (Premium).

- **Version + Changelog:** current version in `io-package.json`; full internal dev history moved to `.claude/dev-history.md` (local, not auto-loaded). User-facing changelog: `README.md` + `io-package.json` news.
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
src/lib/parcel-client.ts → HTTPS-Client (Node.js built-in); baseUrl- + Timeout-Seams (Tests), apiError (typisiert), 15s-Leerlauf + 60s-Deadline, cancelled-Flag, RETRY_AFTER_*-Konstanten
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

## Tests (310 unit + 57 package + 1 integration = 368)

Run: `npm test` (vitest unit + mocha @iobroker/testing packageFiles). CI: `test:unit`-Alias triggert die vitest-Suite in testing-action-adapter@v1 (H2). Abdeckung 99,3 % Statements / 97,0 % Branches.

**Konventionen der Suite (aus dem Test-Audit 2026-08-22 — `Ressourcen/parcelapp/test-audit-2026-08-22.md`):**
- **Ein Test muss FALLEN können.** Der Audit fand drei Tests, die eine Regel nur scheinbar prüften. Neue Tests werden per **Mutation** gegengeprüft: Regel im Quellcode kaputtmachen → der Test MUSS rot werden. Das Protokoll der 12 belegten Mutationen steht im Audit-Report.
- **`state-manager.test.ts` friert die Uhr** (`FIXED_NOW`, Mitte Juni, mittags — kein Sommerzeit-Wechsel, keine Monatsgrenze). Wer `lastUpdated`-Verhalten testet, muss die Uhr **bewusst vorstellen**: zwei Polls in derselben Millisekunde erzeugen denselben Zeitstempel, und dann meldet der Broker-Mock „unverändert" — ein kaputtes Verhalten sähe identisch aus.
- **`parcel-client.test.ts` schaltet die Verbindungswiederverwendung ab** (`globalAgent.keepAlive = false` + `destroy()` nach jedem Test). Sonst kann ein Aufruf einen Socket erwischen, den der Wegwerf-Server gerade geschlossen hat → falsch-rot (einmal live passiert, 2026-08-21).
- **Zeitgrenzen sind injizierbar** (`ParcelClientTimeouts`, 4. Konstruktor-Parameter): Leerlauf-Abbruch und harte Zeitgrenze laufen im Test mit Millisekunden statt 15/60 Sekunden. Produktiv immer die Vorgabewerte.
- **Kein Unit-Test geht ins echte Netz** — alles gegen lokale Wegwerf-Server; die produktiven Fabriken werden direkt aufgerufen, nie über `onReady`.
- **`npm run format` NICHT blind fahren** — der committete Stand ist nicht prettier-CLI-sauber (13 Dateien schon vor jeder Änderung), das echte Gate ist `npm run lint`.

## Befehle

```bash
npm run build        # Production (esbuild)
npm test             # vitest run (310 unit) + mocha (57 package)
npm run lint         # ESLint + Prettier
npm run check        # tsc --noEmit (TS 6)
npm run coverage     # vitest coverage report
```
