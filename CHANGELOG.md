# Changelog

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
