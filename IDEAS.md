# Ideen-Roadmap

Kuratierte, verifizierte Verbesserungsideen für das Dashboard. Bereits **umgesetzt** in den
letzten PRs: Dark-Glassmorphism-Redesign, CSS/JS-Auslagerung, Hero-Breiten-Fix, Hover ohne
Layout-Shift, Empty-States, entprellte Suche, Toast-Queue, Fokus-Ringe/Skip-Link/ARIA-Live,
Kontrast-Anhebung, Tag×Stunde-Heatmap, Year-over-Year + Jahres-Hochrechnung.

## Sync-Zuverlässigkeit & Apple-Redesign (dieser PR)
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
- **Dark-Theme + Toggle** wie bei gptstats — die Design-Tokens sind darauf vorbereitet
  (alle Farben laufen über Variablen); Chart.js-Farben müssten beim Umschalten
  re-initialisiert werden (`_chartColors`-Cache leeren + Charts neu rendern). _(medium)_
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
- Hinweis: `--text3` (#a59ec2) erfüllt WCAG AA/AAA auf dem dunklen Hintergrund (≈7,7:1) —
  ursprünglich vermutete Kontrast-Schwäche bestätigte sich **nicht**. Nicht ändern.

## Zurückgestellt (hoher Nutzen, eigener PR)
- **Scrobble-Aggregation entdoppeln** — der `countMap`-Aufbau (Key splitten → Artist/Track/
  Album trimmen → Map nach Tab) liegt ~6× in `app.js` (`calcChartsFromArchive`, today,
  yesterday, `loadYearReview`, Discovery-Counts, Drilldown) **und** nochmal in `wrapped.js`.
  Eine gemeinsame `aggregateScrobbles(data,{fromTs,toTs,tab})` würde hunderte Zeilen sparen.
  _(hard)_
- **Firebase-Security-Rules** — die DB muss für den Client-Import aktuell offen sein
  (`db.ref('scrobbles').remove()` / Root-`update()`). Ohne Rules kann jeder mit der
  öffentlichen Config das Archiv lesen/überschreiben/löschen. `database.rules.json` +
  Anonymous-Auth/App-Check als eigenes, sorgfältiges Vorhaben. _(hard)_
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
- Loved-Tracks-Mini-Liste (`loved`-Status wird bereits geprüft). _(easy)_
- „Rediscovery": früher viel gehörte, zuletzt pausierte Künstler. _(medium)_
- Genre-Tag-Filter: Tags als klickbare Chips zum Filtern der Charts. _(hard)_
- „Mood"-Anzeige je Monat (Plays/Tag → Chill ↔ Obsessed). _(easy)_
- Now-Playing-Kontext: Rang/Plays des laufenden Künstlers diesen Monat. _(medium)_

## Performance
- ✅ `loading="lazy"` für Album-Cover in Listen/Recent. _(umgesetzt)_
- ✅ `preconnect` für Fonts/Last.fm/Firebase, `defer` für html2canvas. _(umgesetzt)_
- Google-Fonts-`woff2` per `<link rel=preload>` vorladen (über preconnect hinaus). _(easy)_
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
