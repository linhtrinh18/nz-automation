# Form-fill speedup: tab pipeline, probe and pre-SAVE speedups

Adds `NZWH_TAB_PIPELINE=off|verify|save` (default off), a two-slot tab scheduler, per-section run-state keying, and always-on single-tab speedups: one page probe per poll, fewer login-flow waits, a combined pre-SAVE script, and no maximize at launch. Evidence: typecheck exit 0 and 479 tests across 41 files, recorded in the commit message and verify note. I did not re-run them. No live site contact and no live SAVE.

Watch for: (1) the live gain is unproven; the simulated fixture shows only 8-10% (confirmed in the verify note). (2) Pipeline mode is opt-in, so the default path carries only the single-tab changes. (3) Background reads use CDP `Runtime.evaluate`, so the overlap is of network latency only (confirmed in the verify note).

**Verdict**: APPROVED

## High-level view

Off mode keeps the legacy SAVE and reload sequence. `saveStep` is `saveSection` followed by `verifySection({reload:true})`. `persistence accepted` is still emitted right after the path and `[errorlabel]` check (run.ts around 1821), so the event order matches the old flow.

In pipeline mode, `saveSection` with `interactive: true` does not emit `accepted`. `loadTimeRescan` emits it only after the load-time re-scan is clean. A flagged field produces a keyed `section-result failed` while persistence is still `possible`, which the controller maps to `failed`, not `saved_unverified`. `mayPostNext` requires phase `accepted` or `verifying` for barrier `accepted`, and a terminal outcome for barrier `verified`, so N+1 is not posted before the re-scan passes. Unit tests cover both barriers and the controller mapping.

Save fires only after the pre-SAVE batched readback check, which is unchanged and kept as the gate. Waits are per-element and probe based. The remaining `sleep` in run.ts is the deliberate backoff at line 1154. Consent safeguards (`beforePost` hook), keyed run state and the Vietnamese strings are reused. The one new string, "Chưa lưu: …", is only in the pipeline-abort path.

<details>
<summary>Issues (2)</summary>

1. **Live A/B missing** (possible, non-blocking) — run the off/verify/save A/B on the live site, with consent, before changing the default. The server may serialize per-session requests, which would give zero gain.
2. **Barrier `accepted` reports a later failure after N+1 is posted** (confirmed, by design, opt-in) — document it for operators; the default `verified` avoids it.

</details>

<details>
<summary>Details</summary>

## Load-time failure mapping
`loadTimeRescan` throws if the tab is not in `domready`. It emits no persistence event on failure, sets outcome `stop` and `reported`, and emits one keyed `failed` event. The test asserts there is no persistence event, so `saved_unverified` is not reachable. A separate controller test shows that `possible` followed by `failed` gives `failed`. A DOM-ready `[errorlabel]` inside `saveSection` throws `WorkingHolidayStop` before any acceptance, so the mapping is also `failed`.

## Not verified by me
The browser tests (`pipeline-browser.test.ts`) were taken from the verify note. The diff is 9200 lines, so I spot-read only tab-pipeline.ts, its tests, and the saveSection and emit paths.

</details>

<details>
<summary>File map</summary>

See `git diff d25300d`. Main files: workflow/tab-pipeline.ts (new), workflow/run.ts (section loop, saveSection/verifySection), workflow/fast-fill.ts, workflow/page-state.ts, lib/execution-controller.ts, and tests.

</details>
