# Access-denied redirect: investigation and recovery design

Read-only investigation. No source edited. `.env` not read. Public page fetched once (GET, no application data sent).
Labels: **CONFIRMED** = established by reading the code. **UNKNOWN** = needs the live site.

## 1. Summary

- The target is `https://www.immigration.govt.nz/formshelp/access-denied`. It is on the marketing host `www.immigration.govt.nz`, not the application origin `onlineservices.immigration.govt.nz`. It is a static INZ page (title "Access denied"), not a WAF block page. The text I fetched says: "Sorry, but you've been denied access to this page." Listed reasons are: session timed out, no permission for the page, cookies disabled. It advises closing all browser windows and logging in again. I saw no reference ID and no Back link in the extracted text. Raw HTML was not inspected, so a link could exist.
- So it is an application-level session/permission/cookie redirect. It is not proof of rate limiting. Whether the app or a WAF issues the redirect, and what triggers it, is **UNKNOWN**.
- Today the run does not recover. It wastes time and usually ends with a misleading error:
  - `waitForSection` and `locateField` spin the full 20 s `SECTION_WAIT_MS` on a page with no fields (CONFIRMED).
  - `waitForPostback` spins 30 s, then raises `SectionPostbackTimeoutError`. Its handler then calls `assertHost`, which throws "Stopped at an unexpected destination" and ends the run (CONFIRMED).
  - `isSiteBusy`-style checks do not match, because the page has no "please try again later" text.
- Recommended strategy (section 4): detect by hostless pathname match inside the existing `assertSiteAvailable`, which is already called on every `captchaGuard` poll. Throw a dedicated `AccessDeniedError`. The section loop then does a bounded, verify-first recovery:
  - Not risky (`context.risk === false`): GET the section URL again. If the wizard loads, re-enter the section. If a login form shows, use the existing one-shot `SessionExpiredError` re-auth path.
  - Risky (a possible or accepted save existed): never refill and never re-click SAVE. GET the section URL, read back the saved values (read-only), and treat the result with the existing verified or unverified handling.
  - Submission and payment: never retry. This is already the behavior and must stay.
  - After a bounded number of attempts, stop with a PII-free message.

## 2. Evidence: current code

### 2.1 Where the existing waits pass through one choke point (CONFIRMED)

`workflow/site-busy.ts` is 16 lines. `assertSiteAvailable(driver)` runs one `executeScript` that tests `document.title` for "site busy" and `body.innerText` for a line "please try again later". It returns a boolean and throws `SiteBusyError`.

Call sites:
- `captchaGuard` (run.ts), at the top of every call and again on every 200 ms poll inside the CAPTCHA `driver.wait`.
- `finishApplication`'s `ready` callback (run.ts, in `executeWorkingHoliday`): after the `driver.wait` for `readyState` on Submit/Declaration pages.

`captchaGuard` is called by `waitWithCaptcha` on every iteration. `waitWithCaptcha` is used by `ready`, `waitForSection`, `locateField`, `waitForPostback`, `lookupClickAndWait`, `waitForResults`, the fast-fill `waitFor`, `authenticate`, `selectCountry`, `clickApplyNow` and `advanceToWizard`. `fastFillSection` also calls `captchaGuard` before every `fillSegment`.

So one check inside `assertSiteAvailable` covers almost every wait, at no extra round trip if folded into the same script. It runs on the first iteration, before the condition. Detection is prompt, with no fixed delay.

Gaps where no guard runs:
- `waitForChange` in submission (`driver.wait(condition, SUBMISSION_CHANGE_WAIT_MS)`). Its condition compares `next.url !== page.url`, so a redirect satisfies it immediately.
- Raw `driver.executeScript` reads in `saveStep`: the unmapped-field scan, the `[errorlabel]` validation scan, and `readFieldValues`.
- The 200 ms sleeps in the country-closed loops.

### 2.2 Test seam

`workflow/captcha.test.ts` `fixture()` makes `executeScript` return `busy` for any script that is not a CAPTCHA or readyState script. The test "site-busy responses are not mistaken for solved CAPTCHAs" returns `true` and expects `SiteBusyError`.

If the detection script's return type changes, `true` must keep meaning busy. A string-or-boolean result, or a separate second script, are both safe. A second script adds a round trip per poll and breaks the fixture's call counts, such as the readyState count of 3 in "a disappearing challenge waits...". Folding it into the existing script is preferred.

### 2.3 URL and origin handling (CONFIRMED)

- `origin` is a module `let`. The test hook `setFixtureOriginForTest` restricts it to `127.0.0.1`.
- `assertHost(url)` throws `WorkingHolidayStop("Stopped at an unexpected destination.")` if `new URL(url).origin !== origin`. The access-denied page is on another host, so any `assertHost(getCurrentUrl())` after the redirect fails.
- `classifyUrl`/`classifyPage` (page-state.ts) return `"other"` for foreign origins.
- `navigate()` accepts a navigation timeout only when the page is same origin and recognised. The denied page is neither, so it rethrows the timeout.
- Because the host differs, the check must be pathname-based and host-agnostic. A hardcoded host would not be testable against the `127.0.0.1` fixtures. Matching `/formshelp/access-denied` as the pathname suffix, case-insensitive with an optional trailing slash, works for both. Matching only the title or body text risks false positives on applicant pages. I would use text only as a secondary signal.

### 2.4 Fast-fill predicates that read the page (CONFIRMED)

`workflow/fast-fill.ts`:
- `fillSegment` returns `timeOrigin: performance.timeOrigin`. On a denied page the fields are missing, so the script returns `stop: missing` with a new `timeOrigin`.
- `fastFillSection` then runs `if (out.timeOrigin !== stamp) await unexpectedReload()` (run.ts). `unexpectedReload()` emits `persistence: possible` and throws "Form reloaded unexpectedly while filling; stopped before SAVE."
- That sets `context.risk = true` even if nothing was posted. The redirect check must therefore run before `unexpectedReload` and before the `isNavigationError` path, so that a denied redirect before any POST keeps `risk === false`.
- `fieldPresent`, `fieldAvailable` and `readFieldValues` are pure reads. They return false or null on a denied page, and `waitFor` hits the guard first.
- `isNavigationError` matches "document unloaded" and similar. A redirect mid-script produces this error, and that is a likely path.

### 2.5 Save and unverified-state handling (CONFIRMED)

- `emit()` sets `context.risk = true` for any `persistence` event whose state is not `verified`. `risk` is reset to `false` at each `section-start` (section loop).
- `postbackAndWait` emits `possible` before the SAVE key press. `legacyFillField` emits `possible` before a changed posting field. `saveStep` emits `accepted` after the postback lands, then reloads and verifies.
- `SectionPostbackTimeoutError`: the section loop confirms that the URL is still on the same page and application. It pushes the section into `unverifiedSections`, emits `section-result failed` ("no resend"), and continues to the next section. `finishApplication` receives `filled: false`, so submission is blocked.
- `SavedValueVerificationError`: same shape. The section goes to unverified, there is no replay, and the loop continues.
- `SiteBusyError`: the section goes to `skippedBusy`, its entry in `saved` is deleted, `coverage-busy.json` is rewritten, and the loop moves on. No retry.
- `ExecutionController.event()`: `section-result` with status `failed` and persistence `accepted` becomes `saved_unverified`. `checkpoint()` returns early while a section is `running` or `waiting_captcha`. So stop/pause is not honoured inside a section by `checkpoint`. Stop inside a section arrives through `signal.aborted`, checked by `captchaGuard` and `checkCancelled()`. Recovery code therefore must check `signal` itself, and its backoff sleep must be abortable.
- Session expiry path (section loop catch): if `readAuthState().loginForm` or `SessionExpiredError`, it stops when `risk` is true ("Phiên đăng nhập hết hạn sau thao tác có thể lưu dữ liệu. Không tự điền lại."). Otherwise it re-authenticates once (`recoveredSession` flag) and checks that the same ApplicationId is still listed via `editHyperLink`. A second expiry stops. This is the existing precedent. The new recovery should reuse it, not duplicate it.

### 2.6 Resume and re-entry (CONFIRMED)

The section loop is `while (true) { try { build url; if getCurrentUrl() !== url navigate; waitForSection; verify path + ApplicationId; saveStep; ... break } catch {...} }`. A `continue` re-enters the same section: it navigates to the section URL if needed and refills from scratch. This is safe only when no POST may have landed, which is the same condition the session path uses (`!risk`).

`advanceToWizard` (pre-wizard state machine, up to 200 passes) already self-heals from an unknown page: `currentState` is `"other"`, so it falls into the final `else` and runs `navigate(home)`. It also has a `loggedIn` one-shot for login. Only the new guard throw would need to be caught there and turned into a bounded `continue`.

### 2.7 Submission (CONFIRMED)

`finishApplication` never retries. All errors except `StopRequested` are caught and return `incomplete` with the message "Không tự nộp lại". `readSubmissionPage` marks `scoped=false`, so `stage="other"`, when the origin differs or the path does not match, and the loop `break`s. A denied redirect after the final Submit click therefore yields `incomplete`, never a second click. `submitting()` is emitted before the click, so persistence and submission state stay "unconfirmed". The payer form and payment steps follow the same single-click, no-retry rule.

## 3. Per-point analysis: how the redirect can appear

None of the triggers can be confirmed without the live site. The code facts below say what the automation does today and what the server may have applied.

| Point | Today's behavior (CONFIRMED) | Server state | Trigger |
|---|---|---|---|
| Login (`authenticate`) | `waitWithCaptcha` for username field spins 20 s, then generic Stop | No data yet; nothing to corrupt. Cookies/session may be cleared | UNKNOWN |
| Home / country grid (`selectCountry`, `advanceToWizard`) | `currentState` is `other` and `navigate(home)` heals it. A guard throw would break that unless caught | No application data | UNKNOWN |
| Create / APPLY NOW (`clickApplyNow`) | Wait for state `!== create` is satisfied by `other`; the next loop pass heals via `navigate(home)`. APPLY NOW may have created a draft | Draft may exist (a draft may already be created) | UNKNOWN |
| Section GET (`navigate` + `waitForSection`) | 20 s spin, then misleading Stop | Nothing applied by a GET | UNKNOWN (session expiry plausible) |
| Field fill (non-posting) | `timeOrigin` change gives `unexpectedReload`, so `possible` is emitted and `risk` is set | Nothing saved: plain inputs do not hit the server until SAVE | UNKNOWN |
| Field fill (posting / AutoPostBack, `legacyFillField`) | `possible` emitted first, then `waitForPostback` 30 s, then `SectionPostbackTimeoutError`, then `assertHost` Stop | A postback may have been applied | UNKNOWN |
| SAVE (POST) | Same as above | May or may not have been applied; the response was lost | UNKNOWN |
| Verification reload (`navigate(url)` after `accepted`) | `waitForSection` 20 s spin, generic Stop; controller marks `saved_unverified` because persistence was `accepted` | SAVE was accepted; only verification is missing | UNKNOWN |
| CAPTCHA wait (manual or provider) | Guard is polled every 200 ms. A denied page makes `captchaPending` false, so the wait "completes" with `completed=true`. The caller then spins as in the GET case | The CAPTCHA is not a data POST. A provider token is lost | UNKNOWN |
| CAPTCHA-only Submit click | Result of the click is read as a page change | The CAPTCHA submit may have been accepted | UNKNOWN |
| Declarations page | `readSubmissionPage` gives `stage: other`, so `incomplete` | Declaration ticks are client-side until Submit | UNKNOWN |
| Final Submit | `incomplete`, no re-click | Submission may or may not have been received | UNKNOWN |
| Pay Now / Secure Payment / payer name OK | `incomplete`, no re-click | Payment not made by this tool; navigation was one-shot | UNKNOWN |
| Session expiry | Existing login-form path, if the app redirects to login. Denied appears to be an alternative result for the same cause (the page lists "session timed-out") | Same as above | UNKNOWN |

What is CONFIRMED by the page text only: the app lists session timeout, missing permission, and cookies off as reasons. Everything about which point triggers it is UNKNOWN. The analysis assumes the worst case at every POST point: the POST may have been applied.

Possible cause linked to this project (hypothesis, UNKNOWN): the fast-fill and early-fill phases produce many fewer, faster actions, which an anti-automation rule could treat differently. Polling is client-side `executeScript`, which sends no site requests, so poll rate itself does not load the site.

## 4. Recovery strategy

### 4.1 Options compared

| Option | Safe? | Cost | Verdict |
|---|---|---|---|
| A. Navigate back to the section URL (GET), read-only verify before any refill | Yes. A GET is idempotent. Verification uses the existing `readFieldValues` | A few seconds | Chosen as the first step |
| B. Re-login (`authenticate`) | Safe when no POST is possible (`risk` false); the session precedent already does this once | Slow (logout, login, home, list check) and may meet CAPTCHA or lock rules | Fallback only, when step A lands on a login form |
| C. Restart the section (refill and SAVE) | Only safe if no POST may have landed. Otherwise it can duplicate or overwrite a save | Cheap | Only when `risk === false`, which is the same rule as the session path |
| D. Stop | Always safe | Loses all remaining work | Final result after the retry limit, or on a risky state that cannot be verified |

Why this order: it matches the project's established rule ("do not replay what may have been applied"). It adds the cheapest safe step, a GET, before the expensive one, a re-login. It also reuses the session path instead of inventing a second one.

The page advice "close all browser windows" must not be followed. In attach mode the Chrome belongs to the user (`chooseBrowser` documents that only a Chrome we spawned is ever stopped).

### 4.2 Algorithm (in the section loop's `catch`, before the generic failure)

On `AccessDeniedError`:
1. If `StopRequested` or `signal.aborted`, rethrow. Do this first.
2. `attempt++`. If `attempt > MAX_ACCESS_DENIED_RECOVERIES`, stop with a fixed message (see 4.3).
3. Abortable backoff: `ACCESS_DENIED_BACKOFF_MS[attempt - 1]`. Use the `sleep` helper plus a `signal` check, in short slices, like the 200 ms loops used by the country wait.
4. Navigate to the section URL built from `applicationPage` (query string never logged). Wait with the normal `waitForSection`. If it throws `AccessDeniedError` again, loop to step 2. If it throws `SessionExpiredError` or shows `loginForm`, fall into the existing session path, which stops when `risk` is true and re-authenticates once otherwise. The two recovery budgets stay separate.
5. If the wizard section loads:
   - `risk === false`: `continue` the while loop. The section is refilled from the start. Nothing was posted, so refilling is safe and idempotent.
   - `risk === true`: do not refill. Run a read-only verification with `readFieldValues` and `expectedFieldValue`. All values match: emit `persistence: verified`, record the section as completed, and move on. Any mismatch or missing field: handle it as `SavedValueVerificationError` does (unverified, no SAVE replay, next section). If the server could not be reached or the page is not the pinned section, stop. Mismatch cannot prove the save did not land (a response may still be in flight), so no automatic SAVE is made.
6. Count attempts per run, not per section, so a persistent block cannot be retried 3 times per section. Suggested: one counter for the whole run plus a per-section cap.

Never replayed under any outcome: SAVE, a changed posting field, the CAPTCHA-only Submit, declaration Submit, Pay Now, Secure Payment, payer OK. The existing `finishApplication` handling already guarantees the last four. Access-denied inside submission becomes `incomplete` with the standard message. Do not add a retry there.

Special cases:
- Pre-wizard states (`advanceToWizard`, `selectCountry`): catch the error and loop again (the existing `navigate(home)` path heals), counting against the same budget.
- `authenticate` redirect: a login-stage redirect counts as one attempt and restarts `authenticate` once. Credentials come from the existing store; no logging of them.
- CAPTCHA wait: `captchaGuard`'s `finally` already emits `captcha waiting:false` and aborts the provider attempt. The token is lost. After recovery the CAPTCHA state is re-read from scratch. A provider is not asked for a second token unless the page presents a new challenge, which is the existing behavior of `captchaGuard`. In manual mode the user is simply shown the CAPTCHA again. In attach mode nothing is closed and the same tab (`handles[0]`) is reused.
- Verification reload (state `accepted`): this is the highest-value case. The save was accepted, so a read-only verify completes the section without any refill.

### 4.3 Constants (new, named, in `fast-fill.ts` next to the other waits, or in `site-busy.ts`)

```ts
/** Recovery attempts per run after an access-denied redirect. */
export const MAX_ACCESS_DENIED_RECOVERIES = 2;
/** Pause before each recovery attempt (index = attempt - 1). */
export const ACCESS_DENIED_BACKOFF_MS = [2000, 5000] as const;
/** Limit for the section to load again after recovery (reuses SECTION_WAIT_MS). */
```

Values are suggestions. They match the existing `searchWithRetry` backoff `[2000, 5000]`. Keep the total recovery wait under about 10 s so recovery does not cost more than a manual reload.

Failure message, constant and PII-free: `"Access denied by the immigration site; recovery limit reached. Save state may be unverified. Check Chrome and the saved data before restarting."`

## 5. Events and logs

- Reuse `ExecutionEvent` kinds, so no change to `lib/execution-state.ts` is needed:
  - `{ type: "phase", phase: "recovery", message }` on detection and on each action. `phase` is a free string. Note `ExecutionController.event` writes `phase` and `message` into the job, which overwrites the section message, so restore it with a `section` phase on success, as the session path implicitly does.
  - `persistence` events already express possible, accepted and verified. A verified result after read-back uses the existing `verified`.
  - `section-result failed` with `detail` for the unverified outcome, matching the busy and timeout wording.
- If separate observability is wanted, add one variant, such as `{ type: "recovery"; kind: "access-denied"; action: "detected" | "reload" | "verify" | "reauth" | "gave-up" | "recovered"; attempt: number }`. It would touch `lib/execution-state.ts` and the controller's `event()` switch, and all existing tests that enumerate events. The `phase` reuse is smaller.
- Logs (`console.log`, line style `[NZWH] ...`):
  - Allowed content: section name, attempt number, action name, elapsed ms, and the pathname `/formshelp/access-denied`.
  - Forbidden: URLs with query strings (section URLs contain `ApplicationId=...`), cookies, tokens, field values, applicant text, page text. Do not log `getCurrentUrl()` raw. Note `console.log` at "Reached ${getCurrentUrl()}" in `selectCountry` already prints a query string; do not copy that pattern.
  - Use `quiet()` for routine per-attempt lines, and plain `console.log` for milestones (detected, recovered, gave up), following `log-stamp.ts`.
- Control: an environment kill switch matching `NZWH_FAST_FILL`, for example `NZWH_ACCESS_DENIED_RECOVERY=0` (disabled means detect and stop immediately with the clear message). It should be read once per run like `fastEntrySnapshot`.

## 6. Code locations to change

1. `workflow/site-busy.ts`
   - Add `AccessDeniedError extends WorkingHolidayStop` (fixed, PII-free message). It must not extend `SiteBusyError`, because the section loop's busy branch would swallow it.
   - Extend `assertSiteAvailable`'s script to return a discriminated value: `'busy'`, `'denied'`, or `false`. Treat `true` as busy for compatibility with the fixtures. The denied test uses `location.pathname` only.
2. `workflow/run.ts`
   - Section loop `catch`: add an `AccessDeniedError` branch after `StopRequested` and before the busy, timeout and generic branches. It implements 4.2, reusing `recoveredSession` logic, `SessionExpiredError`, `readFieldValues` and the unverified bookkeeping.
   - `fastFillSection`: check for denied before `unexpectedReload()` in the `out.timeOrigin !== stamp` path, the `waitFor` post-check, `recheck`, and the `isNavigationError` catch. Otherwise `risk` is set wrongly.
   - `postbackAndWait` / `SectionPostbackTimeoutError` branch and the busy branch: they call `assertHost`, which throws on the foreign host. The denied branch must come earlier.
   - `advanceToWizard` and `selectCountry`: catch the error, count it, and continue (navigate home).
   - `executeWorkingHoliday`: pass the budget through, and make the final `finishApplication` result mention unverified sections as it does now.
   - `finishApplication`'s `ready` callback: already covered by the shared check. No retry.
3. `workflow/submission.ts`: no behavior change. Optional: add a test that a denied page after a click gives `incomplete` with no second click.
4. `workflow/fast-fill.ts`: place the new constants here. No script changes needed.
5. Docs: `.agents/tasks/form-fill-speedup-report.md` section as requested in the task.

## 7. Tests to add

Mocked WebDriver, same style as `workflow/captcha.test.ts` (`fixture()` with `executeScript`/`wait` mocks and fake timers). Place in a new `workflow/access-denied.test.ts` and `workflow/fast-fill-run.test.ts` where the section loop is already driven.

Detection:
- `assertSiteAvailable` throws `AccessDeniedError` for pathname `/formshelp/access-denied` on any host, with and without trailing slash and query string, and for different letter case.
- It does not trigger for applicant pages, or for a page that merely contains "access denied" in body text.
- `true` return still gives `SiteBusyError`.
- `captchaGuard` and `waitWithCaptcha` throw it on the first poll without running the condition and without a 20 s wait (use fake timers to assert no timer advance).
- Run the real detector script via `runInNewContext`, as the CAPTCHA detection tests do.

Recovery paths (section loop with mocked driver and hooks via `withHooksForTest`):
- Denied before any POST (`risk` false): GET reload, then re-enter, then section completes. Assert one SAVE click only.
- Denied after `possible`: reload, read-only verify matches, then `verified` emitted, with no extra fill or SAVE call (count `fillSegment` and click calls).
- Denied after `accepted` (verification reload): same, verified without SAVE replay.
- Verify mismatch: section is marked unverified, `filled` is false, SAVE not replayed, next section continues.
- Denied then login form: `risk` false re-authenticates once; `risk` true stops with the existing session message.
- Denied inside fast-fill: `risk` stays false and `unexpectedReload` is not used (assert no `possible` event).
- `AccessDeniedError` inside `SectionPostbackTimeoutError` handling: no `assertHost` crash.

Limits and control:
- Retry limit: denied on every attempt stops after `MAX_ACCESS_DENIED_RECOVERIES` with the fixed message. Use fake timers to assert the backoff values.
- Stop and cancel: `signal.abort()` during backoff and during recovery navigation throws `StopRequested` promptly. No further driver calls are made after abort.
- Kill switch off: stops immediately.
- Submission: denied after the final Submit click gives `incomplete`, and `button.click` is called once. Same for Pay Now and payer OK.
- CAPTCHA: denied during a manual wait, and during provider mode. Assert `captcha waiting:false` is emitted and the provider attempt is aborted.
- No PII: capture `console.log`/`warn`/`error` and emitted events. Run with applicant data and URLs that contain `ApplicationId=SECRET123` and a token query. Assert none of those substrings, nor any field value, appear.

Real headless Chrome, in `workflow/fast-fill-browser.test.ts` style (local `127.0.0.1` server):
- Serve a section page whose script does `location.replace('/formshelp/access-denied')` after a delay, and assert that detection fires through `waitWithCaptcha` while `readyState` is still loading, and mid-`fillSegment` (the navigation-error path).
- Serve a flow: denied once, then the section page. Assert recovery re-enters and verifies via `readFieldValues`.
- Redirect after a form POST handler on the fixture server: confirm the `timeOrigin` change does not lead to a `possible` event when nothing was posted.

## 8. What cannot be confirmed without the live site

- What triggers the redirect (session timeout, permission rule, cookies, WAF or rate rule, automation detection) and at which of the points in section 3.
- Whether the redirect is a server-side 302 or a client-side script, and whether `driver.get()` or a click returns normally.
- Whether the session survives it. The page says to log in again, which suggests the session is gone or invalid. This decides how often step B (re-login) is needed.
- Whether a SAVE POST that ended in the redirect was applied, and whether a late response can still be applied after the redirect. This is why the strategy never replays.
- Whether cookies set on `onlineservices` are visible after visiting `www`, and whether the page contains a Back or Login link, a reference ID, or different markup than the extracted text shows.
- Whether the redirect appears as a title/body variant (e.g. other `/formshelp/*` error pages such as `/formshelp/error`, which exists with its own text) that deserves the same handling. I recommend only the `access-denied` path for now; other pages stay out of scope.
- Real timings of recovery, and how often it recurs. Any time-saving estimate is a design estimate, not a measurement.

## 9. Recommendation

Implement the detection inside `assertSiteAvailable`, a dedicated `AccessDeniedError`, and one new `catch` branch in the section loop with the verify-first, bounded recovery in 4.2. Reuse `risk`, `SessionExpiredError`, and the unverified-section bookkeeping. Add the constants, the `phase`-based events, and the tests in section 7. Keep submission and payment untouched.
