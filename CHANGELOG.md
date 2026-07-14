# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.7.0] - 2026-07-14

### Added

- `rebaseBuddy.showActionHints` (default on): turn off to hide the action
  descriptions in the action menu. The menu then shrinks to the width of the
  action button, with thin dividers between the items; descriptions stay
  available as hover tooltips.

### Fixed

- The enable/disable notifications and the output-channel log prefix still
  said "Rebaser"; they now say "Rebase Buddy". Command ids and the editor
  viewType are unchanged, so existing keybindings and state keep working.

## [0.6.1] - 2026-07-09

### Fixed

- The base commit row now accepts drops: dragging a commit onto it places it
  at the oldest position, directly on top of the base. That slot was
  previously unreachable because the drop indicator always inserts above a row.

## [0.6.0] - 2026-07-09

### Added

- Base commit row: the commit your changes are applied onto is shown greyed
  out and read-only, next to the oldest commit (bottom in newest-first, top in
  oldest-first), like GitLens. Toggle with `rebaseBuddy.showBaseCommit`.

### Changed

- The default display order is now newest first (`rebaseBuddy.defaultOrder`).

### Fixed

- Dragging or Alt-moving a commit in newest-first order landed one row off:
  drops are now computed in view order and land exactly on the drop line.

## [0.5.0] - 2026-07-09

### Added

- Select all commits with Cmd/Ctrl+A; bulk actions and block drag operate
  on the full selection.

## [0.4.0] - 2026-07-09

### Added

- Multi-select in the commit list: Cmd/Ctrl-click toggles rows, Shift-click
  and Shift-arrows select ranges. Setting an action (menu or P R E S F D)
  applies to every selected commit, and dragging a selection moves it as one
  contiguous block, preserving relative order.

### Changed

- The message editor auto-fits its height to the content and grows while
  typing (capped at half the viewport).
- Alignment polish: the commit message and its edit button are optically
  centered, the close button aligns with the panel grid, list columns are
  tighter, and the message editor hint no longer wraps awkwardly.

## [0.3.0] - 2026-07-09

### Added

- Host hardening for message files: strict filename whitelist, symlink
  defence before writes, and state recovery from disk after a reload.
- Inline commit message editing: double-click the message in the details
  panel (or the subject in the list, or use the pencil icon) to rewrite a
  commit message during the rebase, without the COMMIT_EDITMSG editor stop.
  Implemented as `pick` plus a host-constructed
  `exec git commit --amend -F <file>` line; message files live inside
  git-managed `rebase-merge/` (auto-cleanup on finish and abort, survives
  conflict pauses, worktree-safe via `--git-path`). Editing a `reword` row
  converts it to the inline flow; fixup/drop rows are excluded. Edited rows
  show reword styling, an edited chip and one-click revert.

## [0.2.0] - 2026-07-09

### Added

- Resizable panel split: drag the divider between the commit list and the
  detail panel; the width persists per editor session. The commit message
  body is vertically resizable too.
- Custom action dropdown replacing the native select: color-coded actions
  with inline hints, keyboard navigation and smooth open animation.
- Display-order toggle in the list header: oldest first (git's todo order)
  or newest first (log order). Arrow navigation and squash/fixup connectors
  follow the chosen direction; the rebase itself always applies oldest first.
- Squash/fixup validation: the menu disables meld actions when no earlier
  non-dropped commit exists, and if reordering creates an invalid meld the
  row is flagged and Start rebase is blocked with an explanation, instead of
  letting git fail mid-rebase.
- Hover copy button next to each commit hash in the list, copying the full
  commit id with inline confirmation.
- Extension settings: `rebaseBuddy.defaultOrder` (initial list order),
  `rebaseBuddy.detailsWidth` (initial panel width) and
  `rebaseBuddy.confirmAbort` (two-step abort toggle). In-editor changes
  override the defaults per session.
- Collapsible details panel: close button in the panel, a slim edge rail to
  reopen it, and double-click on the splitter to toggle. The open state is
  remembered per session.

### Security

- Menu buttons expose aria-expanded state; the serializer also strips
  control characters from subjects and command lines.
- Hardened the todo serializer and entry validation so webview messages can
  never introduce new command lines: newlines in subjects are flattened and
  `setEntries` only accepts known actions, valid hashes, and command lines
  already present in the document.

### Changed

- Tighter alignment: tabular numerals for stats, dates and hashes; the
  author/date column hides gracefully when the list gets narrow.
- Accessibility: listbox/option semantics with selection state, menu roles,
  and visible focus indicators on all interactive elements.
- Reduced motion preference is respected.
- Explanatory tooltips on every control, including the full keyboard map
  behind the status bar hints and clear Start/Abort consequences.

### Fixed

- Failed commit-detail lookups now surface an error message instead of an
  endless loading state.
- Selecting a command line (`exec`, `break`, …) now explains it has no
  commit details.

## [0.1.1] - 2026-07-09

### Fixed

- Listing README pointed to an internal spec path; design docs now live under
  `docs/specs/`.
- Listing screenshots and test fixtures used non-neutral placeholder
  identities; replaced with `user1`/`user2`.
- Remaining "Rebaser" strings after the rename to Rebase Buddy (webview top
  bar, output channel, repository links).

## [0.1.0] - 2026-07-09

### Added

- Interactive rebase editor: custom editor for git's `git-rebase-todo` file,
  opening automatically on `git rebase -i` once enabled.
- Drag & drop reordering and keyboard controls (`↑↓` select, `⌥↑↓` move,
  `P R E S F D` set action).
- Inline action selection per commit: pick, reword, edit, squash, fixup, drop,
  with squash/fixup rows visually connected to their target.
- Commit details panel: full message, author, date, changed files with
  add/delete stats; binary files and renames included.
- One-click native VS Code diff per file via a virtual git content provider.
- Copy full commit id and open-commit-on-remote (GitHub/Gitea/GitLab) from the
  details panel.
- `Rebase Buddy: Enable`/`Disable` commands that set `git config --global
  sequence.editor` to this VS Code install and restore the previous value.
- Start rebase and two-step abort from the editor; passthrough display for
  `exec`, `break`, `label` and other non-commit todo lines.

### Security

- SHA validation plus `--end-of-options` on all git invocations to prevent
  git option injection from webview-supplied input.
- Webview built without `innerHTML` (XSS-safe by construction) under a strict
  CSP with script nonce.

[Unreleased]: https://github.com/frontmatters/rebase-buddy/compare/v0.6.1...HEAD
[0.6.1]: https://github.com/frontmatters/rebase-buddy/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/frontmatters/rebase-buddy/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/frontmatters/rebase-buddy/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/frontmatters/rebase-buddy/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/frontmatters/rebase-buddy/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/frontmatters/rebase-buddy/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/frontmatters/rebase-buddy/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/frontmatters/rebase-buddy/releases/tag/v0.1.0
