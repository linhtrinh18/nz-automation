# Batched fast-fill for wizard sections (phase 1)

Phase 1 swaps the one-field-at-a-time Selenium entry for a batched `executeScript` fill per section segment in a new `workflow/fast-fill.ts`. It uses native setters plus input/change/blur dispatch, and a native select with a Select2 display check. Any field that fails verification, has a missing option or uses unknown markup falls back to `legacyFillField`. AutoPostBack/REMOTE_TRIGGER fields always go to the standard entry, with `possible` emitted first. Verification reads are batched, and polling uses a named `FAST_POLL_MS = 50`. Setting `NZWH_FAST_FILL=0`, read once per run, restores the legacy path. Watch for: none of this was exercised against the live site. Speed gains and event acceptance by the site's validators were only tested against fake and local DOMs (confirmed, from the evidence).

**Verdict**: APPROVED

## High-level view

Fill order and the saveStep decision sequence are unchanged. Fast entry only replaces the write and readback step, and the existing captchaGuard is called before each segment. The full-load wait (`readyState === 'complete'`) still runs before filling. Post-Next and post-SAVE waits are condition-based checks on readyState and async postback, with no fixed sleeps. No phase-2 work is present: no eager pageLoadStrategy, no DOMContentLoaded filling, no two-pass fill and no CAPTCHA load-wait changes.

New log lines carry only section and field key names, fallback causes, counts and durations, which is the same level of detail the legacy log lines already had. The per-section timing line reports counts and milliseconds only, and a test asserts that no sentinel value leaks into logs or events.

The working tree had no user changes in `submission.ts`/`submission.test.ts` before this work started. They are untouched. Nothing was stashed or reset.

<details>
<summary>Issues (1)</summary>

1. **Live-site validation unverified** (non-blocking): the claims about speed and about the site's validators accepting the dispatched events are untested against the real site. Do one live run with timing logs, and keep `NZWH_FAST_FILL=0` as the rollback.

</details>

<details>
<summary>Details</summary>

### Verification basis

The coder's evidence lists `tsc --noEmit` clean and vitest at 309/309 across 32 files (+48 tests). `captcha.test.ts`, `submission*`, `conditions.ts`, `payer-form.ts`, the captcha providers and `coverage-saved.json` are all unchanged. The tests cover:

- the REMOTE_TRIGGER node:vm true/false cases
- every fallback cause
- posting fields routed to legacy with `possible` emitted
- stop/cancel inside the new wait
- unexpected-reload detection
- the pre-SAVE re-check
- batched verify mismatches
- the kill switch running zero fast scripts
- real headless Chrome parity of `fieldAvailable` with `isEnabled && isDisplayed`

A spot-check of the diff found the readyState waits still in place and no new value-bearing log lines. No suites were re-run.

### Conditional dependents

A controller-before-dependent ordering guard was added. A delayed reveal reports as unavailable-required and is waited on at 50 ms with today's timeout message. A batched pre-SAVE re-check refills or stops. This covers the risk of a field being validated before its dependent field loads (confirmed by the tests).

</details>

<details>
<summary>File map</summary>

- `workflow/run.ts`: wires fast-fill into saveStep, adds batched verify, the timing log and the kill switch
- `workflow/fast-fill.ts` (new): fill script, REMOTE_TRIGGER, constants, helpers
- `workflow/fast-fill*.test.ts` (new): vm, mocked-driver and headless-Chrome tests

Full diff: `git diff` plus the untracked files.

</details>
