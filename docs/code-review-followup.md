# Code Review Follow-up — `feature/multi-select-model-picker` @ `0bd077f`

**Reviewer**: independent (this audit)
**Scope**: branch `feature/multi-select-model-picker` at commit `0bd077f`, after the 16-issue fix
**Baseline (verified reproducible)**: `npm test` → 189/189 pass; `npm run lint` → clean; `npm run typecheck` → clean
**Goal**: surface any issues the original 16-issue review missed

> **Note on the lint command**: the verification contract used the literal
> `npm run lint --max-warnings 0` but in this environment npm appends the
> `0` as a positional file argument (resulting in "file 0 not found").
> The clean equivalent is `npm run lint` (which uses the script as-is) or
> `npm run lint -- --max-warnings 0`. Both exit 0 cleanly. Where I cite
> line numbers below, they were verified against the current source.

---

## Summary (corrected after independent audit)

The independent auditor caught three real production-significant defects I missed in the first pass, plus several line-number and citation errors. This revised report:

- **3 new production-significant defects** (renumbered P1–P3) — **the original "0 blocker" claim was wrong**
- **Restructured severity** to reflect actual production risk
- **Fixed line numbers** for N5, N22, N24 (cited lines were off by 6–25)
- **Fixed N5's recommended fix** (the original `split("::", 2)` still loses data)
- **Merged N22 + N23** (same duplicate-label issue, was counted twice)
- **Removed N16** (verified non-issue, the report itself admitted "behaviour is fine")
- **Removed N20** (hand-wavy — the report admitted it wasn't reviewed in depth)
- **Demoted N24** to "verified non-issue" outside the count

**Net effect**: **27 real findings** (3 production, 4 high, 9 medium, 11 minor). The branch is **not** mergeable as-is; the 3 production defects would break core user flows.

| Severity | NEW (16-issue) | PRE-EXISTING (missed) | Total |
|---|---|---|---|
| 🔴 Blocker | 2 | 1 | **3** |
| 🟠 High | 0 | 4 | **4** |
| 🟡 Medium | 6 | 3 | **9** |
| ⚪ Minor | 7 | 4 | **11** |
| **Total** | **15** | **12** | **27** |

**Top five to fix before merge (all blocker/high):**

1. **P1** — `providerDispatch` calls `completeSimple` without fetching auth. Direct-provider users with `/login` (no env var) get auth failures.
2. **P2** — `councilRunner` synthesis retry doesn't disable structured output. Every retry sends the same rejected schema, then degrades.
3. **P3** — `settings-ui` council picker is OpenRouter-only. Contradicts the README claim of multi-provider support.
4. **N2** — `secondOpinionRunner` still uses the old "using fallback mode" wording (M7 was incomplete).
5. **N22** — `searchSelector` non-TUI fallback uses label-only match, returns first duplicate. Same as H1 in `multiSelectPicker` but unfixed here.

---

## 🔴 Blocker — production-significant defects missed by my first pass

### P1 · PRE-EXISTING — `providerDispatch` bypasses authentication for direct providers

**Where**: `providerDispatch.ts:268-292`
**Category**: PRE-EXISTING (introduced by the multi-select work, missed by 16-issue review)

`callModelViaDispatch` calls `completeSimple(model, context, options)` without resolving auth from `modelRegistry`. pi-ai's `completeSimple` uses `options.apiKey` and `options.headers` to authenticate, but `providerDispatch` passes only `signal`, `temperature`, `maxTokens`. For a user who authenticated via `/login openrouter` (no env var, no key in settings), the OpenRouter path resolves auth via the registry inside `callOpenRouterChat`. But for direct providers (anthropic/openai/google), the dispatch path **does not resolve auth**, so the request goes out unauthenticated.

**Reproduction**:
1. `/login openrouter` in pi (no env var)
2. `/login openai` in pi (no env var)
3. Configure council with one OpenRouter model and one `openai/gpt-4o` model
4. Run `/council fix test`
5. The anthropic/openai/google calls fail with auth errors

**Fix** (in `providerDispatch.ts:268`):

```ts
// Fetch auth from the registry, not from process.env / settings.
let apiKey: string | undefined;
let headers: Record<string, string> | undefined;
if (args.modelRegistry) {
  const auth = await args.modelRegistry.getApiKeyAndHeaders(model);
  if (auth.ok) {
    apiKey = auth.apiKey;
    headers = auth.headers;
  }
}

const message = await completeSimple(model, context, {
  ...(args.signal !== undefined ? { signal: args.signal } : {}),
  ...(apiKey ? { apiKey } : {}),
  ...(headers ? { headers } : {}),
  temperature: args.temperature ?? 0.2,
  maxTokens: args.maxTokens ?? 15000,
});
```

### P2 · PRE-EXISTING — `councilRunner` synthesis retry doesn't disable structured output

**Where**: `councilRunner.ts:471-518`
**Category**: PRE-EXISTING

`attemptSynthesis` is defined as a closure that captures `useStructuredSynth` from the outer scope. When the structured-output call fails, the catch block calls `retry({operation: attemptSynthesis, ...})` — but `attemptSynthesis` still closes over `useStructuredSynth = true`. Every retry sends the same rejected schema, then the fallback decision fires.

**Reproduction**: synthesis model doesn't support `json_schema`; first call returns 400; the 2 retries also return 400; the synthesis "succeeds" with empty/garbage; the fallback decision fires.

**Fix**: either make `attemptSynthesis` parameterise on `useStructured`, or do a single explicit retry that disables structured output:

```ts
try {
  synthesisRaw = await attemptSynthesis();
} catch (synthesisError) {
  if (USE_STRUCTURED_OUTPUT && isStructuredOutputError(synthesisError)) {
    synthesisWarnings.push(...);
    // Explicit one-shot retry WITHOUT the structured schema.
    const plainAttempt = () => attemptSynthesisWithStructured(false);
    const retryResult = await retry({
      attempts: 2,
      delayMs: MODEL_RETRY_DELAY_MS,
      operation: plainAttempt,
    });
    synthesisRaw = retryResult.value;
  } else {
    throw synthesisError;
  }
}
```

### P3 · PRE-EXISTING — `openCouncilSettingsUI` restricts council picker to OpenRouter models

**Where**: `settings-ui.ts:274-282, 328-334`
**Category**: PRE-EXISTING (contradicts the new README claim)

The settings UI does `getOpenRouterModelsFromRegistry(registryModels)` which filters to `provider === "openrouter"` only. The `state.availableModels` is then populated with only OpenRouter models. The council `MultiSelectPicker` and the synthesis/opinion `searchableSelect` all consume this list, so the user is forced to pick OpenRouter models — even though the runner now supports direct providers.

The README (line 9) claims: "Models are chosen from Pi's full model registry — OpenRouter, Anthropic, OpenAI, Google, Mistral, Bedrock, or any other provider Pi is configured to talk to." This is a direct contradiction.

**Reproduction**: configure `/login openai` (no env var, no OpenRouter); run `/council-settings`; the picker shows only OpenRouter models even though the runner could call them.

**Fix**: use the full registry (not the OpenRouter filter) for the picker source. Also use the full registry for synthesis/opinion pickers. The `getOpenRouterModelsFromRegistry` helper is fine for OpenRouter-specific things, but the picker source should not be OpenRouter-filtered.

---

## 🟠 High-impact

### N1 · NEW — `runnerHelpers.callModelDispatchWithTimeout` duplicates `callModelWithTimeout`

**Where**: `runnerHelpers.ts:101-129` vs `:131-173`
**Category**: NEW (introduced by the auditor-gap commit `692f3ff`, refined by 16-issue fix)

Both helpers have an identical `withTimeout + try/catch` wrapper. The only difference is the inner call. **Fix**: factor out a shared `withTimeoutAndWrap(fn, modelId, timeoutMs, signal)` helper.

### N2 · PRE-EXISTING — M7 was applied to `councilRunner` but missed `secondOpinionRunner`

**Where**: `secondOpinionRunner.ts:138`
**Category**: PRE-EXISTING (M7 was incomplete)

`secondOpinionRunner` still uses the OLD wording `"Model X does not support structured output, using fallback mode"` while `councilRunner` uses the new clearer wording. **Fix**: copy the new wording.

### N22 · NEW — `searchSelector` non-TUI fallback uses label-only match (N22 + N23 merged)

**Where**: `searchSelector.ts:91` (line 88 in my first report was off; verified)
**Category**: NEW (introduced by 16-issue fix, M3/M6)

`args.items.find((i) => i.label === choice)` — two issues:
1. If two items share a label, the FIRST one wins (H1 fixed this in `multiSelectPicker` but not here).
2. No value matching — programmatic callers returning a value fail.

**Fix**: same pattern as H1:

```ts
const byLabel = new Map(args.items.map((i) => [i.label, i]));
const byValue = new Map(args.items.map((i) => [i.value, i]));
return byLabel.get(choice) ?? byValue.get(choice);
```

### N4 · NEW — `secondOpinionRunner` input validation order is correct (verifying auditor claim)

The auditor flagged N4 ("input validation occurs after model resolution") as factually wrong. **I confirm the auditor is right**: `secondOpinionRunner.ts:45-48` validates the problem is non-empty BEFORE `dispatchId` is computed at lines 50-63. N4 was factually invalid. **Removing N4 from the report.**

---

## 🟡 Medium

### N5 · NEW — `pick.value.split("::")` corruption is fixable but my original fix was wrong

**Where**: `settings-ui.ts:498` (line 509 in my first report was off by 11)
**Category**: NEW (introduced by 16-issue fix, task-3/H1)

Original report recommended `split("::", 2)`. **This was wrong** — the second `::` and everything after is still discarded. If a model id is `openai::gpt-4o::extra`, the user gets `provider: "openai", modelId: "gpt-4o"` (silent corruption).

**Correct fix**: validate the result has exactly 2 parts:

```ts
const parts = pick.value.split("::", 2);
if (parts.length !== 2) {
  ctx.ui.notify(`Invalid selection format: ${pick.value}`, "error");
  return;
}
const [providerChoice, modelChoice] = parts;
```

### N6 · NEW — `validateCouncilSettingsStep` doc comment references non-existent return value

**Where**: `settings-ui.ts:520-527`
**Category**: NEW (introduced by 16-issue fix, task-11/M4)

The doc comment says the function returns one of `"valid" | "invalid" | "cancelled"`, but the return type is `Promise<boolean>`. Stale doc from when M4 was a tri-state helper before being refactored to boolean.

**Fix**: drop the `"cancelled"` bullet from the doc comment.

### N7 · NEW — `councilRunner` silently swallows `fetchOpenRouterModels` failure

**Where**: `councilRunner.ts:691-694`
**Category**: NEW (introduced by 16-issue fix, B3)

`try { ... } catch { /* network failure: skip OpenRouter catalog; degraded mode below */ }` — no user warning. **Fix**: add `args.onStatus?.("Council: OpenRouter catalog unavailable; model validation skipped")`.

### N8 · PRE-EXISTING — TUI `commit()` only validates `minPicks`, never `maxPicks`

**Where**: `multiSelectPicker.ts:303-312`
**Category**: PRE-EXISTING

If `initialPicks.length > maxPicks` (e.g. corrupted settings file with stale cap), the picker starts over the cap. `commit()` only checks `minPicks`. **Fix**: add `if (picks.size > maxPicks) { validationError = ...; return; }`.

### N11 · NEW — `providerDispatch` ignores `stopReason: "error"` assistant messages

**Where**: `providerDispatch.ts:289-292`
**Category**: NEW (introduced by 16-issue fix)

`extractTextFromAssistantMessage(msg)` walks `msg.content` and returns the joined text. If `msg.stopReason === "error"`, the content is typically empty (the error is in `msg.errorMessage`, not in `msg.content`). The function returns `""` silently, and the runner treats it as a successful empty response.

**Fix** (in `callModelViaDispatch`):

```ts
const message = await completeSimple(model, context, options);
if (message.stopReason === "error") {
  throw new Error(`Model ${args.rawId} failed: ${message.errorMessage ?? "unknown error"}`);
}
return extractTextFromAssistantMessage(message);
```

### N9 · NEW — `multiSelectPicker` H5 bad-attempt counter behaviour

**Where**: `multiSelectPicker.ts:188-215`
**Category**: NEW (introduced by 16-issue fix, task-7/H5)

H5 cancels the picker entirely after 10 bad attempts, but partial picks (made before the bug) are discarded. Document this in a comment.

### N10 · NEW — `councilRunner` M7 per-model warnings could be duplicated

**Where**: `councilRunner.ts:401, 421`
**Category**: NEW (introduced by 16-issue fix, task-14/M7)

`warnings: [...allWarnings, ...repaired.warnings]` — if `repairModelOpinion` ever emits the same warning as the structured-output fallback, the user sees a duplicate. **Fix**: deduplicate via `new Set()`.

### N13 · NEW — Test gap: `OpinionSetupError` for missing OpenRouter key in `runSecondOpinion`

**Where**: `__tests__/integration/opinion.test.ts`
**Category**: NEW (test gap, B2/H3)

The B2/H3 test covers the success path (env var → key resolved). It doesn't test the failure path where settings has empty apiKey AND no env var AND OpenRouter opinion model.

**Fix**: add a test that asserts `OpinionSetupError` is thrown.

### N14 · NEW — `multiSelectPicker.test.ts` B1 haystack test is brittle

**Where**: `__tests__/multiSelectPicker.test.ts:178-205`
**Category**: NEW (test quality, B1)

The B1 test reads the source file as a string and asserts on the haystack pattern. The meta-test does NOT verify that the haystack is actually USED defensively. **Fix**: rewrite to exercise the runtime path (mock `fuzzyFilter` and assert it's called with the `$$commit$$` haystack).

### N26 · NEW — `providerDispatch.test.ts` "routes through pi-ai/compat" tests pass for the wrong reason

**Where**: `__tests__/providerDispatch.test.ts:155-180`
**Category**: NEW (test quality)

Tests assert `completeSimple` was called but don't verify call args. **Fix**: add `expect(callArgs?.model.provider).toBe("anthropic")`.

---

## ⚪ Minor

### N12 · NEW — `multiSelectPicker` `displayLabel` magic numbers

**Where**: `multiSelectPicker.ts:140-141`
**Category**: NEW

`40` and `37` are magic constants. Extract to named constants.

### N15 · NEW — `redactedApiKey` boundary lengths not tested

**Where**: `__tests__/settings.test.ts`
**Category**: NEW (test coverage, M5)

Tests cover 27-char and 60-char keys but not the transition at 43 chars (`length - 11 = 32`, the cap). **Fix**: add boundary test.

### N17 · NEW — `ci.yml` Node 22/24 comment is slightly off

**Where**: `.github/workflows/ci.yml:4-5`
**Category**: NEW

"Node 22 (LTS Jod, current Active) and Node 24 (LTS Krypton, current Maintenance)" — Node 22 entered Maintenance in October 2025; Node 24 is the current Active. **Fix**: swap the labels.

### N18 · NEW — `package.json` description is now inaccurate

**Where**: `package.json:4`
**Category**: NEW

`"Pi extension: multi-model coding decisions via OpenRouter"` — after the provider-dispatch work, the extension supports direct providers. **Fix**: update wording.

### N19 · NEW — `package.json` keywords don't reflect multi-provider support

**Where**: `package.json:21-26`
**Category**: NEW

`"keywords": ["pi-package", "pi-extension", "openrouter", "ai-council"]` — should add `anthropic`, `openai`, etc.

### N21 · NEW — `README.md` has minor drift

**Where**: `README.md:5, 26`
**Category**: NEW (16-issue fix touched README but not these specific lines)

- Line 5: "Ask three independent AI models" — but the schema allows 1-8.
- Line 26: "An OpenRouter API key" listed as a prerequisite, but pi-auth users don't need one.

### N25 · NEW — `searchSelector-reasoning.test.ts` test name doesn't match what it verifies

**Where**: `__tests__/searchSelector-reasoning.test.ts:47`
**Category**: NEW (test quality)

The test asserts the model's label is in the choices list — but the non-TUI fallback doesn't render the badge. The test passes for the wrong reason.

**Fix**: rename or make it exercise the TUI render path that actually shows the badge.

### N27 · NEW — `settings-migration.test.ts` doesn't cover empty-strings-only council

**Where**: `__tests__/settings-migration.test.ts`
**Category**: NEW (test coverage, M5/M7)

`councilModels = ["", ""]` + `synthesis = undefined` — partial save edge case. Not tested.

### N28 · NEW — `council-availability.test.ts` doesn't test the `maxPicks` over-limit boundary

**Where**: `__tests__/integration/council-availability.test.ts`
**Category**: NEW (test coverage, B3)

User sets `maxPicks = 1` but saved `councilModels` has 3 entries. Per N8, the TUI `commit()` doesn't validate `maxPicks`, so this state would silently pass.

### N29 · NEW — `secondOpinionRunner` M7 fallback warning has no regression test

**Where**: `__tests__/integration/opinion.test.ts`
**Category**: NEW (test gap, M7)

The M7 fix added a regression test for `councilRunner` but `secondOpinionRunner` (which has the OLD wording per N2) has no test. **Fix**: add a `runSecondOpinion` test.

### N30 · NEW — `multiSelectPicker` TUI `commit()` has no test for the `maxPicks` over-limit path

**Where**: `__tests__/multiSelectPicker.test.ts`
**Category**: NEW (test coverage, N8)

Related to N8 — no test covers the over-limit path. **Fix**: add a test (or document the missing check).

---

## Verified non-issues (not counted)

- **N24** (`searchSelector.ts` commit returns the **original** `SelectableItem`) — verified correct. The M3 fix's `reasoning?` field is preserved through the lookup at line 130 (not 101-106 as originally cited).
- **N16** (`multiSelectPicker` validation reset on query clear) — verified correct. `recomputeFilter` resets `validationError` at line 349-351. No fix needed.
- **N20** (`index.ts` stale docs) — **REMOVED from the report**. The original review admitted it wasn't reviewed in depth; this was a hand-wave and shouldn't be counted as a finding.

---

## Test gap analysis (revised)

For the 16-issue fix, **23 new tests** were added across 4 new test files. Audit found:

- 4 test gaps (N13, N15, N28, N29) — real coverage holes
- 3 brittle test designs (N14, N25, N30) — false-positive risk
- 1 implicit-dependency issue (N26) — test passes for the wrong reason
- The remaining 15 tests are well-written and exercise the actual fix paths

### Test file coverage matrix

| Test file | Issues found |
|---|---|
| `multiSelectPicker.test.ts` | N14 |
| `providerDispatch.test.ts` | N26 |
| `settings-migration.test.ts` | N27 |
| `settings.test.ts` | N15 |
| `settings-ui.test.ts` | — |
| `integration/council.test.ts` | — |
| `integration/council-availability.test.ts` | N28 |
| `integration/opinion.test.ts` | N13, N29 |
| `integration/provider-dispatch.test.ts` | — |
| `integration/retry-transient.test.ts` | (verified N2) |
| `integration/dynamic-council.test.ts` | — |
| `searchSelector-reasoning.test.ts` | N25 |
| `runnerHelpers.test.ts` | — |
| `smoke.test.ts` | — |
| `validation.test.ts` | — |

---

## Recommended fix order

1. **P1** (auth bypass in `providerDispatch`) — real auth break, 1-line fix × 1
2. **P2** (synthesis retry without disabling structured) — real bug, ~10-line fix
3. **P3** (council picker is OpenRouter-only) — contradicts README, ~5-line fix in settings-ui
4. **N2** (M7 consistency) — 1-line fix
5. **N22** (`searchSelector` non-TUI fallback disambiguate) — ~5-line fix
6. **N5** (`split("::", 2)` → validate parts.length === 2) — 3-line fix
7. **N1** (DRY `withTimeoutAndWrap`) — refactor
8. **N6, N7, N8, N9, N10, N11, N12, N15, N17, N18, N19, N21, N25, N27, N28, N29, N30** — defer or accept

The branch is **NOT** in a mergeable state today. The 3 production defects (P1–P3) would break core user flows (direct-provider dispatch fails, synthesis degrades silently, picker is OpenRouter-only). The above 7 fixes would take an estimated 1 hour and bring the review surface to near-zero.

---

## Self-critique

The first version of this report (committed at `58995fc`) was wrong in three important ways:

1. **Missing production defects**: I claimed "0 blocker" but missed P1 (auth bypass), P2 (synthesis retry bug), and P3 (OpenRouter-only picker). These would break core user flows. The auditor caught all three.
2. **Wrong line numbers**: cited lines were off by 6–25 in several findings (N5, N22, N24). The auditor's spot-check found these. I've re-verified every line citation in this revision.
3. **Hand-wavy findings**: I included N20 ("probably has stale docs") and N16 (which the report itself admitted "behaviour is fine"). Both were noise. Removed in this revision.

I should have done a deeper integration test of the direct-provider dispatch path (P1) before claiming the branch was mergeable. The 16-issue fix's tests all used mocked `modelRegistry` with `getApiKeyForProvider` returning a hard-coded "sk-test", which masked the fact that the dispatch layer was never calling it.

---

*End of report. Revised after independent audit found 3 production-significant defects and several citation/categorization errors. Generated by an independent follow-up audit of commit `0bd077f`, with corrections at commit `8cecd91`.*
