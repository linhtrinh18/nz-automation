# Implementation Plan: hybrid parallel verification (NZWH_PARALLEL_VERIFY)

Worktree: /Users/MAC/Desktop/DEV/nz-working-holiday-automation/.worktrees/hybrid-verify (branch feat/hybrid-verify-tab). Use absolute paths only; relative paths land in the parent repo. Commands (run from the worktree root): `npm run typecheck`, `npm test` (vitest). No bun, no new dependencies, never contact the live site, never print .env/credentials/applicant data/CAPTCHA tokens.

Note: the previous run's `.agents/tasks/review.json` (APPROVED) and `plan.md` were renamed to `review-logs-timing-prev.json` / `plan-logs-timing-prev.md` so the stale verdict cannot satisfy this loop's gate.

## Design decisions (grounded in workflow/run.ts)

- D1 Split saveStep, not duplicate it. `saveStep` (run.ts ~1583-1713) is cut at the `persistence: accepted` emit into `saveSection` (fill → unmapped check → captchaGuard → URL check → SAVE/postbackAndWait → pathname check → [errorlabel] check, unchanged) and `verifySection(driver, name, data, url, report, mode, atom, timings)` (reload → waitForSection → ApplicationId check → batched readFieldValues → early re-read → mismatch → SavedValueVerificationError / `verified` emit). `saveStep` becomes `saveSection` + `verifySection` in the same tab, so flag-off executes the identical command sequence. Rationale: one verification implementation for both modes; no second verifier to drift.
- D2 Single driver, two window handles. Selenium has one command queue per session, so "concurrent" means: tab 2 navigation is issued non-blocking (`driver.executeScript("location.href = arguments[0]", url)` after `switchTo().window(verifyHandle)`), then the driver switches back to the main tab and issues tab 1's GET for N+1 (blocking `navigate`, as today). Both page loads proceed in Chrome in parallel; only the WebDriver commands are serialized. The tab 2 read happens at the next safe point (after section N+1's `waitForSection`, before its fill starts) and at the drain. Rationale: no new driver/session (would need second login), no new deps.
- D3 A `VerifyTab` controller (new file `workflow/verify-tab.ts`) owns: the verify handle, a queue of pending `{name, url, report, timingsStart}`, `switchTo` wrapping that ALWAYS restores the main handle in `finally`, `disabled` flag + reason, `open()` via `driver.switchTo().newWindow("tab")` then switch back, `close()`. Every driver call that touches tab 2 goes through `withWindow(handle, fn)`. Rationale: one place guarantees the driver is never left on the wrong window.
- D4 Per-section risk. Replace `risk: boolean` in the AsyncLocalStorage store (~69-75) with `riskBySection: Map<string, boolean>` plus `currentSection?: string`. `emit` (~88) sets risk for `context.currentSection`. Loop (~2050) sets `currentSection = name` and `riskBySection.set(name,false)` instead of `context.risk=false`; readers at ~2000 and ~2146 use `riskBySection.get(name)`. Deferred-verify errors of section N never read or clear section N+1's risk, and a section with risk true is never refilled. `withHooksForTest` / `runWorkingHoliday` initialise the map. Add `export function sectionRiskForTest(name)` only if tests need it.
- D5 CAPTCHA mutex. Module-level `captchaLock` (promise chain) in run.ts. `captchaGuard(driver)` acquires it first; inside it records `pinned = await driver.getWindowHandle()` and every driver call of the guard (provider solve, manual wait, submit click) runs on that handle: before each poll iteration, if `getWindowHandle() !== pinned`, switch back to pinned. Because there is one driver and the guard holds the lock and the event loop is awaiting it, the other tab cannot issue commands, i.e. it is parked. The VerifyTab never calls captchaGuard while holding nothing: its reads run `captchaPending` on tab 2; if pending, it calls `captchaGuard` inside `withWindow(verifyHandle)` (so the guard pins tab 2), then after release switches to main and calls `captchaGuard(main)` again (re-check on own tab), and if the main tab's section was disturbed it reloads via `navigate` GET only. Nothing in the mutex path clicks SAVE. Only one provider solve/human prompt at a time follows from the lock.
- D6 Fallback triggers (disable for rest of run, close tab 2, verify the pending item sequentially in the main tab via the existing `verifySection`): SiteBusyError, AccessDeniedError, SessionExpiredError / login form / `readAuthState().rejected`, NoSuchWindowError, or tab-2 load timeout seen in tab 2. Sequential re-verify is a GET + read, never a POST. If even that fails the section is marked unverified (same as SavedValueVerificationError path) — never re-SAVE.
- D7 Eligibility: flag `NZWH_PARALLEL_VERIFY === "1"` read once in a `parallelVerifySnapshot()` next to `fastEntrySnapshot` (~1538) with one log line. Disabled when `options.attachPort` is set (attach mode, ~1839) and when `!entry.fast` (batched readFieldValues needed). The country popup closer (~547-560) runs only during `advanceToWizard`, before the section loop; tab 2 is opened lazily at the first deferred verify (after advanceToWizard) and closed before `finishApplication` and before any `authenticate`/`advanceToWizard` re-entry, so the closer never sees it. Additionally add a guard in the closer loop: skip `h === verifyTab?.handle` (defensive).
- D8 Drain: before `finishApplication` (~2252) call `verifyTab.drain()` → resolves every pending item; results feed the same `saved`/`completedSections`/`unverifiedSections`/emit logic as today, so `filled:` passed to finishApplication reflects them. Also drain before re-authentication and on any WorkingHolidayStop path (`finally`), and close tab 2.
- D9 Event ordering: section N's `section-result` is emitted only when its verification resolves (at N+1's safe point or the drain), never earlier. Because that is after N+1's `section-start`, change `sectionMark` in `emit` from a single value to a `Map<name, startMs>` and add an optional `section` field to the section-result log path (lookup by name; fall back to the latest mark when absent). Flag-off ordering is unchanged.

## Steps

- [ ] 1. Per-section risk (D4).
      Change the execution store type, `emit`, `withHooksForTest`, `runWorkingHoliday`, the loop reset (~2050) and both readers (~2000 recoverFromAccessDenied, ~2146 session-expiry) to use `riskBySection`/`currentSection`. Behavior identical in sequential mode.
      Files: workflow/run.ts
      Verify: `npm run typecheck` clean; `npm test` — all existing suites (access-denied, fast-fill-run, captcha, early-fill …) pass unchanged.

- [ ] 2. Split saveStep into saveSection + verifySection (D1).
      Move timing capture so `verifyMs` and `reloadGap` are measured inside verifySection; saveStep composes both and prints the same log lines in the same order. No other changes.
      Files: workflow/run.ts
      Verify: typecheck; `npm test` — all pass, in particular fast-fill-run.test.ts and saved-values.test.ts (logs/command sequences unchanged).

- [ ] 3. CAPTCHA mutex and window pinning (D5).
      Add `captchaLock` and window pinning to `captchaGuard` (~183); `waitWithCaptcha` unchanged (it calls captchaGuard). Re-entrancy: if the lock is already held by the same async chain (nested guard), proceed without re-acquiring (track holder via a token in the store) to avoid deadlock.
      Files: workflow/run.ts
      Verify: typecheck; `npm test` — captcha.test.ts, captcha-load-wait.test.ts, capsolver*, two-captcha, autocaptcha tests pass.

- [ ] 4. VerifyTab controller (D2, D3, D6).
      New `workflow/verify-tab.ts` exporting `createVerifyTab(driver, deps)` where deps inject `verifySection`, `captchaGuard`, `captchaPending`, `assertSiteAvailable`, `readAuthState`, `isAccessDenied` (avoids circular import with run.ts). Methods: `start(item)` (open tab lazily, switch, executeScript location.href, switch back), `settle()` (resolve the oldest pending item once tab 2 `document.readyState` is interactive/complete; runs the D5 CAPTCHA path; calls verifySection inside withWindow; returns `{name, outcome: verified|unverified|fallback, report|error}`), `drain()`, `disable(reason)`, `close()`. Max one pending item (start of N+1's verify settles N first) to bound state.
      Files: workflow/verify-tab.ts (new)
      Verify: typecheck; new unit test file in step 6 covers it.

- [ ] 5. Wire into executeWorkingHoliday (D7, D8, D9) and extend timing log.
      Add `parallelVerifySnapshot()`; compute `parallel = flag && entry.fast && !options.attachPort`. In the loop: when parallel and tab enabled, call `saveSection`, then `verifyTab.start({name,url,report})`, mark section as "saved, verify pending" (risk stays true for N), and proceed; at the top of the next iteration after `waitForSection` and before `saveSection`, call `verifyTab.settle()` and apply its outcome through a shared `applyVerifyOutcome` helper that reuses the existing completed / SavedValueVerificationError / SiteBusy branches (extract them into local functions so both modes share the exact code). Fallback outcome → `verifySection` in main tab on that URL — then re-navigate main tab to N+1 via GET (loop's existing `navigate` check handles it). Drain + close before `finishApplication`, before `authenticate` in the session branch, and in a `finally` around the loop. Closer guard at ~550. Timing log: add `mode parallel|sequential`, `verify ${verifyMs}ms (overlapped ${overlapMs}ms)`, `next-load ${ms}ms`, and a run-end summary line `[NZWH] Timing summary mode=…: save total, verify total, load total, fallback=<reason|none>` — no URLs/query strings/values.
      Files: workflow/run.ts
      Verify: typecheck; `npm test` all existing pass (flag unset → sequential).

- [ ] 6. Tests (vitest, mocked drivers; follow access-denied.test.ts pattern: `vi.hoisted` NZWH_REPORT_DIR, `vi.mock("../browser/chooseBrowser")`, fake driver recording commands per window handle, fixtures/sample.json).
      New file workflow/parallel-verify.test.ts covering:
      a. Flag off (unset and "0"): recorded driver command sequence and emitted events identical to a baseline captured from the current flow; no newWindow/switchTo calls.
      b. Mismatch in tab 2 → section in unverifiedSections, `SavedValueVerificationError` detail emitted, SAVE click count for that section == 1, `filled:false` passed to finishApplication.
      c. Pending verification is drained before finishApplication (finishApplication mock asserts no pending item and tab 2 closed when called; last section verified).
      d. Busy and access-denied (and login form) in tab 2 → tab closed, fallback logged once, remaining sections run sequentially (no further newWindow), pending section verified in main tab, no extra SAVE.
      e. CAPTCHA appears in tab 2 → main tab issues no commands while guard runs (assert all commands during the guard target the tab-2 handle); guard never reads another window even if a test switches mid-wait; afterwards main re-checks captchaPending; only one solve/prompt.
      f. Per-section risk: session expiry / access-denied in section N+1 after N's POST → N+1 (risk false) is refilled, N never refilled; expiry after N+1's POST → stop without refill.
      g. Attach mode (attachPort) and flag on → sequential.
      h. Global duplicate-POST invariant: across all scenarios, each section's SAVE control is clicked at most once and never while another POST is in flight.
      Files: workflow/parallel-verify.test.ts (new); optionally workflow/verify-tab.test.ts for controller unit tests.
      Verify: `npm test` — new and existing suites pass; `npm run typecheck` clean.

- [ ] 7. Final check.
      Run full `npm run typecheck && npm test`; review `git diff` for any new `sectionSaveControl`/`postbackAndWait` call sites (there must be none outside saveSection) and for logged URLs/values. Commit locally on feat/hybrid-verify-tab; do not push.
      Verify: both commands pass.

## Reviewer focus
The reviewer will specifically check that no duplicate-POST path was introduced: SAVE (`postbackAndWait` via `sectionSaveControl`) is reachable only from saveSection, at most once per section per run attempt, never from verify/fallback/CAPTCHA/recovery code, and never with risk true for that section. Also: flag-off identity, driver always restored to the main handle, drain before finishApplication.

## Assumptions needing live verification
Whether the server serializes same-session concurrent GETs (default OFF covers this); whether tab 2 shares ASP.NET session cookies (same profile, expected yes); whether a background tab throttles loads (Chrome anti-throttling flags in browser/chooseBrowser.ts assumed sufficient).
