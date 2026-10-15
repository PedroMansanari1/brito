# Changelog

## Unreleased

### Added
- **Images by drag and drop.** Dropping an image file onto the terminal (or typing/pasting its path, quoted, backslash-escaped or `file://`) attaches it to the turn, like Claude Code. PNG, JPEG, GIF and WebP up to 5 MB, at most 5 per message. The prompt shows a short `[imagem #1: name.png]` marker instead of the long path. With an API key the image goes to the model as an `image` block; with the `claude` CLI backend Brito grants Read access to the image's folder and tells the model to open it. Images no longer inflate the context estimate (they would have triggered compaction on every turn).

## 0.4.0 — 2026-10-15

### Added
- **Autonomous skill learning** (`BRITO_SKILLS=auto`, now the default; `ask` keeps the old approve-everything flow, `off` disables learning). The reflection after a turn saves new skills *in trial* without asking. Each later turn that loads a trial skill counts as a win (no error-then-fix, no user correction) or a loss: 3 wins promote it to active, 2 losses (without more wins) or 21 idle days archive it to `.brito/skills/.trash`. An active automatic skill is archived if it starts failing (3+ losses above its wins).
- Safety rails: automatic skills are project-scoped only; at most 3 new ones per day; a change to a skill you approved, or any content with destructive commands, goes to `/skills pending` instead; the lint still applies; a weekly automatic consolidation (6+ skills) only merges or prunes automatic skills.
- Skill front matter gains `status` (`trial`/`active`), `origin` (`auto`/`manual`), `wins` and `losses`; old skills read as active and manual. `/skills` shows the score; the skills index tags trial skills "(em teste)".
- `brito --version` / `-v`.

### Changed
- Skills approved by a human (`/skills approve`, `skill_save` with approval) are always `active` and `manual`, and are never promoted, archived or rewritten automatically.

### Fixed (Windows)
- Approvals through the `claude` CLI backend no longer hang: the approval server listened on a unix socket in `%TEMP%`, which Windows does not accept. It now uses a named pipe (`\\.\pipe\brito-approve-<pid>`).
- The `claude` installed through npm (a `claude.cmd` shim) is now found and run, so the subscription backend no longer disappears silently. Brito resolves the shim's real target instead of using `shell: true`, which would break the quoting of the system prompt and the MCP config.
- The `bash` tool and `!command` use Git Bash when it is installed (or `BRITO_SHELL`), and the model is told when the shell is `cmd.exe`.
- Ctrl+C during a turn is reported as "interrupted" instead of an error (Windows kills the child without a signal).
- The "path outside the project" check compared strings with `startsWith`, which rejected valid paths when the drive letter or directory casing differed (`C:\` vs `c:\`) and accepted sibling directories sharing a prefix (`/proj-x` inside `/proj`) on every system. It now uses `path.relative`.
- Windows is now a documented target (see README); it has so far been exercised only by fixtures and one user report.

## 0.3.2 — 2026-10-11

### Fixed
- Two Brito processes on the same project no longer crash with a raw Kùzu stack trace (`Could not set lock on file`). The graph database accepts one process at a time, so opening it now waits up to 4 s for the other process to let go (covers short overlaps) and, if it is still busy, exits with a clear message saying another Brito (another terminal, or a Claude Code session using Brito) is using the project.

## 0.3.1 — 2026-10-11

### Changed
- New startup banner: the name BRITO over a web (rings, spokes and nodes — half spider web, half graph) generated at runtime. On windows of 95+ columns and 28+ rows the web fills the whole terminal with the panel on top; smaller windows keep the compact banner with a small web, and narrow ones only the panel. `BRITO_BANNER=compact|full` overrides it. Purple tones only (follows `BRITO_COLOR`), fading from light at the center to dark at the edge.

## 0.3.0 — 2026-10-11

### Changed
- **License changed from MIT to [PolyForm Noncommercial 1.0.0](LICENSE).** Free for personal, research, educational and other noncommercial use; commercial use is not permitted. Versions up to and including 0.2.0 were released under MIT.

## 0.2.0 — 2026-10-11

### Packaging
- Published on npm as **`brito-cli`** (`npm i -g brito-cli`); the command is still `brito`. The unscoped name `brito` is blocked by npm's similar-name rule.

### Added
- Code graph for backend languages: **Java** (`.java`), **Kotlin** (`.kt`), **Go** (`.go`), **Ruby** (`.rb`), **PHP** (`.php`), **C#** (`.cs`) and **Rust** (`.rs`), alongside TypeScript/JavaScript, Python and `.svelte/.vue/.astro`.
  - Symbols: classes, interfaces, structs, traits, enums, modules, functions and methods (`Class.method`).
  - Imports are resolved by package/namespace/module against the end of your files' paths (Java/Kotlin packages, PHP PSR-4, Rust `use crate::`, Ruby `require`/`require_relative`, Go via the `go.mod` module path). External packages create no edges.
  - Calls: `this`/`self`/receivers resolve to the enclosing class, bare calls inside a class try the class's own methods first, and a receiver is matched to a project type by name (`userRepository.save()` → `UserRepository.save`). There is no type inference.
- `target`, `vendor`, `obj`, `.gradle`, `*.pb.go`, `*.g.cs` and `*.Designer.cs` are skipped when indexing outside git.
- `src/graph/langs.ts` documents how to add another language.

### Changed
- An import can resolve to several files (e.g. a Go package), producing one `IMPORTS` edge per file.
- Type-name matching for receivers also applies to TypeScript/JavaScript/Python calls.

### Known limits
- No type inference; interface calls do not reach implementations.
- Ruby: bare identifiers without parentheses are not read as calls; autoload and metaprogramming are not captured.
- C#: `using` matches directories with at least 2 segments.
- Go: only the root `go.mod` is read.
- Validated on synthetic fixtures only, not yet on large real-world repositories.
