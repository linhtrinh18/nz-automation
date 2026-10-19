# Per-section timing, logs-first monitor, milestone log stamps

Adds optional `startedAt`/`finishedAt`/`durationMs` to the outcome schema (identical edit in both repos). The automation `ExecutionController` stamps start on `section-start` and duration on `section-result`; `interruptJob`/`stopJob` close timing for in-flight items. The UI monitor now shows the logs panel always open (400px min, 70vh max, resizable), then a results table with Mục / Kết quả / Bắt đầu / Thời lượng. `run.ts` emits a per-section "finished in" line and a run total, and routine lines are unstamped via a `[NZWH:q]` token.

Watch for: run total uses module-load time unless a single-section path resets it (likely); other noisy lines (occupation lookup chatter) are still stamped (confirmed); no browser visual check of the new layout (confirmed).

**Verdict**: APPROVED

## High-level view

Timing is recorded where outcome state lives (controller), so run.ts did not need to change its loop. The schema fields are optional, so old persisted jobs parse and render "—". Data flows end to end: controller writes ISO start and ms duration, the UI formats start with vi-VN time and duration with the shared formatter, and ticks a live value for running rows.

The UI meets the layout requirements: logs visible by default, taller and scrollable, results below logs, verbose detail text and "N đã kiểm tra" removed. Failed, unverified and interrupted rows keep a one-line detail so errors are not hidden.

Log noise reduction is partial. Instead of stamping only milestones, the coder inverted it (opt-out `quiet`) because an existing test asserts every INFO line is stamped. That is a reasonable deviation, but it means unmarked chatter keeps its stamp.

<details>
<summary>Issues (4)</summary>

1. **Run total baseline** (likely) — `runStartMs` is initialised at module load and only reset in `fillAndSaveWorkingHolidaySection`; reset it at the start of `executeWorkingHoliday` so the total is correct.
2. **Residual log noise** (confirmed) — occupation lookup chatter and similar lines are still stamped; wrap them in the quiet token if the user finds the log still noisy.
3. **No visual verification** (confirmed) — `test:browser` failed early on an unrelated Private template step; check the new layout manually.
4. **Literal token in run.ts** (confirmed) — `[NZWH:q]` is hardcoded while `quiet()` is exported and unused; cosmetic.

</details>

<details>
<summary>Details</summary>

## Run total and section marks use module-level state

`runStartMs` and `sectionMark` are module globals in `workflow/run.ts`. `runStartMs` is only reassigned in the single-section entry point, so the full-run "Run finished; total" line measures from module load. Worker runs are one process per job, so the figure is close, but it is not the run start. `sectionMark` is a single slot, which is fine for the sequential section loop. A section that throws before `section-result` leaves no finished line; the controller timing is then closed by `interruptJob`/`stopJob` only.

## Quiet token inversion

The stamp wrapper skips the timestamp for INFO lines containing `[NZWH:q]`. Requirement 4 asked for stamps on milestones only; the shipped behaviour is stamps everywhere except marked routine lines. Per-field read-back, persistence-prep text and wait heartbeats are quieted. Diagnostics remain stamped, which is the intended safety.

## UI verification gap

Typecheck, lint and 189 unit tests passed per the commit message; the browser run never reached the monitor. Layout and the live-ticking duration are unverified visually. No script under scripts/tests references the removed toggle or old strings.

</details>

<details>
<summary>File map</summary>

Automation: lib/execution-state.ts (schema, withTiming), lib/execution-controller.ts (start/duration), lib/log-stamp.ts (quiet token), workflow/run.ts (section and total lines, quiet markers).
UI: components/execution-monitor.tsx (layout, table, ItemDuration), lib/execution-state.ts, lib/log-stamp.ts (mirrors).
Full diff: `git show HEAD` in each repo.

</details>
