# pi-lens Feature Ideas

## Active Priorities

### 1. Pre-write Duplication Warnings + Cache Refresh
**Priority:** High  
**Effort:** Medium  
**Inspired by:** pi-continuous-learning signal caching; pi-lens gap analysis

Two-part fix for duplication detection:

#### Part A: Pre-write warning (like TypeScript errors)
In `tool_call` handler, check new content against `cachedJscpdClones`. If new code matches an existing duplicate block, show warning before write executes:

```
🔴 STOP — this edit contains 15 lines that already exist in helpers.ts:20-35.
Extract to a shared utility first.
```

#### Part B: Async cache refresh via `turn_end` with State Persistence
Currently jscpd and madge caches go stale after writes. Fix:

**State structure (persisted to `.pi-lens/turn-state.json`):**
```json
{
  "files": {
    "src/utils.ts": {
      "modified_ranges": [{"start": 10, "end": 25}],
      "imports_changed": true,
      "last_edit": "2026-03-27T14:20:00Z"
    }
  },
  "turn_cycles": 0,
  "max_cycles": 3
}
```

**Flow:**
- `tool_result`: parse edit range from event, accumulate `modified_ranges` per file, persist to `turn-state.json` (no jscpd/madge)
- `turn_end`: run jscpd once on all collected files, filter results to `modified_ranges` only; run madge on files with `imports_changed: true`; increment `turn_cycles`
- `max_cycles` guard: after 3 turns with unresolved issues, force-through to avoid blocking
- `next tool_call`: load state, check cache against modified ranges

**Benefits:**
- Survives context compaction and agent crashes
- Filter jscpd/madge results to only modified lines (not entire file)
- Track exact line ranges for more precise diagnostics
- Safety guard prevents infinite blocking

---

### 2. Async Background Scanners + Cache
**Priority:** High  
**Effort:** Low-Medium  
**Inspired by:** pi-continuous-learning background analyzer

Run scans async at session start — zero latency, results populate cache when ready.

**Current behavior:** All scanners run synchronously at session start, blocking the session until complete.

**Proposed behavior:**
- `session_start`: fire off knip, jscpd, type-coverage, madge as background processes (non-blocking)
- Session starts immediately with no scan latency
- Scans complete async → write results to `.pi-lens/cache/{scanner}.json`
- Pre-write hints and `/lens-booboo` read from cache when available
- If scan not finished yet: skip hint or show "⏳ knip scan running..."
- `turn_end` (jscpd only): re-scan edited files, merge into cache, persist to disk
- Add `--force` flag to `/lens-booboo` to bypass cache

**Lifecycle:**
```
session_start → fire background scans (non-blocking), session ready immediately
tool_call → check in-memory cache for pre-write hints (may be empty if scan pending)
turn_end → refresh jscpd cache for edited files, persist to disk
scan_complete → populate cache, subsequent tool_calls get full hints
```

**Cache structure:**
```
.pi-lens/cache/
├── knip.json          # Dead code results
├── knip.meta.json     # { timestamp, scanDurationMs }
├── jscpd.json         # Duplicate blocks (refreshed via turn_end)
├── jscpd.meta.json
├── type-coverage.json # Type coverage stats
├── type-coverage.meta.json
├── madge.json         # Circular dependencies
└── madge.meta.json
```

**Implementation notes:**
- Use `child_process.fork()` or `spawn()` for background scans
- Track scan state in memory: `{ status: "pending" | "running" | "complete", result?: ScanResult }`
- On scan complete: write to disk, update in-memory cache
- Pre-write handler checks state: if pending → skip hint; if complete → use cache

---

### 3. Persistent False-Positive Patterns
**Priority:** High  
**Effort:** Low-Medium  
**Inspired by:** pi-continuous-learning confidence tracking

Extend the current per-session false-positive tracking (fix-session.json) into a persistent `.pi-lens/false-positives.json` with pattern matching.

**Current behavior:** False positives are lost between sessions. User marks `no-single-char-var:src/utils.ts:42` as FP, next session same rule triggers again for similar code.

**Proposed behavior:**
- Persist false positives to `.pi-lens/false-positives.json` with:
  - Rule name
  - File glob pattern (not just exact path)
  - Code pattern signature (AST-based)
  - Dismissal count
- After N dismissals (3-5), auto-suppress matching violations
- Surface suppressed count in `/lens-booboo-fix` output: "🔇 Suppressed 7 items based on 3 previous dismissals"
- Add `/lens-fp-clear` command to reset patterns

**Example false-positive entry:**
```json
{
  "rule": "no-single-char-var",
  "pattern": "for (let i = 0; i < length; i++)",
  "fileGlob": "src/utils/*.ts",
  "dismissedCount": 4,
  "firstDismissed": "2026-03-15T10:30:00Z",
  "lastDismissed": "2026-03-27T14:20:00Z"
}
```

---

### 4. Rule Importance Scoring (1-10) + Confidence Tracking
**Priority:** High  
**Effort:** Medium  
**Inspired by:** pi-continuous-learning confidence.ts, brandonros/skills importance scale

Two-part system: **static importance** (rule definition) + **dynamic confidence** (learned from behavior).

#### Part A: Static Importance Score (1-10)
Each rule gets an importance score at definition time:

| Score | Meaning | Examples |
|-------|---------|----------|
| 10 | Security/correctness critical | `no-eval`, `no-hardcoded-secrets` |
| 8-9 | Likely bug | `strict-equality`, `no-return-await` |
| 5-7 | Quality improvement | `no-console-log`, `prefer-template` |
| 2-4 | Style preference | `no-single-char-var`, `no-lonely-if` |

Output shows importance badge:
```
🔴 [10/10] no-eval — eval() allows arbitrary code execution
🟠 [5/10] no-console-log — Remove console.log before shipping
🟡 [2/10] no-single-char-var — Use descriptive variable names
```

#### Part B: AUTO-FIX vs ASK Classification
Each rule classified as fixable by agent without judgment:

```
AUTO-FIX: no-eval, no-debugger, no-console-log, no-return-await
          → Agent can fix immediately, no discussion needed

ASK:      no-as-any, long-method, large-class, no-shadow
          → Requires understanding context, propose fix and wait
```

#### Part C: Dynamic Confidence (Learned)
Track per-project in `.pi-lens/rule-stats.json`:
```json
{
  "no-single-char-var": {
    "fixRate": 0.12,
    "dismissRate": 0.85,
    "fixAccuracy": 0.95,
    "observations": 47
  }
}
```

- **fixRate** — % of times agent actually fixed it
- **dismissRate** — % of times marked as FP
- **fixAccuracy** — % of fixes that stayed fixed (not reverted)

**Confidence effects:**
- dismissRate > 80% → suppress in inline output, only show in `/lens-booboo`
- dismissRate > 95% → auto-suppress, show count: "🔇 Suppressed 7 no-single-char-var"
- fixRate > 90% → mark as AUTO-FIX if not already
- Low observations (<10) → no confidence adjustment (too early)

**Storage:** `.pi-lens/rule-stats.json` (persisted, survives session)

---

### 5. Code Examples in ast-grep Rule Messages
**Priority:** Medium  
**Effort:** Low  
**Inspired by:** aicode-toolkit RULES.yaml codeExample pattern

Show ✓ GOOD / ✗ BAD code snippets in violation messages, so the agent knows exactly how to fix.

**Current:** `no-return-await: Remove the unnecessary return await`

**Proposed:**
```
🔴 no-return-await — Remove the unnecessary return await
  ✗ return await fetch(url)
  ✓ return fetch(url)
```

**Implementation:** Add `codeExample` field to each ast-grep rule YAML in `rules/ast-grep-rules/rules/`. Parser reads it and includes in diagnostic output.

**Example rule file (no-return-await.yml):**
```yaml
id: no-return-await
language: typescript
severity: error
message: |
  Remove the unnecessary `return await`
  ✗ return await fetchData()
  ✓ return fetchData()
note: 'await in a return statement is redundant — the Promise is awaited either way'
```

**Affected files:** ~60 rule YAML files in `rules/ast-grep-rules/rules/`

---

### 6. Agent Behavior Analysis (Blind Writes + Thrashing)
**Priority:** High  
**Effort:** Low  
**Inspired by:** pi-eval methodology scoring

Track tool call sequences and flag anti-patterns in real-time.

#### Part A: Blind Write Detection
Flag writes/edits that happen without a preceding read in the last 5 tool calls.

```typescript
const WRITE_OPS = ["edit", "write", "multiedit"];
const READ_OPS = ["read", "bash", "grep", "glob", "find", "rg"];
```

Output:
```
⚠ BLIND WRITE — edited utils.ts without reading it first
```

**Implementation:** In `tool_result`, maintain rolling window of last 5 tool names. Check if write/edit has a read in the window.

#### Part B: Thrashing Detection
Flag 3+ consecutive identical tool calls with no intervening code changes.

Output:
```
🔴 THRASHING — 4 consecutive test runs with no code changes. Fix failing test instead of re-running.
```

**Implementation:** Track consecutive identical tool names in `tool_result`. Reset counter when a different tool is used or when file content changes.

---

### 7. Learn from Refactor Decisions
**Priority:** High  
**Effort:** Medium

After `/lens-booboo-refactor` completes, capture the architectural decision as a learned rule for `architectural.yaml`.

**Flow:**
```
refactor → identify worst offender → interview → user picks option → implement
                                                              ↓
                                                    agent reflects: 
                                                    "what rule did we just apply?"
                                                              ↓
                                                    propose rule to user
                                                              ↓
                                                    user approves → append to architectural.yaml
```

**Example interaction:**
```
🏗️ REFACTOR COMPLETE

Changes:
  - Extracted validateInput(), transformData(), formatOutput()
  - Original: 291 lines, cognitive 1590 → New: 3× functions, avg cognitive 45

📏 LEARNED RULE — add to architectural.yaml?

  "Functions exceeding 100 cognitive complexity should be decomposed"
  
  Scope: services/**/*.ts
  Source: services/order.ts refactor

  [Approve] [Edit] [Skip]
```

**Storage in architectural.yaml:**
```yaml
learned:
  - id: "extract-long-functions-20260327"
    pattern: "Functions with cognitive complexity > 100"
    scope: "services/**/*.ts"
    source: "refactor"
    trigger_file: "services/order.ts"
    confidence: 1
    created: "2026-03-27T14:20:00Z"
```

**Enforcement:**
- Pre-write hints: "⚠ This function has complexity 120 (learned threshold: 100)"
- `/lens-booboo`: surface learned rules with confidence scores
- Confidence increases with each similar decision; decays if never triggered

**No extra LLM call needed** — agent already knows: (1) what was the problem, (2) what was chosen, (3) what was done. Rule generation is just reflecting on the refactor.

---

### 8. Test-First Enforcement (Pre-write Hints)
**Priority:** High  
**Effort:** Medium

Enforce test discipline at the tool level — warn when creating/editing source files without corresponding test updates.

#### Part A: New file without test
When a new source file is written, check if a matching test file exists:

```
⚠ NO TEST — src/services/order.ts created without test file
  Suggested: src/services/order.test.ts
  [Create test file] [Skip] [Dismiss for *.ts]
```

**Pattern matching:**
- `src/services/order.ts` → expect `src/services/order.test.ts` or `src/services/order.spec.ts`
- `src/utils/format.ts` → expect `src/utils/format.test.ts`
- Configurable scope: `src/services/**` (strict) vs `src/utils/**` (exempt)

#### Part B: Source edited, tests not updated
When a source file is edited but its test file wasn't also edited in the turn:

```
⚠ TESTS NOT UPDATED — src/services/order.ts edited, but order.test.ts unchanged
  [Run tests] [Skip] [Dismiss for session]
```

If tests are run and fail:
```
🔴 TESTS FAILING — 2 test(s) fail in order.test.ts
  ✓ should process valid order
  ✗ should reject negative quantities (expected 400, got 200)
  ✗ should apply discount (expected total 90, got 100)
```

#### Part C: Learned rule (from #7)
After multiple edits without test updates, propose as architectural rule:
```
📏 LEARNED RULE — add to architectural.yaml?

  "Source files in src/services/** must have corresponding test files"
  
  Scope: src/services/**/*.ts
  Source: 7 edits without test updates in this session

  [Approve] [Edit] [Skip]
```

**Configuration in architectural.yaml:**
```yaml
test_enforcement:
  - pattern: "src/services/**/*.ts"
    require_test: true
    test_patterns: ["*.test.ts", "*.spec.ts"]
    exempt: false
  - pattern: "src/utils/**/*.ts"
    require_test: false  # Exempt - pure functions
```

---

## Backlog

### 9. Delta Complexity Warnings in Pre-Write
**Priority:** Low  
**Effort:** Medium

When editing a function, show complexity delta: "⚠️ `calculateScore()` cognitive complexity increased from 42→58 (+38%)"

Requires snapshotting file-level metrics on edit and diffing them.

---

*Last updated: 2026-03-27*
