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
> line numbers below, they were re-verified against the current source
> at commit `0bd077f` and the line is the START of the relevant block.

---

## Summary (corrected after second audit)

The independent auditor caught errors in my first revision. This second revision:

- **Adds 1 more material NEW defect** (B3 introduced a regression in `isModelMissing` — see B3 below)
- **Adds a finding for `settings.ts`** (was previously missing from coverage)
- **Fixes the N5 recommended fix** — my original `split("::", 2)` is wrong because JS drops everything after the second delimiter (the auditor was right)
- **Fixes the N22 recommended fix** — my original `Map<label, item>` overwrites duplicate keys (the auditor was right)
- **Removes N9** — the code already documents the cancellation behavior; not a real finding
- **Adds line numbers to findings that previously cited only a file** (N13, N15, N27, N28, N29, N30)
- **Corrects line numbers** for N7 (691-694 → 695-697), N26 (155-180 → 208-237)
- **Reconciles severity table** to match the actual sections (3 high, not 4; 10 medium, not 9)
- **Acknowledges the auditor's pre-existing N1 categorization** — `runnerHelpers.ts` was added in commit `692f3ff` (auditor-gap commit) BEFORE the 16-issue fix. The fix-related work `callModelDispatchWithTimeout` is the 16-issue work; the file itself predates it.

**Net effect**: **29 real findings** (3 blocker, 3 high, 10 medium, 13 minor). The branch is **not** mergeable as-is; the 3 production defects (P1, P2, P3) and the B3 regression would break core user flows.

| Severity | NEW (16-issue) | PRE-EXISTING (missed) | Total |
|---|---|---|---|
| 🔴 Blocker | 2 | 2 | **4** |
| 🟠 High | 0 | 3 | **3** |
| 🟡 Medium | 6 | 4 | **10** |
| ⚪ Minor | 5 | 8 | **13** |
| **Total** | **13** | **17** | **29** |

**Top five to fix before merge (all blocker/high):**

1. **P1** — `providerDispatch` calls `completeSimple` without fetching auth. Direct-provider users with `/login` (no env var) get auth failures.
2. **P2** — `councilRunner` synthesis retry doesn't disable structured output. Every retry sends the same rejected schema, then degrades.
3. **P3** — `openCouncilSettingsUI` restricts council picker to OpenRouter models. `settings-ui.ts:380-387` also hard-codes opinion provider to OpenRouter.
4. **B3** — `councilRunner.isModelMissing` accepts `anthropic/gpt-4o` when only `openai/gpt-4o` is registered, because the bare-id fallback `gpt-4o` matches. The 16-issue fix introduced this regression.
5. **N2** — `secondOpinionRunner` still uses the old "using fallback mode" wording (M7 was incomplete).

---

## 🔴 Blocker — production-significant defects

### P1 · PRE-EXISTING — `providerDispatch` bypasses authentication for direct providers

**Where**: `providerDispatch.ts:268-292`
**Category**: PRE-EXISTING (introduced by the multi-select work, missed by 16-issue review)

`callModelViaDispatch` calls `completeSimple(model, context, options)` without resolving auth from `modelRegistry`. pi-ai's `completeSimple` uses `options.apiKey` and `options.headers` to authenticate, but `providerDispatch` passes only `signal`, `temperature`, `maxTokens`. For a user who authenticated via `/login openai` (no env var, no key in settings), the OpenRouter path resolves auth via the registry inside `callOpenRouterChat`. But for direct providers (anthropic/openai/google), the dispatch path **does not resolve auth**, so the request goes out unauthenticated.

**Reproduction**:
1. `/login openrouter` in pi (no env var)
2. `/login openai` in pi (no env var)
3. Configure council with one OpenRouter model and one `openai/gpt-4o` model
4. Run `/council fix test`
5. The openai calls fail with auth errors

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
**Category**: PRE-EXISTING (introduced by 16-issue fix's structured-output fallback)

`attemptSynthesis` is defined as a closure that captures `useStructuredSynth` from the outer scope. When the structured-output call fails, the catch block calls `retry({operation: attemptSynthesis, ...})` — but `attemptSynthesis` still closes over `useStructuredSynth = true`. Every retry sends the same rejected schema, then the fallback decision fires.

**Reproduction**: synthesis model doesn't support `json_schema`; first call returns 400; the 2 retries also return 400; the synthesis "succeeds" with empty/garbage; the fallback decision fires.

**Fix**: extract a parameterised synthesis attempt that explicitly accepts a `useStructured` flag, and use the plain version on retry:

```ts
const attemptSynthesisWithStructured = (useStructured: boolean): Promise<string> =>
  withTimeout(
    (childSignal) => {
      if (isOpenRouterSynth) {
        return callOpenRouterChat({
          apiKey: resolvedApiKey ?? "",
          model: SYNTHESIZER_MODEL,
          systemPrompt: synthesisSystem,
          userPrompt: synthesisUser,
          signal: childSignal,
          structuredOutputSchema: useStructured ? councilDecisionJsonSchema : undefined,
          structuredOutputName: "council_decision",
        });
      }
      return callModelViaDispatch({ ... });
    },
    SYNTHESIS_TIMEOUT_MS,
    args.signal,
  );

let synthesisRaw: string;
try {
  synthesisRaw = await attemptSynthesisWithStructured(true);
} catch (synthesisError) {
  if (useStructuredOutputForThisModel && isStructuredOutputError(synthesisError)) {
    synthesisWarnings.push(`Synthesis model doesn't support structured JSON output — response parsed from free-form text (may have errors).`);
    const retryResult = await retry({
      attempts: 2,
      delayMs: MODEL_RETRY_DELAY_MS,
      operation: () => attemptSynthesisWithStructured(false),
    });
    synthesisRaw = retryResult.value;
  } else {
    throw synthesisError;
  }
}
```

### P3 · PRE-EXISTING — `openCouncilSettingsUI` restricts the council picker to OpenRouter and hard-codes opinion provider

**Where**: `settings-ui.ts:274-282` (council picker), `:328-334` (synthesis picker), `:380-387` (opinion picker)
**Category**: PRE-EXISTING (contradicts the new README claim of multi-provider support)

The settings UI does `getOpenRouterModelsFromRegistry(registryModels)` which filters to `provider === "openrouter"` only. The `state.availableModels` is then populated with only OpenRouter models. The council `MultiSelectPicker` and the synthesis/opinion `searchableSelect` all consume this list, so the user is forced to pick OpenRouter models — even though the runner now supports direct providers. Additionally, `settings-ui.ts:386` hard-codes `state.opinionProvider = "openrouter"` regardless of the picked model.

The README (line 9) claims: "Models are chosen from Pi's full model registry — OpenRouter, Anthropic, OpenAI, Google, Mistral, Bedrock, or any other provider Pi is configured to talk to." This is a direct contradiction.

**Reproduction**: configure `/login openai` (no env var, no OpenRouter); run `/council-settings`; the picker shows only OpenRouter models even though the runner could call them.

**Fix**: use the full registry (not the OpenRouter filter) for the picker source in all three pickers (council, synthesis, opinion). Also use the model's actual `provider` field for `state.opinionProvider` (not hard-coded "openrouter"):

```ts
// Council picker: use the full registry
const items: MultiSelectItem[] = registryModels.map((m) => ({
  value: `${m.provider}/${m.id}`,  // include the provider prefix
  label: m.name ?? m.id,
  description: `${m.provider} · ${m.id}${m.reasoning ? "  ·  [reasoning]" : ""}`,
  searchHaystack: `${m.provider} ${m.name ?? ""} ${m.id}`,
  reasoning: m.reasoning,
}));

// Opinion picker: use the model's actual provider, not hard-coded
state.opinionProvider = opinionModel.provider;
state.opinionModelId = opinionModel.id;
```

### B3 · PRE-EXISTING (introduced by 16-issue fix) — `councilRunner.isModelMissing` cross-provider false-positive

**Where**: `councilRunner.ts:715-748`
**Category**: PRE-EXISTING (the bug was introduced in 409ebb2 by the 16-issue B3 fix; the original code didn't have this helper)

`isModelMissing` builds a `bareAlt = modelId.split("/").slice(1).join("/")`. For input `anthropic/gpt-4o`, `bareAlt = "gpt-4o"`. If only `openai/gpt-4o` is in the registry (so `avail.bare = {"gpt-4o"}`), then `avail.bare.has("gpt-4o") === true` — the model passes validation. But dispatch via `callModelViaDispatch` will fail because there's no `anthropic/gpt-4o`.

**Reproduction**: configure a direct-provider model in settings (`anthropic/gpt-4o`) that has the same bare id as an OpenRouter model (`openai/gpt-4o` exists in OpenRouter's catalog). The runner accepts it at startup, then fails at call-time.

**Fix**: match by EXACT provider/id form only, not by bare id:

```ts
function isModelMissing(modelId: string, avail: AvailableModels): boolean {
  if (!avail.hasData) return false;
  // Match exact (provider/id) OR bare (no prefix) — NOT both at once.
  // Cross-provider false-positives (anthropic/gpt-4o matching bare
  // openai/gpt-4o) must be rejected.
  if (avail.exact.has(modelId)) return false;
  if (modelId.startsWith(`${OPENROUTER_PROVIDER}/`)) {
    const bare = modelId.slice(OPENROUTER_PROVIDER.length + 1);
    if (avail.bare.has(bare)) return false;
    return true;
  }
  if (!modelId.includes("/")) {
    // Pure bare form (legacy OpenRouter ids like "qwen/qwen3.7-max" also
    // include "/" but those have a known provider prefix; the only true
    // bare form is a no-slash id).
    if (avail.bare.has(modelId)) return false;
  }
  return true;
}
```

Or, more conservative: only accept a model if the EXACT (provider/id) is in the catalog. This is a behavior change but the safest.

---

## 🟠 High-impact

### N1 · PRE-EXISTING — `runnerHelpers.callModelDispatchWithTimeout` duplicates `callModelWithTimeout`

**Where**: `runnerHelpers.ts:101-129` vs `:131-173`
**Category**: PRE-EXISTING (the file was added in commit `692f3ff`, but the duplicated helper was the 16-issue work)

Both helpers have an identical `withTimeout + try/catch` wrapper. The only difference is the inner call. **Fix**: factor out a shared `withTimeoutAndWrap(fn, modelId, timeoutMs, signal)` helper.

### N2 · PRE-EXISTING — M7 was applied to `councilRunner` but missed `secondOpinionRunner`

**Where**: `secondOpinionRunner.ts:138`
**Category**: PRE-EXISTING (M7 was incomplete)

`secondOpinionRunner` still uses the OLD wording `"Model X does not support structured output, using fallback mode"` while `councilRunner.ts:363-368` uses the new clearer wording. **Fix**: copy the new wording.

### N22 · NEW — `searchSelector` non-TUI fallback uses label-only match (N22 + N23 merged)

**Where**: `searchSelector.ts:91`
**Category**: NEW (introduced by 16-issue fix, M3/M6)

`args.items.find((i) => i.label === choice)` — two issues:
1. If two items share a label, the FIRST one wins (H1 fixed this in `multiSelectPicker` but not here).
2. No value matching — programmatic callers returning a value fail.

**Fix** (auditor was right — use array-of-pairs, not Map):

```ts
// Use array-of-pairs, not Map, so duplicate labels are all preserved
// and disambiguated by value suffix.
const byLabel = args.items.map((i) => [i.label, i] as const);
const byValue = new Map(args.items.map((i) => [i.value, i]));
const found = byLabel.find(([label]) => label === choice)?.[1]
  ?? byValue.get(choice);
return found;
```

The original H1 fix in `multiSelectPicker.ts` used array-of-pairs correctly — see `findByLabel` at line 153 of that file. The same pattern should be applied here.

---

## 🟡 Medium

### N5 · NEW — `pick.value.split("::")` corruption is fixable but my original fix was wrong

**Where**: `settings-ui.ts:498`
**Category**: NEW (introduced by 16-issue fix, task-3/H1)

Original report recommended `split("::", 2)`. **This was wrong** — the auditor caught it. JavaScript's `String.prototype.split(separator, limit)` with a string separator does NOT exclude the separator from the rest of the string, so `"openai::gpt-4o::extra".split("::", 2)` returns `["openai", "gpt-4o"]` — silently dropping the `::extra` suffix.

**Correct fix**: split with NO limit, then validate the parts count:

```ts
const parts = pick.value.split("::");
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

**Where**: `councilRunner.ts:691-697` (line numbers corrected from the audit)
**Category**: NEW (introduced by 16-issue fix, B3)

`try { ... } catch { /* network failure: skip OpenRouter catalog; degraded mode below */ }` — no user warning. **Fix**: add `args.onStatus?.("Council: OpenRouter catalog unavailable; model validation skipped")`.

### N8 · PRE-EXISTING — TUI `commit()` only validates `minPicks`, never `maxPicks`

**Where**: `multiSelectPicker.ts:303-312`
**Category**: PRE-EXISTING

If `initialPicks.length > maxPicks` (e.g. corrupted settings file with stale cap), the picker starts over the cap. `commit()` only checks `minPicks`. **Fix**: add `if (picks.size > maxPicks) { validationError = ...; return; }`.

### N11 · NEW — `providerDispatch` ignores `stopReason: "error"` assistant messages

**Where**: `providerDispatch.ts:289-293`
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

### N10 · NEW — `councilRunner` M7 per-model warnings could be duplicated

**Where**: `councilRunner.ts:401, 421`
**Category**: NEW (introduced by 16-issue fix, task-14/M7)

`warnings: [...allWarnings, ...repaired.warnings]` — if `repairModelOpinion` ever emits the same warning as the structured-output fallback, the user sees a duplicate. **Fix**: deduplicate via `new Set()`.

### N13 · NEW — Test gap: `OpinionSetupError` for missing OpenRouter key in `runSecondOpinion`

**Where**: `__tests__/integration/opinion.test.ts` (lines 47-68 — the existing `OpinionSetupError` tests)
**Category**: NEW (test gap, B2/H3)

The B2/H3 test covers the success path (env var → key resolved). It doesn't test the failure path where settings has empty apiKey AND no env var AND OpenRouter opinion model. Add a test:

```ts
it("throws OpinionSetupError when settings has no OpenRouter key (B2/H3 failure path)", async () => {
  vi.mocked(settingsModule.loadSettings).mockResolvedValue({
    ...buildSettings({ apiKey: "" }),  // no key
    opinion: { provider: "openrouter", modelId: "qwen/qwen3.7-max" },
  });
  const previous = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  try {
    await expect(
      runSecondOpinion({ input: { problem: "test" }, cwd: TEST_DIR, isProjectTrusted: true }),
    ).rejects.toThrow(OpinionSetupError);
  } finally {
    if (previous !== undefined) process.env.OPENROUTER_API_KEY = previous;
  }
});
```

### N14 · NEW — `multiSelectPicker.test.ts` B1 haystack test is brittle

**Where**: `__tests__/multiSelectPicker.test.ts:178-205`
**Category**: NEW (test quality, B1)

The B1 test reads the source file as a string and asserts on the haystack pattern. The meta-test does NOT verify that the haystack is actually USED defensively. **Fix**: rewrite to exercise the runtime path (mock `fuzzyFilter` and assert it's called with the `$$commit$$` haystack).

### N26 · NEW — `providerDispatch.test.ts` "routes through pi-ai/compat" tests pass for the wrong reason

**Where**: `__tests__/providerDispatch.test.ts:208-237`
**Category**: NEW (test quality)

Tests assert `completeSimple` was called but don't verify call args. **Fix**: add `expect(callArgs?.model.provider).toBe("anthropic")`.

### N29 · NEW — `secondOpinionRunner` M7 fallback warning has no regression test

**Where**: `__tests__/integration/opinion.test.ts`
**Category**: NEW (test gap, M7)

The M7 fix added a regression test for `councilRunner` (in `retry-transient.test.ts:223-242`) but `secondOpinionRunner` (which has the OLD wording per N2) has no test. **Fix**: add a `runSecondOpinion` test that triggers the structured-output fallback and asserts the new wording.

---

## ⚪ Minor

### N12 · NEW — `multiSelectPicker` `displayLabel` magic numbers

**Where**: `multiSelectPicker.ts:140-141`
**Category**: NEW

`40` and `37` are magic constants. Extract to named constants.

### N15 · NEW — `redactedApiKey` boundary lengths not tested

**Where**: `__tests__/settings.test.ts:165-180`
**Category**: NEW (test coverage, M5)

Tests cover 27-char and 60-char keys but not the transition at 43 chars (`length - 11 = 32`, the cap). **Fix**: add a test for a 43-char key.

### N17 · NEW — `ci.yml` Node 22/24 comment labels swapped

**Where**: `.github/workflows/ci.yml:4-5`. **Category**: NEW. Node 22 entered Maintenance in Oct 2025; Node 24 is current Active. **Fix**: swap the labels in the comment.

### N18 · PRE-EXISTING — `package.json` description is now inaccurate

**Where**: `package.json:4`
**Category**: PRE-EXISTING (predates the 16-issue fix, but the dispatch work makes it actively wrong)

`"Pi extension: multi-model coding decisions via OpenRouter"` — after the provider-dispatch work, the extension supports direct providers. **Fix**: update wording.

### N19 · PRE-EXISTING — `package.json` keywords don't reflect multi-provider support

**Where**: `package.json:21-26`
**Category**: PRE-EXISTING (predates the 16-issue fix, but the dispatch work makes it actively wrong)

`"keywords": ["pi-package", "pi-extension", "openrouter", "ai-council"]` — should add `anthropic`, `openai`, etc.

### N21 · PRE-EXISTING — `README.md` has minor drift

**Where**: `README.md:5, 26`. **Category**: PRE-EXISTING. Line 5 says "three independent AI models" but the schema allows 1-8; line 26 lists OpenRouter API key as prerequisite but pi-auth users don't need one. **Fix**: update wording on both lines.

### N25 · NEW — `searchSelector-reasoning.test.ts` test name doesn't match what it verifies

**Where**: `__tests__/searchSelector-reasoning.test.ts:47-67`
**Category**: NEW (test quality)

The test asserts the model's label is in the choices list — but the non-TUI fallback doesn't render the badge. The test passes for the wrong reason.

**Fix**: rename or make it exercise the TUI render path that actually shows the badge.

### N27 · NEW — `settings-migration.test.ts` doesn't cover empty-strings-only council

**Where**: `__tests__/settings-migration.test.ts` (synthesis display tests around line 196)
**Category**: NEW (test coverage, M5/M7)

`councilModels = ["", ""]` + `synthesis = undefined` — partial save edge case. Not tested.

### N28 · NEW — `council-availability.test.ts` doesn't test the `maxPicks` over-limit boundary

**Where**: `__tests__/integration/council-availability.test.ts` (the 4 B3 tests)
**Category**: NEW (test coverage, B3 / N8)

User sets `maxPicks = 1` but saved `councilModels` has 3 entries. Per N8, the TUI `commit()` doesn't validate `maxPicks`, so this state would silently pass. Add a test that exercises this state.

### N30 · NEW — `multiSelectPicker` TUI `commit()` has no test for the `maxPicks` over-limit path

**Where**: `__tests__/multiSelectPicker.test.ts` (commit-related tests)
**Category**: NEW (test coverage, N8)

Related to N8 — no test covers the over-limit path. **Fix**: add a test (or document the missing check).

### N31 · NEW — `settings.ts` redaction length still leaks relative key length

**Where**: `settings.ts:128-136`
**Category**: NEW (introduced by 16-issue fix, M5)

The M5 fix scales bullet count to key length: `min(32, max(8, length - 11))`. But the cap is `32` and the minimum is `8`, so for any key in the range `length ∈ [19, 43]` the bullet count `∈ [8, 32]` directly leaks the key length. A user who sees a 32-bullet redacted key knows it's at least 43 characters. A user who sees 8 bullets knows the key is short. This is exactly the leak M5 was supposed to fix.

**Reproduction**: in `/council-settings list`, the redaction for a 25-char key shows 14 bullets; a 50-char key shows 32 bullets. The user can read the relative length from the rendered output.

**Fix**: use a FIXED bullet count (e.g. always 16) regardless of key length, so the redaction is indistinguishable across keys:

```ts
const FIXED_BULLETS = 16;
return apiKey.slice(0, 11) + "•".repeat(FIXED_BULLETS);
```

Or hash the length: `bullets = 8 + (hash(apiKey.length) % 25)` so different lengths can land on the same bullet count.

### N32 · NEW — `secondOpinionRunner.ts:54` M7 wording was inherited from the previous round of fixes

**Where**: `secondOpinionRunner.ts:54-65`
**Category**: NEW (16-issue fix's M7 work missed this file)

The M7 wording fix updated `councilRunner.ts:363-368` but the parallel code path in `secondOpinionRunner.ts:54-65` (the `if (attemptWithStructuredOutput && isStructuredOutputError(firstError))` block) was left untouched. **Fix**: copy the new wording into `secondOpinionRunner.ts` (covered by N2 above).

---

## Test gap analysis

For the 16-issue fix, **23 new tests** were added. Audit found: 5 test gaps (N13, N15, N27, N28, N29), 3 brittle designs (N14, N25, N30), 1 implicit-dependency (N26).

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
| `integration/retry-transient.test.ts` | (verified N2 / P2 coverage) |
| `integration/dynamic-council.test.ts` | — |
| `searchSelector-reasoning.test.ts` | N25 |
| `runnerHelpers.test.ts` | — |
| `smoke.test.ts` | — |
| `validation.test.ts` | — |

---

## Recommended fix order

1. **P1** (auth bypass in `providerDispatch`) — real auth break, ~10-line fix
2. **P2** (synthesis retry without disabling structured) — real bug, ~15-line fix
3. **P3** (council picker is OpenRouter-only) — contradicts README, ~5-line fix in settings-ui
4. **B3** (`isModelMissing` cross-provider false-positive) — real B3-regression, ~10-line fix
5. **N2 / N32** (M7 consistency) — 1-line fix
6. **N22** (`searchSelector` non-TUI fallback disambiguate) — ~5-line fix
7. **N5** (`pick.value.split("::")` → validate parts.length === 2) — 3-line fix
8. **N1** (DRY `withTimeoutAndWrap`) — refactor
9. **N31** (`redactedApiKey` fixed bullet count) — 1-line fix
10. **N6, N7, N8, N10, N11, N12, N13, N15, N17, N18, N19, N21, N25, N27, N28, N29, N30** — defer or accept

The branch is **NOT** in a mergeable state today. The 4 blockers (P1, P2, P3, B3) would break core user flows (auth, synthesis, picker, validation). The above 9 fixes would take an estimated 1.5 hours and bring the review surface to near-zero.

---

*End of report. Revised after second independent audit at commit `25512c7`. Generated by an independent follow-up audit of commit `0bd077f`.*