# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

### Changed

- Tighter alignment: tabular numerals for stats, dates and hashes; the
  author/date column hides gracefully when the list gets narrow.
- Accessibility: listbox/option semantics with selection state, menu roles,
  and visible focus indicators on all interactive elements.
- Reduced motion preference is respected.

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

[Unreleased]: https://github.com/frontmatters/rebase-buddy/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/frontmatters/rebase-buddy/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/frontmatters/rebase-buddy/releases/tag/v0.1.0
