# Early fill before full page load (phase 2, iteration 2)

Phase 2 lets section pages be filled at DOMContentLoaded. The browser runs with the `eager` page-load strategy, an early pass fills the fields already present, and an authoritative pass then re-decides every field once the DOM has settled. Every early write is recorded in the page, silently restored and replayed on the settled DOM, so handlers bound late still see it. A postback inside the authoritative pass restarts that pass on the new document. Submission, declaration and payment pages are back on the change-then-load wait. Iteration 2 closes all five iteration-1 findings: verification evidence, real-Chrome fixtures, session wiring tests, the NIT 2 test, and the report section.

Watch for: the commit is still not made (the orchestrator does it, and the user's unrelated `lib/` edits must stay unstaged). The live timing of handler binding and the eager strategy in `debuggerAddress` attach mode can only be checked on the real site (likely, by design).

**Verdict**: APPROVED

## High-level view

The early pass (`deferClears`) writes only non-empty values and defers clears. It records each pre-write value in `window.__nzwhEarly` and nowhere else. It never throws: past `MAX_FIELD_RESUMES` it defers, and it returns on `posting`/`fallback`, so no POST is sent before `load` (findings 3 and 4). `SECTION_DOM_READY_JS` also requires `jQuery.isReady` (finding 1).

The authoritative pass (`restoreEarly`) runs after `settle()`. It restores each recorded value with no events, then makes the usual phase-1 decision, so every early write is replayed with events against the handlers bound by then. When legacy entry produces a new `timeOrigin`, the pass returns `"postback"`. The section then settles again and restarts, with a cap of `entries.length` restarts (finding 2).

The session is `eager` only when `NZWH_FAST_FILL` and `NZWH_EARLY_FILL` are both enabled. A capability report that isn't `normal` registers the driver in `eagerDrivers`, and the early pass needs a confirmed `eager`. Registered drivers get the CAPTCHA provider-branch load wait. That wait reads readyState first and sets `skipProvider` when the challenge disappears (finding 6). They also get `waitForChangeThenLoad` on submission. Non-section pages still call `ready()`. With the early-fill switch off, the run is phase 1 with the `normal` strategy.

Recorded evidence in `plan-phase2.md` is `tsc --noEmit` clean and vitest 363/363 in 36 files, against a 309/309 baseline. `captcha.test.ts`, `submission.ts`, `payer-form.ts`, `conditions.ts` and `fields.ts` are unchanged since `e58534f`, which I confirmed with `git diff --stat`. No dependencies were added.

<details>
<summary>Issues (2)</summary>

1. **Commit pending** (confirmed, non-blocking): phase 2 is uncommitted on `perf/fast-fill`. Stage by name and leave out `lib/format-duration*.ts` and `lib/log-stamp.ts`, which are unrelated timing edits.
2. **Live-only assumptions** (likely, non-blocking): handler-binding timing, the eager strategy under `debuggerAddress` attach, and the real DCL→load gap are not verified on the live site. The kill switches are the fallback.

</details>

<details>
<summary>Details</summary>

### Early pass and restore protocol

`FILL_SEGMENT_JS` takes `deferClears` and `restoreEarly` as `arguments[2]` and `[3]`. It records `rec[id] = e.value` only on the first write, and only under `deferClears`. With `restoreEarly` and `start === 0` it sweeps all records, and it also restores per entry. The script result shape is unchanged, and the tests check with `JSON.stringify` that the sentinel is not in it. The timing log adds only counts (`early`, `restarts`, `settle` ms), and the per-field logs print keys only. The case-22 browser test asserts that no letter-bearing value appears in the timing line.

### Postback restart and verification reload

```
authoritative: settle → runAuthoritative
  "postback" → ++postbacks > entries.length ? stop : restart
  {wrote}    → settle if wrote
```

A legacy postback to a new document causes a restart with no unexpected-reload stop. A reload the run didn't cause still goes through `unexpectedReload()` inside `settle()`, and the NIT 2 test covers that path, including no SAVE. The case-28 fix holds: on the verification reload, a missing or different value now waits for full load and re-reads before it can fail. This keeps the load-first outcome, and it doesn't loosen the check because the re-read is still compared.

### Tests

Fixtures A, B, C/D, hidden-input echo (27), late insert (28) and `NZWH_EARLY_FILL=0` (29) are in `early-fill-browser.test.ts`, and they ran against real Chrome with none skipped, according to the recorded evidence. `early-session.test.ts` covers the strategy passed to `chooseBrowser` under both switches, plus 11b registration and the submission-wait mapping. `captcha-load-wait.test.ts` has five cases: unregistered, registered, finding 6 disappearance, stop/cancel, and manual mode. The unit tests in `fast-fill.test.ts` cover restore and resume deferral.

</details>

<details>
<summary>File map</summary>

- `workflow/fast-fill.ts`: deferClears/restoreEarly, `deferred` status, DOM-ready, settle and readiness scripts, `waitForChangeThenLoad`.
- `workflow/run.ts`: `EntryMode`, early/authoritative orchestration, `eagerDrivers`, CAPTCHA load wait, submission wait, timing counts.
- `browser/chooseBrowser.ts`: optional trailing `pageLoadStrategy`.
- New tests: `early-fill-browser`, `early-session`, `captcha-load-wait`, `submission-load-wait`. Extended: `fast-fill`, `fast-fill-run`.
- `lib/*`: unrelated user edits, not part of this change.

Full diff: `git diff HEAD -- workflow browser`.

</details>
