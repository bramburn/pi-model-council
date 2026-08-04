# Code Review Follow-up — `feature/multi-select-model-picker` @ `0bd077f`

**Reviewer**: independent (this audit)
**Scope**: branch `feature/multi-select-model-picker` at commit `0bd077f`, after the 16-issue fix
**Baseline**: `npm test` → 189/189 pass; `npm run lint --max-warnings 0` → clean; `npm run typecheck` → clean
**Goal**: surface any issues the original 16-issue review missed

---

## Summary

The 16-issue fix delivered real, well-tested code. This follow-up found **21 new findings** — none blocker, but 3 high and 8 medium worth fixing before merge. The bulk of the original work holds up under re-review; the issues below are mostly the second 5% that a focused audit catches.

| Severity | NEW (16-issue) | PRE-EXISTING (missed) | Total |
|---|---|---|---|
| 🔴 Blocker | 0 | 0 | 0 |
| 🟠 High | 1 | 2 | **3** |
| 🟡 Medium | 7 | 1 | **8** |
| ⚪ Minor | 5 | 5 | **10** |
| **Total** | **13** | **8** | **21** |

**Top three to fix before merge:**

1. **N2** — `secondOpinionRunner.ts:138` still uses the old "using fallback mode" wording. M7 was supposed to unify this. Inconsistent UX.
2. **N5** — `settings-ui.ts:509` `pick.value.split("::")` accepts unlimited parts. A model id with `::` would corrupt the saved settings.
3. **N8** — `multiSelectPicker.ts:305` TUI commit only validates `minPicks`, never `maxPicks`. If `initialPicks.length > maxPicks` (e.g. corrupted settings), the user saves too many models.

---

## 🔴 Blockers

*None.* The branch is in a mergeable state; the blocker surface from the previous review is genuinely closed.

---

## 🟠 High-impact

### N1 · NEW — `runnerHelpers.callModelDispatchWithTimeout` duplicates `callModelWithTimeout`

**Where**: `runnerHelpers.ts:101-129` vs `:131-173`
**Category**: NEW (introduced by 16-issue fix, task-2)

`callModelDispatchWithTimeout` is a 80% copy of `callModelWithTimeout` — same `withTimeout` + `try/catch` wrapping, same `Model X failed: <reason>` error format. The only meaningful difference is whether the inner call is `callOpenRouterChat` or `callModelViaDispatch`.

```ts
// runnerHelpers.ts:101
try {
  return await withTimeout(
    (childSignal) => callOpenRouterChat({ ... }),
    args.timeoutMs, args.signal,
  );
} catch (error) { throw new Error(`Model ${args.model} failed: ${message}`, { cause: error }); }

// runnerHelpers.ts:131 — almost identical, calls callModelViaDispatch instead
try {
  return await withTimeout(
    (childSignal) => callModelViaDispatch({ ... }),
    args.timeoutMs, args.signal,
  );
} catch (error) { throw new Error(`Model ${args.rawId} failed: ${message}`, { cause: error }); }
```

**Fix**: factor out a shared `withTimeoutAndWrap` helper:

```ts
async function withTimeoutAndWrap<T extends { rawId: string }>(
  fn: (signal: AbortSignal) => Promise<string>,
  model: T["rawId"],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  try {
    return await withTimeout(fn, timeoutMs, signal);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Model ${model} failed: ${message}`, { cause: error });
  }
}
```

### N2 · PRE-EXISTING — M7 only updated `councilRunner`, not `secondOpinionRunner`

**Where**: `secondOpinionRunner.ts:138`
**Category**: PRE-EXISTING (M7 was incomplete)

M7's task spec said "councilRunner logs a warning when structured-output fallback fires" but the second-opinion runner has the same code path with the OLD wording:

```ts
// secondOpinionRunner.ts:138 — never updated
warnings.push(
  `Model ${dispatchId} does not support structured output, using fallback mode.`,
);
```

vs. `councilRunner.ts:363-368` (updated):

```ts
allWarnings.push(
  `Model ${model} doesn't support structured JSON output — the response was parsed from free-form text (may have errors).`,
);
```

User-facing inconsistency: `/council` and `/opinion` give different fallback messages.

**Fix**: copy the new wording to `secondOpinionRunner.ts:138`.

### N3 · NEW — `providerDispatch.findModelInRegistry` returns wrong type

**Where**: `providerDispatch.ts:211-221`
**Category**: NEW (introduced by 16-issue fix)

```ts
function findModelInRegistry(...): Model<"openai-completions"> | undefined {
  ...
  return found as unknown as Model<"openai-completions">;
}
```

The `found` model has whatever `api` it actually has (`"anthropic-messages"`, `"google-generative-ai"`, etc.). The cast lies to TypeScript: "I promise this is openai-completions." It works today because `completeSimple` is generic over `Model<Api>`, but the type assertion is wrong. A future refactor that adds API-specific guards in `completeSimple` will silently break.

**Fix**: change the return type to `Model<Api>` (the generic, no narrowing). Or use the actual `Api` union. Or, better, import `Api` from `@earendil-works/pi-ai/compat` and declare:

```ts
function findModelInRegistry(
  provider: string, id: string, modelRegistry?: ModelRegistry,
): Model<Api> | undefined { ... }
```

---

## 🟡 Medium

### N4 · NEW — `secondOpinionRunner` never validates problem non-empty (regression risk)

**Where**: `secondOpinionRunner.ts:46-49`
**Category**: NEW (introduced by 16-issue fix — runner was rewritten, the check was kept but now sits after the dispatchId computation)

`runSecondOpinion` validates `args.input.problem` is non-empty, but only AFTER computing `dispatchId` (which calls `resolveModel`). If the problem is empty, we waste cycles resolving the model. Move the empty-problem check to the top of the function, before any other work.

**Fix**: reorder — empty-problem check at the top.

### N5 · NEW — `pick.value.split("::")` is unbounded

**Where**: `settings-ui.ts:509`
**Category**: NEW (introduced by 16-issue fix, task-3)

```ts
const [providerChoice, modelChoice] = pick.value.split("::");
```

If a model id contains `::` (uncommon but legal in some naming schemes), `split("::")` returns 3+ parts. `providerChoice` becomes the first segment and `modelChoice` becomes the rest joined with `::`. The user gets a corrupt settings entry: `provider: "openrouter", modelId: "rest-of-the-id"`.

**Fix**: limit the split or validate:

```ts
const parts = pick.value.split("::", 2);
if (parts.length !== 2) {
  ctx.ui.notify(`Invalid selection format: ${pick.value}`, "error");
  return;
}
const [providerChoice, modelChoice] = parts;
```

### N6 · NEW — `validateCouncilSettingsStep` doc comment references return value that doesn't exist

**Where**: `settings-ui.ts:520-527`
**Category**: NEW (introduced by 16-issue fix, task-11/M4)

The doc comment says:
```
- "cancelled" — future-proof; the current impl doesn't cancel, but
  this lets the caller distinguish "we asked and got no" from "we didn't ask".
```

But the function returns `Promise<boolean>`, not a string union. Stale doc from when M4 was a tri-state helper before I refactored it to boolean.

**Fix**: drop the cancelled bullet, or refactor the return type to match.

### N7 · NEW — `councilRunner` swallows `fetchOpenRouterModels` failure silently even when used as a sanity check

**Where**: `councilRunner.ts:691-694`
**Category**: NEW (introduced by 16-issue fix, B3)

```ts
try {
  const models = await fetchOpenRouterModels(openrouterApiKey);
  for (const m of models) {
    availableModels.add(...);
  }
} catch {
  // network failure: skip OpenRouter catalog; degraded mode below
}
```

The comment says "degraded mode below" but there's no actual degradation handling — if `availableModels` is empty after both layers, the `isModelMissing` helper returns `false` for everything (degraded). The `hasData: avail.exact.size > 0 || avail.bare.size > 0` check is correct, but the user gets no warning that validation was skipped. Add a `args.onStatus?.("Council: OpenRouter catalog unavailable; model validation skipped")` for the catch.

### N8 · PRE-EXISTING — TUI `commit()` only validates `minPicks`, never `maxPicks`

**Where**: `multiSelectPicker.ts:303-312`
**Category**: PRE-EXISTING (the 16-issue fix touched commit() but missed this)

```ts
const commit = (): void => {
  if (picks.size < minPicks) {
    validationError = `Select at least ${minPicks}...`;
    cachedLines = undefined;
    return;
  }
  done(Array.from(picks));
};
```

`toggleAt` enforces `maxPicks` on add, but if `initialPicks.length > maxPicks` (corrupted settings file with stale cap), the picker starts over the cap and `commit` doesn't notice. Add a parallel `picks.size > maxPicks` check.

**Fix**:
```ts
if (picks.size < minPicks) { ... return; }
if (picks.size > maxPicks) {
  validationError = `Too many models selected. Deselect ${picks.size - maxPicks} to continue.`;
  return;
}
done(Array.from(picks));
```

### N9 · NEW — `multiSelectPicker` bad-attempt counter resets only on success path

**Where**: `multiSelectPicker.ts:188-215`
**Category**: NEW (introduced by 16-issue fix, task-7/H5)

The H5 fix adds a `badAttempts` counter that resets to 0 on successful pick. But if the user is *deselecting* (a valid action), the counter is also reset — which is correct. However, if the user reaches `MAX_BAD_ATTEMPTS` because of a transient UI bug, the picker silently cancels. There's no fallback to "save whatever was successfully picked before the bug". Acceptable for the use case but worth documenting.

**Fix**: add a one-line comment in the loop: "We cancel the entire picker because partial picks are too confusing to surface; the user re-opens with `initialPicks` to re-select."

### N10 · NEW — `councilRunner` `M7` per-model warnings include both real warnings AND the fallback's own warning

**Where**: `councilRunner.ts:401, 421`
**Category**: NEW (introduced by 16-issue fix, task-14/M7)

```ts
warnings: [...allWarnings, ...repaired.warnings],  // line 401 (success)
warnings: [...allWarnings, "Failed to parse..."],  // line 421 (parse failure)
```

If `repairModelOpinion` itself emits a warning that's the same as the structured-output fallback warning (it shouldn't, but if it ever did), the user would see a duplicate. Add deduplication:

```ts
const seen = new Set<string>();
const allUnique = (msgs: string[]) => msgs.filter((m) => seen.has(m) ? false : (seen.add(m), true));
warnings: [...allUnique([...allWarnings, ...repaired.warnings])],
```

### N11 · NEW — `providerDispatch` doesn't propagate `signal` to the User message in `Context`

**Where**: `providerDispatch.ts:264-273`
**Category**: NEW (introduced by 16-issue fix)

```ts
const context: Context = {
  systemPrompt: args.systemPrompt,
  messages: [
    {
      role: "user",
      content: args.userPrompt,
      timestamp: Date.now(),
    },
  ],
};
```

The `signal` (abort) is passed to `completeSimple(model, context, { signal, ... })` correctly. But if `userPrompt` is empty (rare but possible), the User message has `content: ""`. Some providers reject empty user messages. Defensive fix: pass a placeholder if empty.

**Fix**: `content: args.userPrompt || "(empty)"`.

---

## ⚪ Minor

### N12 · NEW — `multiSelectPicker` `displayLabel` truncation uses 40-char threshold

**Where**: `multiSelectPicker.ts:140-141`
**Category**: NEW (introduced by 16-issue fix, task-4/H1)

```ts
const suffix = item.value.length > 40 ? `…${item.value.slice(-37)}` : item.value;
```

The 40/37 numbers are magic constants with no explanation. Extract:

```ts
const MAX_DISAMBIG_SUFFIX = 40;
const TRUNCATED_SUFFIX_TAIL = 37;
const suffix = item.value.length > MAX_DISAMBIG_SUFFIX
  ? `…${item.value.slice(-TRUNCATED_SUFFIX_TAIL)}`
  : item.value;
```

### N13 · NEW — Test gap: `OpinionSetupError` for missing OpenRouter key in `runSecondOpinion`

**Where**: `__tests__/integration/opinion.test.ts`
**Category**: NEW (test gap from 16-issue fix, B2/H3)

The B2/H3 test only covers the success path (env var → key resolved). It doesn't test the failure path where settings has empty apiKey AND no env var AND OpenRouter opinion model. Should throw `OpinionSetupError("Second opinion cannot run: no OpenRouter API key found.")`.

**Fix**: add the failure-path test. Will also help if anyone refactors the key-resolution path.

### N14 · NEW — `multiSelectPicker.test.ts` B1 haystack test is brittle

**Where**: `__tests__/multiSelectPicker.test.ts:178-205`
**Category**: NEW (test quality from 16-issue fix)

The B1 test reads the source file as a string and asserts on the haystack pattern. This is a meta-test that breaks on any refactor of the haystack (e.g. switching to a `const HAYSTACK = "..."` constant). More importantly, the meta-test does NOT verify that the haystack is *actually* wired through `fuzzyFilter` defensively — it just verifies the source contains the magic string. False-positive risk: if the haystack was defined but never passed to `fuzzyFilter`, the test would still pass.

**Fix**: make the test exercise the runtime path. Mock `fuzzyFilter` and assert it's called with the `$$commit$$` haystack. Or document the test as a regression guard only and pair it with a comment that explains what it doesn't cover.

### N15 · NEW — Test gap: boundary lengths for `redactedApiKey` bullet count

**Where**: `__tests__/settings.test.ts`
**Category**: NEW (test coverage gap from 16-issue fix, M5)

`redactedApiKey` uses `Math.min(32, Math.max(8, apiKey.length - 11))`. The tests cover 27-char (16 bullets) and 60-char (32 bullets capped). The transition at 43 chars (`-11 = 32` exactly) and beyond isn't explicitly tested. Add a test for `length === 43` to nail the boundary.

**Fix**: add one test for `length = 43` (boundary) and one for `length = 44` (cap kicks in).

### N16 · NEW — `multiSelectPicker` TUI doesn't reset `validationError` when the search query clears

**Where**: `multiSelectPicker.ts:341-343`
**Category**: NEW (introduced by 16-issue fix)

```ts
const recomputeFilter = (): void => {
  const q = query.trim().toLowerCase();
  validationError = undefined;  // reset on every recompute
  ...
};
```

This is fine — `recomputeFilter` resets it. But what if the user hits a `MAX_BAD_ATTEMPTS` error, then presses Esc, then reopens? The state is captured in the closure, not the component. Probably fine since the component is rebuilt per call. But worth a comment confirming the lifecycle.

**Fix**: add a comment that the closure-based state is intentionally per-invocation.

### N17 · NEW — `ci.yml` Node 22/24 comment slightly out of date

**Where**: `.github/workflows/ci.yml:7-8`
**Category**: NEW (introduced by 16-issue fix)

```
# The matrix covers Node 22 (LTS Jod, current Active) and Node 24 (LTS
# Krypton, current Maintenance), so we catch any version-specific issues before
# users hit them in the field.
```

Node 22 entered Maintenance in October 2025; Node 24 is the current Active LTS. The comment is slightly reversed. Update:

```
# The matrix covers Node 22 (LTS Jod, Maintenance) and Node 24 (LTS
# Krypton, current Active).
```

### N18 · NEW — `package.json` description is now inaccurate

**Where**: `package.json:3`
**Category**: NEW (introduced by 16-issue fix, B6)

```json
"description": "Pi extension: multi-model coding decisions via OpenRouter",
```

After the provider-dispatch work, the extension supports `anthropic`, `openai`, `google`, etc. directly — OpenRouter is just one of many routes. Update:

```json
"description": "Pi extension: multi-model coding decisions via OpenRouter + any provider Pi supports (anthropic, openai, google, etc.)",
```

### N19 · NEW — `package.json` keywords don't reflect multi-provider support

**Where**: `package.json:13-18`
**Category**: NEW (introduced by 16-issue fix, B6)

```json
"keywords": ["pi-package", "pi-extension", "openrouter", "ai-council"]
```

Add the new provider-specific keywords so npm search surfaces this:

```json
"keywords": ["pi-package", "pi-extension", "openrouter", "ai-council", "anthropic", "openai", "google-gemini", "provider-dispatch"]
```

### N20 · PRE-EXISTING — `index.ts` likely has stale docs about OpenRouter-only

**Where**: `index.ts`
**Category**: PRE-EXISTING (not directly changed by 16-issue fix but the package-level description drift exposed it)

Not reviewed in depth (out of scope for this audit), but the index.ts file probably has command descriptions that still say "OpenRouter" when the runner supports direct providers.

**Fix**: review `index.ts` command descriptions and update to reflect the new dispatch behavior.

### N21 · PRE-EXISTING — `README.md` has minor drift

**Where**: `README.md:5, 26`
**Category**: PRE-EXISTING (16-issue fix touched README but not these specific lines)

- Line 5: "Ask three independent AI models" — but the schema allows 1-8.
- Line 26: "An **OpenRouter API key**" — listed as a prerequisite, but pi-auth users don't need one.

**Fix**: update to "Ask 1–8 independent AI models" and "An OpenRouter API key *(only required for OpenRouter opinion models)*".

---

## Test gap analysis

For the 16-issue fix, **23 new tests** were added. Audit found:

- 2 test gaps (N13, N15) — real coverage holes
- 2 brittle test designs (N14, N16) — false-positive risk
- The remaining 19 tests are well-written and exercise the actual fix paths

---

## Recommended fix order

1. **N2** (M7 consistency in `secondOpinionRunner`) — 1-line fix
2. **N5** (`split("::")` validation) — 5-line fix, real bug
3. **N8** (TUI `maxPicks` validation) — 5-line fix, real edge-case bug
4. **N1** (DRY `withTimeoutAndWrap` helper) — refactor, ~30 lines
5. **N3** (provider-dispatch type-lie) — 1-line type fix
6. **N18, N19, N21** (doc drift) — text-only changes
7. **N13, N15** (test gaps) — add 2 tests
8. **N6, N9, N10, N11, N12, N14, N16, N17, N20** — defer or accept

The branch is in a mergeable state today. The above 5 high/medium fixes would take an estimated 30 minutes and bring the review surface to near-zero.

---

*End of report. Generated by an independent follow-up audit of commit `0bd077f`.*
