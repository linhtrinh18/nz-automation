# Speed-up analysis: overlapping and parallel sections

Read-only analysis. No source changed. Line numbers refer to the working tree at the time of reading.

## Summary

- After the fast-fill work (design.md, form-fill-speedup-report.md), client-side fill per section is estimated at under 50 ms. Wall-clock is now mostly three server round trips per section: section GET, SAVE POST, verification-reload GET. Add CAPTCHA time when a challenge shows up.
- Option A (save in one tab, fill the next in another) can only hide the SAVE POST behind the next section's GET and fill. Fill is already tiny, so the realistic gain is about one GET per section. It also depends on the server handling two requests from the same session concurrently. The code can't show that. On ASP.NET it's a common reason this fails (session-state locking), so it needs live verification.
- Option B (all sections in parallel tabs) has no hard data dependency between sections except personal → adviser. But one Selenium session runs commands serially, the run state is single-section (`context.risk`, `sectionMark`), and every SAVE still goes through the same ASP.NET session. Its upside over A is small and its risk is much larger.
- CAPTCHA: the code detects it per current tab only. The claim that "once required, every tab is blocked" can't be confirmed or refuted from code or tests. The tests are mocks of one driver. Detection by URL path (`/captcha/i` on `location.pathname`) suggests a server-side interstitial, which would plausibly gate the whole session. That's an assumption until tested live.
- Recommendation: a conservative hybrid. Keep SAVE and the `[errorlabel]` check strictly sequential in one tab. Move only the read-only verification reload to a second tab, in parallel with the next section's GET, and drop the extra GET where it's redundant. First, measure with the existing timing log whether the server serializes concurrent requests from one session.

## 1. Current flow and bottlenecks

Section loop: `executeWorkingHoliday`, `run.ts:2034-2245`. Sections come from `requestedSections` (`lib/run-plan.ts:14-17`) in `fields.ts` key order: personal → identification → (occupation excluded, `section-policy.ts:2-4`) → health → character → adviser (skipped unless `representedByAdviser === "Yes"`, `run.ts` loop) → workingHoliday. Then `finishApplication` runs (`run.ts:2259`, `submission.ts:147`).

Per section, in one tab:

| # | Step | Code | Server-dependent? | Bound |
|---|---|---|---|---|
| 1 | GET section URL (skipped if already on it) | loop `navigate` → `driver.get` (`run.ts:383`) | yes, GET | pageLoad 30 s (`run.ts:1835`) |
| 2 | `waitForSection`: `activateChrome`, ready/DOM-ready, session check, first field present | `run.ts:765-783` | waits on page load | `READY_WAIT_MS` 30 s + `SECTION_WAIT_MS` 20 s (`fast-fill.ts:16-20`), polls 50/200 ms |
| 3 | Fill: batched in-page script, or legacy per-field. AutoPostBack fields do a server round trip each | `saveStep` → `fastFillSection` (`run.ts:1249`) / `legacyFillField` | only AutoPostBack fields | `DEPENDENT_FIELD_TIMEOUT_MS` 5 s, settle 30 s |
| 4 | Unmapped-field gate, `captchaGuard`, URL unchanged, find SAVE | `run.ts:1603-1625`, `sectionSaveControl` `run.ts:1113` | no (local) | — |
| 5 | SAVE: `sendKeys(SPACE)`, then `waitForPostback` waits for a new `timeOrigin`, `readyState complete`, no async postback, jQuery idle, first field present | `postbackAndWait` `run.ts:895-918`, `waitForPostback` `run.ts:920-940` | yes, POST response | `POSTBACK_WAIT_MS` 30 s |
| 6 | Path unchanged; `[errorlabel]` server-validation count | `run.ts:1628-1640` | yes, reads the POST response | — |
| 7 | Verification reload: `navigate(url)`, `waitForSection`, same ApplicationId, batched value read (re-read at `load` if early) | `run.ts:1643-1700` | yes, second GET of the same section | as step 2 |
| 8 | Log timing (`fill/save/verify`, load gaps); next iteration does step 1 for the next section | `run.ts:1703-1710` | — | — |

Where the time goes:

- Server-bound waits per section: steps 1, 5 and 7, plus one round trip per changed AutoPostBack field in step 3. Only step 5 and step 6 depend on the SAVE response. Step 7 depends on the save having been committed, but it's a read.
- Client-side waits: poll quantization (50 ms fast, 200 ms legacy, `fast-fill.ts:12-14`) and `activateChrome` (2 CDP calls each, `run.ts:753-759`), which runs in `waitForSection`, `postbackAndWait`, `waitForPostback` and `clickWithFallback`.
- Sleeps: none in the section loop. The only fixed sleeps are outside it: country tile 300 ms (`run.ts:546`), re-check 200 ms (`run.ts:592/664`), access-denied backoff 2 s / 5 s (`fast-fill.ts:43`).
- CAPTCHA: open-ended. It's paused inside every `waitWithCaptcha` (`run.ts:345-361`) and is not counted against the page timeout. Provider budgets: 2Captcha 180 s (`two-captcha.ts:93`), AutoCaptcha 120 s (`autocaptcha.ts:11`), human 30 min default (`run.ts:179`).
- The timing log line (`run.ts:1705`) already separates `save` and `verify` ms and the DCL→load gaps. Real numbers have to come from a live run. I had no live logs.

What design.md covers and leaves open: it covers client-side cost (batched fill, eager load, 50 ms polls, batched verify, settle barrier). It explicitly keeps all server round trips (Overview: "Server time stays the same"). It rejects parallel tabs and prefetching in one line (B7) on ViewState/session-race grounds, with no measurement. Still open: the three server round trips per section, whether any of them can overlap, and CAPTCHA behaviour across tabs. This report is about those gaps.

## 2. Option A: overlap SAVE with the next section

Site constraints visible in code:

- Session and cookies: there's no cookie handling in the code. Auth is the browser's cookie jar. Tabs in the same Chrome profile share it. `requireSession` (`run.ts:103-110`) only reads the DOM for a login form. A new tab would be on the same session. That's needed for A, and it's also why server-side session locking would apply.
- ViewState: no code touches `__VIEWSTATE`. SAVE is a native WebForms postback of the current page's form (`postbackAndWait`). Each tab's form carries its own ViewState, so a GET of section N+1 in tab 2 doesn't corrupt tab 1's postback at the page level. Whether the wizard keeps progress or draft state in server Session, so that a concurrent GET renders stale data or is blocked, is not visible. **Assumption, live check needed.**
- Save ordering: no client-side prerequisite in `fields.ts` or `conditions.ts` other than personal → adviser (`conditions.ts:12-13`). `sectionSaveControl` (`run.ts:1129-1160`) shows the footer switches from SAVE to final SUBMIT once all sections are complete. So the server tracks per-section completion, and the next page's footer depends on what is already saved. If the last section is filled before the previous SAVE commits, the expected control could differ. The code handles both footers, so this is tolerated.
- Busy and rate limits: `SITE_STATE_JS` (`site-busy.ts:33-38`) detects "Site busy" / "Please try again later". The loop treats it as unverified and skips without retry (`run.ts:2210-2232`). The access-denied page (`site-busy.ts:13-29`) is described as appearing on "session, permission or cookie problems". Both are plausible responses to concurrent same-session traffic. There's no client throttling, because the flow is already serial.

Single-tab assumptions in the code:

- One driver and one current window. Every helper calls `driver.*` on the focused handle. The run deliberately pins `handles[0]` (`run.ts:1838-1842`, comment "Use one existing tab for the sequential save flow"). The only multi-handle code is the country popup closer (`run.ts:547-560`), and it would close any non-Create tab it finds, including a second section tab, if run during that phase.
- `activateChrome` (`run.ts:753-759`) brings the current target to the front before native SAVE and clicks. A background tab gets throttled. `chooseBrowser` passes `--disable-background-timer-throttling`, `--disable-renderer-backgrounding` and `--disable-backgrounding-occluded-windows` (`browser/chooseBrowser.ts:83,90`), which mitigates this, but only for Chrome it spawns. Attach mode (`chooseBrowser.ts:72-73`) uses the user's flags.
- Run state is global and single-section: `context.risk` (`run.ts:89`, reset per section in the loop) drives access-denied and session recovery decisions. `sectionMark` (`run.ts:80-86`) times one section. `persistence` events have no section id.
- Post-SAVE checks read the current document. The `[errorlabel]` count (`run.ts:1633-1635`) and the path check (`run.ts:1629`) must run on tab 1's response page. The reload verification (`run.ts:1643`) navigates the current tab.

If the SAVE result is checked later:

- `[errorlabel]` failures currently stop the whole run (`run.ts:1636-1639`). Deferred, you'd already have typed or posted section N+1 before learning that N failed. N+1's save is still valid on its own, so this is mainly a reporting change. One exception: the final SUBMIT footer appears only when all sections are valid.
- `SectionPostbackTimeoutError`, `SavedValueVerificationError` and `SiteBusyError` already mark the section unverified and continue without a repeat POST (`run.ts:2181-2232`). So deferring their detection doesn't change the outcome, only when it's reported.
- Access-denied or login redirect after a possible save uses `risk` (`run.ts:2070-2180`) to decide "read back, never refill". With two in-flight sections, `risk` has to become per-section, or recovery could refill a section whose POST may have landed. That would be a duplicate-submission risk.
- Detecting a failed background save: keep tab 1 open until `waitForPostback` is satisfied, then run the `[errorlabel]` check there. Recovery stays as today: read back, never re-POST, mark unverified. This needs a per-tab state machine and `switchTo().window()` between commands.

Expected saving: at most `min(SAVE POST, next GET + fill)` per section, and only if the server processes them concurrently. If ASP.NET session locking is on (typical for InProc read/write session pages), the second request queues and the saving is about 0. **Assumption, live check needed.**

## 3. Option B: every section in its own tab

Independence (from `conditions.ts:11-20` and `fields.ts`):

- Within-section dependencies only: title → otherTitle, health answers → details, deported → date/country, charge questions → details, beenToNz → previousVisitDate, adviserType → exemptionReason.
- Cross-section: `personal.representedByAdviser` decides whether adviser applies (`conditions.ts:13`). On the live site it likely also decides whether `Agent.aspx` is reachable (the loop throws "Conditional page unavailable" otherwise). So personal must be saved before adviser. This is the only proven order constraint.
- No other ordering is visible. Whether the server rejects SAVE on a later page before earlier pages are valid is unknown. The SAVE/SUBMIT footer switch suggests completion is tracked but not enforced in order. **Assumption, live check needed.**

Selenium concurrency:

- One WebDriver session runs one command at a time. ChromeDriver serializes them, and each command targets the session's current window. "Parallel tabs" from one driver means interleaving `switchTo().window()` + command. Real concurrency only happens in the browser: page loads and POSTs keep running while the driver is on another tab. That's enough to overlap network waits, if navigation is started without blocking. `driver.get` blocks until the page-load strategy is satisfied, so use `window.open` / `location.href` from `executeScript`, or CDP `Target.createTarget`.
- `activateChrome` / `Page.bringToFront` brings one tab forward at a time. Calling it per tab switch adds 2 CDP calls each time, and it's required before native SAVE (`run.ts:905`).
- True parallel driving needs multiple sessions: for example, several ChromeDriver sessions attached to the same Chrome via `debuggerAddress` (already supported, `chooseBrowser.ts:72-73`), or a CDP client per target. They'd share the cookie jar (same profile). Each would need its own execution context, since `execution` is an AsyncLocalStorage with a single `risk`/`hooks` (`run.ts:79-96`).

Risk of flagging: N near-simultaneous POSTs from one session is exactly what the busy and access-denied paths describe. The access-denied budget is shared per run (`MAX_ACCESS_DENIED_RECOVERIES`, backoff 2 s / 5 s), so one burst could use it up for all sections. This is an inference from code. Server-side rate limiting can't be observed from code. **Assumption, live check needed.**

Expected saving vs A: B overlaps all GETs and POSTs. If the server serializes per session, it saves nothing. If it doesn't, it saves about (sections − 1) × (GET + POST + reload), roughly 4 sections' worth. It's also the highest risk for unverified or duplicate saves and recovery bugs.

## 4. CAPTCHA analysis

What the code and tests establish:

- Detection is per document. `captchaPending` (`run.ts:133-142`) checks `location.pathname` for `captcha`, the "please complete the captcha" text, or a visible unsolved reCAPTCHA/hCaptcha widget, in the current tab only. `page-state.ts:15,31-32` classifies the same as page state `captcha`.
- When it's checked: on every iteration of every `waitWithCaptcha` (`run.ts:354`), explicitly before SAVE (`run.ts:1622`), in `fastFillSection` (`run.ts:1301,1373`), in login and wizard entry (`run.ts:460,650`), and from submission via `waitForCaptcha` (`run.ts:2278`). So a CAPTCHA can be met on any navigation, and it blocks the run: `captchaGuard` doesn't return until it's solved, times out (`WorkingHolidayStop`, `run.ts:330-334`), or is cancelled.
- Handling: `assertSiteAvailable` runs first. Then, in provider modes, a `readCaptchaChallenge` sitekey read and a solve via CapSolver, 2Captcha or AutoCaptcha run in the background while a 200 ms `driver.wait` loop watches for human completion. Human completion always wins and aborts the provider (`run.ts:233-247`, test "human completion cancels an in-flight solve"). Only the CAPTCHA page's own Submit is clicked, once per response (`captchaSubmitCandidate`, `run.ts:144-177`; tests at `captcha.test.ts:145,168`). A token is cleared after 10 s if not accepted and never retried (`run.ts:300-305`; test `captcha.test.ts:297`). Time spent here extends the surrounding wait's deadline (`run.ts:354`; test `captcha.test.ts:66`).
- Fixture `scripts/fixtures/captcha.html` is a standalone page that POSTs to a captcha endpoint. That matches an interstitial page, not an inline widget on the section form.

The "every tab is blocked" claim: not provable from code. Nothing in the code or tests involves a second tab. All tests mock one driver. Detection by pathname is consistent with a server redirect that gates the session. If so, a request from any tab would land on the CAPTCHA page until it's solved. But it could equally be issued per request or per page. Also not verifiable: whether solving in one tab clears the gate for the others, whether a solved state has a lifetime, and what triggers it (request rate, time, IP). All of these are **assumptions, live check needed.**

Interaction with multiple tabs, from the code:

- `captchaGuard` uses `driver` state (current window) and fixes `challenge.websiteURL` from that tab. A provider token is injected into that tab only (`applyCaptchaToken`). If the driver switches tabs mid-wait, `captchaPending` would read the other tab, and the guard could wrongly return "solved".
- The provider spend is per call. N tabs each meeting the challenge would start N paid solves, and N human prompts (`emit captcha waiting`).
- Manual path: one `notify` per guard. The user solves in whichever tab is in front. `activateChrome` at `run.ts:199` brings the guarded tab forward.

Proposal if gating holds (applies to A and B):

1. One global CAPTCHA mutex. The first tab that detects the challenge owns the guard. Every other tab's worker parks before its next command and never navigates or POSTs while the mutex is held.
2. The owner runs today's `captchaGuard` unchanged, with the driver pinned to its window for the whole wait.
3. On completion, the others resume. Each one re-runs `captchaPending` on its own tab. If its tab is on a CAPTCHA page, reload its section URL with a GET. Never re-POST: if that tab had a SAVE in flight, treat it as `risk` and read it back.
4. Avoid triggering it: limit in-flight requests per session (1 POST + at most 1 GET), and don't burst at section start.

## 5. Comparison

| | Sequential (today) | Hybrid (recommended) | Option A | Option B |
|---|---|---|---|---|
| Expected time saved | baseline | about 1 GET per section (verification reload hidden behind next GET), if not serialized | about min(POST, next GET) per section, if not serialized | up to about (n−1) sections of server time, if not serialized; 0 if serialized |
| Implementation complexity | — | moderate: second tab, window switching, per-section verify queue | high: per-tab state, per-section `risk`, deferred `[errorlabel]`, CAPTCHA mutex | very high: multi-session or CDP, per-tab context, mutex, budget sharing |
| Failed or duplicate submission risk | lowest; no re-POST paths | same as today: POSTs stay serial, the second tab only does GETs | moderate: recovery while 2 sections are in flight | high: N in-flight POSTs, shared recovery budget |
| CAPTCHA exposure | 1 tab | 2 tabs, only GETs in the second | 2 tabs, POST in flight | N tabs; N solves possible |
| Code evidence against | none | session lock unknown | session lock unknown; global `risk` | personal→adviser order; global `risk`; one driver |

## 6. Recommendation

1. Measure first (no code change). Run a live section set with the existing timing log (`run.ts:1705`). Record `save`/`verify` ms and the load gaps. In devtools, open the next section URL in a second tab while a SAVE is in flight, and check whether it returns in parallel or after the POST. This decides everything below.
2. If concurrent same-session GETs aren't serialized, implement the hybrid:
   - Keep fill → `captchaGuard` → SAVE → `waitForPostback` → `[errorlabel]` exactly as now, in tab 1. Every safety check stays. Only one POST is in flight at any time.
   - Right after `[errorlabel]` passes, start the GET for section N+1 in tab 1. At the same time, start the verification GET of section N in tab 2 with a non-blocking `executeScript('location.href=…')`. Read tab 2's values with `readFieldValues` once its document is ready. Mismatch handling stays as today: `SavedValueVerificationError` → unverified, no re-SAVE (`run.ts:2195-2208`). That's why deferring it is safe, since the outcome is the same as now.
   - Do the remaining verification before `finishApplication`, so nothing is submitted with an unverified section unreported.
   - Make `risk` per section and add the CAPTCHA mutex (section 4). Don't run the country-popup closer (`run.ts:547-560`) while tab 2 exists. Spawn Chrome with the existing anti-throttling flags. In attach mode, fall back to sequential.
3. If they are serialized, don't pursue A or B. Remaining options: cut AutoPostBack round trips and load tails (phase-2 early fill, already designed), and reduce CAPTCHA time (prefer provider mode, keep the human-wins race).
4. Don't do Option B. The proven personal → adviser order, the single-session serialization and the shared recovery budget give it the worst risk-to-gain ratio. Option A adds a second in-flight request on top of the hybrid with little extra gain once fill is under 50 ms.

Main risks and mitigations:
- Stale verification read (tab 2 reads before commit): start tab 2's GET only after `waitForPostback` and `[errorlabel]` pass. That's the same ordering point as today's reload.
- Session or access-denied from the second request: on the first busy or denied response in tab 2, close tab 2 and switch back to sequential for the rest of the run.
- CAPTCHA in tab 2: the mutex parks tab 1, the guard runs in tab 2, then tab 1 re-checks.
- Kill switch: an env flag like `NZWH_FAST_FILL`, read once per run.

## 7. Open questions needing live testing

- Does the server serialize concurrent requests in one session (ASP.NET session lock)? Measure GET-during-POST latency.
- Does a GET of section N started right after the SAVE response always reflect the committed save (no async commit)?
- Is `Agent.aspx` reachable before `representedByAdviser=Yes` is saved? Are any later pages blocked until earlier ones are saved?
- Does concurrent traffic trigger "Please try again later", the access-denied redirect, or CAPTCHA?
- Is the CAPTCHA gate per session, per request or per IP? Does solving it in one tab clear other tabs? How long does a solved state last?
- Real DCL→load gaps and server times per section, from the existing timing log, to size every estimate above.
