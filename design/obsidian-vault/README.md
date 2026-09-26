# Apple Glass Light 2.6

## Neu in 2.6

- **Performance-Modus:** optionaler Style-Settings-Schalter für lange Notizen,
  große Dashboards und schwächere Geräte. Entfernt Aurora, Blur, komplexe
  Schatten, dekorative Ebenen und Übergänge. Abstände, Rundungen, Kontrast und
  die Apple-Farbsprache bleiben erhalten.
- Der normale Modus bleibt das visuell reichere Standardprofil.

## Neu in 2.3

- **Bewegung:** animierter Überschriften-Verlauf, rotierender Fokus-Rahmen des
  aktiven Bereichs, Shine-Sweep auf Callouts und Codeblöcken beim Hover,
  federnder Checkbox-Haken sowie fließende Akzentbalken (Frontmatter, aktiver Tab).
  Alles wird von „Bewegung reduzieren" automatisch abgeschaltet.


## Neu in 2.2

- **Sprach-Badge** an Codeblöcken (CSS, JS, Python … in der Kopfleiste).
- **Callout-Feinschliff**: weich animierter Klapp-Pfeil für einklappbare Callouts.
- **Editor-Politur**: dezente Hervorhebung der aktiven Zeile, wärmere Textauswahl
  und ein sanftes Einblenden der Leseansicht.


Ein helles Obsidian-Theme im Apple-Stil mit Aurora-Hintergrund, geschichteten
Glasflächen, farbigen Überschriften, „Jewel“-Listenmarkern und klaren
Interaktionszuständen. Version 2.0 wurde mit Obsidian 1.12.7 getestet.

## Neu in 2.1

- **Code-Syntax-Highlighting** in Apple-Farben – für Leseansicht (Prism) und
  Live Preview (CodeMirror).
- **Plugin-Flächen** im Theme-Stil: Tasks (farbige Status & Metadaten-Pills),
  Calendar (Heute/Auswahl/Punkte), Mermaid (Glasrahmen + lesbare Diagramme) und
  Meta-Bind-Felder in Notizen.
- **Seitenleisten-Panels**: Outline, Backlinks, Suchergebnisse, Tag-Pane und
  Graph-View (über die offiziellen `--graph-*`-Variablen).
- **Fußnoten** als Akzent-Pills mit ruhigem Notizen-Abschnitt.

## Installation

Den Ordner `Apple Glass Light` nach
`<Vault>/.obsidian/themes/Apple Glass Light/` kopieren und das Theme unter
**Einstellungen → Erscheinungsbild** auswählen. Das Basisfarbschema bleibt
**Hell**; ein eigener Dark-Modus ist bewusst nicht enthalten.

## Style Settings

- **Akzentfarbe:** Navigation, Fokus und wichtige Aktionen.
- **Systemschrift statt lokalem Inter:** Verwendet ausschließlich die
  Systemschrift. Ohne Schalter wird Inter nur benutzt, wenn es lokal installiert
  ist. Das Theme lädt keine Schrift oder andere Assets aus dem Internet.
- **Performance-Modus:** Schaltet auf das vollständig statische, GPU-schonende
  Darstellungsprofil um. Zu finden unter **Einstellungen → Style Settings →
  Apple Glass Light**.
- **Aurora-Stärke:** Intensität des Hintergrundlichts von 0 bis 100.
- **Inhaltsfläche:** Regelt, wie stark die Aurora durch die Notizfläche scheint.
- **Ordnerliste schlicht:** Schaltet die farbige Finder-Ordnerfolge ab.
- **Glas-Deckkraft:** Deckkraft der zentralen Materialflächen.
- **Ambient-Lichtstärke:** Sichtbarkeit der statischen dekorativen Lichtflächen.
  Die Betriebssystem-Einstellung „Bewegung reduzieren“ wird zusätzlich respektiert.

Bestehende gespeicherte Werte und die CSS-Hooks `home-dash`, `bfw-hub` und
`ag-*` bleiben kompatibel.

## Dashboard und Mobile

Die Home- und BFW-Dashboards verwenden dasselbe Karten-, Fokus- und
Responsive-System. Mobile Regeln sind direkt im Theme enthalten; ein separates
CSS-Snippet ist nicht mehr nötig. Auf mobilen Geräten werden teure Blur-Layer
deaktiviert, während Farbe, Tiefe und Touch-Ziele erhalten bleiben.

Der Home-Bereich benötigt Dataview. Tracker-Daten bleiben unter
`_00Home/_History/Drink_Tracker.json`, die Historie unter
`_00Home/_History/Brew_History.md`.

## Visuelle Prüfung

`Theme-Testseite.md` sammelt Überschriften H1–H6, Listen, Aufgaben, Links,
Tags, Callouts, Tabellen, Code und Embeds. Änderungen sollten sowohl in der
Leseansicht als auch in Live Preview sowie bei schmalem Fenster geprüft werden.
