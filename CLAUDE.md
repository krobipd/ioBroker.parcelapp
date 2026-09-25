# CLAUDE.md — ioBroker.parcelapp

> Gemeinsame ioBroker-Wissensbasis: `../CLAUDE.md` (lokal, nicht im Git). Standards dort, Projekt-Spezifisches hier.

## Projekt

**ioBroker Parcel Tracking Adapter** — Paketverfolgung über [parcel.app](https://parcelapp.net) API. Alle Carrier die parcel.app unterstützt, ein API-Key (Premium).

- **Version + Changelog:** aktuelle Version in `io-package.json`; interne Entwicklungsgeschichte samt Belegen in `.claude/dev-history.md` (lokal, nicht geladen). Nutzer-Changelog: `README.md` + `io-package.json` news.
- **GitHub:** https://github.com/krobipd/ioBroker.parcelapp
- **npm:** https://www.npmjs.com/package/iobroker.parcelapp
- **Repository PR:** ioBroker/ioBroker.repositories#5667 (MERGED 2026-05-10) — im Latest- und Stable-Repo
- **Runtime-Deps:** nur `@iobroker/adapter-core` (HTTPS über Node.js built-in)
- **Test-Setup:** vitest 5 (`src/**/*.test.ts`, globals), Paket-Tests über mocha/`@iobroker/testing` getrennt
- **`@types/node` + `@tsconfig/nodeXX` an `engines.node`-Min gekoppelt** (`>=22`); Dependabot ignoriert Major-Bumps.

## API

- **Base URL:** `https://api.parcel.app/external/` · **Auth:** Header `api-key: <key>` (Premium-Abo nötig)
- **Rate Limits:** GET 20/Stunde, POST 20/Tag (fehlgeschlagene zählen mit) · **Doku:** https://parcelapp.net/help/api.html
- **Kein DELETE-Endpoint** — nur über parcel.app UI löschbar
- **`supported_carriers.json` ist ÖFFENTLICH** (kein `api-key`, kein Rate-Limit) und liefert seit 2026 **Objekte** `{ "dhl": { "name", "extra_required"?, "name_variations"? } }`; der Client liest auch die alte Flach-Form. Aufzeichnung mit Datum: `test/fixtures/supported_carriers-*.json`.
- **`add-delivery/` kennt `postcode` und `email`** (offizielle, optionale Felder); keine Vorprüfung gegen `extra_required` — parcel.app antwortet selbst, der Fehlertext aus dem Body erreicht den Aufrufer.
- **Datumsformen (Recherche 2026-09-25, `Ressourcen/parcelapp/api-referenz.md`):** `date_expected[_end]` real nur `YYYY-MM-DD HH:MM:SS`; `events[].date` in der Sprache der Sendung, mit Jahr, UPS-Punktform Monat zuerst, Wochentagsform ohne Jahr.

## Architektur

```
src/main.ts              → Adapter: Lifecycle, Poll (GET-Ledger, Auth-Backoff, Log-Stufen), sendTo-Handler (checkConnection, addDelivery mit Tagesgrenze), handlePollError, updateDeliveries (Batch-Fan-out), Mitternachts-Timer, correctInstanceObject, refreshManifestObjects, Pick<>-Seams
src/lib/types.ts         → API-Interfaces + ApiErrorCode/ApiError + DELIVERED/UNKNOWN_STATUS_CODE
src/lib/coerce.ts        → errText (Flotten-Masterform), oneLine, LOG_SNIPPET_LEN, coerceFiniteNumber strict, coerceClampedInt, isTrueish
src/lib/parcel-client.ts → HTTPS-Client: Timer-Naht (2. Parameter), baseUrl-/Timeout-Seams, Retry-After (Zahl oder HTTP-Datum, eine Klemme), Carrier-Liste mit Tages-Auffrischung, API-Drift-Wächter an der Grenze
src/lib/package-id.ts    → reine Id-Regel ohne adapter-core: sanitize, identityOf, rawIdKey, suffixKey, shortHash, idCandidates, candidateIndex — `test/inventory.js` lädt sie aus `build/`
src/lib/state-manager.ts → Broker-Arbeit: Objekte per extendObject, Kennungs-Besitz (idOwner, presentKeys, storedIdentity), loadExisting, lastUpdated über tracksChange + notChanged, refreshDerived, Cleanup
src/lib/delivery-view.ts → reine Darstellung: Datumsparser (parseDateParts + Gründe), Tagesbereich, Ereignisdatum (15 App-Sprachen), Fenster, Schätzung, Gesamtfenster
src/lib/device-icons.ts  → Carrier-Piktogramme: Karte `carrier_code` → Datei in `admin/icons/`, Inline-URI, Cache je Datei
src/lib/native-key-migration.ts → Flotten-Master (byte-gleich, samt Test): nullt verwaiste native-Schlüssel beim Start
src/lib/i18n.ts          → tName/tText/statusLabel/packageName/KNOWN_STATUS_CODES (Schlüssel aus admin/i18n/en.json)
test/inventory.js        → Objekt-Inventar aus Fixtures (Herkunft im Kopf) + Werte-Prüfungen; ⚠️ vorher `npm run build`
test/self-explaining.json → Beschreibungs-Entscheidung für D08 und den desc-Test — nie eine zweite Liste
docs/en/ + docs/de/      → Nutzerdoku (README/scripting/faq), nicht im npm-Paket
```

## Design-Entscheidungen

_Jede Entscheidung steht hier als Regel-Satz; Beleg, Messung und Verlauf stehen in `.claude/dev-history.md`._

1. **Polling mit Guard** — `isPolling` + 60-s-Abstand; die Mitternachts-Auffrischung nimmt denselben Riegel.
2. **autoRemoveDelivered** — true: API `active` + Filter Status 0; false: API `recent`, zugestellte bleiben.
3. **Carrier-Liste** — ein Tag Gültigkeit, Auffrischen führt ZUSAMMEN (entfernte Codes behalten ihren Namen), Fehlschlag mit Cache wartet eine Stunde, eine Karte ohne brauchbaren Eintrag wird nie gecacht.
4. **Fehler-Entprellung** — `classifyError()` + `lastErrorCode`; Netz/Zeitüberschreitung sind ein Zustand (nur debug), alles zum Handeln einmal warn, Wiederholung debug; error nur „kein API-Key".
5. **Anfrage-Budgets im Adapter** — gleitende Stunde aller GETs mit dem eigenen Schlüssel (Eintrag vor dem await), Folge-Poll nach addDelivery höchstens einmal je Intervall, addDelivery höchstens 20 je 24 h.
6. **Auth-Backoff in Ticks** — nach der n-ten Ablehnung in Folge 2^(n-1)−1 reguläre Ticks aussetzen (max. 6 h), gezählt in Ticks statt Uhrzeit, damit die GET-Dauer keinen Versuch verschiebt.
7. **sendTo** — `checkConnection` antwortet `{result}`/`{error}` (Admin-Kontrakt), `addDelivery` `{success, error_message}` (dokumentiert, NICHT ändern) und läuft auch ohne Rückruf (Ergebnis auf info).
8. **Kennung aus package-id.ts** — Kandidatenkette nackt → Anhang ohne Carrier (Bestand v0.13) → Anhang mit Carrier → `_n`; Besitz bleibt über Polls und Neustarts (`native.identity`), Übernahme nur durch dieselbe Sendung.
9. **Datum** — erwartetes Datum nur mit Jahr (Mehrdeutiges nie geraten, jede Ablehnung eine Drift-Zeile); ein Bereich zählt jeden Tag als heute; Status 4 mit altem/ohne Datum ist heute bei Scan von heute.
10. **`lastUpdated` folgt der Sendung** — nur Zeilen mit `tracksChange` zählen (nicht carrier, status, deliveryEstimate); ein neuer Carrier-CODE stempelt, erst wenn eine gespeicherte Identität vorliegt.
11. **Mitternachts-Auffrischung** — Timer auf lokale 00:00:05 rechnet Schätzung und Summe aus dem letzten Poll neu, ohne GET, Pakete mit gescheitertem Schreibvorgang ausgelassen.
12. **Strikter Status-Parser** — ein String muss eine ganze Zahl sein, sonst −1 (nie „0abc" = zugestellt); eine Zahl wird abgeschnitten; `statusCode.common.states` als reine Strings (React #31).
13. **Sprache** — alles über adapter-core `I18n` (Systemsprache, Fallback en); Sprachwechsel wirkt auf Werte nach Neustart.
14. **`supportedMessages` ist als GANZES verboten** — `correctInstanceObject()` löscht den Schlüssel (nie `{stopInstance:false}`); verwaiste `native`-Schlüssel (`filterMode`, `language`) nullt der Flotten-Helfer `native-key-migration.ts` (`{ drop }`, Master-Kopie byte-gleich), keine eigene Bereinigung daneben.
15. **Objekt-Schreibvorgang nie hinter der Bedingung des Wertes** — `ensureStateObject()` läuft bedingungslos, nur der Wert von `lastUpdated` hat eine Bedingung.
16. **Objekt-Texte erreichen bestehende Anlagen** — `extendObject` statt `setObjectNotExists`, `refreshManifestObjects()` mit ausgeschriebenen Kennungen.
17. **`common.desc` = Erklärung, sonst leer** — Entscheidung gehört D08 über `test/self-explaining.json`.
18. **Der Gerätename gehört dem Adapter** — kein `preserve`; der Name ist die parcel.app-Beschreibung.
19. **Carrier-Piktogramm über den CODE** — Inline-URI nach Flotten-Rezept, Eingang und Teil der Signatur von `writeDeviceObject`; FedEx/InPost-Monogramme abgenommen 2026-09-25.
20. **Timer nur über den Adapter** — auch die Frist im Client läuft über die injizierte Timer-Naht (`this.setTimeout`); ihre Felder sind Funktions-Eigenschaften, weil der Repochecker (S5005) `setTimeout(` in einer Methodensignatur als nackten Timer wertet.
21. **Startfehler endet mit `UNCAUGHT_EXCEPTION`** — nur dieser Exit-Code zählt im js-controller als Absturz (`crashCount`); ein anderer startet die Instanz jede Sekunde ohne Schleifenschutz neu.

## Status-Codes

0=Zugestellt, 1=Eingefroren, 2=Unterwegs, 3=Abholung, 4=In Zustellung, 5=Nicht gefunden, 6=Zustellversuch, 7=Ausnahme, 8=Registriert; unlesbar → −1 (`UNKNOWN_STATUS_CODE`), bleibt sichtbar.

## Tests

Drei Ebenen: **vitest** (`src/**/*.test.ts`) · **Paket-Prüfung** (mocha, `@iobroker/testing` packageFiles) · **Integration** (Boot ohne Schlüssel); der Betriebspfad läuft über `test:inventory` (CI-Job `adapter-inventory`). Zahlen nie pinnen.

- **Ein Test muss FALLEN können** — Nadeltabelle `Ressourcen/iobroker-entwicklung/mutation-testing/mutations_parcelapp_2026-09-02.py`, nach Umbauten zuerst `--check`.
- **„Erreicht bestehende Anlagen" nur mit VORHANDENEM Objekt testen**; die Attrappe ehrt `preserve` und `recursive`.
- **`objectWrites` zählt jeden Objekt-Schreibvorgang** — Gerät nur über `countDeviceWrites`.
- **Broker ≠ API im Poll** — jeder Broker-Schreibvorgang in `poll()` hat einen eigenen Fang (warn, „API connection is fine").
- **vitest 5: `clearMocks` ist Vorgabe `true`** — bewusst nicht festgenagelt, die Nadeltabelle sichert ab.
- **Die Uhr steht** (`FIXED_NOW`, Mitte Juni) — wer `lastUpdated` testet, stellt sie bewusst vor.
- **`parcel-client.test.ts` ohne Keep-Alive**; Zeitgrenzen und Timer injizierbar; kein Unit-Test geht ins echte Netz.
- **prettier-sauber halten** — Ausschlüsse nur `build/`, `io-package.json`, `.github/dependabot.yml`.
