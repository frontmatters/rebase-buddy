# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/frontmatters/rebase-buddy/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/frontmatters/rebase-buddy/releases/tag/v0.1.0
