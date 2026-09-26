# Ideen-Roadmap

Kuratierte, verifizierte Verbesserungsideen für das Dashboard.

## Vault-Design, Sync-Genauigkeit & echte Hörzeit (aktueller Stand)
- ✅ **Deterministische Scrobble-Keys (v2)** — `ts_artist_track_hash`, ohne die frühere
  Fenster-Position (`seq`). Parallele Syncs (zwei Tabs, Handy + Desktop) erzeugten damit
  Duplikate; jetzt sind alle Writes idempotent. _(umgesetzt, `js/core.js`)_
- ✅ **Fenster-Abgleich statt Append-only** — Delta-Sync überlappt 72 h (Deezer reicht
  Offline-Plays mit altem Zeitstempel nach) und entfernt bei vollständigem Fenster Einträge,
  die Last.fm nicht mehr kennt. _(umgesetzt, `js/sync.js`)_
- ✅ **Monats-Prüfung & Reparatur** ersetzt Gap-Fill — 1 Zähl-Call pro Monat, nur abweichende
  Monate werden neu geladen; migriert Legacy-Keys; letzte 3 Monate laufen automatisch. _(umgesetzt)_
- ✅ **Eine Sync-Sperre** für Auto/Delta/Import/Abgleich (die alte `busy`-Prüfung griff nie). _(umgesetzt)_
- ✅ **Eine Datenquelle** — Diversität, Pie, Trend, 12-Monats- und Lifetime-Chart rechnen aus
  dem Archiv (vorher Last.fm-Toplisten bzw. die Tabelle `monthly`, die Fehler als 0 speicherte);
  gemeinsame, case-insensitive Aggregation für alle Sektionen und Wrapped. _(umgesetzt)_
- ✅ **Echte Hörzeit** — Track-Längen aus Last.fm `track.getInfo` bzw. Deezer (JSONP) in
  `track_meta`, fortsetzbar im Hintergrund; Abdeckung wird angezeigt. _(umgesetzt)_
- ✅ **Stat-Fixes** — „Aktive Tage“ (zeigte Tage seit Registrierung), Anteile relativ zu allen
  Scrobbles, „Heute“ ohne laufenden Track, Teiljahre im Jahresvergleich, Legende doppelt. _(umgesetzt)_
- ✅ **Vault-Design** — Tokens aus Apple Glass Light 2.12 + Layer8 (`css/vault-tokens.css`,
  Referenz unter `design/obsidian-vault/`), Hell/Dunkel nach System + Toggle, Boot-Screen,
  Asterismus, Luna-Motive, Überschriften-Spektrum. _(umgesetzt)_
- ✅ **Abhängigkeiten** — Chart.js 4.5.1, Firebase 12.19 (compat), `modern-screenshot` statt
  html2canvas (kann kein `color-mix()`). _(umgesetzt)_

### Offen / Folge-Ideen
- **Firebase-Security-Rules** — die DB ist offen: jeder mit der öffentlichen Config kann das
  Archiv lesen, überschreiben oder löschen. `database.rules.json` + Anonymous-Auth/App-Check. _(hard, wichtig)_
- **Deezer-Verlauf importieren** — Deezers DSGVO-Export enthält den kompletten Hörverlauf; ein
  Import würde Plays nachtragen, die Deezer nie an Last.fm gemeldet hat. _(medium)_
- **Archiv chunked laden** — `getArchiveData()` lädt weiterhin das ganze Archiv einmal pro
  Seitenaufruf (danach nur noch lokale Merges). Für 100k+ Scrobbles nach Jahren splitten. _(hard)_

## Sync-Zuverlässigkeit & Apple-Redesign (früherer PR)
- ✅ **Sync-Resume-Fix** — Root-Cause des "unterbrochener Sync macht nicht weiter"-Bugs:
  Seiten wurden *neueste zuerst* geladen und parallel (fire-and-forget) geschrieben. Bei
  Abbruch war das Neueste bereits archiviert, in der Mitte blieb ein Loch — und der nächste
  Delta-Sync (startet ab dem neuesten Eintrag) übersprang es für immer. Jetzt: Seiten
  **älteste zuerst** in einem **fixierten Zeitfenster** (`to`-Param) + Writes strikt in
  Reihenfolge → das Archiv wächst immer lückenlos; jeder abgebrochene Sync/Import wird vom
  nächsten (Auto-)Delta-Sync automatisch an derselben Stelle fortgesetzt. _(umgesetzt)_
- ✅ **Paging-Fix (~200× weniger API-Calls)** — `totalPages` wurde aus einem `limit=1`-Call
  übernommen (= Anzahl aller Tracks!), die Sync-Loops fetchten dadurch massiv zu viele
  Seiten. Jetzt wird die Seitenzahl für `limit=200` korrekt berechnet (`getSyncTotals`).
  Macht Delta-Sync/Import drastisch schneller — weniger Gelegenheit für Abbrüche. _(umgesetzt)_
- ✅ **Abbrechen = Pausieren** — Abbruch-Meldungen kommunizieren jetzt, dass der Fortschritt
  erhalten bleibt und Delta-Sync fortsetzt (inkl. Hinweistext im Archiv-Modal). _(umgesetzt)_
- ✅ **Apple-Redesign (Light)** — komplette Neufassung von `styles.css` in der hellen
  Designsprache der gptstats-Seite: System-Fonts (SF Pro/SF Mono-Stack, Google Fonts
  entfernt), `#f5f5f7`-Grund mit weichen Pastell-Glows, weiße Karten (22px-Radius),
  Pill-Buttons/-Tabs, große Headlines mit Eyebrow, Apple-Systempalette
  (Blau/Indigo/Violett/Pink-Gradient). Alle Selektoren & Legacy-CSS-Variablen blieben
  erhalten; Chart.js-Farben/Fonts, Heatmap-Rampen, Statusfarben und Inline-Farben auf
  Hell angepasst (Manifest/Meta-Theme-Color inklusive). _(umgesetzt)_
- ✅ **Wrapped im Apple-Look (Light)** — `wrapped.css` komplett neu im selben hellen
  Design (Pastell-Slide-Hintergründe, weiße Karten, Hero-Gradient-Headlines,
  System-Fonts statt Fraunces/DM Sans/Space Mono); Konfetti-Farben in `wrapped.js`
  auf die Apple-Palette umgestellt. Alle Klassen/Variablennamen erhalten. _(umgesetzt)_

### Folge-Ideen zum Redesign
- ✅ ~~Dark-Theme + Toggle~~ — Vault-Dunkelmodus, folgt dem System. _(umgesetzt)_
- **Sync-Checkpoint-Anzeige** — im Archiv-Modal anzeigen, wenn ein Import/Sync
  unvollständig ist ("Fortsetzen"-Button statt nur Delta-Sync-Wissen). _(easy)_

> Hinweis: Der gemeldete „Chart.js-Memory-Leak" ist **kein** Bug — der Code ruft `.destroy()`
> vor jedem neuen Chart (`app.js`). Nicht weiterverfolgen.

## Bugfixes & A11y (Review-PR)
- ✅ Manueller Delta-Sync aktualisiert jetzt die ganze Seite ohne Reload (vorher nur
  Auto-Sync) — zentralisiert in `invalidateArchiveCaches()`. _(umgesetzt)_
- ✅ 429-Rate-Limit-Erkennung mit `Retry-After`/exponentiellem Backoff in
  `fetchScrobblePage`. _(umgesetzt)_
- ✅ Fehlgeschlagene Firebase-Writes werden nicht mehr still verschluckt — `failedPages`-Zähler
  + Hinweis im Sync-Status (Full Import, Delta, Auto). _(umgesetzt)_
- ✅ `prefers-reduced-motion` für JS-Effekte (Spotlight/Parallax) + Smooth-Scroll. _(umgesetzt)_
- ✅ Wrapped: Fokus-Management beim Öffnen/Schließen, `role="dialog"`, `aria-live`-Loader.
  _(umgesetzt)_
- ✅ CSS-Token-Deduplizierung (identische 0.03-Glas-Token referenzieren eine Quelle).
  _(umgesetzt)_

## Zurückgestellt (hoher Nutzen, eigener PR)
- ✅ ~~Scrobble-Aggregation entdoppeln~~ — `ScrobbleCore.aggregate()` in `js/core.js`. _(umgesetzt)_
- **CSS-Utility-Extraktion** — ~39× `backdrop-filter`, ~100 Gradients, ~94 Shadows wiederholt;
  als benannte Tokens/Utilities bündeln (Regressionsrisiko → separater PR). _(medium)_
- **Archiv-Pagination** — `getArchiveData()` lädt das gesamte `scrobbles`-Objekt in den
  Speicher; jede Sektion scannt es erneut O(n). Für 10k+ chunked laden / gemeinsamer
  Single-Pass. _(hard)_

## Visual & Layout
- Bento-Grid für Diversität/Top-5 (Rang 1 als 2×-Kachel). _(medium)_
- Einheitliches Hover-Bewegungssystem über alle Karten. _(easy)_
- Sektions-Counter auf sehr kleinen Screens weiter entzerren. _(easy)_

## UX & Interaktion
- Sticky Content-Tabs (`.ctabs`) — benötigt Auflösung des `overflow:hidden`-Clippings der
  Glas-Cards (sonst klebt sticky nicht); daher als eigenes, sorgfältiges Refactoring. _(medium)_
- Lade-Spinner direkt im aktiven Perioden-Tab während async-Load. _(medium)_
- „Was ist neu"-Badge an Archiv-Button nach Delta-Sync. _(easy)_
- Tastatur-Shortcuts (1–9 Perioden, S = Sortierung). _(medium)_

## Neue Features (datengetrieben)
- Loved-Tracks-Mini-Liste (der alte, nie aufgerufene `loadLoved`-Code wurde entfernt). _(easy)_
- „Rediscovery": früher viel gehörte, zuletzt pausierte Künstler. _(medium)_
- Genre-Tag-Filter: Tags als klickbare Chips zum Filtern der Charts. _(hard)_
- „Mood"-Anzeige je Monat (Plays/Tag → Chill ↔ Obsessed). _(easy)_
- Now-Playing-Kontext: Rang/Plays des laufenden Künstlers diesen Monat. _(medium)_

## Performance
- ✅ `loading="lazy"` für Album-Cover in Listen/Recent. _(umgesetzt)_
- ✅ `preconnect` für Fonts/Last.fm/Firebase, `defer` für html2canvas. _(umgesetzt)_
- Archiv-Pagination/Chunking für sehr große Sammlungen (10k+). _(hard)_
- Service-Worker: statische Assets + letzter Archiv-Snapshot offline. _(hard)_

## Accessibility
- ✅ Modal-Focus-Trap (Tab-Schleife) für Artist-/Archiv-Modal. _(umgesetzt)_
- ✅ `role="tablist"`/Pfeiltasten-Navigation für Perioden-/Content-Tabs. _(umgesetzt)_
- Muster/Hatching für Rang 1–3 (Farbfehlsichtigkeit). _(medium)_

## Mobile / PWA
- ✅ `apple-touch-icon`-PNG (180) + Icons (192/512) + `manifest.webmanifest`. _(umgesetzt)_
- Artist-Modal als Bottom-Sheet auf Mobile. _(medium)_
- Haptisches Feedback (`navigator.vibrate`) bei Aktionen (Android). _(easy)_
- Gesten-Navigation zwischen Sektionen. _(hard)_

## Code-Qualität / Wartbarkeit
- `Formatters`-Modul (`fmt`/`fmtTime`/`timeAgo` …) auslagern. _(easy)_
- `ChartManager`/`ArchiveStore` zur Bündelung von Chart- bzw. Archiv-Zugriffen. _(hard)_
- ✅ Inline-`onclick` in `index.html` auf zentrale Event-Delegation (`data-action`) umgestellt. _(umgesetzt)_
- `app.js` perspektivisch in `archive.js`/`charts.js`/`ui.js` aufteilen. _(hard)_
