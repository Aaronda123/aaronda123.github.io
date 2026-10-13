# J.A.R.V.I.S. – Anleitung

## Wo läuft Jarvis?

- Adresse: **https://aaronda123.github.io**
- Zugriff: **Jeder, der den Link hat**, kann Jarvis öffnen und benutzen. Es gibt keine Anmeldung, kein Passwort und
  keine Gerätesperre.
- Suchmaschinen sollen die Seite **nicht** anzeigen (`robots.txt` und „noindex“ sind eingebaut). Wer den Link nicht
  kennt, findet sie also praktisch nicht.
- Der **Code ist öffentlich** auf GitHub lesbar. Darin stehen keine Schlüssel und keine persönlichen Daten.
- **Schlüssel, Einstellungen, Notizen, Konto- und Termindaten bleiben nur im Browser des jeweiligen Geräts.** Andere
  Besucher sehen davon nichts und können deine Schlüssel nicht benutzen. Ein neues Gerät startet immer leer.

## Aufs Handy bringen

- **iPhone/iPad:** Den Link in **Safari** öffnen → **Teilen** (Quadrat mit Pfeil) → **„Zum Home-Bildschirm“** →
  **„Hinzufügen“**. Das Symbol lässt sich danach wie jede App auf den zweiten Bildschirm ziehen.
- **Android:** Den Link in **Chrome** öffnen → **⋮** → **„Zum Startbildschirm hinzufügen“** bzw. **„App installieren“**.
- **Computer:** Den Link in Chrome, Edge, Safari oder Firefox öffnen. In Chrome/Edge kann man ihn über das
  Installieren-Symbol in der Adresszeile als App speichern.

## „Hey Jarvis“ auf dem iPhone

- Solange Jarvis **offen** ist, hört er auf „Jarvis“ bzw. „Hey Jarvis“. Im **Hintergrund-Modus** (Knopf
  „☾ Hintergrund“ oder „tauch ab“) ist der Bildschirm schwarz, und Jarvis lauscht still weiter.
- Ist die App **zu** oder das iPhone **gesperrt**, darf keine Web-App mithören. Dafür gibt es die iPhone-Funktion
  **Sprachkurzbefehle**. Die genauen Schritte stehen in Jarvis unter **„Hey Jarvis“ einrichten**.

## Kostenlos – und was optional ist

- Ohne Schlüssel funktionieren sofort: Uhr, Timer, Wetter, Bilder, Links (YouTube, Spotify, Google, Karten,
  WhatsApp-Entwurf), 3D-Modelle, Notizen („merk dir …“), Weckwort, Hintergrund-Modus und die kostenlose Gerätestimme.
- Für **richtige Gespräche** braucht Jarvis ein Gehirn:
  - **Gemini (kostenlos):** aistudio.google.com/apikey → mit dem Google-Konto anmelden → „API-Schlüssel erstellen“ →
    in Jarvis unter ⚙ Einstellungen einfügen. Hinweis: Im kostenlosen Tarif darf Google die Gespräche zur
    Verbesserung seiner Dienste nutzen.
  - **Claude (kostenpflichtig, beste Qualität wie am Mac):** console.anthropic.com → API Keys. Abrechnung pro
    Gespräch, meist ein paar Cent.
- **Butler-Stimme vom Mac** (optional): braucht einen eigenen Azure-Schlüssel. Ohne ihn spricht die kostenlose
  Gerätestimme.

## Wie die Seite online gestellt wurde

1. Repo **Aaronda123/aaronda123.github.io** auf GitHub (öffentlich).
2. Die Dateien von Jarvis liegen direkt im Branch **main**, im obersten Ordner.
3. GitHub Pages ist für Repos mit dem Namen `<name>.github.io` automatisch eingeschaltet. Nachsehen kannst du unter
   **Repo → Settings → Pages**: *Source* = „Deploy from a branch“, Branch **main**, Ordner **/ (root)**.

## Aktualisieren

- Jede Änderung im Branch **main** wird automatisch veröffentlicht. Das geht auch, wenn du Claude bittest, Jarvis zu
  ändern.
- Das dauert meist **1 bis 3 Minuten**.
- **Prüfen, ob es live ist:** Repo → **Actions** → oben steht „pages build and deployment“. Ein **grüner Haken**
  heißt online. Ein rotes X heißt, dass etwas schiefging. Dann einfach Claude Bescheid geben.
- Auf dem Handy lädt Jarvis die neue Version beim nächsten Öffnen. Falls nicht: App einmal ganz schließen und neu
  öffnen.

## Offline nehmen (falls nötig)

- **Schnell und rückgängig machbar:** Repo → **Settings → Pages** → **„Unpublish site“**. Wieder an geht es unter
  Settings → Pages mit Branch **main** und **/ (root)** → Save.
- **Endgültig:** Repo → Settings → ganz unten **„Delete this repository“**. Dann ist die Seite weg.

## Später: eigene Adresse

**Umzug auf `dammer-solutions.github.io` (kostenlos):**
1. Auf GitHub die Organisation **dammer-solutions** anlegen (kostenloser Tarif).
2. Darin ein öffentliches Repo **dammer-solutions.github.io** anlegen.
3. Der Claude-GitHub-App Zugriff darauf geben (github.com/settings/installations → Claude → Configure).
4. Claude Bescheid sagen. Jarvis wird dorthin kopiert, und die alte Adresse leitet dann automatisch weiter.

**Eigene Domain, z. B. `jarvis.dammer-solutions.de` (Domain kostet beim Anbieter Geld):**
1. Die Domain bei einem Anbieter kaufen (z. B. dammer-solutions.de).
2. Beim Anbieter einen **CNAME-Eintrag** anlegen: Name **jarvis** → Ziel **dammer-solutions.github.io** (bzw. die
   github.io-Adresse, unter der Jarvis gerade läuft).
3. Auf GitHub: Repo → **Settings → Pages → Custom domain** → `jarvis.dammer-solutions.de` eintragen → Save.
4. Warten, bis der DNS-Check grün ist (Minuten bis Stunden), dann **„Enforce HTTPS“** anhaken.
