# Häufige Fragen

Kapitel: [Hauptseite](README.md) · [Skripte und Automatisierung](scripting.md) · **diese Seite**

---

## Anfragegrenzen

parcel.app erzwingt zwei Grenzen je API-Schlüssel:

| Vorgang                     | Grenze            | Wer verbraucht sie                                   |
| --------------------------- | ----------------- | ---------------------------------------------------- |
| GET (Sendungen lesen)       | **20 pro Stunde** | jede Abfrage und jeder Klick auf _Verbindung testen_ |
| POST (Sendungen hinzufügen) | **20 pro Tag**    | jedes `addDelivery` — auch die fehlgeschlagenen      |

Deshalb kann das Abfrageintervall nicht unter 5 Minuten gehen: 12 Abfragen pro Stunde lassen Luft
für ein paar Verbindungstests. Ein fehlgeschlagenes `addDelivery` zählt trotzdem gegen das
Tagesbudget — ein Skript, das ein falsches `carrier_code` in einer Schleife wiederholt, verbraucht
also den ganzen Tag.

Antwortet parcel.app mit einem Anfragegrenzen-Fehler, pausiert der Adapter seine Anfragen für die
vom Server verlangte Abkühlzeit (mindestens eine Minute, höchstens ein Tag) und schreibt eine
Warnung. Er klopft nicht weiter an.

## Der Verbindungstest sagt, der Schlüssel sei in Ordnung, aber es erscheint nichts

Am wahrscheinlichsten gibt es nichts zu zeigen: bei eingeschaltetem _Zugestellte Pakete automatisch
entfernen_ listet der Adapter nur Sendungen, die **nicht** zugestellt sind. Wenn alles in deinem
Konto angekommen ist, sind null Sendungen das richtige Ergebnis und `info.connection` bleibt grün.

Andernfalls hilft das Log auf Stufe „debug" — der Adapter protokolliert dort jede Anfrage, ihren
Statuscode und die Zahl der empfangenen Sendungen.

## Ich habe eine Sendung hinzugefügt und sie hat keine Sendungsdaten

Gib ihr 45 bis 90 Minuten. parcel.app liefert die Sendungsliste aus einem serverseitigen
Zwischenspeicher und braucht so lange, bis eine frisch hinzugefügte Sendung Ereignisse trägt. Der
Adapter kann das nicht verkürzen; häufigeres Abfragen verbrennt nur das Anfragebudget.

## Eine Sendung zeigt „Unbekannt (-1)"

parcel.app hat einen Statuswert geschickt, den der Adapter nicht deuten konnte — vermutlich einen
dort neu eingeführten Statuscode. Die Sendung bleibt bewusst sichtbar, statt als zugestellt behandelt
und entfernt zu werden. Sobald der Adapter den neuen Code kennt, wird sie wieder richtig angezeigt;
die Sendungsdaten selbst sind davon nicht betroffen.

## Eine Sendung ist aus dem Objektbaum verschwunden

Drei mögliche Gründe, nach Wahrscheinlichkeit:

1. Sie wurde zugestellt und _Zugestellte Pakete automatisch entfernen_ ist eingeschaltet. Dann tut
   die Einstellung genau ihre Arbeit.
2. Du hast die Sendung in parcel.app gelöscht. Der Adapter bildet dein Konto ab und folgt.
3. parcel.app liefert sie nicht mehr aus. Der Adapter entfernt eine Sendung nur, wenn die API sie
   nicht mehr listet — ein vorübergehender Fehler oder eine fehlerhafte Antwort löscht nie etwas.

Eine Sendung wird **nie** entfernt, weil ein einzelner Schreibvorgang fehlgeschlagen ist. Das war
einmal ein echter Defekt und ist seit v0.9.0 abgesichert.

## Kann ich eine Sendung aus ioBroker heraus löschen?

Nein. Die parcel.app-API hat keinen Lösch-Endpunkt — löschen geht nur in der parcel.app-App oder im
Web. Die ioBroker-Datenpunkte von Hand zu löschen hilft ebenfalls nicht: die nächste Abfrage legt
sie wieder an, solange parcel.app die Sendung noch liefert.

## Warum ist `lastUpdated` alt, obwohl der Adapter abfragt?

Weil es „die Sendungsdaten haben sich zuletzt geändert" bedeutet und nicht „der Adapter hat zuletzt
abgefragt". Eine Sendung, die übers Wochenende im Depot liegt, behält einen wochenendalten
Zeitstempel — das ist die nützliche Lesart. Ob der Adapter lebt, sagt `info.connection`.

## Die Verbindungsanzeige war kurz rot

Nur ein echter Fehler der parcel.app-API färbt `info.connection` rot. Ein Aussetzer der
ioBroker-Datenbank während des Schreibens tut das nicht — er erscheint als
`State maintenance failed (API connection is fine, retrying next poll)` auf Warnstufe, und die
Anzeige bleibt grün.

War die Anzeige wirklich rot, nennt die Logzeile davor den Grund: ein ungültiger Schlüssel
(HTTP 401), ein Abo-Problem (HTTP 403), eine Anfragegrenze (HTTP 429), eine Zeitüberschreitung oder
ein Netzwerkfehler. Wiederholt gleiche Fehler werden einmal gemeldet und danach nur noch auf
Debug-Stufe, eine lange Störung flutet das Log also nicht.

## Ich habe eine Sendung im Admin umbenannt und der Adapter hat es überschrieben

Tut er nicht. Der Gerätename ist geschützt — deine Umbenennung gewinnt gegen die Beschreibung aus
parcel.app und überlebt jedes Update. Die aktuelle Beschreibung aus parcel.app steht immer im
Datenpunkt `description`.

Die **Namen der Datenpunkte** unterhalb einer Sendung sind etwas anderes: die gehören dem Adapter
und werden bei jedem Start aufgefrischt, damit eine verbesserte Übersetzung auch deine Anlage
erreicht.

## Welche Zusteller werden unterstützt?

Alle — der Adapter unterstützt, was parcel.app unterstützt, denn parcel.app macht die
Sendungsverfolgung. Die aktuelle Liste ist
[`supported_carriers.json`](https://api.parcel.app/external/supported_carriers.json).

## Schickt der Adapter meine Daten irgendwohin?

Der Adapter spricht mit `api.parcel.app` und mit sonst nichts. Dein API-Schlüssel liegt
verschlüsselt im Instanz-Objekt und wird nie ins Log geschrieben.

Die Fehlerberichte über Sentry sind eine eigene Sache und **aus**, solange du sie nicht unter
_Systemeinstellungen → Diagnose und Fehlerberichte_ eingeschaltet hast. Sind sie an, wird zum
Absturzbericht nur eine anonyme Installationskennung übertragen — kein Name, keine E-Mail-Adresse,
keine IP-Adresse, keine Sendungsdaten.

## Wo melde ich ein Problem?

Auf [GitHub](https://github.com/krobipd/ioBroker.parcelapp/issues). Am meisten hilft ein Log auf
Stufe „debug" über die Minuten um das Problem herum — der Adapter protokolliert dort jede Anfrage
und jede Datenpunkt-Entscheidung.
