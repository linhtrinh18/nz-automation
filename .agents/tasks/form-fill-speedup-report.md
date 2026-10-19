# Form-fill speedup: final report (phase 1)

Status: phase 1 is implemented, reviewed and APPROVED (`.agents/tasks/review.md`). The changes are uncommitted on `main`: `workflow/run.ts` is modified, and `workflow/fast-fill.ts`, `fast-fill.test.ts`, `fast-fill-run.test.ts` and `fast-fill-browser.test.ts` are new. Nothing has been run against the live site yet.

Summary: each wizard section is now filled with one batched in-page `executeScript` per segment, not 13–20+ Selenium round trips per field. Verification reads are batched, and fill-flow waits poll at 50 ms instead of 200 ms. The full-load wait is still in place, so phase 1 saves fill time only and no load-tail time. Set `NZWH_FAST_FILL=0` to get today's behavior back.

## 1. Bottlenecks found

Line numbers refer to `workflow/run.ts` at the baseline commit `3f4fb30` (design Part A).

| # | Bottleneck | Where | Phase 1 |
|---|---|---|---|
| A1 | Full-load waits. `pageLoadStrategy` is `normal` (`:1337`). `ready()` polls `readyState === 'complete'` (`:317-324`). `waitForSection` runs `ready()` then a first-field wait at least 3 times per section (`:709-717`, called at `:1466`, `:871`, `:1185`). `waitForPostback` requires `complete` (`:855-872`). Cost: (3 + P) × the DCL→load gap per section. | run.ts | Deferred to phase 2 (kept as is) |
| A2 | One field at a time in `saveStep` (`:1094-1150`). A text field costs 13 RTs: `requireSession` `:1101`, `locateField` + `captchaGuard` + session + find `:1114/:765`, `isEnabled`/`isDisplayed` `:1116-1117`, `remoteTrigger` `:1125`, `getAttribute` `:1126`, clear/sendKeys/TAB `:690-692`, readback `:1139-1145`. A Select2 select costs at least 20 + k RTs (`:640-686`, `getText()` per choice, plus a 200 ms-poll results wait at `:669`/`:683`). The personal section totals about 470 RTs. | run.ts | Fixed |
| A2b | Post-reload verification costs 2 RTs per field (`findElement` + `getAttribute`, `:1191-1202`). | run.ts | Fixed |
| A3 | 200 ms poll quantization in `waitWithCaptcha` (`:313`), about 0.3 s per section. Other sleeps were reviewed and kept on purpose: CAPTCHA `driver.wait` (`:225-276`), provider polls (`capsolver.ts:69`, `two-captcha.ts:143,151`), country scroll `:495`, country re-check `:460`, occupation backoff `:917/:949`, submission `waitForChange` `:1634`, DevTools readiness (`chooseBrowser.ts:45`). | run.ts | Fill-flow waits fixed. Others unchanged |
| A4 | Redundant checks. `waitForSection` runs again inside `waitForPostback` (`:871`) after the predicate has already proved the page is ready. `requireSession` runs per field and per poll (`:1101`, `:767`). `captchaGuard` runs on every `locateField` call. Four fact-finding RTs per field. Unchanged values get cleared and retyped, and `clear()` on an AutoPostBack text field starts an unawaited postback. | run.ts | Fixed |
| A5 | No client-side Next button. SAVE (`sendKeys(SPACE)`, `:848`), then a verification reload (`:1184`), then the next section GET (`:1465`). Each one blocks on `load` and then on 200 ms polls. | run.ts | Poll quantization and the redundant re-wait are fixed. The load wait is kept |

## 2. What changed (phase 1)

1. **Batched in-page fill** (`fast-fill.ts`, `fastFillSection` in `run.ts`). One `executeScript` per segment sets values with the native `value` setter. Text, date and textarea fields get `input`, `change`, `focusout` and `blur` events. Selects get `input` and `change`, plus `focusout`/`blur` when there is no Select2 widget. No focus events are sent, so date pickers never open. Every write is checked in the page. Availability uses selenium's own `is-displayed` atom plus `:disabled`, the same rule `isDisplayed()`/`isEnabled()` apply today. A segment stops at `missing`, `unavailable-required`, `posting`, `fallback`, or a `yield` after each changed select, so a controller's queued handlers run before its dependents are evaluated. Results hold only key and status, never values.
2. **Safety fallbacks to the extracted legacy path** (`legacyFillField`, today's loop body moved verbatim). These cases always go to legacy: AutoPostBack/`REMOTE_TRIGGER` fields (with `possible` emitted first, as today), Select2 clears, read-only inputs, `too-long`, `value-rejected`, `option-missing`, and Select2 `widget-mismatch`/`widget-unknown`.
3. **Dependent-field handling.** When a required conditional field is not yet available, the code waits up to `DEPENDENT_FIELD_TIMEOUT_MS = 5000` at 50 ms polls. On timeout it throws today's exact message. A missing field waits up to `SECTION_WAIT_MS`. Each key can resume at most `MAX_FIELD_RESUMES = 3` times. A test guards that each controller precedes its dependent in field order.
4. **Pre-SAVE batched re-check** (1 RT). If any filled field drifted, the fill runs once more and the check repeats. If the mismatch persists, the run stops with `Readback mismatch: <section>.<key>.`. An unexpected reload (changed `performance.timeOrigin`, or a document-unloaded error) emits `possible` and stops before SAVE.
5. **Batched post-reload verification.** One read replaces 2N RTs. The comparison, the diagnostics, `SavedValueVerificationError` and the `verified` event are unchanged. A missing field still throws `NoSuchElementError`.
6. **Faster, condition-based waits.** `FAST_POLL_MS = 50` applies to the section, postback and field waits in fast mode. The fast `waitForPostback` drops the redundant trailing `waitForSection`, since its predicate already covers new document + `complete` + async-postback idle + jQuery idle + first field. Every touched literal is now a named constant (`PAGE_POLL_MS`, `SECTION_WAIT_MS`, `POSTBACK_WAIT_MS`, `READY_WAIT_MS`, `SELECT2_RESULTS_WAIT_MS`, `SUBMISSION_CHANGE_WAIT_MS`, ...), with values unchanged.
7. **Kill switch.** `NZWH_FAST_FILL=0` (or `false`) restores the legacy path. It is read once per run (`fastEntrySnapshot()`), and one status line is logged.
8. **Shared `REMOTE_TRIGGER_FN`.** This is a `String.raw` constant with single backslashes (design-review NIT 5), and a `node:vm` test covers it.
9. **Per-section timing log** (section 5). It runs in both modes, so the legacy mode gives an A/B baseline.

Unchanged: `captchaGuard` (only new call sites were added, one before each segment), `captcha.test.ts`, the CAPTCHA providers, site-busy handling, stop/cancel handling (a new `checkCancelled()` runs before every segment and inside every new wait), checkpoint and event reporting, the section policy, `validateData`, `submission*.ts`, `payer-form.ts`, `conditions.ts`, `fields.ts` and `chooseBrowser.ts`. The fill script never clicks or submits. No dependencies were added.

Other options I evaluated and why they were rejected or deferred (design B7):
- Selector caching was rejected. IDs are static, `getElementById` is O(1), and cached `WebElement`s go stale across postbacks.
- Parallel tabs and prefetching the next section were rejected. With one ASP.NET session and its ViewState, they risk server-side races and writes we can't verify.
- A MutationObserver field wait was deferred to phase 2 with early fill. After a full load these waits are rare, and polling keeps the CAPTCHA, busy, session and cancel checks in every iteration.

## 3. Expected savings per section

These are client-side estimates from design B11 and plan step 9. None has been measured on the live site.

| Section | Fill today (est.) | Fill phase 1 (est.) | Approx. saving |
|---|---|---|---|
| personal | 1.1–2.5 s (about 470 RTs, about 0.7 s typing, 7 Select2 UI cycles) | < 50 ms (about 20–40 RTs) + legacy time for each changed AutoPostBack field | ~1–2.5 s |
| identification | 0.25–0.45 s | < 20 ms | ~0.3–0.6 s |
| health | 0.5–2.1 s | < 20 ms | ~0.6–2.5 s |
| character | 0.6–2.4 s | < 20 ms | ~0.6–2.5 s |
| adviser (only if represented) | 0.9–1.7 s | < 40 ms | ~1–2 s |
| workingHoliday | 0.4–1.4 s | < 20 ms | ~0.5–1.5 s |

The savings column also counts the following in every section: post-reload verify going from 2N RTs to 1 (about 0.1 s on personal), and about 0.15–0.3 s less poll quantization from the 50 ms polls and the dropped re-wait.

**Phase 1 saves no load-tail time.** Every page still waits for `readyState === 'complete'` before filling, after SAVE, and after the verification reload. AutoPostBack fields still pay their full postback and load. On re-runs over a filled draft, most fields come back `unchanged` and are not written.

## 4. Tests and type check vs baseline

| | Baseline (`3f4fb30`) | Phase 1 |
|---|---|---|
| `npx vitest --run` | 261/261 passed, 29 files | **309/309 passed, 32 files** (+3 files, +48 tests, 0 failures, ~82 s) |
| `npx tsc --noEmit` | clean | **clean (exit 0)** |

These are the results recorded in the plan's verification evidence and accepted by the review. I did not re-run them for this report. `captcha.test.ts` and `workflow/coverage-saved.json` are unmodified.

New tests:
- `fast-fill.test.ts` (31 tests, `node:vm` fake DOM): event order per control type, every fallback cause, stops and skips, results that never contain values, the `REMOTE_TRIGGER` true/false cases, the planner and helpers, the kill-switch parsing, and the controller-before-dependent ordering guard.
- `fast-fill-run.test.ts` (14 tests, mocked WebDriver through `saveStepForTest`): one batched segment with no per-field `findElements`, posting fields routed to legacy with `possible` emitted first, fallback, yield, missing/unavailable waits and timeouts, stop/cancel with no SAVE, unexpected-reload stops, the pre-SAVE re-check (recover and stop), batched verify mismatch and missing field, the kill switch issuing zero fast scripts, the fast postback skipping the re-wait, and the timing-line format with no sentinel value leaking into logs or events.
- `fast-fill-browser.test.ts` (3 tests, real headless Chrome on 127.0.0.1): real-DOM fill of text, textarea, date, select and a Select2 stub; a delayed reveal of a dependent field; an idempotent re-run; a posting select left untouched; `isTrusted`-guard and maxlength fallbacks; and `fieldAvailable` parity with `isEnabled() && isDisplayed()` across 8 visibility and disabled cases.

One deviation from the plan: the end-to-end SAVE harness (`scripts/fixtures/fast-fill-harness.ts`) was not built. The full SAVE, postback and kill-switch orchestration is covered by the mocked-driver tests, not by a real-browser server round trip.

## 5. Reading the timing log to decide phase 2

`saveStep` writes one line per section, before "SAVE completed". It contains only counts and milliseconds:

```
[NZWH] personal: timing fill 120ms (fast 22, unchanged 0, standard 2 in 95ms, skipped 1, segments 9), save 1800ms, verify 1500ms; load gap page 600/save 650/reload 580ms.
```

(The numbers above are illustrative.)

- `fill`: the whole fill, from loop start through the pre-SAVE re-check. `fast`/`unchanged`/`standard`/`skipped` are field counts. `standard ... in Nms` is the time spent in the legacy path, including its awaited AutoPostBacks. `segments` is the number of fill scripts.
- `save`: SAVE postback through the `[errorlabel]` check. This is mostly server time plus the response page's full load.
- `verify`: the reload GET through the end of value verification.
- `load gap page/save/reload`: Navigation Timing `loadEventStart − domContentLoadedEventEnd` for the section page, the SAVE response and the verification reload. `n/a` means it was unavailable.

How to decide:
1. Run one section with `NZWH_FAST_FILL=0` and one with it on. Comparing the `fill` values gives the real phase-1 gain.
2. If `fill` minus `standardMs` is small and `standard` is above 0, the AutoPostBack fields are what remains of the fill cost. Those are server round trips, and phase 2 cannot remove them, apart from their load tails.
3. Add up the three load gaps per section, plus one gap per changed AutoPostBack field. That is the most phase 2 can save, before its own overhead (settle barrier ≥ 50 ms, the authoritative pass, the restart cost from finding 2).
   - If the gaps stay under about 100–200 ms, phase 2 isn't worth its complexity and risk.
   - If they are 0.5 s or more per page, phase 2 is worth doing.
4. Any `fast entry not accepted (<cause>)` lines show which controls the site rejects (for example `value-rejected` means validators ignore synthetic events). A high count means fast fill is not paying off on those controls.

## 6. Phase-2 backlog

Phase 2 means filling before `load`. These items come from design Part B and `design-review.md`:

| Item | Design / review pointer |
|---|---|
| `eager` pageLoadStrategy (new optional `chooseBrowser` param). Also needs `waitForChangeThenLoad` on the 4 submission/payer click sites (`submission.ts:178,187,276`, `payer-form.ts:48`) | design B3/B4. Attach-mode support was measured locally but not re-verified by the reviewer |
| Filling at DOMContentLoaded (`SECTION_DOM_READY_JS`, with jQuery `isReady`), plus MutationObserver field waits (`WAIT_FOR_FIELD_JS`) | design B4. Review finding 1, fix step 4 |
| Early/authoritative two-pass fill. The authoritative pass restarts after any postback, capped at `entries.length` | design B5. **Review finding 2 (HIGH)** |
| `restoreEarly`: replay every early write on the settled DOM so handlers bound late receive it | **Review finding 1 (HIGH)** |
| The early pass never sends a postback (a `posting` stop ends it) | **Review finding 3 (MEDIUM)** |
| The early pass's resume guard defers instead of throwing | **Review finding 4 (MEDIUM)** |
| Pre-SAVE settle barrier (`NAV_WATCH_JS`, `PRE_SAVE_SETTLE_JS`, 2 stable reads) and the post-SAVE settle before `[errorlabel]` | design B5/B6 |
| CAPTCHA provider-branch load wait inside `captchaGuard`. Read `readyState` first, then break if `captchaPending` turns false | design B8. **Review finding 6 (NIT)** |
| `REMOTE_TRIGGER` single-backslash `String.raw` | Review finding 5. **Done in phase 1** |

Review findings 1–4 do not apply to phase 1. They all concern work done before `load`: handlers bound after DCL, decisions made at DCL, postbacks sent before `load`, and the early-pass guard. Phase 1 keeps today's full-load wait, so every fill and postback happens after `readyState === 'complete'`. Page handlers are bound by fill time, just as they are for today's typing. Phase 1 has no early pass, and it sends postbacks no earlier than today.

## 7. What needs the live site to confirm

None of these were verified. All testing used `node:vm` fake DOMs, a mocked WebDriver and a local headless-Chrome page.

- **Native setter acceptance.** Whether the site's validators and handlers accept native-setter values plus synthetic `input`/`change`/`focusout`/`blur` on every text and date control. Rejections that change the value fall back to typing. A validator that silently ignores untrusted events would be caught by the `[errorlabel]` check after SAVE or by reload verification. The same goes for any `keyup`/`keypress` side effects such as masks or counters.
- **Select2 display behavior.** The Select2 version and markup, and whether a native `change` re-renders `.select2-chosen`. A mismatch or unknown markup falls back to the legacy Select2 UI path.
- **The real AutoPostBack field set.** Which fields post back, and whether any postback is partial. Detection uses today's regex. An undetected full postback is caught by the `timeOrigin` check and stops before SAVE.
- **Real timings.** Live RTT, the actual per-section savings, and the DCL→load gap that decides phase 2. The timing log in section 5 measures all of them.

Recommended next step: run one live section with timing logs in both modes, keeping `NZWH_FAST_FILL=0` as the rollback.

# Phase 2: fill before full page load

Status: implemented and APPROVED in the final review (`.agents/tasks/review-phase2.md`, verdict `review-phase2.json`: APPROVED, two non-blocking notes). The work is on branch `perf/fast-fill` on top of phase 1 (`e58534f`) and the logging commits (HEAD `7e73ecb`), and it is **not committed yet**. When it is committed, stage files by name and leave out the user's unrelated `lib/format-duration*.ts` and `lib/log-stamp.ts` edits. Nothing has been run against the live site. Sources: `design-phase2.md` (iteration 4), `plan-phase2.md`, and the current `workflow/run.ts`, `workflow/fast-fill.ts` and `browser/chooseBrowser.ts`.

Summary: section pages are now filled during the DOMContentLoaded→`load` gap, not after it. An early pass fills fields as they appear. Once the page settles, an authoritative pass replays and re-decides every field before SAVE. The verification reload is read at DOM-ready. Every other load precondition is kept: SAVE and its `[errorlabel]` check, AutoPostBacks, CAPTCHA provider reads, and the submission, declaration and payment pages. No dependencies were added.

## 1. What changed

1. **Eager session with attach-mode handling** (`browser/chooseBrowser.ts`, `run.ts` `entrySession`). `chooseBrowser` has a new trailing optional `pageLoadStrategy: "normal" | "eager" = "normal"`, applied with `options.setPageLoadStrategy(...)` before `new Builder()`. That covers both the spawned/`debuggerAddress` attach branch and the headless branch. The run asks for `"eager"` only when `NZWH_FAST_FILL` and `NZWH_EARLY_FILL` are both on. After start, it reads `getCapabilities().pageLoadStrategy` and derives two separate values:
   - `eagerSession = requested && reported !== "normal"`. If the read fails or the value is unknown, the session counts as eager. This flag restores the load preconditions (CAPTCHA load wait, `waitForChangeThenLoad`) and registers the driver in the `eagerDrivers` WeakSet.
   - `early = requested && reported === "eager"`. Only this flag turns on the early pass. If it is false, the run logs `Early fill: page-load strategy not confirmed as eager; early pass inactive.`

   An odd capability read therefore switches off the speedup but never the safety waits. Chromedriver could also report `eager` while still blocking until `load`, for example in attach mode. In that case each section's step 0 (`documentComplete`) sees `readyState === 'complete'`, skips the early pass, and the section runs exactly as in phase 1. `fillAndSaveWorkingHolidaySection`, where the caller supplies the driver, always uses `{ fast, early: false }`.
2. **DOM-ready section entry** (`SECTION_DOM_READY_JS`, tag `nzwh:dom-ready`). In early mode, `waitForSection` has no `ready()` call. It polls one predicate at `FAST_POLL_MS`:
   - `readyState !== 'loading'`
   - stylesheets applied, which `isShown` needs for layout
   - no ASP.NET async postback
   - `jQuery.active === 0` and `jQuery.isReady === true`, so jQuery's ready handlers have run (finding 1)
   - the first field is present

   The wait keeps the combined `READY_WAIT_MS + SECTION_WAIT_MS` budget (`EARLY_SECTION_WAIT_MS`, 50 s), so no timeout budget is reduced. CAPTCHA, site-busy, session and cancel checks still run on every poll through `waitWithCaptcha`. `NAV_WATCH_JS` is a passive `beforeunload`/`navigation` flag. It is prepended to the dom-ready, fill and settle scripts.
3. **MutationObserver field waits** (`buildWaitForFieldScript(atom)`, tag `nzwh:wait-field`, the design's `WAIT_FOR_FIELD_JS`). This is an `executeAsyncScript` that resolves when the field appears or becomes available, using a MutationObserver plus `readystatechange`. It returns `ready`, `loaded` or `pending`. Each call runs for at most `FIELD_WAIT_SLICE_MS = 500`, then control returns to Node, so cancel, CAPTCHA, busy and session checks run about every 550 ms. The early pass uses it in place of fixed sleeps. The authoritative pass keeps phase 1's 50 ms polls, because the DOM has settled by then.
4. **Early/authoritative two-pass fill with `restoreEarly`** (`fastFillSection` in `run.ts`, `buildFillSegmentScript` in `fast-fill.ts`).
   - **Early pass** (`deferClears`). Fills non-empty values as their fields appear and defers clears (status `deferred`). Before an element's first write, it saves the previous value only in `window.__nzwhEarly`. That record is never returned to Node or logged, and a test checks with `JSON.stringify` that no sentinel value leaks. Early writes count toward `stats.early` only, never `report.filled`.
   - **Settle barrier** (`PRE_SAVE_SETTLE_JS`, tag `nzwh:settle`). Requires `SETTLE_STABLE_POLLS = 2` consecutive reads, 50 ms apart, that show: load complete, no async postback, jQuery idle, and no pending navigation. A changed `timeOrigin` emits `possible` and stops with the unexpected-reload stop. A timeout after `PRE_SAVE_SETTLE_WAIT_MS = 30000` stops with `Page did not settle before SAVE; stopped.`
   - **Authoritative pass** (`restoreEarly`). At index 0 it silently restores every recorded early write with the native setter and no events, before making any decision. A per-entry restore covers ids that were missing at sweep time. Each field is then re-decided on the settled DOM with phase 1's rules. Non-posting fields are written again with events, so handlers bound late receive the value. AutoPostBack fields go through the unchanged `legacyFillField`, which emits `possible` first.
   - **Pre-SAVE settle.** If the authoritative pass wrote anything, a second settle runs before the re-check. The phase-1 pre-SAVE re-check and its single refill follow. The refill is now a full authoritative pass. Then come the unmapped-field gate, `captchaGuard` and SAVE.
5. **Post-SAVE settle.** SAVE goes through the unchanged phase-1 `postbackAndWait(..., true)`. Its `waitForPostback` predicate requires a new document that is `complete`, has no async postback and has jQuery idle. The `[errorlabel]` server-validation count therefore still runs after full load, as it does today. A separate post-SAVE barrier was not needed.
6. **Verification reload at DOM-ready.** After SAVE, `navigate(url)` returns at DCL, then the early `waitForSection`, the URL/ApplicationId check, and the batched `readFieldValues` run. If any value is missing or different, the run waits for `documentComplete` (cancel and session checks, `READY_WAIT_MS`) and reads again before deciding. The outcome is the same as a load-first read. The real-Chrome fixture for case 28, a field inserted after DCL, exposed this gap, which was then fixed.
7. **CAPTCHA load wait** (`captchaGuard`, provider branch only, finding 6). For drivers in `eagerDrivers`, the guard waits for `load` before `readCaptchaChallenge`, polling at `PAGE_POLL_MS` for up to `READY_WAIT_MS`. Each iteration reads `readyState` first, then `checkCancelled`, `assertSiteAvailable` and `captchaPending`. If the challenge disappears, `skipProvider` skips the provider: no key load, no solver, no notify. Manual solving, auto-submit and the provider fallbacks are unchanged. Unregistered drivers (every `captcha.test.ts` fake, and both kill switches) make zero extra calls. `captcha.test.ts` is unmodified.
8. **`waitForChangeThenLoad` at the submission and payer sites** (`fast-fill.ts`, `run.ts` `submissionWaitForChange`). When `eagerSession` is set, `finishApplication` receives a `waitForChange` that first waits for the click's change (`SUBMISSION_CHANGE_WAIT_MS`). It then waits for `readyState === 'complete'` (`READY_WAIT_MS`, polling at `PAGE_POLL_MS`), running an injected guard (`checkCancelled` + `assertSiteAvailable`) on every load poll. That function also reaches `completePayerForm` through `options.waitForChange`. All four click sites (`submission.ts:179,188,277` and `payer-form.ts:49`) therefore read nothing until the next page has fully loaded. `submission.ts` and `payer-form.ts` are byte-identical to `e58534f`. A timeout lands in `finishApplication`'s existing `catch`, which returns `incomplete`, and nothing is re-clicked. Without `eagerSession`, the call is today's single `driver.wait`.

### Review findings resolved (`design-review.md` iteration 3)

| # | Finding | Resolution |
|---|---|---|
| 1 (HIGH) | Handlers bound after DCL miss early writes | Early writes are recorded in the page only. The authoritative pass restores them silently at index 0 and re-writes them with events on the settled DOM. `SECTION_DOM_READY_JS` also requires `jQuery.isReady`. |
| 2 (HIGH) | Decisions on a post-postback document taken before `load` | A legacy postback that produces a new `timeOrigin` returns `postback`. The section then settles and restarts the authoritative pass from index 0. One counter is shared with the re-check refill, capped at `entries.length`. Beyond that the run stops with `Form reloaded repeatedly while filling; stopped.`. A reload the run did not cause still stops before SAVE. |
| 3 (MEDIUM) | Early pass could send a postback before `load` | A `posting` stop ends the early pass, and `legacyFillField` is never called there. Stricter than the review asked: a `fallback` stop also ends the pass, so no unrecorded UI write can bypass the replay. |
| 4 (MEDIUM) | Early-pass resume guard threw | The early pass has its own resume counter. Past `MAX_FIELD_RESUMES`, a wait timeout, or a `loaded` result defers the entry (`index = i + 1`). The authoritative pass keeps phase 1's throwing guard and messages. |
| 5 (NIT) | `REMOTE_TRIGGER_FN` escaping | Done in phase 1. |
| 6 (NIT) | CAPTCHA load wait ordering | `readyState` is read first in each iteration. The loop breaks, and the provider is skipped, when the challenge disappears. |

## 2. Expected extra savings (estimates, not measured live)

Phase 2 removes the load tail, T = the live DOMContentLoaded→`load` gap. The phase-1 timing log reports it as `load gap page/save/reload`.

| Page in a section | Phase-2 saving on top of phase 1 |
|---|---|
| Section's first page | Up to about T − 0.15 s. Filling overlaps the tail. After `load`, it pays two settle reads, the authoritative re-write (in-page, under 50 ms) and a second settle. Break-even when T is under about 150 ms. |
| Verification reload | Up to T, when every value matches at DOM-ready. On a mismatch it waits for load and re-reads, so the saving is 0, as in phase 1. |
| SAVE response | 0 (the `[errorlabel]` check still waits for `load`) |
| Each changed AutoPostBack field | Costs about 0.1–0.2 s (one restart: settle plus one authoritative pass). Re-runs over a filled draft mostly read `unchanged` and do not restart. |
| Submission, declaration, payment | 0, by design |

At a plausible T of 0.2–1.5 s, this is about 0.3–2.8 s per section on top of the phase-1 fill savings. A section with several changed posting fields can come out slightly slower than phase 1 on a first fill.

## 3. Tests and type check vs baseline

| | Baseline (phase 1) | Phase 2 |
|---|---|---|
| `npx vitest --run` | 309/309 passed, 32 files | **363/363 passed, 36 files** (+4 files, +54 tests, 0 failures) |
| `npx tsc --noEmit` | clean | **clean (exit 0, no output)** |

These are the results recorded in the verification evidence of `plan-phase2.md` and accepted by the final review. I did not re-run them for this report. `git diff --stat e58534f` is empty for `captcha.test.ts`, `submission.ts`, `payer-form.ts`, `conditions.ts` and `fields.ts`.

New and extended tests:
- `early-fill-browser.test.ts` (new) uses real headless Chrome on 127.0.0.1, an eager session and a 2 s slow image. It runs the full section flow: fill, settle, SAVE form POST, reload, verify. Cases 22 (fill before `load`, SAVE after), 23 (a handler bound in `onload` reveals a field), 24 (an AutoPostBack bound on `$(window).on('load')`, with an inline jQuery shim and no dependency), 25/26 (onload clears and resets after a second postback), 27 (the hidden-input echo is posted after `loadEventStart`), 28 (a field inserted 300 ms after DCL, no fixed sleep) and 29 (`NZWH_EARLY_FILL=0`) **all ran and passed on this machine, none skipped**.
- `early-session.test.ts` (new) checks that `chooseBrowser` gets `"eager"` by default and `"normal"` under either switch. It also checks capability mapping and registration (a rejected read is registered; `"normal"` is not) and the submission-wait choice.
- `captcha-load-wait.test.ts` (new) has 5 cases: unregistered, registered, challenge disappears, stop/cancel, manual mode.
- `submission-load-wait.test.ts` (new) checks: no readyState or guard call before the change, resolving after load, `TimeoutError`, `StopRequested` within one poll, and `SiteBusyError` propagation.
- `fast-fill.test.ts` (extended) covers the restore sweep, no sweep when `start > 0`, `deferred`, first-write-only recording, and the no-sentinel check on results.
- `fast-fill-run.test.ts` (extended) covers the two-pass orchestration, the restart cap, deferral, cancel during the early field wait and the settle barrier, the timing-line fields, and the delegated `__doPostBack` early write (emits `possible`, stops, no SAVE).

## 4. Switches and A/B testing

| Env | Behavior |
|---|---|
| `NZWH_FAST_FILL=0` / `false` | Full legacy: `normal` strategy, per-field entry, no phase 1 or phase 2 |
| `NZWH_EARLY_FILL=0` / `false` | Phase 1 exactly: batched fill and verify, `normal` strategy, `ready()`-based entry, no early pass, no settle barrier, no CAPTCHA load wait, no `waitForChangeThenLoad` |
| neither set | Phase 2 (eager plus everything above) |

Each switch is read once per run and logs one status line. In early mode, the per-section timing line gains `early`, `restarts` and `settle`. It contains counts and milliseconds only:

```
[NZWH] personal: timing fill 140ms (fast 22, unchanged 0, standard 2 in 95ms, skipped 1, segments 11, early 20, restarts 2), settle 410ms, save 1800ms, verify 900ms; load gap page 600/save 650/reload 580ms.
```

(Illustrative numbers.)

A/B procedure:
1. Run the same section once with `NZWH_EARLY_FILL=0` and once with the switch unset.
2. Compare `fill + settle` and `verify` between the two runs. The difference is the phase-2 gain. `load gap page` and `reload` show how much was available.
3. A high `restarts` count means changed AutoPostBack fields are eating the gain.
4. If the logs contain `Form reloaded unexpectedly`, `Page did not settle before SAVE` or `page-load strategy not confirmed as eager`, keep `NZWH_EARLY_FILL=0` and investigate. `NZWH_FAST_FILL=0` stays the full rollback.

## 5. What still needs the live site

None of the following was verified. All testing used `node:vm` fake DOMs, a mocked WebDriver and local headless Chrome.

- **When the site binds its handlers** (inline, jQuery ready, or `load`). The replay on the settled DOM is designed to cover all three. Whether the live site's validators then accept the replayed values has not been checked.
- **Eager in `debuggerAddress` attach mode.** The client sends the capability, but chromedriver's behavior was not re-measured. The capability check and the step-0 `readyState` skip make the worst case phase-1 behavior.
- **The real DCL→`load` gap (T), RTT and net savings.** These decide whether phase 2 is worth keeping on. Read them from the timing log.
- **Delegated postback handlers** that `REMOTE_TRIGGER_FN` misses. These are detected (new `timeOrigin`, `possible` emitted, stop before SAVE) but not prevented.
- **CAPTCHA iframe timing under eager.** On the deadline, the load wait falls back to today's behavior.
- **Postback timing.** The fixtures delay `__doPostBack`'s submit by 250 ms, because the unchanged legacy select entry (option click, then TAB) goes stale against an instant local submit under either load strategy. The live site evidently does not hit this, but it has not been re-checked.

Recommended next step: commit phase 2 on `perf/fast-fill`, staging by name and excluding `lib/`. Then run one live section in each mode, with `NZWH_EARLY_FILL=0` as the rollback.

# Access-denied redirect recovery

Design authority: `.agents/tasks/access-denied-investigation.md`. Everything below is uncommitted on `perf/fast-fill`.

## 1. What changed
- `workflow/site-busy.ts`
  - `AccessDeniedError extends WorkingHolidayStop` with a fixed, PII-free message. It does not extend `SiteBusyError`, so the busy branch cannot swallow it.
  - `assertSiteAvailable` still runs one `executeScript`. The script now returns `'denied'`, `'busy'` or `false`. `'denied'` is decided by `location.pathname` only, on any host, in any case, with an optional trailing slash. A legacy `true` still means busy.
  - New helpers: `isAccessDenied` (same script, returns false while a navigation is in flight) and `abortableBackoff` (100 ms slices, `StopRequested` on abort).
- `workflow/fast-fill.ts`: `MAX_ACCESS_DENIED_RECOVERIES = 2`, `ACCESS_DENIED_BACKOFF_MS = [2000, 5000]`, `ACCESS_DENIED_BACKOFF_SLICE_MS = 100`, and the kill switch `NZWH_ACCESS_DENIED_RECOVERY=0`.
- `workflow/run.ts`
  - Detection needs no new polling. Every `captchaGuard` call and every `waitWithCaptcha` iteration already runs `assertSiteAvailable`, so the first poll sees the redirect.
  - `unexpectedReload(driver)` and the `waitFor`, `settle` and `postbackAndWait` timeout conversions check for the denied page first. A redirect before any POST no longer sets `risk` or emits `persistence: possible`. A timeout on the denied page no longer reaches `assertHost`.
  - The section loop has an `AccessDeniedError` branch after `StopRequested`, before the auth block.
    - It uses a per-run budget and an abortable backoff, then a GET of the section URL.
    - `risk === false`: continue, and the section is refilled from scratch.
    - `risk === true`: no refill and no SAVE. It reads the applicable fields back (read-only). A full match emits `verified`, completes the section and writes `coverage-saved.json`. Anything else is unverified: no replay, `filled: false` blocks submission, and the loop moves to the next section.
    - A login form after the reload reuses the existing one-shot re-authentication. If `risk` is true it still stops with the existing session message.
  - The pre-wizard `advanceToWizard`/`authenticate` calls (including login-only) go through `withAccessDeniedRetry`. It uses the same budget and goes back to the home page. No applicant data has been sent at that point.
  - Submission and payment are untouched. Access-denied there ends as `incomplete` after the single click, as it does for any other non-stop error.
- Observability reuses the existing `phase` event with `phase: "recovery"` (detected, attempt/reload, read-back) and restores `phase: "section"` afterwards. Logs contain only the section name, attempt number, action, elapsed ms and the path `/formshelp/access-denied`. They never contain `getCurrentUrl()`, query strings, field values or credentials.

## 2. Strategy and why
GET the section again, check the server state, and only then act. Rejected alternatives:
- Re-login first: slow, may hit CAPTCHA or lockout, and the page itself lists three causes of which only one is a lost session.
- Restart the section: only safe when nothing was posted.
- Stop immediately: always safe, but gives up work that a GET can recover.

The rule is the project's existing one: never replay what may have been applied. `risk` tells us whether a POST was possible. When it was, recovery is read-only. When it was not, a refill is idempotent. Retries are bounded per run (2 attempts, 2 s then 5 s), so a persistent block cannot be retried per section. The page's advice to close all browser windows is deliberately not followed, because in attach mode that browser belongs to the user.

Known limit: if a redirect is still in flight when `unexpectedReload` checks, the old document is read. The result is today's behavior (`possible`, stop), which is the conservative direction.

## 3. Expected time impact (design estimate, not measured)
- Before: a redirect cost a 20 s `SECTION_WAIT_MS` spin, or a 30 s postback wait, and then ended the run with a misleading "unexpected destination" error.
- After: detection within one poll (50 to 200 ms). Recovery costs the 2 s (or 5 s) backoff plus one page load, instead of losing every remaining section. The happy path adds no round trip (the same single script), only the extra `isAccessDenied` call on the rare reload/timeout paths.

## 4. Tests
- Totals: `npx vitest --run` 414 passed in 38 files (baseline 363 in 36). `npx tsc --noEmit` is clean.
- New `workflow/access-denied.test.ts` (45 tests, mocked WebDriver): real detector script via `vm`, no-spin check with fake timers, CAPTCHA manual and provider-abort, each recovery path, per-run retry limit and the 2000/5000 ms backoff, stop/cancel during backoff and navigation, kill switch, login path, and the no-PII check.
- New `workflow/access-denied-browser.test.ts` (3 tests, headless Chrome): a script redirect during early fill, a full run with refill and one SAVE, and a 302 after a POST that is verified read-only with the server POST count staying 1.
- Added 3 cases to `workflow/submission.test.ts`: access-denied after the final Submit click is incomplete with one click.
- Not covered by a dedicated test: Pay Now, Secure Payment and payer OK. They share the single `finishApplication` loop and catch, which the final-Submit cases exercise.
- Sanity check done: removing the denied check from `unexpectedReload` makes 6 of the new tests fail.

## 5. What could not be verified without the live site
Per investigation section 8, none of this was seen on the real site:
- What triggers the redirect, and at which step.
- Whether it is a 302 or a script redirect. (Both are exercised on a local fixture.)
- Whether the session survives it, and so how often the login path will run.
- Whether a SAVE that ended in the redirect was applied. This is why recovery is read-only after a possible save.
- The real markup of the page (detection is by pathname, so markup should not matter) and whether the denied page is reached through a different host (`www.immigration.govt.nz`) in a way that the cross-origin `navigate()` timeout handling covers. That path is covered by mocks only.
- Real recovery timings, and how often it recurs.
- Whether `/formshelp/error` or other `/formshelp/*` pages deserve the same handling. They are out of scope.

# Access-denied recovery

Final report for the redirect to `https://www.immigration.govt.nz/formshelp/access-denied`. The review (`.agents/tasks/review-access-denied.md`) is APPROVED. The work is uncommitted on `perf/fast-fill`, left for your review. This section consolidates the notes above it. Sources: the implemented diff, `access-denied-investigation.md`, `plan-access-denied.md` and the review.

## What changed

Detection is folded into `assertSiteAvailable` in `workflow/site-busy.ts`. It still runs one `executeScript`, so the happy path gains no round trip. The script now returns `'denied'`, `'busy'` or `false`. `'denied'` is decided by `location.pathname` only (any host, any case, optional trailing slash), never by body text, so an applicant page that mentions "access denied" cannot trigger it. A legacy `true` still means busy, which keeps the CAPTCHA test fixtures valid. `AccessDeniedError` is a `WorkingHolidayStop` with a fixed, PII-free message. It deliberately does not extend `SiteBusyError`, so the busy branch cannot swallow it and it is not a `StopRequested`. Two helpers were added: `isAccessDenied` (same pathname test, returns false while a navigation is in flight) and `abortableBackoff` (100 ms slices, throws `StopRequested` as soon as the run is aborted).

Every `captchaGuard` call and every `waitWithCaptcha` iteration already runs `assertSiteAvailable`. The first poll therefore sees the redirect in the early-fill and settle paths too (`waitFor`, `waitEarly`, `settle`, `segment`, `runFill`, `waitForSection`, `waitForPostback`). No new polling was added. The remaining gap was the places that decide "the form reloaded" without going through the guard. `unexpectedReload(driver)` now checks for the denied page first, as do the `waitFor`, `settle` and `postbackAndWait` timeout conversions. A redirect before any POST no longer sets `risk` or emits `persistence: possible`, and a timeout on the denied page no longer reaches `assertHost` and its misleading "unexpected destination" stop.

The section loop in `workflow/run.ts` has a new `AccessDeniedError` branch after the `StopRequested` rethrow and before the auth block. It draws on a per-run budget, waits an abortable backoff, then does a GET of the section URL and re-validates host, page and ApplicationId. If `risk` is false, the section is refilled from scratch. If `risk` is true, nothing is refilled and SAVE is not clicked. The applicable fields are read back read-only. A full match emits `verified`, completes the section and writes `coverage-saved.json`. Anything else marks the section unverified, so `filled: false` blocks submission and the loop moves on. A login form after the reload falls into the existing one-shot re-authentication, which still stops with the existing session message when `risk` is true. The pre-wizard `advanceToWizard` and `authenticate` calls (including login-only) go through `withAccessDeniedRetry` on the same budget. No applicant data has been sent at that stage. Submission and payment code is unchanged: a denied page there ends as `incomplete` after the single click.

Constants are named and live in `workflow/fast-fill.ts`: `MAX_ACCESS_DENIED_RECOVERIES = 2`, `ACCESS_DENIED_BACKOFF_MS = [2000, 5000]` and `ACCESS_DENIED_BACKOFF_SLICE_MS = 100`. The fixed give-up and disabled messages live in `site-busy.ts`. Events reuse the existing `phase` event with `phase: "recovery"` (detected, attempt and reload, read-back), and `phase: "section"` is restored afterwards. Logs carry only the section label, attempt number, action, elapsed ms and the constant path `/formshelp/access-denied`. They never contain the current URL, query strings, field values or credentials.

## Recovery strategy and why

The order is: GET the section again and verify the server state read-only, then re-login only if the GET lands on a login form, then refill only if nothing could have been posted. The options compared in the investigation (section 4.1):
- Navigate back and verify (chosen first step): a GET is idempotent, it costs a few seconds, and it uses the existing `readFieldValues` for verification.
- Re-login first: slow, may meet CAPTCHA or lockout rules, and the page lists three causes of which only one is a lost session. It stays as a fallback via the existing session path.
- Restart the section: cheap, but it can duplicate or overwrite a save, so it is allowed only when `risk` is false.
- Stop immediately: always safe, but it throws away work a GET can recover. It is the final result after the retry limit.

The rule is the project's existing one: never replay what may have been applied. `risk` tells us whether a POST was possible. A possible POST is never replayed (no refill, no SAVE, no submit, no payment). The recovery reuses the session and unverified-section handling instead of adding a second mechanism. The page's advice to close all browser windows is deliberately not followed, because in attach mode that Chrome belongs to you. Known limit: if the redirect is still in flight when `unexpectedReload` checks, it reads the old document and falls back to today's `possible` stop, which is the conservative direction.

## Expected time impact (design estimate, not measured)

Today a redirect causes a 20 to 30 s spin (the 20 s `SECTION_WAIT_MS`, or the 30 s postback wait) and then a misleading "unexpected destination" stop, which loses every remaining section. The new behavior is detection on the first poll (50 to 200 ms), a bounded 2 s backoff (5 s on the second attempt), and one GET plus page load. A first recovery therefore costs roughly 2 to 7 s including the load, versus a failed run. These are design estimates and have not been timed against the live site.

## Kill switch

`NZWH_ACCESS_DENIED_RECOVERY=0` (or `false`) is read once per run. With it set, the redirect is still detected, but the run stops immediately with the fixed "automatic recovery is disabled" message and makes no recovery navigation. Detection itself is never disabled.

## Test and type-check results

Baseline: 363/363 tests in 36 files and a clean type check. Recorded by the coder and quoted by the review: `npx vitest --run` 414 passed in 38 files, and `npx tsc --noEmit` clean. I did not re-run them for this report step. New tests: `workflow/access-denied.test.ts` (45, mocked WebDriver), `workflow/access-denied-browser.test.ts` (3, headless Chrome) and 3 cases in `workflow/submission.test.ts`. They cover detection, each recovery path, the retry limit and backoff, stop and cancel during recovery, the possibly-saved case, the kill switch, CAPTCHA, and a no-PII check. Removing the denied check from `unexpectedReload` makes 6 of the new tests fail. The review notes two non-blocking gaps: Pay Now, Secure Payment and payer OK have no dedicated denied test (they share the `finishApplication` loop that the final-Submit cases cover), and a redirect still in flight can read as the old document (conservative).

## What could NOT be verified without the live site

None of the following was seen on the real site. The investigation (section 8) treats each as UNKNOWN, and the design is conservative for all of them:
- What triggers the redirect (session timeout, permission rule, cookies, a WAF or rate rule, or automation detection), and at which step.
- Whether the session survives it, and so how often the login path will run.
- Whether a late SAVE can still land after the redirect, and whether a SAVE that ended in the redirect was applied. This is why recovery is read-only after a possible save.
- Whether it is a server 302 or a script redirect. Both are exercised on a local fixture only.
- The real page markup and links. Detection uses the pathname, so markup should not matter, but a Back or Login link was not inspected. The cross-origin `navigate()` timeout path (`www.immigration.govt.nz`) is covered by mocks only.
- Real recovery timings and how often it recurs.
- Whether other `/formshelp/*` pages such as `/formshelp/error` deserve the same handling. They are out of scope.
