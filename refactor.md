# pi-lens Architecture

## Overview

pi-lens is a pi extension that provides inline linting feedback to the agent as it writes/edits code.

## Core Concepts

### 1. Event Flow

```
session_start     → Show tools, run fast scans, establish baselines
       ↓
tool_call         → Pre-write hints (architectural rules)
       ↓  
tool_result       → Run dispatchers, show inline errors/warnings
       ↓
turn_end          → Batch scans (jscpd, madge), mark error debt check
       ↓
[next session]    → Check error debt, run pending scans
```

### 2. Inline Feedback

- **Who sees it**: Only the agent (you), not the human
- **When**: On every `tool_result` for `write` or `edit` operations
- **What**: Linting errors, warnings, architectural violations
- **Format**: Emoji-prefixed messages (🔴 errors, 🟡 warnings, ✅ fixes)

### 3. Caching

All expensive scans cache their results in `.pi-lens/cache/`:
- **Default TTL**: 30 minutes
- **Cache files**: `{scanner}.json` + `{scanner}.meta.json`
- **Purpose**: Avoid re-running slow scans on every session

| Scanner | Runs At | Cached? |
|---------|---------|---------|
| TODO/FIXME | session_start | No (fast) |
| Knip (dead code) | session_start | Yes |
| jscpd (duplicates) | session_start + turn_end | Yes |
| type-coverage | session_start | Yes |
| exports | session_start | Yes |

### 4. Dispatch System

Per-file linting uses declarative dispatch (`clients/dispatch/`):

```
file → detectFileKind() → getRunnersForKind() → run all runners
```

Runners:
- ts-lsp: TypeScript errors
- biome: JS/TS/JSON lint
- ruff: Python lint
- type-safety: Switch exhaustiveness
- ast-grep: Structural analysis
- architect: Architectural rules
- go-vet: Go lint
- rust-clippy: Rust lint

### 5. Error Ownership

Every session_start shows:

```
📌 Remember: If you find ANY errors (test failures, compile errors, lint issues) in this codebase, fix them — even if you didn't cause them. Don't skip errors as 'not my fault'.
```

### 6. Error Debt (Opt-in)

Flag: `--error-debt`

Tracks test failures across turns:
- session_start: Establish baseline (tests pass/fail)
- turn_end: If files modified, mark pending check
- Next session: Run tests, block if they regressed

Purpose: Prevent accumulation of ignored test failures.

---

## Flags

| Flag | Default | Description |
|------|---------|-------------|
| `lens-verbose` | false | Enable debug logging |
| `no-biome` | false | Disable Biome linting |
| `no-ast-grep` | false | Disable ast-grep |
| `no-ruff` | false | Disable Ruff Python lint |
| `no-lsp` | false | Disable TypeScript LSP |
| `no-madge` | false | Disable circular deps |
| `no-tests` | false | Disable test runner |
| `no-go` | false | Disable Go lint |
| `no-rust` | false | Disable Rust lint |
| `autofix-biome` | false | Auto-fix Biome issues |
| `autofix-ruff` | true | Auto-fix Ruff issues |
| `error-debt` | false | Track test regressions |

---

## Commands

| Command | Description |
|---------|-------------|
| `/lens-metrics` | Show complexity metrics |
| `/lens-format` | Format all files |
| `/lens-booboo` | Full codebase review |
| `/lens-booboo-fix` | Fix booboo issues |
| `/lens-refactor` | Refactor architectural issues |

---

## Key Files

| File | Purpose |
|------|---------|
| `index.ts` | Main extension, event handlers |
| `clients/dispatch/dispatcher.ts` | Per-file lint orchestration |
| `clients/dispatch/runners/*.ts` | Individual lint tools |
| `clients/cache-manager.ts` | Caching layer |
| `clients/file-kinds.ts` | File type detection |
| `clients/sanitize.ts` | Output sanitization |

---

## Testing

```bash
npm test    # Run all tests
npm run build  # Compile TypeScript
```

---

## Previous Refactoring

### Phase 1: Foundation ✅
- Centralized file-kind detection (`clients/file-kinds.ts`)
- Tool output sanitization (`clients/sanitize.ts`)
- Tool availability caching (`clients/tool-availability.ts`)

### Phase 2: Declarative Dispatch ✅
- Replaced ~400 lines of if/else with dispatcher
- Added 8 new runners (ts-lsp, biome, ruff, type-safety, ast-grep, architect, go-vet, rust-clippy)
- Net reduction: 357 lines (-22%)

---

## Future Phases

### Phase 3: Deferred Feedback
- Batch feedback until agent_end
- Reduce per-write latency

### Phase 4: Config Walking
- Centralize config file detection
- Remove duplicated config walking code

### Phase 5: Module Extraction
- Break index.ts into separate files
- Extract command handlers
