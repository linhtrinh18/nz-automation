# Design review: phase-2 addendum (iteration 4), fill before full page load

Reviewed: `.agents/tasks/design-phase2.md` (iteration 4) against `.agents/tasks/design-review.md` (iteration 3), `workflow/fast-fill.ts` (constants, `REMOTE_TRIGGER_FN`, `buildFillSegmentScript`, `fillSegment`, `readTimeOrigin`) and `workflow/run.ts` (`captchaGuard`, `waitWithCaptcha`, `waitForSection`, `legacyFillField`, `unexpectedReload`, `fastFillSection`, `saveStepForTest`, `fastEntrySnapshot`, `executeWorkingHoliday` capability read and `finishApplication` options). No builds or tests were run.

Verdict: **APPROVED** (0 HIGH, 0 MEDIUM, 3 NIT).

## Gate checklist

| Gate | Result |
|---|---|
| F1 (HIGH): replay every early write with native setter, no events, then re-decide; record page-only; `jQuery.isReady` | Met. P6 silent sweep at `start === 0` plus per-entry fallback; record only in `window.__nzwhEarly`; result type has no value field (test 3); `SECTION_DOM_READY_JS` has the `isReady` clause (P5). |
| F2 (HIGH): restart authoritative pass on any postback document, capped at `entries.length` | Met. `authoritative()` returns `'postback'` on new `timeOrigin`, settles, restarts from 0; one shared counter, `WorkingHolidayStop` past cap (P7, tests 11, 11a, 25, 26). |
| F3 (MEDIUM): early pass never posts | Met. `posting` and `fallback` both end `runEarly`; `legacyFillField` never called there (tests 9, 10, 27). |
| F4 (MEDIUM): early resume guard defers | Met. `index = i + 1; continue`, separate counter (test 8). |
| F6 (NIT): CAPTCHA load wait reads readyState first, breaks on `captchaPending` false, test specified | Met (P8, tests 17–21). |
| Re-decide on settled DOM incl. postback documents | Met (P7 + P12). |
| Kill switches | Met. `NZWH_FAST_FILL=0` → legacy, `normal`, no waits; `NZWH_EARLY_FILL=0` → phase 1 exactly (P2, test 15). |
| Hard constraints | Met. CAPTCHA code untouched except `eagerDrivers`-gated wait; every new wait calls `checkCancelled` and site-busy (directly, via `waitWithCaptcha`, or injected guard); submission pages get `waitForChangeThenLoad` gated on `eagerSession`; no submits/clicks in new scripts; logs are counts/keys only; no deps; named constants (P4). |
| Eager in attach mode | Resolved with degradation path: capability check splits `eagerSession` (fail-safe) from `early` (fail-off), plus step-0 `readyState === 'complete'` skip (P1). |

## Findings

### 1. NIT: Redundant `captchaPending` round trip after the CAPTCHA load wait (P8)

When the loop already broke on `!captchaPending`, the post-loop check repeats the same read. Fix: set `skipProvider = true` inside the loop at the break (`if (!(await captchaPending(driver))) { skipProvider = true; break; }`) and keep the post-loop re-check only for the readyState and deadline exits.

### 2. NIT: Delegated (document-level) posting handlers can POST before `load` (P14 row 4)

`REMOTE_TRIGGER_FN` inspects inline attributes and `jQuery._data(e,'events')` only (verified, `fast-fill.ts:50-55`), so a delegated handler bound in a ready handler is invisible, and the early pass's `change` could POST before `load`. The design states this and detects it (nav watch + `timeOrigin` → `possible` + stop before SAVE). Fix: add to P11 a unit fixture with `$(document).on('change', '#x', () => __doPostBack('x',''))` asserting the early pass results in `unexpectedReload` (`possible` emitted, no SAVE), so the stated degradation is tested rather than only documented.

### 3. NIT: `"deferred"` status handling in phase-1 result loop not stated (P6/P7)

`FillStatus` gains `"deferred"`; phase-1 `runFill` counts any non-filled/unchanged status as `skipped`. Only `deferClears` emits it, so it never reaches phase-1 code, but state it: "`deferred` is produced only with `deferClears`; `runEarly` ignores it in stats; the authoritative pass never sees it."

## Verified assumptions

- `READY_WAIT_MS = 30000`, `SECTION_WAIT_MS = 20000`, `FAST_POLL_MS = 50`, `PAGE_POLL_MS = 200`, `MAX_FIELD_RESUMES = 3`, `SUBMISSION_CHANGE_WAIT_MS = 30000` exist in `fast-fill.ts`; `EARLY_SECTION_WAIT_MS = 50 s` is correct.
- `fillSegment(driver, atom, entries, start)` passes args 0 and 1 only; adding args 2/3 with `false` defaults is backward compatible.
- `REMOTE_TRIGGER_FN` is single-backslash `String.raw` (finding 5 shipped).
- `legacyFillField(driver, name, key, field, data, report, fast)` matches the design's call; it emits `possible` before an awaited postback and reads back.
- `unexpectedReload()` emits `possible` then throws the quoted stop.
- Phase-1 `fastFillSection` matches the described `runFill` / `recheck` / single refill structure; the early variant reuses it as stated.
- `saveStepForTest(driver, name, data, fast = false)` exists; the boolean-normalizing overload is compatible.
- `executeWorkingHoliday` reads `driver.getCapabilities().catch(() => null)` right after `chooseBrowser` (`run.ts:1542`); `finishApplication` gets `waitForChange: condition => driver.wait(condition, SUBMISSION_CHANGE_WAIT_MS)` (`run.ts:1855`).
- `captchaGuard` provider branch begins with `readCaptchaChallenge`; manual mode is the `else notify(manual)` path; the shared `driver.wait` returns `readyState === 'complete'` once `captchaPending` is false, so `skipProvider` falls through correctly.

## Unverified / wrong assumptions

- Unverified (live only): chromedriver honoring `eager` in attach mode (degrades to phase 1 via P1/step 0); site handler binding timing; real DCL→`load` gap; validator acceptance of native setter + synthetic events. All have stated degradations and the `NZWH_EARLY_FILL=0` switch.
- Unverified: the iteration-1 attach-mode 1 ms measurement (not reproduced). Not blocking.
- None found wrong.
