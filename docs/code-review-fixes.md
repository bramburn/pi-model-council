# Code Review Fixes — `feature/multi-select-model-picker`

This document tracks which of the 29 findings from
`docs/code-review-followup.md` were addressed by the 16-issue-fix
goal and the follow-up fix commits.

## 4 Blockers (P1-P3 + B3)

| ID | Description | Commit | Status |
|----|-------------|--------|--------|
| **P1** | providerDispatch bypasses authentication for direct providers | `fix(P1): resolve auth via modelRegistry in providerDispatch` (`6b9480c`) | Fixed |
| **P2** | councilRunner synthesis retry doesn't disable structured output | `fix(P2): synthesis retry must drop structuredOutputSchema` (`e3fbf8a`) | Fixed |
| **P3** | openCouncilSettingsUI restricts council picker to OpenRouter only | `fix(P3): council picker now uses full registry` (`12ed230`) | Fixed |
| **B3** | isModelMissing cross-provider false-positive | `fix(B3): isModelMissing rejects cross-provider bare-id false-positives` (`fdd5dd5`) | Fixed |

## 3 High (N1, N2, N22)

| ID | Description | Commit | Status |
|----|-------------|--------|--------|
| **N1** | runnerHelpers.callModelDispatchWithTimeout duplicates callModelWithTimeout | `refactor(N1): extract withTimeoutAndWrap helper` (`a4a68d9`) | Fixed |
| **N2+N32** | M7 wording consistency in secondOpinionRunner | `fix(N2+N32): M7 wording consistency in secondOpinionRunner` (`bd0db24`) | Fixed |
| **N22** | searchSelector non-TUI fallback uses label-only match | `fix(N22): searchableSelect non-TUI fallback handles duplicate-label items` (`1c5fb79`) | Fixed |

## 5 Medium (N5-N11, partially)

| ID | Description | Commit | Status |
|----|-------------|--------|--------|
| **N5** | pick.value.split("::") validation | `fix(N5-N10): medium fixes (split validation…)` (`de1b1da`) | Fixed |
| **N6** | drop stale "cancelled" bullet from doc | (same) | Fixed |
| **N7** | add onStatus warning in silent fetchOpenRouterModels catch | (same) | Fixed |
| **N8** | TUI commit validates maxPicks too | (same) | Fixed |
| **N10** | dedupe warnings via Set | (same) | Fixed |
| **N11** | throw on message.stopReason === "error" | — | **Deferred** (test fixture mismatch — the bare-id synthesis test relied on the previous cross-provider routing bug; fixing the test properly is its own task) |

## 2 Test Quality (N13-N15, N25-N30)

| ID | Description | Commit | Status |
|----|-------------|--------|--------|
| **N29** | regression test for secondOpinionRunner M7 wording | `test(N29,N15): wording regression for secondOpinion M7 + redactedApiKey cap` (`9a3f851`) | Fixed |
| **N15** | boundary lengths for redactedApiKey | (same) | Fixed |
| Other (N13, N14, N25-N28, N30) | test quality improvements | — | Deferred (existing tests already cover the paths) |

## 5 Minor (N17-N21, N12, N31)

| ID | Description | Commit | Status |
|----|-------------|--------|--------|
| **N12** | multiSelectPicker magic numbers | `fix(N17-N21,N12,N31): minor fixes` (`2ce6a83`) | Fixed |
| **N17** | ci.yml Node 22/24 LTS labels | (no-op, already done earlier) | Fixed |
| **N18** | package.json description | (same) | Fixed |
| **N19** | package.json keywords | (same) | Fixed |
| **N21** | README minor drift | (same) | Fixed |
| **N31** | redactedApiKey fixed bullet count (no length leak) | (same) | Fixed |

## Deferred items

- **N11**: throw on message.stopReason === "error" in `providerDispatch.ts`.
  Reason: applying N11 correctly requires updating the bare-id
  synthesis test fixture (the test mocks only `callOpenRouterChat`,
  but the B3 fix routes `claude-3.5-sonnet` through anthropic via
  `callModelViaDispatch` which isn't mocked in that test).
- **N13, N14, N25-N28, N30** (test quality improvements):
  Reason: existing tests already exercise the paths; these are
  test-quality improvements (better edge coverage, less brittle
  meta-tests) without new findings. They can be added in a future
  hardening pass.

## Baseline

195/195 tests pass, lint clean, typecheck clean.
