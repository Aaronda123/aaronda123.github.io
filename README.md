# J.A.R.V.I.S. fürs iPhone

Der Jarvis vom Mac als Web-App für den Home-Bildschirm: dasselbe rote Overlay mit der Neuronen-Kugel und der
Milchstraße, dieselbe Art zu reden, dasselbe Weckwort („Jarvis“ oder „Hey Jarvis“ – das Overlay springt auf),
derselbe Modus „still im Hintergrund“, dieselben 3D-Modelle und dasselbe „Merk dir …“. Jarvis startet **kostenlos und
ohne Schlüssel**: Uhrzeit, Timer, Wetter, Bilder, Links, 3D-Modelle, Kugel und Weckwort laufen sofort. Für freie
Fragen braucht er ein Gehirn – am einfachsten einen kostenlosen Gemini-Schlüssel von Google. Die Butler-Stimme vom
Mac gibt es optional über einen eigenen Azure-Schlüssel; ohne ihn spricht Jarvis mit der besten deutschen Stimme des
Geräts. Beim ersten Öffnen führt **„Jarvis einrichten“** in sechs kurzen Schritten durch Mikrofon, Bildschirm, Stimme,
Gehirn und Google; danach startet Jarvis jedes Mal **still im Hintergrund** und lauscht auf „Jarvis“. Mit deinem
eigenen Google-Zugang liest er **Google Kalender und Gmail**, trägt Termine ein und schreibt Mails – eintragen,
speichern und senden aber nur nach deinem „ja“.

## Aufs iPhone bringen

1. Öffne in Safari die Adresse dieser App: die GitHub-Pages-Adresse dieses Repos (GitHub → Settings → Pages).
2. Tippe auf „Teilen“ (Quadrat mit Pfeil nach oben) → „Zum Home-Bildschirm“ → Name „Jarvis“ → „Hinzufügen“.
   „Als Web-App öffnen“ bleibt eingeschaltet.
3. Öffne Jarvis über das Symbol. Beim ersten Mal erscheint „Jarvis einrichten“ (siehe unten). Erlaube Mikrofon und
   Spracherkennung, wenn das iPhone fragt. Für freie Fragen trag einen Gemini-Schlüssel (kostenlos) oder deinen
   Claude-Schlüssel ein – im Assistenten oder später unter ⚙ Einstellungen.

Zeigt Jarvis „Tippen, um Jarvis zu starten“, tippe einmal auf den Bildschirm: iOS gibt Ton und Mikrofon erst nach einer
Berührung frei.

## Jarvis einrichten (erster Start)

Beim ersten Besuch auf einem Gerät zeigt Jarvis „Jarvis einrichten“: ein Schritt pro Bildschirm, jeder lässt sich
überspringen, und jeder Knopf holt seine Erlaubnis direkt in deinem Tippen (iOS erlaubt Mikrofon, Ton und Wachhalten
nur so).

1. **Mikrofon erlauben** – startet die Spracherkennung einmal; der Browser fragt nach der Erlaubnis.
2. **Bildschirm wach halten** – Wake Lock (bzw. ein unsichtbares schwarzes Video als Ersatz).
3. **Stimme testen** – schaltet den Ton frei; Jarvis sagt einen Satz.
4. **Gehirn (optional)** – kostenlosen Gemini-Schlüssel einfügen und testen, oder „Claude oder mehr: Einstellungen“.
5. **Google verbinden (optional)** – mit eigener Client-ID (Anleitung unten); ohne Client-ID führt der Knopf zur Anleitung.
6. **Fertig – ich lausche jetzt still im Hintergrund.** „Los geht's“: Jarvis sagt kurz Bescheid, der Bildschirm wird
   schwarz, „Jarvis“ oder „Hey Jarvis“ holt ihn zurück.

Ab dann startet Jarvis bei jedem Öffnen still im Hintergrund (Häkchen „Bei jedem Start still im Hintergrund lauschen“,
abschaltbar unter ⚙ → WAKE-WORD). Nach einem Neustart der App kann der Browser einmal ein Tippen verlangen; dann steht
„Tippen, um Jarvis zu starten“ auf dem schwarzen Bildschirm. ✕ im Assistenten heißt „später“: Jarvis startet normal und
fragt nicht wieder; den Assistenten gibt es jederzeit unter ⚙ → WAKE-WORD → „Jarvis einrichten (Schritt für Schritt)“.

**Ehrlich:** Eine Webseite hört nur zu, solange sie offen ist und der Bildschirm an bleibt. Ist das Gerät gesperrt, die
App gewechselt oder Jarvis geschlossen, hört keine Webseite zu. Auf dem iPhone öffnet dann ein Sprachkurzbefehl Jarvis
auf „Hey Jarvis“ (siehe „Hey Jarvis“, Punkt 3).

## Andere Geräte

Jarvis ist eine normale Webseite. Jeder, der die Adresse hat, kann sie öffnen – ohne Anmeldung, ohne Passwort.
Jedes Gerät hat dabei seine eigenen Einstellungen und Schlüssel; andere Besucher sehen nichts davon. Suchmaschinen
sollen die Seite nicht aufnehmen (`robots.txt` und `noindex`). Geheim ist die Adresse damit nicht: Wer den Link hat,
kann die Seite öffnen, und Dienste wie Wetter, Bilder und Kurse sehen beim Abruf, von welcher Adresse er kommt.

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
| Google-OAuth-Client-ID (optional) | Google Kalender und Gmail | eigene, kostenlose Client-ID, siehe „Google Kalender und Gmail“ |
| Anrede, Vorname, Firma | wie Jarvis dich nennt, Kopfzeile | selbst eintragen (Anrede Standard: „Boss“) |
| Wohnort | Wetter ohne Ortsangabe | selbst eintragen |
| Gedächtnis | was Jarvis immer über dich wissen soll | selbst eintragen |

## „Hey Jarvis“

1. **Jarvis ist offen:** „◎ Wake-Word“ einschalten. Dann reicht „Jarvis“ oder „Hey Jarvis“ – auch mit dem Satz
   direkt dahinter („Hey Jarvis, wie spät ist es?“). Nur „Jarvis“: Er antwortet „Ja, Boss?“ und hört 4 Sekunden zu.
2. **Schwarzer Bildschirm:** „☾ Hintergrund“ tippen oder „Geh in den Hintergrund“ sagen.
   Jarvis ist dann unsichtbar und stumm und lauscht nur noch auf „Jarvis“. Der Bildschirm bleibt dafür an; am besten
   hängt das iPhone am Ladekabel. Zweimal auf Schwarz tippen holt ihn ebenfalls zurück.
3. **Jarvis ist zu (iOS 18 oder neuer):** Das iPhone selbst lauscht auf deinen Satz und öffnet Jarvis.
   - In Jarvis unter ⚙ Einstellungen → SETUP-LINK „Kurzbefehl-Link kopieren“ tippen.
   - App „Kurzbefehle“ → „+“ → „Aktion hinzufügen“ → „URL öffnen“ → den Link einfügen → Kurzbefehl „Jarvis“ nennen.
   - Einstellungen → Bedienungshilfen → Sprachkurzbefehle → „Sprachkurzbefehle einrichten“ (bzw. „Aktion
     hinzufügen“) → unter „Kurzbefehle“ „Jarvis“ wählen → dreimal deutlich „Hey Jarvis“ sagen → „Fertig“. Für „Jarvis“
     allein einen zweiten Sprachkurzbefehl anlegen.
   - Test: „Hey Jarvis“ sagen. Jarvis öffnet sich, sagt „Ja, Boss?“ und hört zu.
   - Der Kurzbefehl öffnet Jarvis eventuell in Safari statt als Home-Bildschirm-App. Safari hat einen eigenen
     Speicher, deshalb steckt im Link (nach „#cfg=“) eine Kopie deiner Einstellungen – nie deine Schlüssel. Beim
     ersten Öffnen fragt Jarvis, ob er sie übernehmen soll. Soll Jarvis auch in Safari mitdenken: in der
     Home-Bildschirm-App unter ⚙ → SETUP-LINK „Setup-Code kopieren“, in Safari dort einfügen und „Code übernehmen“
     tippen. **Gib Link und Code nicht weiter.** Siehst du bei „App öffnen“ die Web-App „Jarvis“, kannst du
     stattdessen diese Aktion nehmen und in Jarvis „Beim Öffnen zuhören“ einschalten.

## Bedienung

- **Das Gehirn** ist wie am Mac ein Gyroskop aus Kern und kreisenden Ringen, das durch die 4. Dimension dreht. Per
  Stimme gibt es die Formen Ringe, Kern, Galaxie, Netz und Schalen („Zeig dein Gehirn als Galaxie“, „Form zurück“).
- **Antippen:** zuhören. Während er zuhört: antippen = „fertig“. Während er spricht oder denkt: antippen = Stopp.
- **Finger (Handy):** ein Finger ziehen = das Gehirn in diese Richtung zur lila-blauen Milchstraße langziehen und
  aufziehen (der Hintergrund leuchtet mit); zweimal tippen = Ursprungsform; zwei Finger auseinander/zusammen = Größe;
  zwei Finger gemeinsam ziehen = verschieben (nahe der Mitte losgelassen springt es zurück); lange drücken und ziehen =
  eine einzelne Kugel herausziehen. Form, Größe und Platz bleiben gespeichert.
- **Maus (Computer), wie am Mac:** links ziehen = langziehen, Mausrad = aufziehen, Strg/Cmd + Rad = Größe, rechts
  ziehen = verschieben, Alt + ziehen = eine Kugel herausziehen, Klick = zuhören, Doppelklick = Ursprungsform.
- **Zweimal auf Schwarz tippen:** Jarvis kommt zurück.
- **Karte mit Knöpfen:** Bei einem Termin oder einer Mail zeigt Jarvis, was er tun würde, und darunter
  „✓ Eintragen“ bzw. „➤ Senden“ / „✎ Nur Entwurf“ und „✕ Nein“.
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
| „Mach die Kugel größer“ · „Kugel zurück in die Mitte“ · „Zeig dein Gehirn als Netz“ | die Neuronen-Kugel |
| „Zeig mir kurz die Höhe vom Mount Everest“ · „Text weg“ | schwebender Text über der Kugel (30 Sekunden, mit Gehirn) |
| „Spiel … auf YouTube“ · „Spiel Astronaut von Sido“ · „Google …“ · „Öffne Instagram“ | Link zum Antippen (Spotify, YouTube, Google, Seite) |
| „Navigiere mich nach Hamburg“ | Route in Apple Karten (iPhone/iPad) bzw. Google Maps (Android, Computer) |
| „Schreib Tom bei WhatsApp, dass …“ · „Schreib Tom bei WhatsApp ich bin gleich da“ | fertige WhatsApp-Nachricht zum Antippen; abschicken tust du |
| „Was steht heute im Kalender?“ · „Was steht morgen an?“ · „Nächster Termin?“ | Termine aus Google Kalender und Jarvis-Liste, ohne Gehirn |
| „Trag Friseur morgen um 14 Uhr ein“ (mit Google) | Jarvis zeigt den Termin und fragt; eingetragen wird erst nach „ja“ |
| „Hab ich neue Mails?“ · „Lies die Mail von Anna“ · „Lies sie vor“ | ungelesene Mails der letzten zwei Tage, Mail vorlesen bzw. zusammenfassen |
| „Antworte ihr, dass ich mich bis Freitag melde“ (mit Gehirn) | Jarvis zeigt Empfänger und Text; gesendet wird erst nach „ja“ |
| „Merk dir, dass …“ · „Vergiss, dass …“ · „Was hast du dir gemerkt?“ | Jarvis merkt es sich dauerhaft (⚙ → Daten) |
| „Trag Zahnarzt Donnerstag um 15 Uhr ein“ · „Mein Kontostand ist 2.400 Euro“ | Panels TERMINE und KONTO (auch ohne Gehirn) |
| „Wenn ich sage Feierabend, dann tauch ab“ | eigener Kurzbefehl (mit Gehirn) |
| „Schließ dich“ · „Tschüss“ · „Gute Nacht“ | ausblenden, lauscht weiter |
| „Geh in den Hintergrund“ · „Tauch ab“ | still im Hintergrund |
| „Neues Gespräch“ · „Stopp“ · „Danke“ · „Wiederhol das“ | wie am Mac |

Ohne Gehirn sagt Jarvis bei freien Fragen, dass er dafür einen Schlüssel braucht, und zeigt den Knopf
„⚙ Einstellungen“.

### Mitdenken statt Floskel

Wie am Mac seit dem 13.10.: Kein „Kann ich sonst noch was tun?“ nach jedem Befehl. Gibt es genau einen
naheliegenden nächsten Schritt, fragt Jarvis kurz („Der Zahnarzt ist um 10. Soll ich dich um 9:45 erinnern?“) und
hört ein paar Sekunden zu („Ja oder nein?“). Ein „ja“ reicht, dann erledigt er es selbst (eine Erinnerung klingelt
als „Boss, Erinnerung: …“). „Okay“ oder „klar“ allein aus dem Fernseher lösen nichts aus; „Jarvis, ja“ geht drei
Minuten lang. Nach drei Absagen am Stück ist 30 Minuten Ruhe. „Sonst noch was?“ kommt nur noch am Ende eines
Ablaufs und höchstens alle zehn Minuten. Nach einer Websuche formuliert Jarvis die Frage selbst und schlägt nur
Harmloses vor (Erinnerung, Wetter, Bild, Amazon-Suche).
Schalter per Stimme: „Keine Vorschläge mehr“ / „Mach wieder Vorschläge“, „Hör nach Vorschlägen nicht mehr zu“ /
„… wieder zu“; oder unter ⚙ → MITDENKEN.

### Plaudern

Bei Smalltalk („Wie geht's dir?“, „Mir ist langweilig“) hört Jarvis nach seiner Antwort sechs Sekunden lang ohne
„Jarvis“ weiter zu, höchstens zehn Sätze am Stück. Was er so hört, bekommt das Gehirn als „ohne Weckwort“ markiert:
Fernseher oder Gespräche im Raum beantwortet es nicht. Abschalten: „Hör beim Plaudern nicht mehr weiter zu“.

### Satzende

Klingt dein Satz fertig, antwortet Jarvis nach 0,9 Sekunden; endet er unsicher (z. B. auf „von“), wartet er 1,5
Sekunden; bricht er mittendrin ab („… und“, „äh“, „dass ich“), wartet er 2 Sekunden auf den Rest. Alle drei Zeiten
stehen unter ⚙ → FEINEINSTELLUNGEN.

Im PROTOKOLL steht der neueste Satz voll und hervorgehoben, ältere Einträge sind auf drei Zeilen gekürzt (antippen
zeigt sie ganz). Nach dem Neuladen zeigt Jarvis die letzte Stunde Gespräch, falls das Protokoll geleert war.

## Google Kalender und Gmail

Jarvis meldet sich direkt im Browser bei Google an (Google Identity Services), ohne fremden Server. Dafür brauchst du
einmal eine eigene, kostenlose OAuth-Client-ID – im öffentlichen Code steht keine:

1. console.cloud.google.com öffnen und mit deinem Google-Konto anmelden.
2. Projektauswahl → „Neues Projekt“ → Name z. B. „Jarvis“ → „Erstellen“.
3. „APIs & Dienste“ → „Bibliothek“: „Google Calendar API“ → „Aktivieren“; „Gmail API“ → „Aktivieren“.
4. „APIs & Dienste“ → „OAuth-Zustimmungsbildschirm“ (teils „Google Auth Platform“): Nutzertyp „Extern“, App-Name
   „Jarvis“, eigene E-Mail als Kontakt; unter „Zielgruppe“ bzw. „Testnutzer“ deine eigene E-Mail-Adresse eintragen.
5. „APIs & Dienste“ → „Anmeldedaten“ → „Anmeldedaten erstellen“ → „OAuth-Client-ID“ → „Webanwendung“.
6. „Autorisierte JavaScript-Quellen“ → genau die Adresse von Jarvis ohne Pfad und ohne Schrägstrich am Ende (Jarvis
   zeigt sie unter ⚙ → GOOGLE VERBINDEN an). Weiterleitungs-URIs brauchst du nicht. → „Erstellen“.
7. Client-ID (endet auf „.apps.googleusercontent.com“) in Jarvis unter ⚙ → GOOGLE VERBINDEN einfügen → „Verbinden“.

Beim ersten Verbinden zeigt Google „Google hat diese App nicht überprüft“ – bei deiner eigenen Test-App normal:
„Erweitert“ → „Weiter zu Jarvis (unsicher)“ → Häkchen setzen → „Weiter“. Solange die App im Status „Test“ ist, will
Google die Zustimmung ab und zu erneuern (oft nach 7 Tagen); dann einfach wieder „Verbinden“.

So arbeitet Jarvis damit:

- **Rechte Schritt für Schritt:** zuerst nur der Kalender (lesen und Termine anlegen). Gmail (lesen, Entwürfe, senden)
  fragt Jarvis erst, wenn du zum ersten Mal nach Mails fragst („Gmail erlauben“ antippen).
- **Kalender:** Die Termine aller sichtbaren Kalender stehen im Panel TERMINE (zusammen mit der Jarvis-Liste).
  „Trag … ein“ zeigt den Termin als Karte und fragt „Soll ich … eintragen?“ – eingetragen wird erst nach „ja“,
  „Jarvis, ja“ (drei Minuten) oder einem Tippen auf „✓ Eintragen“. Nebengeräusche im kurzen Nachhören zählen nicht.
- **Gmail:** „Hab ich neue Mails?“ nennt die ungelesenen der letzten zwei Tage. „Lies die Mail von …“ liest ohne
  Gehirn Absender, Betreff und den Anfang vor (ganz: „lies sie vor“), mit Gehirn fasst es die Mail zusammen. Antworten
  und neue Mails schreibt das Gehirn; Jarvis zeigt Empfänger, Betreff und Text und sendet erst nach deinem
  ausdrücklichen „ja“ („✎ Nur Entwurf“ speichert stattdessen einen Entwurf in Gmail). Nie automatisch, und Adressen
  denkt sich Jarvis nicht aus. Auf kleinen Handys wird die Schrift der Karte kleiner oder sie lässt sich scrollen –
  abgeschnitten wird nichts, was du bestätigen sollst.
- **Mails sind fremder Text:** Was in einer Mail steht, ist für Jarvis nur Daten. Aktionen, die nach dem Lesen einer
  Mail vorgeschlagen werden, sind auf Harmloses beschränkt (Schreiben nur mit deinem „ja“, nie Links öffnen, anrufen,
  WhatsApp oder etwas lernen); bis „neues Gespräch“ lernt Jarvis nichts mehr dazu.
- **Zugriffsschlüssel:** Das Token von Google gilt eine Stunde und liegt nur im Speicher dieses Fensters
  (sessionStorage), nie dauerhaft. Läuft es ab, holt Jarvis still ein neues; blockiert der Browser das (z. B. bei einem
  Sprachbefehl ohne Tippen), zeigt er „◎ Google verbinden“ – ein Tippen, und die Bitte von eben läuft weiter.
  „Trennen“ zieht den Zugang bei Google zurück.
- Klappt die Anmeldung in der Home-Bildschirm-App des iPhones nicht (das Google-Fenster schließt sich, ohne dass Jarvis
  verbunden ist), nutze Jarvis für Kalender und Mail in einem Safari-Tab; Client-ID und Schlüssel bringst du mit dem
  Setup-Code dorthin.

## WhatsApp

WhatsApp-Nachrichten **lesen** kann eine Webseite nicht – für private Konten gibt es dafür keine Schnittstelle. Das geht
nur mit Jarvis am Mac. **Schreiben** geht: „Schreib Tom bei WhatsApp, dass ich später komme“ bereitet die Nachricht vor
und zeigt einen Knopf; WhatsApp öffnet sich mit dem Text, den Chat wählst und abschicken tust du selbst.

## Was Jarvis im Browser nicht kann

Lautstärke und Musik steuern, Programme öffnen und schließen, den Hotspot verbinden und WhatsApp-Nachrichten lesen geht
in einer Web-App nicht – Jarvis sagt das ehrlich. Timer klingeln nur, solange Jarvis
offen ist; war er zu, meldet er einen verpassten Timer beim nächsten Öffnen (bis 30 Minuten danach). Gesperrt oder in
einer anderen App hört keine Web-App zu – dafür gibt es den Sprachkurzbefehl. Eine Webseite im Jarvis-Fenster („öffne
Spiegel im Jarvis“) gibt es nicht: die meisten Seiten verbieten das Einbetten; Jarvis zeigt sie als Link zum Antippen.

## Datenschutz

- Schlüssel, Profil, Notizen, Kurzbefehle, Termine, Konto und Verlauf liegen nur im Speicher dieses Geräts.
  „⚙ → Daten → Alles löschen“ entfernt alles, auch die zwischengespeicherten Azure-Sprachaufnahmen.
- Was das Gehirn sieht: Mit jeder Frage gehen Gedächtnis und Notizen an das gewählte Gehirn mit, bei Claude auch
  Termine und Konto, beim kostenlosen Gemini Termine und Konto nur, wenn die Frage danach klingt. Im kostenlosen
  Gemini-Tarif darf Google die Gespräche auswerten und zum Verbessern nutzen – keine PINs oder Passwörter in Notizen.
- Setup-Link und Kurzbefehl-Link enthalten nie Schlüssel: Der Browser merkt sich einen geöffneten Link im Verlauf
  (Chrome und Edge mit Sync auch im Konto). Schlüssel überträgt der Setup-Code, den du kopierst und auf dem anderen
  Gerät einfügst. Link und Code gelten erst nach der Frage „Einstellungen übernehmen?“, die zeigt, was sich ändert
  (Schlüssel, Gedächtnis, Notizen, Kurzbefehle).
- Spracherkennung: die des Geräts (auf dem iPhone die Diktierfunktion von Apple). Stimme: die des Geräts oder, mit
  eigenem Schlüssel, Microsoft Azure. Gehirn: Google Gemini oder Anthropic Claude mit deinem eigenen Schlüssel.
- Google: Die Anmeldung läuft direkt zwischen Browser und Google (accounts.google.com); Kalender und Gmail fragt Jarvis
  direkt bei Google ab (www.googleapis.com, gmail.googleapis.com). Gespeichert bleiben nur die Client-ID und welche
  Teile du erlaubt hast; das Token nur bis zum Schließen des Fensters. Eine Mail, die du zusammenfassen lässt, geht an
  dein Gehirn (Gemini bzw. Claude); Termine aus dem Google-Kalender gehen wie die Jarvis-Termine mit (bei Gemini nur,
  wenn die Frage danach klingt). Ohne Client-ID lädt Jarvis nichts von Google. Die Client-ID reist nur im Setup-Code,
  nie im Setup-Link. Nichts davon läuft über den Service-Worker-Cache.
- Wetter (Open-Meteo), Bilder (Wikipedia) und Kurse (Binance, CoinGecko, Frankfurter) werden ohne Schlüssel abgefragt.
  Die Schriften liegen in der App selbst (kein Abruf bei Google Fonts).
- Jarvis gehört allein auf seine Adresse: Andere Seiten derselben Adresse (z. B. weitere GitHub-Pages-Projekte desselben
  Kontos unter `/<repo>/`) teilen sich den Browser-Speicher und könnten die Schlüssel lesen. Der Service-Worker fasst
  nur Jarvis' eigene Dateien an.

## Technik

Reines HTML, CSS und JavaScript (ES-Module), kein Build-Schritt.

| Datei | Aufgabe |
|---|---|
| `index.html`, `style.css` | Overlay, Panels, Blätter; Layout für Handy, Tablet und Computer |
| `app.js` | Steuerung: Start, Zustände, Weckwort-Abläufe, Modi, Timer |
| `intents.js` | Sprachlogik vom Mac: Weckwort, Satzende, Schließen/Hintergrund, Schnellbefehle, Smalltalk, alle Sätze |
| `mitdenken.js` | Vorschläge („Soll ich …?“): prüfen, Frage formulieren, „ja“/„nein“ verstehen, ausführen |
| `ears.js`, `voice.js` | Zuhören (Spracherkennung, Satzende) und Sprechen (Gerätestimme oder Azure) |
| `brain.js`, `tools.js`, `store.js` | Gehirn, Aktionen, Speicher (Einstellungen, Notizen, Timer, Setup-Link) |
| `google.js` | Google-Anmeldung (GIS-Token, bei Bedarf geladen), Kalender und Gmail über REST |
| `hud.js`, `neuro.js`, `galaxy.js`, `model3d.js` | Anzeige, Neuronen-Kugel, Milchstraße, 3D-Modelle (Ports vom Mac) |
| `sheets.js`, `awake.js`, `sw.js` | „Jarvis einrichten“, Einstellungsblätter, Bildschirm wach halten, Offline-Start |
| `vendor/anthropic.mjs` | offizielles Anthropic-SDK (`@anthropic-ai/sdk` 0.128.0) als Browser-Bundle |
| `fonts/` | Orbitron und Rajdhani (SIL Open Font License 1.1, Lizenztexte daneben) |
| `media/awake.mp4` | 4 Sekunden schwarzes Video mit stummer Tonspur, hält Geräte ohne wirksamen Wake Lock wach |
| `robots.txt` | Suchmaschinen sollen die Seite nicht aufnehmen |

Tests liegen außerhalb der App in `jarvis-tests/` und werden nicht veröffentlicht. Veröffentlichen: den Inhalt von
`jarvis-app/` in das Hauptverzeichnis des GitHub-Pages-Repos kopieren und in `sw.js` die `VERSION` erhöhen.
