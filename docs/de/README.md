# ioBroker.parcelapp — Nutzerdokumentation

Verfolgt Sendungen aller Zusteller, die [parcel.app](https://parcelapp.net) unterstützt, mit einem
einzigen API-Schlüssel. Der Adapter fragt dein parcel.app-Konto ab und bildet jede Sendung im
ioBroker-Objektbaum ab.

Kapitel: **diese Seite** · [Skripte und Automatisierung](scripting.md) · [Häufige Fragen](faq.md)

---

## Voraussetzung

Du brauchst ein **parcel.app-Premium-Abo**. Die API ist eine Premium-Funktion — ohne sie beantwortet
parcel.app jede Anfrage mit HTTP 403 und der Adapter kann nichts lesen. Der Adapter legt kein Konto
an und verwaltet keines; er liest nur (und fügt auf Wunsch Sendungen hinzu).

Der Adapter spricht nicht selbst mit den Zustellern. Alles, was in ioBroker erscheint, ist das, was
parcel.app über eine Sendung weiß — einen Zusteller, den parcel.app nicht erreicht, erreicht auch
dieser Adapter nicht.

---

## Einrichtung

### 1. API-Schlüssel holen

1. [web.parcelapp.net](https://web.parcelapp.net) öffnen und mit dem parcel.app-Konto anmelden.
2. Den Bereich **API** öffnen.
3. Den Schlüssel kopieren. Er ist eine lange Zeichenkette — vollständig kopieren, ohne Leerzeichen
   davor oder dahinter.

### 2. Instanz anlegen

In ioBroker unter **Adapter** nach `parcelapp` suchen und eine Instanz hinzufügen. Der
Konfigurationsdialog öffnet sich von selbst.

### 3. Einstellungen ausfüllen

| Einstellung                                  | Wirkung                                                                                                                                                                                                                            |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **API-Schlüssel**                            | Der Schlüssel aus Schritt 1. Er wird verschlüsselt im Instanz-Objekt gespeichert und niemals ins Log geschrieben.                                                                                                                  |
| **Abfrageintervall**                         | Wie oft der Adapter parcel.app nach Neuigkeiten fragt, in Minuten (5–60, Vorgabe 10).                                                                                                                                              |
| **Zugestellte Pakete automatisch entfernen** | Ein: eine zugestellte Sendung verschwindet aus dem Objektbaum. Aus: sie bleibt mit dem Status _Zugestellt_ stehen, solange parcel.app sie liefert — der Adapter entfernt eine Sendung nur, wenn die API sie nicht mehr zurückgibt. |

### 4. Verbindung testen

Die Schaltfläche **Verbindung testen** führt eine echte Anfrage aus und meldet das tatsächliche
Ergebnis — ein falscher Schlüssel, ein abgelaufenes Abo oder ein Netzwerkproblem werden benannt und
nicht hinter einem grünen „Ok" versteckt. Danach speichern; die Instanz startet und die erste
Abfrage folgt sofort.

> Hinweis: der Test verbraucht dasselbe Anfragebudget wie das Abfragen (20 Anfragen pro Stunde). Der
> Adapter zählt mit: ist das Stundenbudget verbraucht, sagt der Knopf das, statt parcel.app zu fragen.

### Das richtige Abfrageintervall

parcel.app selbst liegt laut eigener FAQ im Schnitt **45 und höchstens etwa 90 Minuten** hinter
der Website des Zustellers. Ein kürzeres Intervall macht die Sendungsdaten deshalb nicht frischer —
es verkürzt nur die Zeit zwischen dem, was parcel.app erfährt, und dem Bemerken in ioBroker. Die
Vorgabe von 10 Minuten ist ein guter Kompromiss; unter 5 Minuten wäre das Stundenbudget gesprengt
und wird abgelehnt.

---

## Was im Objektbaum entsteht

```
parcelapp.0.
├── info.connection              Verbindung zur parcel.app-API
├── summary.
│   ├── activeCount              Noch nicht zugestellte Sendungen
│   ├── todayCount               Heute erwartete Sendungen
│   └── deliveryWindow           Gemeinsames Fenster der heutigen Sendungen
└── deliveries.
    └── <Paketkennung>.          Ein Gerät je Sendung
        ├── carrier
        ├── status
        ├── statusCode
        ├── description
        ├── trackingNumber
        ├── extraInfo
        ├── deliveryWindow
        ├── deliveryEstimate
        ├── lastEvent
        ├── lastLocation
        └── lastUpdated
```

### Verbindung

| Datenpunkt        | Typ     | Bedeutung                                                                                                                                                       |
| ----------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `info.connection` | boolean | Wahr, solange der Adapter die parcel.app-API erreicht. Ein kurzer Aussetzer der ioBroker-Datenbank färbt ihn **nicht** rot — nur ein echter API-Fehler tut das. |

### Zusammenfassung

| Datenpunkt               | Typ    | Bedeutung                                                                                                                                                                     |
| ------------------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `summary.activeCount`    | number | Sendungen, die noch nicht zugestellt sind.                                                                                                                                    |
| `summary.todayCount`     | number | Sendungen, deren voraussichtliches Zustelldatum heute ist.                                                                                                                    |
| `summary.deliveryWindow` | string | Das gemeinsame Fenster aller heute erwarteten Sendungen: frühester Beginn bis spätestes Ende, z. B. `09:15 - 18:30`. Leer, wenn keine Sendung ein brauchbares Fenster meldet. |

Die Zusammenfassungswerte werden beim Stoppen der Instanz **nicht** zurückgesetzt. Die Zahl der
unterwegs befindlichen Sendungen ändert sich nicht dadurch, dass niemand hinsieht.

### Je Sendung

Jede Sendung wird ein **Gerät** unterhalb von `deliveries.`. Der Gerätename ist die Beschreibung,
die du der Sendung in parcel.app gegeben hast, und folgt ihr: änderst du sie dort, wird das Gerät
bei der nächsten Abfrage umbenannt. Der Name gehört dem Adapter — eine Umbenennung im
ioBroker-Admin hält also nicht; für eine eigene Bezeichnung nimm einen Alias oder einen Datenpunkt
in `0_userdata`.

Jede Sendung trägt im Objektbaum außerdem das **Zeichen ihres Zustellers**, damit du siehst, wer
liefert, bevor du den Namen liest: DHL, Deutsche Post, Hermes/Evri, DPD, GLS, UPS, Amazon, USPS,
TNT, FedEx, InPost, Apple, Vinted und DoorDash haben ihr eigenes Zeichen, nationale
Postgesellschaften und ihre Express-Töchter einen Briefumschlag, alle übrigen Zusteller einen
Lieferwagen. Die Zeichen sind einfarbig gezeichnet und folgen deinem Admin-Thema.

| Datenpunkt         | Typ    | Bedeutung                                                                                                                                                                                                                                                                                                                                                      |
| ------------------ | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `carrier`          | string | Anzeigename des Zustellers (z. B. `DHL Express`). Ersatzweise das Zustellerkürzel in Großbuchstaben, wenn parcel.app keinen Namen kennt.                                                                                                                                                                                                                       |
| `status`           | string | Der Status als lesbarer Text, in deiner ioBroker-Systemsprache.                                                                                                                                                                                                                                                                                                |
| `statusCode`       | number | Der Status als Zahl — **das ist der Datenpunkt für Skripte**, weil er sich nicht mit der Sprache ändert. Der Admin zeigt die Bedeutung jedes Codes daneben. Siehe Tabelle unten.                                                                                                                                                                               |
| `description`      | string | Die Beschreibung aus parcel.app. Anders als der Gerätename zeigt sie immer den aktuellen Wert.                                                                                                                                                                                                                                                                 |
| `trackingNumber`   | string | Die Sendungsnummer.                                                                                                                                                                                                                                                                                                                                            |
| `extraInfo`        | string | Zusatzangabe, die der Zusteller benötigt, etwa Postleitzahl oder E-Mail-Adresse. Bei den meisten Sendungen leer.                                                                                                                                                                                                                                               |
| `deliveryWindow`   | string | Erwartetes Zustellfenster, z. B. `14:00 - 16:00`. Ein über mehrere Tage reichendes Fenster trägt auf beiden Seiten das Datum (`12-06 14:30 - 12-08 18:30`). Leer, wenn kein brauchbares Fenster vorliegt — entweder meldet der Zusteller keins, oder er meldet ein Datum in einem Format, das der Adapter nicht liest (eine Debug-Zeile nennt dann den Wert).  |
| `deliveryEstimate` | string | Dieselbe Information in Worten: _heute_, _morgen_, _in 3 Tagen_, _überfällig_. In der Systemsprache. Jeder Tag eines gemeldeten Bereichs gilt als _heute_; der Wert rückt direkt nach Mitternacht weiter, ohne Anfrage.                                                                                                                                        |
| `lastEvent`        | string | Die jüngste Sendungsmeldung mit Datum, z. B. `Im Zustellstützpunkt eingetroffen - 2026-09-02`.                                                                                                                                                                                                                                                                 |
| `lastLocation`     | string | Wo diese Meldung entstanden ist, sofern der Zusteller einen Ort nennt.                                                                                                                                                                                                                                                                                         |
| `lastUpdated`      | string | Wann sich die Sendungsdaten zuletzt **geändert** haben — nicht, wann der Adapter zuletzt abgefragt hat. Eine Sendung, die zwei Tage stillsteht, behält einen zwei Tage alten Zeitstempel; das ist so gewollt. Eine weiterrückende Schätzung, ein neuer Anzeigename des Zustellers oder eine andere Systemsprache zählen nicht; ein neuer Zusteller-Code schon. |

### Status-Codes

| Code | Bedeutung           | Code | Bedeutung                     |
| ---- | ------------------- | ---- | ----------------------------- |
| 0    | Zugestellt          | 5    | Nicht gefunden                |
| 1    | Eingefroren         | 6    | Zustellversuch fehlgeschlagen |
| 2    | Unterwegs           | 7    | Ausnahme                      |
| 3    | Zur Abholung bereit | 8    | Registriert                   |
| 4    | In Zustellung       | -1   | Unbekannt                     |

`-1` ist kein parcel.app-Status. Der Adapter verwendet ihn, wenn parcel.app einen Statuswert
schickt, den er nicht deuten kann — etwa weil dort ein neuer Code eingeführt wurde. Eine solche
Sendung bleibt bewusst **sichtbar**, statt als „zugestellt" missverstanden und still entfernt zu
werden.

Nur Sendungen im Status 2, 4 und 8 können ein voraussichtliches Zustelldatum haben; bei allen
anderen sind `deliveryWindow` und `deliveryEstimate` deshalb leer.

Eine Sendung im Status 4 (_In Zustellung_) zählt als **heute**, auch wenn der Zusteller kein
voraussichtliches Datum meldet — sofern die letzte Erfassung von heute ist, denn dann ist sie im
Fahrzeug. `deliveryEstimate` sagt dann _heute_ und die Sendung zählt in `summary.todayCount`,
während `deliveryWindow` leer bleibt: es gibt keine Uhrzeit zu zeigen.

---

## Sprache

Jeder Text, den der Adapter schreibt — Statusbezeichnungen, Zustellprognosen, Objektnamen und
Beschreibungen — folgt der **ioBroker-Systemsprache** (_Systemeinstellungen → Sprache_). Es gibt
keine Spracheinstellung je Instanz. Ein Sprachwechsel wirkt bei den Objektnamen sofort und bei den
Zustandswerten nach dem nächsten Adapter-Neustart.

---

## Sendungen löschen

Die parcel.app-API hat keinen Lösch-Endpunkt, der Adapter **kann** eine Sendung also nicht aus
deinem parcel.app-Konto entfernen. Lösche sie in der parcel.app-App oder im Web, dann verschwindet
sie mit der nächsten Abfrage auch aus ioBroker.

Was der Adapter tut: bei eingeschaltetem _Zugestellte Pakete automatisch entfernen_ verschwinden
eine zugestellte Sendung und alle ihre Datenpunkte aus dem Objektbaum — die Sendung selbst bleibt in
deinem parcel.app-Konto.
