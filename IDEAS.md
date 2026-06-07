# Ideen-Roadmap

Kuratierte, verifizierte Verbesserungsideen für das Dashboard. Bereits **umgesetzt** in den
letzten PRs: Dark-Glassmorphism-Redesign, CSS/JS-Auslagerung, Hero-Breiten-Fix, Hover ohne
Layout-Shift, Empty-States, entprellte Suche, Toast-Queue, Fokus-Ringe/Skip-Link/ARIA-Live,
Kontrast-Anhebung, Tag×Stunde-Heatmap, Year-over-Year + Jahres-Hochrechnung.

> Hinweis: Der gemeldete „Chart.js-Memory-Leak" ist **kein** Bug — der Code ruft `.destroy()`
> vor jedem neuen Chart (`app.js`). Nicht weiterverfolgen.

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
- `loading="lazy"` für Album-Cover in Listen/Recent. _(easy)_
- Google-Fonts-`woff2` per `<link rel=preload>` vorladen. _(easy)_
- Archiv-Pagination/Chunking für sehr große Sammlungen (10k+). _(hard)_
- Service-Worker: statische Assets + letzter Archiv-Snapshot offline. _(hard)_

## Accessibility
- Modal-Focus-Trap (Tab-Schleife) für Artist-/Archiv-Modal (Escape existiert bereits). _(medium)_
- `role="tablist"`/Pfeiltasten-Navigation für Perioden-/Content-Tabs. _(medium)_
- Muster/Hatching für Rang 1–3 (Farbfehlsichtigkeit). _(medium)_

## Mobile / PWA
- Echte `apple-touch-icon`-PNGs (192/512) + Manifest. _(easy)_
- Artist-Modal als Bottom-Sheet auf Mobile. _(medium)_
- Haptisches Feedback (`navigator.vibrate`) bei Aktionen (Android). _(easy)_
- Gesten-Navigation zwischen Sektionen. _(hard)_

## Code-Qualität / Wartbarkeit
- `Formatters`-Modul (`fmt`/`fmtTime`/`timeAgo` …) auslagern. _(easy)_
- `ChartManager`/`ArchiveStore` zur Bündelung von Chart- bzw. Archiv-Zugriffen. _(hard)_
- Inline-`onclick` schrittweise auf Event-Delegation umstellen. _(medium)_
- `app.js` perspektivisch in `archive.js`/`charts.js`/`ui.js` aufteilen. _(hard)_
