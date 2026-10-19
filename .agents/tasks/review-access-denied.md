# Verify-first recovery from access-denied redirects

Adds `AccessDeniedError` (a `WorkingHolidayStop`, not a `SiteBusyError`) and detects `/formshelp/access-denied` inside `assertSiteAvailable`'s existing single `executeScript`. Recovery reuses the project's "possible save" model. If nothing could have been posted, the section is reloaded with a GET and refilled. If a save may have been applied, nothing is refilled and SAVE is not re-clicked; the values are read back read-only and marked verified or unverified. Retries are bounded to 2 per run (2000/5000 ms abortable backoff), with a kill switch and PII-free messages.

Watch for: nothing blocking. The live-site unknowns (trigger, 302 vs script redirect, session survival, whether a denied SAVE was applied) are stated in the report; the design is conservative for all of them (confirmed from the report and diff).

**Verdict**: APPROVED

## High-level view

Detection adds no round trip. The same script now returns `'denied'` (decided by pathname only), `'busy'` or `false`. A legacy `true` still maps to busy, so the captcha fixtures are untouched.

The phase-2 early-fill and settle paths check for the denied page before `unexpectedReload` sets `risk`. A mid-fill redirect therefore does not emit `possible`.

The section loop has one new `AccessDeniedError` branch. With `risk` false it returns "retry" and the normal fill restarts. With `risk` true it only reads values back. Verified completes the section; otherwise it is pushed to `unverifiedSections` and the loop moves on without any replay.

Pre-wizard login and advance steps go through `withAccessDeniedRetry` on the same shared budget. No applicant data has been sent at that point.

Submission and payment code is untouched. A denied page there ends as `incomplete` through the existing single-click path.

<details>
<summary>Issues (2)</summary>

1. **Pay Now, Secure Payment and payer OK have no dedicated denied tests** (confirmed, non-blocking) — they share the `finishApplication` loop that the final-Submit cases exercise. Consider one parameterized case later.
2. **In-flight redirect read as the old document** (possible, non-blocking, documented) — `unexpectedReload` can then still set `possible` and stop. This is the conservative direction, so no action is needed.

</details>

<details>
<summary>Details</summary>

## Safe-to-repeat recovery

`recoverFromAccessDenied` always starts with a GET of the section URL and re-validates the host, pathname and ApplicationId. The branch on `risk` is the only fork. The `risk === true` path contains no fill and no click. It calls `readFieldValues`, compares against `planSection(...).expected`, and re-reads once after `documentComplete` before declaring "unverified". I found no path in which the retry loop re-clicks SAVE, submit or payment. The `continue` after "retry" re-enters `saveStep` only when `risk` is false, meaning no POST was possible (confirmed in the diff).

An access-denied after a possible SAVE emits `verified` only on a full match. Otherwise the section is marked failed and unverified, mirroring the site-busy handling. The session-expired outcome reuses the existing `risk`-guarded stop.

## Bounds, kill switch and logging

`MAX_ACCESS_DENIED_RECOVERIES=2` and `ACCESS_DENIED_BACKOFF_MS=[2000,5000]` are named constants. The kill switch is read once per run, and the recovery-disabled path detects and stops. `abortableBackoff` polls the abort signal every 100 ms and throws `StopRequested`. Exhaustion throws a fixed message. Logs and events carry only the section label, attempt, action, elapsed ms and the constant path `/formshelp/access-denied`. `getCurrentUrl()` is only used for pathname and ApplicationId comparison and is never logged raw.

## Regressions and scope

The CAPTCHA wait and site-busy branches are unchanged. The `AccessDeniedError` branch sits after the `StopRequested` rethrow and before the busy handler. Only one other catch in `run.ts` handles `WorkingHolidayStop`, and it is reached only after the denied branch. The uncommitted phase-2 files and the `lib/format-duration*` and `lib/log-stamp.ts` edits are intact, and nothing is staged or committed. There are no dependency changes.

## Test evidence

I did not re-run the suites, as instructed. The report records 414 passed in 38 files (baseline 363) with a clean `npx tsc --noEmit`. That meets the 363-or-more bar. It also records a mutation check: removing the denied check in `unexpectedReload` fails 6 new tests. `access-denied.test.ts` (45 tests) covers the vm-run detector, fake-timer no-spin, each recovery path, the retry limit and backoff, stop during backoff, the kill switch, login, CAPTCHA, and no-PII. `access-denied-browser.test.ts` adds 3 headless-Chrome fixtures. `submission.test.ts` adds 3 incomplete/single-click cases.

</details>

<details>
<summary>File map</summary>

- `workflow/site-busy.ts`: AccessDeniedError, combined detector script, `isAccessDenied`, `abortableBackoff`
- `workflow/fast-fill.ts`: recovery constants and kill switch
- `workflow/run.ts`: denied-before-risk checks, section recovery branch, pre-wizard retry
- `workflow/access-denied.test.ts`, `workflow/access-denied-browser.test.ts`, `workflow/submission.test.ts`: tests
- Full diff: `git diff` on `perf/fast-fill`

</details>
