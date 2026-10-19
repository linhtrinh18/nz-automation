# Form-fill pipeline audit (phase 1, read-only)

Worktree `.worktrees/formfill-speedup`, branch `perf/formfill-speedup`, HEAD `d25300d`. No source changed.
Line numbers are `workflow/run.ts` unless another file is named. Timings come from 14 complete live runs in
`data/runs/users/*/*/events.log` (only timing lines, step names and durations were read out; no PII is reproduced).
"Measured" = from those logs. "Estimated" = derived from code + round-trip counts.

Relevant prior work: phase 1 (batched fill) and phase 2 (eager page-load + early fill) are merged on this branch.
A read-only verify tab (`NZWH_PARALLEL_VERIFY`, commit `8f84880`) was implemented, run live once (run `9a251153`),
then reverted (`46704c7`, no reason given in the commit).

## 1. Flow map (job start → completion)

1. `workflow/worker.ts:52` builds `ExecutionController(store, job, () => assertCurrentCredentials(binding))`; consent
   (`liveSaveConsent`, `recoveryAcknowledged`) is enforced earlier by `validateRun` (`lib/run-config.ts:54-62`) and
   `lib/jobs.ts:244`. Plan/outcomes come from `buildPlan` / `requestedSections` (`lib/run-plan.ts:14-17`).
2. `runWorkingHoliday` (`:1762`) → `executeWorkingHoliday` (`:1769`): snapshots `NZWH_FAST_FILL` / `NZWH_EARLY_FILL`,
   starts Chrome via `chooseBrowser` (`browser/chooseBrowser.ts:53`, `eager` when early fill on), reads capabilities,
   `setTimeouts({pageLoad: 30000, script: 15000})` (`:1840`), maximize, `activateChrome`, pins `handles[0]` in attach mode (`:1845`).
3. Login: `authenticate` (`:408`): GET home + `ready()`, optional logout GET + `ready()`, GET login + `ready()`,
   field wait, `sendKeys` credentials, `captchaGuard`, LOGIN click, auth wait, `ready()`, GET home + `ready()`,
   wait for `editHyperLink` or country grid. Optional `advanceToWizard` (`:634`) → `selectCountry` (`:516`) → `clickApplyNow` (`:604`).
4. Application pick: navigate Edit.aspx + `ready()` → Wizard URL with `ApplicationId`.
5. Section loop (`:1975-2240`), per section, one tab:
   `checkpoint()` → `section-start` → GET section (`navigate`, `:384`) → `waitForSection` (`:766`, DOM-ready predicate in early mode)
   → `saveStep` (`:1584`): `fastFillSection` (`:1250`: early pass, settle, authoritative pass, settle, re-check)
   → unmapped-field scan → `captchaGuard` → `sectionSaveControl` → `postbackAndWait` (`:896`, emits `possible`, `sendKeys(SPACE)`)
   → `waitForPostback` (`:921`, new `timeOrigin` + `readyState==='complete'` + no async postback + jQuery idle)
   → path check + `[errorlabel]` count → emit `accepted` → **reload GET** (`navigate(url)`) → `waitForSection`
   → batched `readFieldValues` (re-read at `load` on mismatch) → emit `verified` → `coverage-saved.json` → `section-result completed`.
   Catch branches: AccessDenied (verify-first recovery), session expiry (one re-auth if `!risk`), `SectionPostbackTimeoutError`
   / `SavedValueVerificationError` (→ unverified, continue, controller maps `failed`+`accepted` → `saved_unverified`,
   `lib/execution-controller.ts:91-94`), `SiteBusyError` ("Please try again later" → `skippedBusy`, continue), else stop.
6. `finishApplication` (`workflow/submission.ts:147`) with `filled = no busy && no unverified`; submission/payer clicks are one-shot.

## 2. Measured timing (live logs)

Representative early-fill run (`78a92501`, total 40 s, AutoCaptcha mode):

| Phase | Wall-clock | Notes |
|---|---|---|
| Browser start | 1.6 s | spawn + DevTools poll (250 ms) + chromedriver attach |
| Login → wizard ready | 8.7 s | 4-5 GETs each followed by `ready()` (full load) |
| Sections (6) | 28.7 s | personal 6.6 (CAPTCHA 4.2), identification 3.7, health 2.9, character 2.9, adviser 4.9, workingHoliday 6.1 |
| Inter-section gap | ~0.33-0.37 s × 6 ≈ 2.1 s | between "Section X completed" and next "Opening section" |
| Finish (saveAll) | 0.7 s | |

Per-section components across the 14 runs (ms; early-fill runs unless noted):

| Section | GET+entry (derived) | fill (of which settle) | save | verify | load gap after SAVE |
|---|---|---|---|---|---|
| personal | ~0.5-0.8 s | 76-186 (62-127) | 1518-3121 | 680-891 (4961-85378 when CAPTCHA hits on reload) | 1-8 |
| identification | ~0.5-0.8 s | 391-505 (355-472) | 1483-1686 (one outlier 10501) | 567-630 | 230-296 |
| health | ~0.6 s | 180-200 (123-127) | 1302-1522 | 546-572 | 2-4 |
| character | ~0.6 s | 186-206 (123-126) | 1340-1533 | 580-775 | 3-5 |
| adviser | ~0.6 s | 1874-2084 (369-417); 1 AutoPostBack field = 1417-1624 | 1482-1709 | 652-826 | 3-6 |
| workingHoliday | ~1.0 s | 158-172 (122-126) | 3550-4699 | 1016-1089 | **1304-1482** |

Run totals: 40-66 s without long CAPTCHA, 104 s with a 31 s AutoCaptcha solve. CAPTCHA (`/rs-captcha`) appears in
**every** full run, right after the first SAVE (personal) or on its reload — it is a session gate triggered by saving.

Totals per run (excluding CAPTCHA): save POSTs ≈ 11 s, reload-verify ≈ 3.7 s, section GET/entry ≈ 4 s,
fill ≈ 3.2 s (2 s is the adviser AutoPostBack + settle barriers ≈ 1 s), inter-section ≈ 2 s, login ≈ 9 s, startup 1.6 s.

Verify-tab live run (`9a251153`): next-section GET in tab 1 took 537-1041 ms while the verify reload ran in tab 2;
verification then finished 21-45 ms after the next page was ready. identification went 3.7 s → 3.0 s. No busy,
access-denied or extra CAPTCHA was triggered by two concurrent same-session GETs (one run only).

## 3. Every current wait

RT = one WebDriver round trip (~2-5 ms locally, plus page work).

| # | Wait | Location | Type | Cost |
|---|---|---|---|---|
| W1 | `ready()` readyState==='complete' poll (200 ms) | `:364`; callers `:428,437,441,472,475`, `selectCountry :522,568,596`, `advanceToWizard :668,673`, Edit.aspx `:1914`, `fillAndSave… :1735` | full-load wait | login flow: 5-6 full loads ≈ part of the 8.7 s; ≥ 1 poll quantum (≤200 ms) each |
| W2 | `navigate()` → `driver.get` | `:384` | page-load strategy (eager → DCL, else load) | GET ≈ 0.5-1.0 s per section (server) |
| W3 | `waitForSection` DOM-ready predicate, 50 ms poll | `:766-784`, `fast-fill.ts:227` | targeted (OK); legacy path still `ready()` + field poll | ≤ 50 ms quantum + 4 RT/poll |
| W4 | `waitWithCaptcha` per poll: `assertSiteAvailable` (`site-busy.ts:40`, reads `document.body.innerText` → forces layout) + `captchaPending` (`:134`) + `requireSession` (`readAuthState`) + condition | `:346-362` | blanket per-poll overhead | 4 RT per poll; ~15-25 polls per section → ~0.1-0.3 s/section |
| W5 | Settle barrier: 2 consecutive settled reads 50 ms apart, run **twice** when the authoritative pass wrote | `fastFillSection :1430-1450,1520`, `SETTLE_STABLE_POLLS fast-fill.ts:34` | blanket fixed-minimum | measured 122-127 ms floor/section; 355-472 ms on identification (waits for load) |
| W6 | Early field wait `executeAsyncScript` slices 500 ms | `:1390`, `fast-fill.ts:349` | targeted (MutationObserver) | only on missing fields |
| W7 | Dependent-field / missing-field waits 50 ms | `:1266`, `DEPENDENT_FIELD_TIMEOUT_MS` 5 s | targeted | rare |
| W8 | Legacy AutoPostBack field (`legacyFillField` `:1164`) → `waitForPostback` full load | `:1185`, `:921` | full-load wait + server RT | adviser: 1.4-1.6 s measured |
| W9 | SAVE `sendKeys(SPACE)` then `waitForPostback` requiring `readyState==='complete'` | `:908-937` | **full-load wait** | server ~1.3 s + load gap: up to **1.48 s** (workingHoliday), ~0.25 s (identification) |
| W10 | `[errorlabel]` scan, unmapped-field scan, path checks | `:1606,1630` | 3 RT | ~10-20 ms |
| W11 | Verification reload: `navigate(url)` + `waitForSection` + `readFieldValues`; on mismatch wait for `load` and re-read | `:1643-1668` | full extra GET (+ conditional full-load wait) | **0.55-1.1 s per section** |
| W12 | CAPTCHA: eager load wait (200 ms poll, ≤30 s) before provider | `:213-223` | full-load wait | ≤ load tail |
| W13 | CAPTCHA `driver.wait` poll 200 ms (assertSite + submitCandidate + captchaPending each poll) | `:253-327` | fixed poll | ≤200 ms quantum after solve; solve itself 1.5-31 s (provider) |
| W14 | `activateChrome` (2 CDP calls) in `waitForSection`, `postbackAndWait`, `waitForPostback`, `clickWithFallback`, `captchaGuard` | `:754`, 8 call sites | per-step overhead | ~5-15 ms each, ~4-6 per section |
| W15 | `checkpoint()` → `store.command` + **`assertCurrentCredentials`** (remote `result("validate")`, `server/cloud.ts:42`) | `lib/execution-controller.ts:107-113`, loop `:1981` | blocking network call at every section boundary | ~0.33 s measured gap × 7 boundaries ≈ **2.3 s** (probable cause, not profiled) |
| W16 | Fixed sleeps: country tile `driver.sleep(300)` `:547`; country/scheme recheck 200 ms × 75 `:592,664`; DevTools poll 250 ms (`chooseBrowser.ts:45`); access-denied backoff 2 s/5 s (`fast-fill.ts:43`); controller pause poll 200 ms (`execution-controller.ts:121`); occupation backoff `:1032` (occupation excluded) | various | fixed sleeps | 300 ms per country click; rest only on closed scheme / recovery / pause |
| W17 | Submission/declaration: `driver.wait` readyState 30 s `:2276`; `waitForChangeThenLoad` (`fast-fill.ts:381`); payer `driver.wait(read, 20000)` (`payer-form.ts:33`) | submit path | full-load waits (kept deliberately) | only in `fillAndSubmit` |
| W18 | Readback round trips: pre-SAVE `recheck` (1 RT), post-reload `readFieldValues` (1 RT, +1 on mismatch), per-segment `timeOrigin` reads | `:1322`, `:1650` | batched already | ~5-20 ms |

## 4. Ranked bottlenecks

1. **SAVE POST server time** ≈ 1.3-1.7 s × 6 (≈ 11 s/run). Server-bound; can only be overlapped, not removed.
2. **Verification reload GET** ≈ 0.55-1.1 s × 6 (≈ 3.7 s). Pure read; can be overlapped with the next section's GET (proven live once).
3. **Next-section GET** ≈ 0.5-1.0 s × 6 (≈ 4 s). Can be issued while the previous SAVE is in flight (requested pipeline).
4. **Login flow** ≈ 8.7 s: 5-6 sequential GETs each gated by a full-load `ready()`.
5. **Section-boundary checkpoint** ≈ 0.33 s × 7 (≈ 2.3 s): a remote credential validation awaited before every GET.
6. **Post-SAVE load gap** (W9): 1.3-1.5 s on workingHoliday, ~0.25 s on identification — a full-load wait that the requested change #1 targets.
7. **AutoPostBack field** (adviser) 1.4-1.6 s + restart: server RT + full-load wait (W8).
8. **Settle barrier floor** ≈ 0.12 s × 6 + identification ≈ 0.35-0.47 s (W5).
9. **Per-poll overhead** (W4/W14): 4 RT per poll + `innerText` layout + 2 CDP calls per step ≈ 0.1-0.3 s/section.
10. CAPTCHA solve (1.5-31 s, provider-bound) — out of scope for speed except prompt detection; must not be multiplied by tabs.

## 5. Requested changes: analysis and risks

### 5.1 No full-page-load waits (#1)

State: section entry already fills at DOM-ready (phase 2). Remaining full-load waits in the hot path: W9 (SAVE response),
W8 (AutoPostBack), W11 mismatch re-read, W1 (login flow), W12/W17 (CAPTCHA provider, submission — deliberate).

Plan:
- W9: accept the SAVE response at "new `timeOrigin` + `readyState !== 'loading'` + no async postback + first field present"
  and run the `[errorlabel]` scan at DOM-ready. **Risk**: if any validator label is set by a load-time script, an error
  could be missed. Mitigation: `[errorlabel]` is a server-rendered attribute (scan reads attributes, not script state);
  additionally re-run the scan once the tab reaches `load` (in the background slot of the pipeline, §5.3) before the
  section is reported `completed`. Net: the load gap leaves the critical path but is still checked.
- W1: replace `ready()` after login-flow GETs with the targeted element waits that already follow each of them
  (username field, `editHyperLink`/tiles, `readAuthState().authenticated`). Keep `ready()` only on Edit.aspx→Wizard redirect.
- W5: one settle (not two) when the authoritative pass only re-wrote values identical to the early writes; keep two otherwise.
- W8: keep (server postback, correctness-critical); only its trailing poll quantum shrinks via the single-probe change (§6 E1).
- Keep W12, W13, W17 unchanged (CAPTCHA token injection and one-shot submission/payment safety).
- Fixed sleep `:547` (300 ms scroll settle) → wait until the tile is in viewport (1 RT); other sleeps are backoffs/closed-scheme polls and stay.

Risks: missed late-bound validation (mitigated above); fields re-rendered by `load` handlers (already covered by the
authoritative pass + re-check); `navigate()` timeout semantics under eager are unchanged.

### 5.2 Save as soon as filled (#2)

Already true: SAVE fires right after the authoritative pass + re-check (1 batched readback) + unmapped scan + `captchaGuard`.
Remaining latency before SAVE: settle barriers (≈0.12 s, §5.1) and three separate RTs (unmapped scan, `captchaGuard`
2 RT, URL check, `sectionSaveControl`). Plan: fold unmapped scan + URL/`timeOrigin` check + site/CAPTCHA probe + save-control
lookup into one pre-SAVE script; keep the readback check as the gate. Risk: none beyond today if the combined script
returns the same facts; SAVE must still be triggered by native `sendKeys(SPACE)` (trusted event) after `activateChrome`.

### 5.3 Pipeline across tabs (#3)

#### Facts that constrain the design
- One Selenium session executes commands serially on the focused window; "background" work is only the browser's own
  network/page activity. Background tabs keep running because `chooseBrowser` passes the anti-throttling flags
  (`chooseBrowser.ts:83,90`) — **only for Chrome we spawn**; attach mode has no such guarantee.
- `sendKeys(SPACE)` on SAVE blocks the driver until the response reaches DCL (eager). So "click SAVE then immediately
  open a tab" cannot overlap anything unless the tab is opened **before** the click.
- One ASP.NET session (shared cookie jar). If the server holds an exclusive session lock, a GET issued during a POST
  queues behind it → zero gain but no harm. The one live run showed concurrent GET+GET at normal latency.
- `/rs-captcha` appears after the first SAVE in every run: a session-level gate. A prefetched tab may land on it too.
- Cross-section dependencies: personal → adviser (`conditions.ts:12-13`; Agent.aspx reachable only after personal saved).
  The final-section footer switches SAVE→SUBMIT based on server-side completion (`sectionSaveControl :1114`).
- Run state is single-section: `context.risk`, `sectionMark`, controller `current()`, persistence events without section id.

#### Decision: single driver, cooperative scheduler, at most one POST in flight
- **Window handles**: the main window handle is recorded at run start. Each pipelined section gets a `SectionTab
  { name, handle, phase, stamp, risk, outcome }`. New tabs are created with `driver.switchTo().newWindow('tab')`
  followed by a **non-blocking** navigation `executeScript("location.href = arguments[0]")` so the driver returns
  immediately. Every driver command for a tab is preceded by `switchTo().window(handle)` through one helper
  (`onTab(tab, fn)`), which also calls `activateChrome` before any native click. No helper ever assumes the current
  window. Tabs are closed (`driver.close()` + switch back) as soon as their section is reported. Max **2 open tabs**.
- **Order per section N** (pipeline "save" mode):
  1. Tab N is filled and passes the readback re-check (unchanged code).
  2. Open tab N+1 and start its GET (non-blocking) — only if N+1 does not depend on N (never adviser while personal
     is unsettled; never before the first SAVE of the run has passed CAPTCHA, i.e. personal runs sequentially as warm-up).
  3. Switch to tab N, `captchaGuard`, native SAVE (blocks to DCL; tab N+1 loads meanwhile).
  4. Tab N quick checks at DOM-ready: path, `[errorlabel]`. Emit `accepted` for N.
  5. Switch to tab N+1: wait DOM-ready, fill, re-check. Interleaved with **tab N background steps**: fire its reload
     verify (non-blocking `location.href`), then poll its `readFieldValues` between N+1's segments/polls.
  6. Before SAVE of N+1: tab N must be settled (verified / unverified / failed). This is the barrier that keeps
     one POST in flight and guarantees a late failure in N is known before N+1 posts.
- **Pipeline "verify" mode** (smaller variant): skip step 2's prefetch during the POST; only overlap N's verify reload
  with N+1's GET+fill (the reverted `NZWH_PARALLEL_VERIFY` design).
- Config flag `NZWH_TAB_PIPELINE` = `off` | `verify` | `save`, read once per run, one log line. **Default `off`** (today's
  sequential behavior) until a live A/B confirms no session lock, no extra CAPTCHA, no busy/denied responses.
  Forced `off` in attach mode, legacy entry (`NZWH_FAST_FILL=0`), and `loginOnly`. Auto-downgrade to `off` for the rest
  of the run on the first busy, access-denied, session-expiry, CAPTCHA-in-background-tab or closed-window event.

#### Interaction with save verification and statuses
- `risk` becomes per-section (`Map<section, boolean>`); persistence/section-result events carry an optional `section`
  key, and `ExecutionController.event()` resolves the item by key when present (falls back to `current()`).
  `checkpoint()` stays a no-op while any item is `running`/`waiting_captcha`, so pause/stop still land only at safe
  boundaries (no in-flight tab).
- `saved_unverified`: unchanged mapping (`failed` + `accepted`). A background `SavedValueVerificationError` or
  `SectionPostbackTimeoutError` for N is reported as `section-result failed` **for N** (keyed), N goes to
  `unverifiedSections`, no re-SAVE; N+1 continues.
- `failed` / run stop: a late `[errorlabel]` failure in N stops the run exactly as today. Because of the barrier, N+1
  has been filled but **not saved**; its tab is closed with nothing posted, N+1 is reported `skipped/failed` with
  "not run". No data loss, same message.
- "Please try again later" (`SiteBusyError`) in tab N's response or reload: N → `skippedBusy`, `coverage-busy.json`
  updated, its `saved` entry deleted (as today); pipeline downgrades to `off`; N+1 is re-entered in the main tab.
  Busy on N+1's prefetch GET: nothing posted → close the tab, re-GET sequentially.
- **Late failure detection and reporting**: each `SectionTab` holds a terminal `outcome` set only by its own checks
  (DOM-ready errorlabel, load-time errorlabel re-scan, reload verify). The scheduler drains outcomes (a) between every
  fill segment/poll of the foreground tab, (b) at the pre-SAVE barrier of the next section, (c) before `finishApplication`
  (`filled` stays false if any section is unverified/busy). Each outcome emits its keyed `section-result` and writes
  `coverage-saved.json` / `coverage-busy.json` immediately, so a crash after detection still leaves correct files.

#### CAPTCHA and session/login across tabs
- One global CAPTCHA mutex per driver: the tab that detects the challenge owns it; the guard pins its handle for the
  whole wait (re-switching each poll, as the reverted commit did) and other tabs are not touched meanwhile. Provider
  solves therefore stay ≤ 1 per challenge. After completion, every other tab re-runs `captchaPending`; a tab sitting
  on `/rs-captcha` with nothing posted is re-GET; a tab with a POST possibly applied is handled as `risk` (read-back only).
- `selectCountry`'s popup closer (`:550-562`) must skip pipeline handles (only runs pre-wizard, but guard anyway).
- Session expiry / login form in any tab: downgrade to `off`, close extra tabs, then today's one-shot re-auth rule
  using that section's own `risk`. Access-denied in any tab: same downgrade, then today's verify-first recovery in the main tab.
- `requireSession`, `assertSiteAvailable`, cancel checks keep running on every poll of every tab.

#### Resume and recovery
- `coverage-saved.json` is still written only for verified sections; resume (`resumeKeys`/`taskKeys`) is unchanged.
- Interruption with two sections in flight: `ExecutionController.complete()` must mark **every** running item
  (`accepted` → `saved_unverified`, else `failed`), not just `current()`. Stop/abort closes pipeline tabs it opened
  (never the user's tabs in attach mode — pipeline is off there anyway).

#### Server-side limits
- No client-visible rate-limit headers or documented concurrency limit. Signals that could indicate limits: "Please
  try again later" (`site-busy.ts:36`), `/formshelp/access-denied` (session/permission/cookie, not proven rate-limit;
  `access-denied-investigation.md`), and the `/rs-captcha` gate after the first SAVE. A burst of requests is the most
  plausible trigger for all three. Mitigation: ≤ 2 tabs, ≤ 1 POST in flight, ≤ 2 concurrent GETs, personal sequential,
  shared access-denied budget unchanged, auto-downgrade on first signal.

#### Verdict
Fully "fire SAVE and forget" (multiple POSTs in flight, later tabs saving before earlier ones are verified) is **unsafe**:
it risks session-state races, duplicate CAPTCHA solves, ordering bugs (personal→adviser, SAVE/SUBMIT footer) and
reporting a later section as saved while an earlier one silently failed. The safe variant above keeps every requested
overlap that does not need a second POST in flight. Expected gain if the server does not serialize: ≈ min(SAVE POST,
next GET + fill) + verify reload ≈ **1.2-1.8 s per section**, ≈ 6-9 s/run. If the server serializes per session:
≈ 0.6 s/section (verify overlap only, as measured). Gated, default `off`.

## 6. Full improvement list (ranked by expected gain / risk)

| # | Improvement | Where | Est. gain/run | Risk | Default |
|---|---|---|---|---|---|
| P1 | Tab pipeline `verify` mode (overlap reload-verify with next GET+fill) | new `workflow/tab-pipeline.ts`, `saveStep` split into `saveSection`/`verifySection`, loop | ~3-4 s (measured 0.5-1 s/section) | low-med | flag |
| P2 | Tab pipeline `save` mode (prefetch next tab before SAVE; barrier before next SAVE) | same | +3-5 s on top of P1 | med | flag |
| E1 | Overlap `assertCurrentCredentials` with the next section GET (start the promise at the boundary, await before fill/SAVE); stop/pause command still read synchronously | `lib/execution-controller.ts` checkpoint split, loop `:1981` | ~2 s | low (validation still gates any POST) | on |
| E2 | Single probe script per poll: site state + CAPTCHA + auth + condition in one `executeScript`; use `textContent` checks before `innerText` | `waitWithCaptcha`, `site-busy.ts`, `auth-state.ts` | 0.5-1.5 s | low (same predicates; `captcha.test.ts` fixture expectations) | on |
| E3 | SAVE response accepted at DOM-ready + `[errorlabel]` re-scan at load (background in pipeline, inline otherwise) | `waitForPostback`, `saveStep` | ~1.5-2 s (workingHoliday + identification gaps) | med (late validators) | on with `NZWH_EARLY_FILL` |
| E4 | Login flow: drop `ready()` where a targeted element wait follows | `authenticate`, `selectCountry`, `advanceToWizard` | 1-3 s | low | on |
| E5 | One settle barrier when the authoritative pass wrote nothing new | `fastFillSection` | ~0.4-0.7 s | low | on |
| E6 | Combine pre-SAVE RTs (unmapped scan, URL check, save-control lookup) in one script | `saveStep`, `sectionSaveControl` | ~0.1-0.2 s | low | on |
| E7 | `activateChrome` only before native clicks/keys and on tab switch, not on every wait | `waitForSection`, `waitForPostback` | ~0.1-0.3 s | low (background throttling flags present for spawned Chrome) | on |
| E8 | Replace `driver.sleep(300)` after tile scroll with an in-viewport check | `selectCountry :547` | 0.3 s when used | low | on |
| X1 | Reuse logged-in session (skip logout+login when already authenticated as the same account) | `authenticate` | ~5-7 s | **high**: credential isolation (`credential-isolation.test.ts`), wrong-account risk; no reliable account-identity selector known | **not recommended**; at most flag, default off |
| X2 | `pageLoadStrategy: 'none'` | `chooseBrowser` | small over eager | high: every `driver.get`/click returns immediately; all callers would need explicit waits | reject (eager already in place) |
| X3 | Verify from the SAVE response instead of a reload | `saveStep` | ~3.7 s | high: postback response echoes posted/ViewState values, does not prove persistence | reject |
| X4 | Selector caching / cheaper selectors | — | ~0 | stale elements across postbacks; `getElementById` already O(1) | reject (as in phase 1) |
| X5 | Browser startup: keep spawned Chrome (already avoids banner); skip `maximize` when spawned with `--window-size` | `executeWorkingHoliday :1841` | ~0.1 s | low | optional |

## 7. Must-keep invariants (checklist for implementation)

- Live-save consent: `validateRun` / `liveSaveConsent` / `recoveryAcknowledged` / fictional-draft opt-in untouched.
- Exactly one SAVE call site; SAVE only via native `sendKeys(SPACE)` after `possible` is emitted; never replayed.
- Never more than one POST in flight; no re-POST on any late failure; submission/payment one-shot.
- Run state: `section-start` / `persistence` / `section-result` / `coverage-*.json` semantics; `saved_unverified` mapping;
  `checkpoint()` only at safe boundaries; every in-flight section finalized on interruption.
- Vietnamese status messages: reuse existing strings; any new user-facing message (pipeline downgrade, late failure)
  written in Vietnamese in the same style; logs PII-free (no URLs with query strings, no values).
- Kill switches `NZWH_FAST_FILL`, `NZWH_EARLY_FILL`, `NZWH_ACCESS_DENIED_RECOVERY` keep working; new `NZWH_TAB_PIPELINE` default `off`.
- `captcha.test.ts` behavior expectations preserved (if E2 changes RT counts, update fixtures deliberately, not loosely).

## 8. What cannot be verified offline

Server session locking, whether prefetched GETs land on `/rs-captcha`, whether late-bound validators exist, real
gains of P2/E3, and any rate-limit threshold. Build (`npm run typecheck`) and tests (`npm run test`) can be run;
"before vs after" wall-clock must be compared from live timing logs (the per-section timing line already exists),
using the run totals in §2 as the baseline (40-66 s without long CAPTCHA).

## Verification results
All numbers below come from offline runs (fake drivers, a local 127.0.0.1 fixture server, headless Chrome). No request was sent to the government site and no live SAVE was performed.

### Build and tests
- `npm run typecheck` (`tsc --noEmit`): exit 0, no diagnostics.
- `npm run test` (`vitest run`, vitest v5.0.5): Test Files 41 passed (41), Tests 479 passed (479), duration 85.34 s.
  Includes `workflow/tab-pipeline.test.ts` (scheduler, barriers, late-failure and downgrade cases) and `workflow/pipeline-browser.test.ts` (real Chrome against the fixture).

### Offline before/after timing (SIMULATED, not the live site)
Harness: `workflow/pipeline-browser.test.ts`. A local HTTP fixture serves 3 sections with artificial latencies: 600 ms per GET, 500 ms per SAVE POST, 900 ms per reload. The same job is run twice in the same headless Chrome:
- before: `NZWH_TAB_PIPELINE=off` (one tab, sections strictly sequential: GET, fill, SAVE, verify reload, then next section)
- after: `NZWH_TAB_PIPELINE=save` (first section sequential, the next two pipelined on the second tab slot; earlier saves verified in the background)

| run | off (ms) | save (ms) | delta |
|---|---|---|---|
| this verification run | 6242 | 5698 | -544 ms (-8.7 %) |
| earlier runs (impl note, 3 runs) | 6250-6360 | 5670-5860 | about -8 to -10 % |

Headline: about 0.55 s (about 9 %) faster on a 3-section fixture whose latencies are artificial. Caveats on reading this number:
- `off` already includes the non-pipeline speedups (single page probe, targeted login waits, combined pre-SAVE script, skipped `ready()` after GETs, skipped `maximize()`). The table isolates the pipeline gain only. The harness does not rebuild the pre-change commit, so no offline number exists for the sum of all changes versus the original code. Those savings (E1-E8) are counted in round trips and reads by unit tests, not in milliseconds.
- Overlap is of network latency only. ChromeDriver blocks commands on a tab that is still navigating, so background navigation is timer-scheduled and background reads use CDP `Runtime.evaluate`.
- Only 2 of the 3 sections can overlap (the first always runs sequentially), so the ratio will differ with the real section count and real latencies.
- The fixture has no CAPTCHA, login churn, or server think time, which dominate the live baseline (40-66 s per run, section 2).

### Not verifiable offline (needs a live A/B that must not be run here)
1. Real wall-clock before/after on the government site (live A/B of off / verify / save, at least 3 runs each).
2. Server-side session locking or serialization when a background reload overlaps a foreground POST on the same session.
3. Whether a prefetched GET of the next section lands on `/rs-captcha` (or a challenge/denied page) instead of the form.
4. Whether live load-time or late-bound server validators exist beyond what the fixture simulates (a flagged field appearing only after window `load`), and their timing.
5. Real-world `drain()` overhead (end-of-run wait for background saves and verification) with real save latencies.
6. Server rate-limit or concurrency thresholds (requests per session/IP, simultaneous tabs) and whether "Please try again later" appears sooner with pipelining.
7. Real CAPTCHA behavior across tabs: a second challenge triggered by a background reload, solver (2captcha / autocaptcha) latency overlap, and the downgrade-to-sequential path on the live site.
8. Session/login persistence across two tabs on the live site (cookie scope, logout or session-expiry triggered by a background navigation).
9. Live save-verification semantics under pipelining: true `saved_unverified` versus `failed` classification, and the actual server duplicate-save or double-POST behavior on late failure.
10. Real-browser focus and native-input effects in non-headless mode (window focus, `activateChrome`, tab-slot reuse on desktop Chrome and in attach mode; attach mode forces the pipeline off).
11. Effect of the skipped `maximize()` and the viewport wait on live layout and element interactability.
12. Live behavior of the live-save consent safeguard end to end with pipelining. Offline tests cover the gating logic only, and a live save is prohibited here.

Count: 12 unverifiable steps. Default stays `NZWH_TAB_PIPELINE=off` until a live A/B is run by the owner.
