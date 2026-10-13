# J.A.R.V.I.S. fürs iPhone

Der Jarvis vom Mac als Web-App für den Home-Bildschirm: dasselbe rote Overlay mit der Neuronen-Kugel und der
Milchstraße, dieselbe Art zu reden, dasselbe Weckwort („Jarvis“ oder „Hey Jarvis“ – das Overlay springt auf),
derselbe Modus „still im Hintergrund“, dieselben 3D-Modelle und dasselbe „Merk dir …“. Jarvis startet **kostenlos und
ohne Schlüssel**: Uhrzeit, Timer, Wetter, Bilder, Links, 3D-Modelle, Kugel und Weckwort laufen sofort. Für freie
Fragen braucht er ein Gehirn – am einfachsten einen kostenlosen Gemini-Schlüssel von Google. Die Butler-Stimme vom
Mac gibt es optional über einen eigenen Azure-Schlüssel; ohne ihn spricht Jarvis mit der besten deutschen Stimme des
Geräts.

## Aufs iPhone bringen

1. Öffne in Safari die Adresse dieser App: die GitHub-Pages-Adresse dieses Repos (GitHub → Settings → Pages).
2. Tippe auf „Teilen“ (Quadrat mit Pfeil nach oben) → „Zum Home-Bildschirm“ → Name „Jarvis“ → „Hinzufügen“.
   „Als Web-App öffnen“ bleibt eingeschaltet.
3. Halte das neue Jarvis-Symbol gedrückt → „Home-Bildschirm bearbeiten“ → zieh es nach rechts auf die zweite Seite →
   „Fertig“.
4. Öffne Jarvis über das Symbol. Er läuft sofort. Erlaube Mikrofon und Spracherkennung, wenn das iPhone fragt. Für
   freie Fragen trag unter ⚙ Einstellungen einen Gemini-Schlüssel (kostenlos) oder deinen Claude-Schlüssel ein und
   tippe „Speichern“.

Fragt Jarvis „Tippen, um Jarvis zu starten“, tippe einmal auf den Bildschirm: iOS gibt Ton und Mikrofon erst nach einer
Berührung frei.

## Andere Geräte

Jarvis ist eine normale Webseite. Jeder, der die Adresse hat, kann sie öffnen – ohne Anmeldung, ohne Passwort.
Jedes Gerät hat dabei seine eigenen Einstellungen und Schlüssel; andere Besucher sehen nichts davon. Suchmaschinen
sollen die Seite nicht aufnehmen (`robots.txt` und `noindex`), sie ist also nur über den Link zu finden.

| Gerät | So geht's |
|---|---|
| Android | In Chrome öffnen → ⋮ → „Zum Startbildschirm hinzufügen“ bzw. „App installieren“. Das Weckwort funktioniert, solange die Seite offen ist. |
| Computer | In Chrome oder Edge in der Adresszeile auf das Installieren-Symbol klicken oder die Seite einfach als Lesezeichen speichern. Großer Bildschirm: Layout wie das Mac-Overlay. Tasten wie am Mac: Strg+Alt+Leertaste zuhören, Strg+Alt+J ein/aus, Strg+Alt+K nur Kugel, Esc schließt Blätter und Modelle. |
| iPad | Wie beim iPhone über „Teilen“ → „Zum Home-Bildschirm“. |
| Firefox | Firefox kann nicht zuhören. Jarvis funktioniert dort über die Eingabezeile; zum Sprechen Chrome oder Safari nehmen. |

## Was du einträgst

Alles bleibt nur im Speicher dieses Geräts. Nichts davon ist Pflicht.

| Feld | Wofür | Woher |
|---|---|---|
| Gemini-Schlüssel (kostenlos) | Gehirn für freie Fragen, ohne Zahlung | aistudio.google.com/apikey öffnen, mit dem Google-Konto anmelden, „API-Schlüssel erstellen“, einfügen. Im kostenlosen Tarif darf Google die Gespräche zur Verbesserung seiner Dienste nutzen. |
| Claude-API-Schlüssel (optional) | bestes Gehirn, wie am Mac; Abrechnung pro Gespräch, meist ein paar Cent | console.anthropic.com → API Keys |
| Gehirn | „Automatisch“ nimmt Claude, wenn ein Claude-Schlüssel da ist, sonst Gemini | Einstellungen → Gehirn |
| Azure-Speech-Schlüssel + Region (optional) | die Butler-Stimme vom Mac (Microsoft „Conrad“) | portal.azure.com → Speech-Dienst anlegen, Tarif „Free F0“ → „Schlüssel und Endpunkt“ |
| Anrede, Vorname, Firma | wie Jarvis dich nennt, Kopfzeile | selbst eintragen (Anrede Standard: „Boss“) |
| Wohnort | Wetter ohne Ortsangabe | selbst eintragen |
| Gedächtnis | was Jarvis immer über dich wissen soll | selbst eintragen |

## „Hey Jarvis“

1. **Jarvis ist offen:** „◎ Wake-Word“ einschalten. Dann reicht „Jarvis“ oder „Hey Jarvis“ – auch mit dem Satz
   direkt dahinter („Hey Jarvis, wie spät ist es?“). Nur „Jarvis“: Er antwortet „Ja, Boss?“ und hört 4 Sekunden zu.
2. **Schwarzer Bildschirm:** „☾ Hintergrund“ tippen oder „Verpiss dich und bleib still im Hintergrund offen“ sagen.
   Jarvis ist dann unsichtbar und stumm und lauscht nur noch auf „Jarvis“. Der Bildschirm bleibt dafür an; am besten
   hängt das iPhone am Ladekabel. Zweimal auf Schwarz tippen holt ihn ebenfalls zurück.
3. **Jarvis ist zu (iOS 18 oder neuer):** Das iPhone selbst lauscht auf deinen Satz und öffnet Jarvis.
   - In Jarvis unter ⚙ Einstellungen „Kurzbefehl-Link kopieren“ tippen.
   - App „Kurzbefehle“ → „+“ → „Aktion hinzufügen“ → „URL öffnen“ → den Link einfügen → Kurzbefehl „Jarvis“ nennen.
   - Einstellungen → Bedienungshilfen → Sprachkurzbefehle → „Sprachkurzbefehle einrichten“ (bzw. „Aktion
     hinzufügen“) → unter „Kurzbefehle“ „Jarvis“ wählen → dreimal deutlich „Hey Jarvis“ sagen → „Fertig“. Für „Jarvis“
     allein einen zweiten Sprachkurzbefehl anlegen.
   - Test: „Hey Jarvis“ sagen. Jarvis öffnet sich, sagt „Ja, Boss?“ und hört zu.
   - Der Kurzbefehl öffnet Jarvis eventuell in Safari statt als Home-Bildschirm-App. Safari hat einen eigenen
     Speicher, deshalb steckt im Link (nach „#cfg=“) eine Kopie deiner Einstellungen samt Schlüsseln. **Gib den Link
     nicht weiter.** Siehst du bei „App öffnen“ die Web-App „Jarvis“, kannst du stattdessen diese Aktion nehmen und in
     Jarvis „Beim Öffnen zuhören“ einschalten.

## Bedienung

- **Kugel antippen:** zuhören. Während er zuhört: antippen = „fertig“. Während er spricht oder denkt: antippen = Stopp.
- **Kugel ziehen:** verschiebt sie; einzelne Kugeln lassen sich herausziehen; mit zwei Fingern zoomen. Losgelassen
  nahe der Mitte springt sie zurück.
- **Zweimal auf Schwarz tippen:** Jarvis kommt zurück.
- **KOMMANDO:** ◉ Zuhören · ■ Stopp · ↺ Neues Gespräch · ◎ Wake-Word · ♪ Stimme · ◇ Nur Kugel · ◐ Ausblenden ·
  ☾ Hintergrund · ⚙ Einstellungen. ✕ oben: stumm und weg, lauscht weiter.
- Links und Apps öffnet das iPhone erst nach einem Antippen: Jarvis zeigt sie als Knopf über der Eingabezeile.

| Sag zum Beispiel | Was passiert |
|---|---|
| „Wie spät ist es?“ · „Welcher Tag ist heute?“ | sofort, ohne Gehirn |
| „Timer fünf Minuten für die Pizza“ · „Wie lange läuft der Timer noch?“ · „Timer aus“ | Timer im Panel SYS.ZEIT |
| „Wie wird das Wetter morgen?“ · „Wird es regnen?“ | Wetter für deinen Wohnort oder jeden anderen Ort |
| „Zeig mir ein Bild von einem Okapi“ | Bild aus Wikipedia |
| „Zeig mir einen 4D-Würfel“ · „Zeig mir ein Haus in 3D“ · „Mach ihn größer“ · „Weg damit“ | 3D-Modell zum Drehen (das Haus baut das Gehirn) |
| „Mach die Kugel größer“ · „Kugel zurück in die Mitte“ | die Neuronen-Kugel |
| „Spiel … auf YouTube“ · „Spiel Astronaut von Sido“ · „Google …“ · „Öffne Instagram“ | Link zum Antippen (Spotify, YouTube, Google, Seite) |
| „Navigiere mich nach Hamburg“ | Route in Apple Karten |
| „Schreib Tom auf WhatsApp, dass …“ | fertige WhatsApp-Nachricht; abschicken tust du |
| „Merk dir, dass …“ · „Vergiss, dass …“ · „Was hast du dir gemerkt?“ | Jarvis merkt es sich dauerhaft (⚙ → Daten) |
| „Trag Zahnarzt Donnerstag 15 Uhr ein“ · „Mein Kontostand ist 2.400 Euro“ | Panels TERMINE und KONTO (mit Gehirn) |
| „Wenn ich sage Feierabend, dann tauch ab“ | eigener Kurzbefehl (mit Gehirn) |
| „Schließ dich“ · „Tschüss“ · „Gute Nacht“ | ausblenden, lauscht weiter |
| „Verpiss dich und bleib still im Hintergrund offen“ · „Tauch ab“ | still im Hintergrund |
| „Neues Gespräch“ · „Stopp“ · „Danke“ · „Wiederhol das“ | wie am Mac |

Ohne Gehirn sagt Jarvis bei freien Fragen, dass er dafür einen Schlüssel braucht, und zeigt den Knopf
„⚙ Einstellungen“.

## Was nur der Mac kann

Mails, Google-Kalender, Lautstärke und Musiksteuerung, Mac-Programme öffnen und schließen, den Hotspot und WhatsApp
vorlesen erledigt weiter der Jarvis am Mac – auf dem iPhone sagt Jarvis das ehrlich. Timer klingeln nur, solange Jarvis
offen ist; war er zu, meldet er einen verpassten Timer beim nächsten Öffnen (bis 30 Minuten danach). Gesperrt oder in
einer anderen App hört keine Web-App zu – dafür gibt es den Sprachkurzbefehl.

## Datenschutz

- Schlüssel, Profil, Notizen, Kurzbefehle, Termine, Konto und Verlauf liegen nur im Speicher dieses Geräts.
  „⚙ → Daten → Alles löschen“ entfernt alles.
- Setup-Link und Kurzbefehl-Link enthalten deine Schlüssel. Nur in deinen eigenen Kurzbefehl einfügen.
- Spracherkennung: die des Geräts (auf dem iPhone die Diktierfunktion von Apple). Stimme: die des Geräts oder, mit
  eigenem Schlüssel, Microsoft Azure. Gehirn: Google Gemini oder Anthropic Claude mit deinem eigenen Schlüssel.
- Wetter (Open-Meteo), Bilder (Wikipedia) und Kurse (Binance, CoinGecko, Frankfurter) werden ohne Schlüssel abgefragt.

## Technik

Reines HTML, CSS und JavaScript (ES-Module), kein Build-Schritt.

| Datei | Aufgabe |
|---|---|
| `index.html`, `style.css` | Overlay, Panels, Blätter; Layout für Handy, Tablet und Computer |
| `app.js` | Steuerung: Start, Zustände, Weckwort-Abläufe, Modi, Timer |
| `intents.js` | Sprachlogik vom Mac: Weckwort, Schließen/Hintergrund, Schnellbefehle, alle Sätze |
| `ears.js`, `voice.js` | Zuhören (Spracherkennung, Satzende) und Sprechen (Gerätestimme oder Azure) |
| `brain.js`, `tools.js`, `store.js` | Gehirn, Aktionen, Speicher (Einstellungen, Notizen, Timer, Setup-Link) |
| `hud.js`, `neuro.js`, `galaxy.js`, `model3d.js` | Anzeige, Neuronen-Kugel, Milchstraße, 3D-Modelle (Ports vom Mac) |
| `sheets.js`, `awake.js`, `sw.js` | Einstellungsblätter, Bildschirm wach halten, Offline-Start |
| `vendor/anthropic.mjs` | offizielles Anthropic-SDK (`@anthropic-ai/sdk` 0.128.0) als Browser-Bundle |
| `media/awake.mp4` | 2 Sekunden schwarzes Video, hält ältere Geräte wach |
| `robots.txt` | Suchmaschinen bleiben draußen (die Seite ist nur über den Link zu finden) |

Tests liegen außerhalb der App in `jarvis-tests/` und werden nicht veröffentlicht. Veröffentlichen: den Inhalt von
`jarvis-app/` in das Hauptverzeichnis des GitHub-Pages-Repos kopieren und in `sw.js` die `VERSION` erhöhen.
