# Verification note (iteration 1, PARTIAL implementation)

Ran in the worktree:
- `npm run typecheck` -> exit 0, no errors.
- `npm test` -> 40 files, 445 tests passed (includes new `workflow/tab-pipeline.test.ts`, 13 tests; `login-only.test.ts` now parametrized for maximize skip).
- Offline only. No live site, no live SAVE.

Implemented: plan items 1 (flag snapshot + log line), 2 (windowSizedAtLaunch, both non-attach paths; attach/unknown drivers keep maximize),
the keyed-event/background model in `lib/execution-*` (part of item 8), and the finding-1 gate in `workflow/tab-pipeline.ts`
(`loadTimeRescan`, `mayPostNext`): `persistence accepted` only after the load-time re-scan, load-time `[errorlabel]` -> keyed `failed`
(persistence stays `possible`, controller maps to `failed`), barrier `accepted` waits for the emitted event, N+1 gets no SAVE.

NOT implemented (not verified, no behavior change): items 3-7 and 9-12, i.e. single-probe, login `ready()` removal, settle-barrier
reduction, combined pre-SAVE script, `waitForPostback` levels / `saveStep` split, `boundary()`, the scheduler/TabSlots, run.ts section-loop
integration, browser fixture tests. NZWH_TAB_PIPELINE is parsed and logged but run.ts still always runs sequentially (effective `off`).
