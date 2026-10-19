# Read-only verify tab overlapping the next section's load (NZWH_PARALLEL_VERIFY)

The change splits `saveStep` into `saveSection` (fill, CAPTCHA guard, the single SAVE POST, path and `[errorlabel]` checks) and `verifySection` (reload, ApplicationId check, batched read, mismatch check). With `NZWH_PARALLEL_VERIFY=1` and fast entry on, the accepted section's reload is fired in a second tab via `location.href` while the main tab GETs the next section. The pending verification is settled before the next `section-start`, and again after the loop before submission. Busy, denied, session, timeout or closed-window errors in tab 2 turn the feature off for the rest of the run, and the section is re-verified by GET in the main tab. Reviewed against the parent commit `ff0ddc9` (`git diff HEAD~1`), since `main` is far behind and carries unrelated history.

Watch for: whether a GET of section N in tab 2 after section N+1 loads in tab 1 changes any server-side wizard "current step" state. This is possible and needs live verification. The CAPTCHA lock is effectively redundant because all driver calls are serialized awaits. It is harmless.

**Verdict**: APPROVED

## High-level view

The SAVE path is untouched and still has a single call site. `sectionSaveControl`/`postbackAndWait` are only called inside `saveSection` (run.ts ~1691-1693), and `verifyTab.start` is only reached after `saveSection` returns, so the postback has already completed. Tab 2 only runs `executeScript("location.href = …")` and the read-only checks in `verifySection` (verify-tab.ts:95, run.ts ~1722-1735). No duplicate-POST path exists. Every failure branch reuses the same handlers as the sequential catch (`savedButMismatched`, `busySection`, `deniedVerified`/`deniedUnverified`, `savedRiskStop`), and none of them refills or re-SAVEs.

With the flag off, `verifyTab` is `undefined`. `saveStep` becomes `saveSection` + `verifySection({reload:true})`, the same sequence as before. `captchaGuard` short-circuits to `captchaGuardOnce` because `hasVerifyTab` is false. The only additions are timing counters and one summary log line. The flag is read once in `parallelVerifySnapshot` (run.ts ~1577), and attach mode and non-fast mode are both forced sequential.

Risk is now tracked per section (`riskBySection`, keyed by `currentSection`). Settling N happens before `currentSection` moves to N+1, so recovery events for N mark N, and a redirect while filling N+1 refills only N+1. The tests cover both directions.

CAPTCHA handling pins the guard to the window that showed the challenge (`pinned`, run.ts ~212/279) and switches back if anything moved focus. The popup closer skips protected handles (run.ts ~578). Only one driver exists and every command is awaited in sequence, so the "other tab" cannot act during a solve. The main tab's next `waitForSection` re-runs `captchaGuard`, which re-checks `captchaPending` there.

<details>
<summary>Issues (2)</summary>

1. **Wizard step state across tabs (possible, non-blocking)**: GETting section N in tab 2 after N+1 has loaded in tab 1 might shift server-side "current step" state before N+1's SAVE. Verify on the live site with the flag on before relying on it.
2. **Redundant CAPTCHA lock (confirmed, non-blocking)**: `captchaLocks` can never contend under serialized awaits. Keep it as a guard or drop it. Note that it would deadlock if `captchaGuard` ever became reentrant (it isn't today: no nested call in `captchaGuardOnce`).

</details>

<details>
<summary>Details</summary>

### Settle ordering and submission gating

`settleVerify` runs inside the loop only when something is pending and the next section isn't the skipped adviser. It runs once more after the loop, inside a `try/finally` that closes the tab before `finishApplication` (run.ts ~2475). A pending item can only exist between N's `break` and the next iteration's settle. Exceptions in that window come from either the prefetch navigate, which is caught and replayed by the loop's own navigate plus page checks, or settle itself, which clears `pending`. So no section reaches submission unverified and unreported. A `StopRequested` with an item pending ends the run without submitting.

### Fallback cost

On fallback, `verifySection({reload:true})` navigates the main tab back to N, which throws away the prefetched N+1 page, and the loop then reloads N+1. This is correct (GET only) but costs one extra load per fallback, once per run at most.

### Concurrent GETs in one session

Two page loads now overlap within the same ASP.NET session. Session-state locking would serialize them server-side, which reduces the gain but does not affect correctness. Rate limiting or busy responses triggered by the overlap would hit `fallbackReason` and drop to sequential. Both effects are assumptions that need live verification.

### Test evidence

verification.md reports a passing typecheck, 442/442 tests, and 11 new tests in `parallel-verify.test.ts`. A sensitivity check (7/11 failing with the flag broken) shows the tests exercise the parallel path. The mock asserts that every SAVE comes from the main tab with no other POST in flight, at most once per section. Not tested: live-site wizard state across tabs, and real overlap timing. Neither can be checked offline.

</details>

<details>
<summary>File map</summary>

- `workflow/run.ts`: saveStep split, per-section risk, verify-tab orchestration, shared outcome handlers, CAPTCHA pin/lock, popup-closer exclusion, timing summary.
- `workflow/verify-tab.ts`: new second-tab controller (open/start/settle/disable/close, protected handles).
- `workflow/parallel-verify.test.ts`: multi-window mocked WebDriver tests.

Full diff: `git -C .worktrees/hybrid-verify diff HEAD~1`
</details>
