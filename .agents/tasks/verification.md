# Verification: hybrid parallel verify (NZWH_PARALLEL_VERIFY)

Worktree: /Users/MAC/Desktop/DEV/nz-working-holiday-automation/.worktrees/hybrid-verify (branch feat/hybrid-verify-tab). No live site contacted.

| Command (worktree root) | Result |
| --- | --- |
| `npm run typecheck` (`tsc --noEmit`) | pass, exit 0, no errors |
| `npm test` (`vitest run`) | pass: 40 files, 442 tests, 0 failed, 0 skipped |
| `npx vitest run workflow/parallel-verify.test.ts` | pass: 11 tests |

Baseline before the change: 39 files / 431 tests passing (includes workflow/captcha.test.ts, captcha-load-wait, access-denied, fast-fill-run, saved-values, capsolver*, two-captcha, autocaptcha). All still pass unchanged.

Sensitivity check: with the flag check temporarily broken (flag never on), 7 of the 11 new tests failed; restored afterwards (the flag-off and per-section-risk outcome tests pass in both modes by design).

New tests (workflow/parallel-verify.test.ts, multi-window mocked WebDriver):
- flag unset and "0": no window commands, identical command sequences, sequential GET order, timing summary `mode=sequential`.
- flag on: verify reloads only via `location.href` in the verify tab, main tab only loads next sections; results reported before the next section-start; finishApplication called with tab 2 closed, driver on main, all 3 sections reported.
- mismatch in tab 2: section failed/unverified, one SAVE, outcome incomplete (submission blocked), tab kept.
- busy / access-denied / login in tab 2: tab closed once, one fallback log, pending section re-verified in main tab by GET, rest sequential, one SAVE per section.
- CAPTCHA in tab 2: one prompt; during the wait no main-tab commands except the guard's pin switch-back after a forced mid-wait switch; all pending reads on tab 2; no GET/SAVE.
- per-section risk: redirect while filling N+1 refills only N+1; session expiry after N+1's SAVE stops with no refill/re-send.
- attach mode + flag on: sequential, no second tab.
- Mock asserts on every SAVE: issued from the main tab with no other POST in flight; each section saved at most once.

Static check: `sectionSaveControl(`/`postbackAndWait(` call sites in run.ts: only inside saveSection (lines ~1691-1693).
