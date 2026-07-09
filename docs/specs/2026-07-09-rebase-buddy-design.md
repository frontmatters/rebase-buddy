# Rebase Buddy — Design Spec (Phase 1)

> Historical document; written under the working title "Rebaser", renamed to
> **Rebase Buddy** (`frontmatters.rebase-buddy`) at publication.

**Date:** 2026-07-09
**Status:** Approved design, phase 1
**Goal:** Free, minimal alternative to GitLens Pro's interactive rebase editor + commit details, as a VS Code extension.

## Why

GitLens puts the interactive rebase editor and commit graph (partially) behind a Pro paywall. Rebase Buddy delivers the core functionality — interactive rebasing with a GUI and inspecting commit details — self-owned, without bloat.

## Phasing

- **Phase 1 (this spec):** interactive rebase GUI + commit details (diff per commit) within the rebase flow.
- **Phase 2 (later):** commit graph / visual history as a separate view.
- **Phase 3 (later):** blame / file history.

Each phase is independently usable and shippable.

## Architecture

One TypeScript VS Code extension, two layers:

```
┌─ Extension host (Node) ──────────────────────────┐
│  RebaseEditorProvider   GitService                │
│  (CustomTextEditor for   (spawns `git` child      │
│   git-rebase-todo)        processes, parses)      │
└───────────────┬──────────────────────────────────┘
                │ postMessage (typed protocol)
┌───────────────▼──────────────────────────────────┐
│  Webview UI (vanilla TS + CSS, no framework)     │
│  ┌────────────────────┬───────────────────────┐  │
│  │ Commit list        │ Detail panel          │  │
│  │ (drag & drop,      │ (message, author,     │  │
│  │  action dropdown)  │  date, file list)     │  │
│  └────────────────────┴───────────────────────┘  │
└──────────────────────────────────────────────────┘
```

### Core principles

1. **Git stays the executor.** The extension registers a `CustomTextEditor` on `**/rebase-merge/git-rebase-todo`. The GUI is a smart editor for that text file — no custom rebase engine, no libgit2.
2. **The todo file is the single source of truth.** Every UI change is written straight back to the TextDocument as text via `WorkspaceEdit`. Undo/redo comes for free.
3. **No dependencies** beyond the VS Code API. Repo data comes from `git` child processes with NUL-separated formats (`git log --format=%H%x00%an%x00...`, `git show --stat`).
4. **Native theming.** Exclusively `--vscode-*` CSS variables (dark/light automatic), inline SVG icons. Flat, thin borders, no emojis.

## Components

### Extension host

- **`RebaseEditorProvider`** — implements `vscode.CustomTextEditorProvider`, registered on filename pattern `**/rebase-merge/git-rebase-todo` (only interactive rebases use this path). Parses todo lines into a model, sends state to the webview, translates webview mutations back into text edits.
- **`GitService`** — runs `git` commands as child processes. The repo root is resolved robustly from the todo file path: `git --git-dir=<dir-above-rebase-merge> rev-parse --show-toplevel`, falling back to the `gitdir` file (linked worktrees) and finally two levels up. Delivers per SHA: full message, author, date, changed files with +/- stats. Fetched metadata is cached per SHA for the session.
- **`TodoParser`** — pure, testable: todo text ↔ model (lines: `pick|reword|edit|squash|fixup|drop <sha> <subject>`, comments, blank lines; `break`/`exec`/`label` etc. are passed through unchanged and shown read-only).
- **Commands:**
  - `rebaser.enable` — stores the current `sequence.editor` value (in `globalState`), then sets `git config --global sequence.editor "code --wait"`.
  - `rebaser.disable` — restores the stored previous value, or unsets the config when there was none.

### Webview UI

- **Commit list** — one row per todo entry: action dropdown (pick/reword/edit/squash/fixup/drop), short SHA, subject, author, relative date. Reorder via drag & drop and Alt+↑/↓. Selection via click or arrow keys.
- **Detail panel** — on selection: full commit message, author, date, file list with +/- stats. Clicking a file opens VS Code's native diff editor via `vscode.diff` with two `git show` URIs (custom `TextDocumentContentProvider` with scheme `rebaser-git`). No custom diff renderer.
- **Action bar** — **Start Rebase** and **Abort** buttons, plus a warning line that closing the tab without action equals Start.

### Message protocol (extension ↔ webview)

Typed messages, shared TypeScript types in `src/shared/`:

- extension → webview: `init { entries, repoInfo }`, `commitDetails { sha, details }`, `externalEdit { entries }` (on document changes outside the webview; debounced ~150 ms so an external editor session never renders stale intermediate states).
- webview → extension: `ready`, `moveEntry { from, to }`, `setAction { index, action }`, `selectCommit { sha }`, `openDiff { sha, path }`, `start`, `abort`.

## Data flow (happy path)

1. One-time: user runs the **enable** command.
2. `git rebase -i <ref>` from any terminal → git writes `.git/rebase-merge/git-rebase-todo` → VS Code opens it via `code --wait` → the custom editor claims the tab.
3. The provider parses the todo lines and fetches metadata per commit via `GitService`; the webview renders the list (metadata may trickle in asynchronously).
4. The user reorders, picks actions, inspects details/diffs.
5. **Start Rebase** → save document + close tab → `code --wait` returns → git executes the rebase.
6. **Abort** → all lines become comments (`# pick ...`) → save + close → git sees an empty todo and aborts with "Nothing to do".

## Error handling

| Situation | Behavior |
|---|---|
| Conflict during rebase | Git stops on its own; VS Code's built-in merge conflict UI takes over. Our editor is already closed — deliberately no custom conflict flow. |
| Reword/squash message | Git opens `COMMIT_EDITMSG` in the normal editor — native flow, phase 1 leaves it alone. |
| Tab closed without Start/Abort | Behaves as Start with the current state (standard `--wait` behavior). The UI warns about this permanently in the action bar. |
| Commit metadata unavailable (e.g. `--root`, shallow clone, unparseable output) | Row shows only SHA + todo line; the editor stays fully functional. |
| `git` command fails | Error message in the detail panel, never an editor crash; stderr goes to an output channel for debugging. |
| Unknown todo line types (`exec`, `break`, `label`, `merge`, …) | Passed through unchanged, shown read-only in place. |

## Testing & verification

- **Unit tests (vitest)** for `TodoParser` (text ↔ model, round-trip) and the `GitService` output parsers. That is where the expected bugs live.
- **`scripts/fixture-repo.sh`** — generates a throwaway repo with 8 commits and a branch for manual and integration testing.
- **Visual verification (mandatory):** run the extension in the Extension Development Host, do a real rebase on the fixture repo, screenshot the webview in light and dark mode before calling anything "done".

## Out of scope (phase 1)

Commit graph, blame, autosquash detection (`fixup!`), in-webview diff preview, multi-repo, marketplace publication (local `.vsix` suffices), custom conflict handling, message editing in the GUI.

## Project structure

```
rebase-buddy/
├── package.json          # extension manifest + esbuild scripts
├── src/
│   ├── extension.ts      # activation, registrations
│   ├── rebaseEditor.ts   # RebaseEditorProvider
│   ├── gitService.ts     # git child processes + parsers
│   ├── todoParser.ts     # todo text ↔ model (pure)
│   └── shared/messages.ts# typed protocol
├── media/                # webview: main.ts, styles.css (bundled)
├── scripts/fixture-repo.sh
└── test/                 # vitest unit tests
```
