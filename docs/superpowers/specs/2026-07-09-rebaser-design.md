# Rebaser — Design Spec (Fase 1)

**Datum:** 2026-07-09
**Status:** Goedgekeurd design, fase 1
**Doel:** Gratis, minimalistisch alternatief voor GitLens Pro's interactive rebase editor + commit details, als VS Code-extensie.

## Waarom

GitLens zet de interactive rebase editor en commit graph (deels) achter een Pro-paywall. Rebaser levert de kernfunctionaliteit — interactief rebasen met een GUI en commit details bekijken — in eigen beheer, zonder bloat.

## Fasering

- **Fase 1 (deze spec):** interactive rebase GUI + commit details (diff per commit) binnen de rebase-flow.
- **Fase 2 (later):** commit graph / visuele history als aparte view.
- **Fase 3 (later):** blame / file history.

Elke fase is apart bruikbaar en shipbaar.

## Architectuur

Eén TypeScript VS Code-extensie, twee lagen:

```
┌─ Extension host (Node) ──────────────────────────┐
│  RebaseEditorProvider   GitService                │
│  (CustomTextEditor voor  (spawnt `git` child      │
│   git-rebase-todo)        processes, parst output)│
└───────────────┬──────────────────────────────────┘
                │ postMessage (typed protocol)
┌───────────────▼──────────────────────────────────┐
│  Webview UI (vanilla TS + CSS, geen framework)   │
│  ┌────────────────────┬───────────────────────┐  │
│  │ Commit-lijst       │ Detail-paneel         │  │
│  │ (drag & drop,      │ (message, author,     │  │
│  │  actie-dropdown)   │  datum, file-lijst)   │  │
│  └────────────────────┴───────────────────────┘  │
└──────────────────────────────────────────────────┘
```

### Kernprincipes

1. **Git blijft de uitvoerder.** De extensie registreert een `CustomTextEditor` op `**/rebase-merge/git-rebase-todo`. De GUI is een slimme editor voor dat tekstbestand — geen eigen rebase-engine, geen libgit2.
2. **Het todo-bestand is de single source of truth.** Elke UI-wijziging wordt direct als tekst teruggeschreven naar het TextDocument via `WorkspaceEdit`. Undo/redo werkt daardoor gratis mee.
3. **Geen dependencies** behalve de VS Code API. Repo-data komt uit `git` child processes met NUL-gescheiden formaten (`git log --format=%H%x00%an%x00...`, `git show --stat`).
4. **Native theming.** Uitsluitend `--vscode-*` CSS-variabelen (dark/light automatisch), codicons voor iconen. Flat, dunne borders, geen emojis.

## Componenten

### Extension host

- **`RebaseEditorProvider`** — implementeert `vscode.CustomTextEditorProvider`, geregistreerd op filename-pattern `**/rebase-merge/git-rebase-todo` (alleen interactieve rebases gebruiken dit pad). Parst todo-regels naar een model, stuurt state naar de webview, vertaalt webview-mutaties terug naar tekst-edits.
- **`GitService`** — voert `git`-commando's uit als child process in de repo-root (afgeleid van het todo-bestandspad: twee niveaus omhoog vanaf `.git/rebase-merge/`). Levert per SHA: volledige message, author, datum, gewijzigde bestanden met +/- stats.
- **`TodoParser`** — puur, testbaar: todo-tekst ↔ model (regels: `pick|reword|edit|squash|fixup|drop <sha> <subject>`, comments, lege regels; `break`/`exec`/`label` e.d. worden ongewijzigd doorgelaten en read-only getoond).
- **Commands:**
  - `rebaser.enable` — zet `git config --global sequence.editor "code --wait"`.
  - `rebaser.disable` — verwijdert die config-waarde weer (`git config --global --unset sequence.editor`).

### Webview UI

- **Commit-lijst** — één rij per todo-entry: actie-dropdown (pick/reword/edit/squash/fixup/drop), SHA (kort), subject, author, relatieve datum. Herordenen via drag & drop én Alt+↑/↓. Selectie via klik of pijltjestoetsen.
- **Detail-paneel** — bij selectie: volledige commit message, author, datum, file-lijst met +/- stats. Klik op een bestand → opent VS Code's native diff-editor via `vscode.diff` met twee `git show`-URI's (eigen `TextDocumentContentProvider` met scheme `rebaser-git`). Geen eigen diff-renderer.
- **Actiebalk** — knoppen **Start Rebase** en **Abort**, plus een waarschuwingsregel dat de tab sluiten zonder actie gelijkstaat aan Start.

### Message-protocol (extension ↔ webview)

Typed messages, gedeelde TypeScript-types in `src/shared/`:

- extension → webview: `init { entries, repoInfo }`, `commitDetails { sha, details }`, `externalEdit { entries }` (bij wijziging van het document buiten de webview om).
- webview → extension: `ready`, `moveEntry { from, to }`, `setAction { index, action }`, `selectCommit { sha }`, `openDiff { sha, path }`, `start`, `abort`.

## Dataflow (happy path)

1. Eenmalig: gebruiker draait command **"Rebaser: Enable"**.
2. `git rebase -i <ref>` (terminal, Claude Code, waar dan ook) → git schrijft `.git/rebase-merge/git-rebase-todo` → VS Code opent het via `code --wait` → custom editor claimt de tab.
3. Provider parst de todo-regels en haalt per commit metadata op via `GitService`; webview rendert de lijst (metadata mag async nadruppelen).
4. Gebruiker herordent, kiest acties, bekijkt details/diffs.
5. **Start Rebase** → document opslaan + tab sluiten → `code --wait` keert terug → git voert de rebase uit.
6. **Abort** → alle regels worden comments (`# pick ...`) → opslaan + sluiten → git ziet een lege todo en breekt af met "Nothing to do".

## Error handling

| Situatie | Gedrag |
|---|---|
| Conflict tijdens rebase | Git stopt zelf; VS Code's ingebouwde merge-conflict-UI neemt over. Onze editor is dan al gesloten — bewust geen eigen conflict-flow. |
| Reword/squash-message | Git opent `COMMIT_EDITMSG` in de normale editor — native flow, fase 1 laat dat zo. |
| Tab gesloten zonder Start/Abort | Gedraagt zich als Start met de huidige staat (standaard `--wait`-gedrag). De UI waarschuwt hiervoor permanent in de actiebalk. |
| Commit-metadata niet ophaalbaar (bijv. `--root`, shallow clone, onparsebare output) | Rij toont alleen SHA + todo-regel; editor blijft volledig functioneel. |
| `git`-commando faalt | Foutmelding in detail-paneel, nooit een crash van de editor; stderr naar een output channel voor debugging. |
| Onbekende todo-regeltypes (`exec`, `break`, `label`, `merge`, …) | Ongewijzigd doorgelaten, read-only getoond op hun positie. |

## Testen & verificatie

- **Unit tests (vitest)** voor `TodoParser` (tekst ↔ model, round-trip) en de `GitService`-outputparsers. Daar zitten de verwachte bugs.
- **`scripts/fixture-repo.sh`** — genereert een wegwerp-repo met 8 commits en een branch voor handmatige en integratietests.
- **Visuele verificatie (verplicht):** extensie draaien in de Extension Development Host, echte rebase op de fixture-repo, screenshots van de webview in light én dark mode vóór iets "klaar" heet.

## Buiten scope (fase 1)

Commit graph, blame, autosquash-detectie (`fixup!`), in-webview diff-preview, multi-repo, Marketplace-publicatie (lokale `.vsix` volstaat), eigen conflict-afhandeling, message-editing in de GUI.

## Projectstructuur

```
rebaser/
├── package.json          # extensie-manifest + esbuild scripts
├── src/
│   ├── extension.ts      # activatie, registraties
│   ├── rebaseEditor.ts   # RebaseEditorProvider
│   ├── gitService.ts     # git child processes + parsers
│   ├── todoParser.ts     # todo-tekst ↔ model (puur)
│   └── shared/messages.ts# typed protocol
├── media/                # webview: main.ts, styles.css (gebundeld)
├── scripts/fixture-repo.sh
└── test/                 # vitest unit tests
```
