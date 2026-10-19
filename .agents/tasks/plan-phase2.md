# Implementation Plan: phase 2, fill before full page load

Source of truth: `.agents/tasks/design-phase2.md` (iteration 4, APPROVED in `design-phase2-review.md`). Section refs (P1–P14) point into that addendum; follow its code sketches literally. Also apply the review's 3 NITs (items 6, 9, 12 below).

Repo: `/Users/MAC/Desktop/DEV/nz-working-holiday-automation`, branch `perf/fast-fill` (HEAD `7e73ecb`, phase 1 = `e58534f`). No worktree. Use absolute paths.

Commands (from package.json): `npx vitest --run` (baseline 309/309 in 32 files), `npx tsc --noEmit`. Single file: `npx vitest --run workflow/<file>.test.ts`.

Ground rules for every item:
- Do not modify: `captcha.test.ts`, `submission.ts`, `submission*.test.ts`, `payer-form.ts`, `conditions.ts`, `fields.ts`, `section-policy.ts`, `data-validation.ts`, `capsolver*.ts`, `two-captcha.ts`, `occupation-widget.test.ts`.
- `fast-fill.ts` must not import from `run.ts`.
- New browser scripts are `String.raw` constants with a `/* nzwh:<name> */` tag (`nzwh:dom-ready`, `nzwh:wait-field`, `nzwh:settle`), so tests can match them by tag.
- Every new wait calls `checkCancelled()` and site-busy (via `waitWithCaptcha`/`captchaGuard`, directly, or the injected guard).
- Log lines carry keys, counts, ms and cause codes only. `window.__nzwhEarly` is never returned or logged.
- Pre-existing uncommitted edits in `lib/format-duration*.ts` and `lib/log-stamp.ts` belong to the user. Do not stage or revert them. Stage files by name.

---

- [x] 1. Add the `pageLoadStrategy` param to `chooseBrowser`.
      Add trailing optional `pageLoadStrategy: "normal" | "eager" = "normal"` after `signal` in `chooseBrowser` (line 56). Call `options.setPageLoadStrategy(pageLoadStrategy)` before `new Builder()` (line 96) so both the spawned/attach and headless branches get it (P3). Existing callers stay unchanged.
      Files: browser/chooseBrowser.ts
      Verify: `npx tsc --noEmit` is clean; `npx vitest --run` stays 309/309.

- [x] 2. Add the phase-2 constants, switch and browser scripts to `fast-fill.ts`, with unit tests.
      - Constants (P4): `FIELD_WAIT_SLICE_MS=500`, `PRE_SAVE_SETTLE_WAIT_MS=30000`, `SETTLE_STABLE_POLLS=2`, `EARLY_FIELD_WAIT_MS=PRE_SAVE_SETTLE_WAIT_MS`, `EARLY_SECTION_WAIT_MS=READY_WAIT_MS+SECTION_WAIT_MS`, each with a doc comment.
      - `earlyFillEnabled()` (P2).
      - Scripts (P5): `NAV_WATCH_JS`; `SECTION_DOM_READY_JS` = NAV_WATCH + predicate, including `jQuery.isReady === true` (finding 1); `buildWaitForFieldScript(atom)` (MutationObserver + readystatechange, returns `ready|loaded|pending`), cached in `scriptsFor` beside `fill`/`available`; `PRE_SAVE_SETTLE_JS` returns `{ timeOrigin, navigating, settled }` (P7).
      - Wrappers: `sectionDomReady(driver, id)`; `waitForFieldInPage(driver, atom, id, mode, sliceMs, untilLoad)`, which maps `isNavigationError` to `"pending"` and rethrows anything else; `readSettleState(driver)`, which maps a navigation error to `null`; `documentComplete(driver)`, which maps a navigation error to `false`; `waitForChangeThenLoad(driver, condition, guard, changeTimeoutMs?, loadTimeoutMs?)` exactly as in P9.
      - Tests in `workflow/fast-fill.test.ts` (node:vm pattern already in the file): P11 cases 1, 2 and 5. New `workflow/submission-load-wait.test.ts` covers P11 case 6: no readyState or guard call before the condition is true; `false,false,true` resolves; never-complete rejects with `TimeoutError`; a guard of `checkCancelled` aborts with `StopRequested` within one poll; a `SiteBusyError` from the guard propagates.
      Files: workflow/fast-fill.ts, workflow/fast-fill.test.ts, workflow/submission-load-wait.test.ts (new)
      Verify: `npx vitest --run workflow/fast-fill.test.ts workflow/submission-load-wait.test.ts` passes; full suite and `npx tsc --noEmit` clean.

- [x] 3. Extend the fill script with `deferClears` / `restoreEarly` and the `deferred` status.
      In `buildFillSegmentScript`, read `arguments[2]`/`[3]` and prepend `NAV_WATCH_JS`. Add `nativeSet`, the `start === 0` silent restore sweep, the per-entry fallback restore, `deferred` for `expected === ''` under `deferClears`, and the first-write-only record `rec[id] = e.value` before each value write (P6, in the stated loop order). Add `"deferred"` to `FillStatus` with a comment that only `deferClears` produces it, `runEarly` ignores it in stats, and the authoritative pass never sees it (review NIT 3). Change `fillSegment(driver, atom, entries, start, opts = { deferClears: false, restoreEarly: false })` to pass both args; phase-1 callers keep identical behavior.
      Tests (`fast-fill.test.ts`): P11 cases 3 and 4, all bullets, including the sweep case, no sweep when `start > 0`, and the `JSON.stringify(result)` sentinel check.
      Files: workflow/fast-fill.ts, workflow/fast-fill.test.ts
      Verify: `npx vitest --run workflow/fast-fill.test.ts` passes, and existing phase-1 fill cases are unchanged and green; full suite clean.

- [x] 4. Introduce `EntryMode` and `earlyEntrySnapshot` in `run.ts`, threaded through without behavior change.
      Add `type EntryMode = { fast: boolean; early: boolean }` and `earlyEntrySnapshot(fast)` next to `fastEntrySnapshot` (line 1310) (P2). Change `waitForSection` (732), `saveStep` (1325) and `fastFillSection` (1193) from `fast` to `mode: EntryMode`, with default `{ fast: false, early: false }`. `legacyFillField`, `waitForPostback` and `postbackAndWait` keep their boolean. `saveStepForTest` (1307) accepts `boolean | EntryMode` and normalizes booleans. `fillAndSaveWorkingHolidaySection` (1446) passes `{ fast, early: false }` and does not call `earlyEntrySnapshot`. For now `mode.early` takes the phase-1 branch everywhere.
      Files: workflow/run.ts
      Verify: `npx tsc --noEmit` clean; `npx vitest --run` 309/309 + items 2–3 tests; `fast-fill-run.test.ts:136,195` unchanged and passing.

- [x] 5. Wire the session strategy and the capability check in `executeWorkingHoliday`.
      After `fast` (1509), add `let early = earlyEntrySnapshot(fast)` and pass `early ? "eager" : "normal"` as the new last arg of `chooseBrowser(...)` (1535). At the capability read (1542), compute `requestedEager`, `reported`, `eagerSession`, and the confirmed `early`, and log the "not confirmed" line (P1). Add the module-level `eagerDrivers` WeakSet and `markEagerDriverForTest`, and register the driver when `eagerSession`. Build `const entry: EntryMode = { fast, early }` and pass it to the section loop's `waitForSection` and `saveStep`. At line 1855, pass `waitForChangeThenLoad(driver, condition, async () => { checkCancelled(); await assertSiteAvailable(driver); })` when `eagerSession`; otherwise keep today's `driver.wait`.
      Check `credential-isolation.test.ts` (fakes `getCapabilities: async () => null`). If its fake reaches `finishApplication`, make it answer `readyState`. Adjust the fake, never the assertion.
      Tests (`fast-fill-run.test.ts` or a new `workflow/early-session.test.ts`, following the existing executeWorkingHoliday mock pattern): P11 case 11b (reject means registered, `early=false`, `waitForChangeThenLoad` passed; `"normal"` means not registered, `driver.wait` passed), and case 15's `NZWH_FAST_FILL=0` part (`chooseBrowser` called with `"normal"`; `NZWH_EARLY_FILL=0` also means `"normal"`).
      Files: workflow/run.ts, workflow/fast-fill-run.test.ts (or new workflow/early-session.test.ts), workflow/credential-isolation.test.ts (fake only, if needed)
      Verify: targeted tests pass; full suite and `npx tsc --noEmit` clean.

- [x] 6. Add the CAPTCHA provider-branch load wait (finding 6).
      In `captchaGuard` (170), inside the provider branch only, right before `readCaptchaChallenge` (198), add the `eagerDrivers.has(driver)` loop: read readyState FIRST, then `checkCancelled`, `assertSiteAvailable`, `captchaPending`, sleep `PAGE_POLL_MS`, up to `READY_WAIT_MS` (P8). Apply review NIT 1: set `skipProvider = true` at the `!captchaPending` break, and keep the post-loop `captchaPending` re-check only for the readyState and deadline exits. With `skipProvider`, skip the provider block (no key load, solver or notify) and trace `challenge gone during load wait.`. The manual branch and unregistered drivers keep an unchanged call sequence.
      Tests: new `workflow/captcha-load-wait.test.ts` with P11 cases 17–21, using `markEagerDriverForTest`. `captcha.test.ts` stays untouched.
      Files: workflow/run.ts, workflow/captcha-load-wait.test.ts (new)
      Verify: `npx vitest --run workflow/captcha-load-wait.test.ts workflow/captcha.test.ts` passes; `git diff --stat workflow/captcha.test.ts` is empty; full suite clean.

- [x] 7. Add early section entry in `waitForSection`.
      Add the `mode.early` branch: `activateChrome`, then `waitWithCaptcha(driver, async () => { checkCancelled(); await requireSession(driver); return sectionDomReady(driver, firstId); }, EARLY_SECTION_WAIT_MS, FAST_POLL_MS)`. There is no `ready()` call (P5). The `!fast` and phase-1 branches stay unchanged. The verification reload inside `saveStep` uses the same `mode`.
      Tests (`fast-fill-run.test.ts`): P11 case 15a (fake timers: false for 25 s, then true, no throw; `TimeoutError` only after `EARLY_SECTION_WAIT_MS`).
      Files: workflow/run.ts, workflow/fast-fill-run.test.ts
      Verify: targeted test passes; full suite clean.

- [x] 8. Implement the two-pass `fastFillSection` for `mode.early` (findings 1–4).
      Depends on 3 and 7. Keep the phase-1 body for `!mode.early`. Add the early variant per P7:
      - Step 0: `earlyWanted = !(await documentComplete(driver))`.
      - `runEarly()`: separate resume map. Over `MAX_FIELD_RESUMES`, defer with `index=i+1; continue` (finding 4). Field waits use the `waitWithCaptcha` loop over `waitForFieldInPage(..., FIELD_WAIT_SLICE_MS, true)` with limit `EARLY_FIELD_WAIT_MS`; a `TimeoutError` counts as `loaded`, and `loaded` defers. `posting` and `fallback` return (finding 3; `legacyFillField` is never called). `filled` increments `stats.early` only and does not touch `report.filled`.
      - `settle()`: `PRE_SAVE_SETTLE_JS` reads via `waitWithCaptcha`, `SETTLE_STABLE_POLLS` consecutive settled reads. Reset on `null`, `navigating` or `!settled`. A changed `timeOrigin` calls `unexpectedReload()`. On timeout, throw `WorkingHolidayStop("Page did not settle before SAVE; stopped.")`. Accumulate `stats.settleMs`.
      - `authoritative()` / `runAuthoritative()`: `fillSegment(..., { deferClears:false, restoreEarly:true })` from index 0. Phase-1 missing/unavailable handling (throwing guard). On `posting`/`fallback`, call the unchanged `legacyFillField(..., true)`; a new `timeOrigin` gives `stamp = next; return 'postback'`. One `postbacks` counter per section is shared with the re-check refill; past `entries.length`, throw `WorkingHolidayStop("Form reloaded repeatedly while filling; stopped.")` (finding 2). Settle again if `wrote`.
      - Re-check: phase-1 `recheck` → one `authoritative()` refill → `Readback mismatch`.
      - Timing log: add `early N`, `restarts N` and `settle Nms` (P2 format).
      Tests (`fast-fill-run.test.ts`, mocked driver via `saveStepForTest(driver, name, data, { fast:true, early:true })`): P11 cases 7, 8, 9, 10, 11, 11a, 12, 13, 14 (cancel during the early field wait → `StopRequested` within ~600 ms), and a cancel during the settle barrier → `StopRequested`. Also add case 15's `NZWH_EARLY_FILL=0` / `{fast:true, early:false}` (no `nzwh:dom-ready`, `nzwh:settle` or `nzwh:wait-field` scripts), case 16 (timing line has the new fields and no sentinel value), and review NIT 2 (a delegated `$(document).on('change','#x',…__doPostBack)` early write produces a new `timeOrigin`, which emits `possible`, throws the unexpected-reload stop, and sends no SAVE).
      Files: workflow/run.ts, workflow/fast-fill-run.test.ts
      Verify: `npx vitest --run workflow/fast-fill-run.test.ts` passes; full suite and `npx tsc --noEmit` clean.

- [x] 9. Add real-Chrome eager fixtures.
      Extend `workflow/fast-fill-browser.test.ts` using its 127.0.0.1 server and skip-if-no-Chrome pattern. Pages get a 2–3 s slow image so `load` lags DCL. The session is `eager`, set on `Options` or through `chooseBrowser`'s new param, whichever the file already uses for driver creation. Cover P11 cases 22–29:
      - 22: fill happens while `readyState !== 'complete'`; SAVE only after load.
      - 23 (A): a `title` onchange bound in `window.onload` reveals `otherTitle`; the server gets both.
      - 24 (B): `$(window).on('load')` binds an AutoPostBack; `possible` before the legacy postback; the dependent field is filled. Serve a local jQuery copy if one exists in node_modules or the test assets. Otherwise inline a minimal `$`/`jQuery._data` shim in the fixture. Do not add a dependency.
      - 25 (C): second-postback document clears in onload; the server receives `""`.
      - 26 (D): onload resets a later field; it is rewritten; no `Readback mismatch`.
      - 27: hidden-input echo (finding 3). The server POST timestamp is after the page's `loadEventStart`, and the echoed value is the post-load one.
      - 28: a field inserted 300 ms after DCL is filled with no fixed sleep.
      - 29: `NZWH_EARLY_FILL=0` runs no early scripts, and fill starts after load.
      Files: workflow/fast-fill-browser.test.ts
      Verify: `npx vitest --run workflow/fast-fill-browser.test.ts` passes locally with Chrome (record skip vs run in the report); full suite clean.

- [x] 10. Run final verification and update the report.
      Run `npx vitest --run` (expect ≥309 plus the new tests, 0 failures) and `npx tsc --noEmit` (clean). Confirm `git diff --stat e58534f.. -- workflow/captcha.test.ts workflow/submission.ts workflow/payer-form.ts workflow/conditions.ts workflow/fields.ts` is empty. Append a phase-2 section to `.agents/tasks/form-fill-speedup-report.md` covering what changed, the P13 savings estimate per page, the switches and A/B procedure, and what remains unverified live (P14). Commit locally on `perf/fast-fill`, staging only the files touched above, never pushing.
      Files: .agents/tasks/form-fill-speedup-report.md
      Verify: both commands are green; `git log -1` shows the commit; `git status` shows only the user's pre-existing lib/ edits and untracked .agents files.

---

## Verification evidence (iteration 2, after review-phase2)

Run on branch `perf/fast-fill`, working tree uncommitted (orchestrator commits):

- `npx tsc --noEmit`: exit 0, no output.
- `npx vitest --run`: **Test Files 36 passed (36), Tests 363 passed (363)**. Baseline: 309/309 in 32 files. New files: `early-session.test.ts`, `early-fill-browser.test.ts`, `captcha-load-wait.test.ts` and `submission-load-wait.test.ts`. Extended: `fast-fill.test.ts` and `fast-fill-run.test.ts`.
- `git diff --stat e58534f -- workflow/captcha.test.ts workflow/submission.ts workflow/payer-form.ts workflow/conditions.ts workflow/fields.ts`: empty.

Review findings addressed:

1. Evidence: recorded above, and plan items marked done.
2. Real-Chrome eager fixtures: new `workflow/early-fill-browser.test.ts`. It runs the full section flow through `saveStepForTest` (fill, settle, SAVE form POST, reload, verify) against 127.0.0.1 with a 2 s slow image. Cases 22, 23 (A), 24 (B, jQuery shim inline, no dependency), 25/26 (C, D on `character` with two AutoPostBack selects, second-postback onload), 27 (hidden echo), 28 (300 ms late insert) and 29 (`NZWH_EARLY_FILL=0`, normal session) **all ran and passed on this machine. None were skipped.** The file is separate from `fast-fill-browser.test.ts` because it needs its own server and sessions. C and D are one fixture with two assertions.
3. Session wiring: new `workflow/early-session.test.ts`. Case 15: `chooseBrowser` gets `"eager"` by default and `"normal"` under `NZWH_FAST_FILL=0` and under `NZWH_EARLY_FILL=0`. Case 11b covers four checks. A rejected capability registers the driver. Reported `"normal"` does not, and neither does `NZWH_EARLY_FILL=0`. The submission wait is change+load with a guard on each poll when the session is eager, and a single 30 s `driver.wait` with no readyState read otherwise. The `entrySession` mapping table is tested too. This adds the test-only export `isEagerDriverForTest`.
4. NIT 2: a dedicated test in `fast-fill-run.test.ts`. An early write fires a delegated `__doPostBack` and produces a new timeOrigin. The test checks `possible`, the unexpected-reload stop, no authoritative pass, no legacy entry and no SAVE.
5. Report: a phase-2 section is appended to `form-fill-speedup-report.md`. **Commit not made**: this step's instructions say the orchestrator commits after review. Stage by name and leave out the user's `lib/` edits.

Fix found by the real-Chrome fixtures (case 28): in early mode the verification reload read values at DOM-ready, so a field inserted after DCL read as missing. That was a false `Saved field missing` failure. Now, if any value is missing or different, the run waits for full load (`waitWithCaptcha`, `checkCancelled`, `requireSession`, `READY_WAIT_MS`) and re-reads, which gives the load-first outcome (`run.ts`, `saveStep`). This also covers the P14 row "load script on the verification reload rewrites a saved value".
