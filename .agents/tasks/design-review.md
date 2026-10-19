# Design review (iteration 3): fast-fill for NZ Working Holiday wizard sections

Reviewed: `.agents/tasks/design.md` (third iteration) against `workflow/run.ts` (captchaGuard, waitWithCaptcha, ready, navigate, setField, waitForSection, remoteTrigger, locateField, postbackAndWait, waitForPostback, saveStep, fillAndSaveWorkingHolidaySection, executeWorkingHoliday section loop and finishApplication options), `workflow/captcha.test.ts` (full), `workflow/submission.ts`, `workflow/payer-form.ts`, `workflow/fields.ts`, `workflow/conditions.ts`, `workflow/site-busy.ts`, `lib/execution-controller.ts`, `browser/chooseBrowser.ts`, `node_modules/selenium-webdriver/{package.json,lib/http.js,lib/atoms/}`, and `git log`/`git status`. No builds or tests were run.

Verdict: **CHANGES_REQUESTED** (2 HIGH, 2 MEDIUM, 2 NIT).

All eight iteration-2 findings are addressed correctly. I checked the CAPTCHA boolean form against the fixture, the post-SAVE settle, the authoritative pass, `waitForChangeThenLoad` across all four click sites, the nav watch prefix, Select2 normalization, the test-local controller table, and the helper signatures. The remaining problems are all about the claim "no decision taken at DOMContentLoaded is final". It holds for values and visibility. It does not hold for event delivery, and it does not hold for documents reached through a postback inside the authoritative pass.

---

## Findings

### 1. HIGH: Events the early pass dispatches before the page binds its handlers are lost, and the authoritative pass never replays them (B5 orchestration, B6, B12)

Where: B5, where the early pass writes at DOMContentLoaded and the authoritative pass marks a field `unchanged` when `e.value === expected` ("no events, no postback"). Also B6 "Client-side dependents" and "Late page scripts", and the B12 row "Whether any field's visibility, value or existence changes at `load`".

Problem: the authoritative pass re-checks values and availability on the settled DOM. It never re-checks whether the page's handlers saw the change. Handlers bound after the early write never receive it. That includes `window.onload`, `$(window).on('load')`, jQuery 3's async `$(fn)` (which runs in a task after DOMContentLoaded), and widget init at `load`. Those fields then read `unchanged`, so nothing is ever dispatched to them:

- (a) A client-side dependent, for example a `title` change handler bound at `load` that reveals `otherTitle`, is never revealed. The authoritative pass then stops with `Required conditional field unavailable`. Today the same data succeeds.
- (b) An AutoPostBack handler bound at `load` (jQuery `change` → `__doPostBack`) is invisible to `REMOTE_TRIGGER` at DOMContentLoaded. The field is fast-filled with no listener. After `load` it is `unchanged`, so the authoritative pass never asks whether it posts. The server-side postback that happens today **never happens**. Branch fields the server would render never appear, so the unmapped-field gate can't see them, and SAVE posts a form the server never re-rendered. That silently weakens today's AutoPostBack and unmapped-field safety.
- (c) A cascading client-side select whose options are filled by a controller handler bound at `load` gets `option-missing`, and legacy throws `Option no longer exists.`. Today it works.

B12 does not list handler-binding timing as unverified, and no fixture covers it. Fixtures 12 and 17 cover value and visibility changes only.

Fix (choice: replay every early write on the settled DOM; no handler fingerprinting, because delegated handlers can't be fingerprinted reliably):

1. In `FILL_SEGMENT_JS`, when `deferClears` is true (early pass) and a field is written, record its pre-write value in the page only: `(window.__nzwhEarly ||= {})[id] = previousValue`. The value is never returned to Node or logged. The result contract is unchanged.
2. Add `restoreEarly` as a fourth `FILL_SEGMENT_JS` argument (true only in the authoritative pass). Before any decision on an entry, if `window.__nzwhEarly` has its id, set the recorded value back with the native setter and **no events**, then delete the record. The entry then goes through today's decision order on the settled DOM. `current !== expected`, so `REMOTE_TRIGGER` is evaluated against the handlers bound now. A posting field goes to `legacyFillField` (stamp → UI `setField` → awaited postback), exactly as today. A non-posting field is written with events that the now-bound handlers receive.
3. Every early-written field is therefore written again, so `p.wrote` is true and the second settle runs. Cost: one more fill RT plus about 2 × `FAST_POLL_MS`. State this in B11.
4. Add `&& (typeof jQuery === 'undefined' || jQuery.isReady === true)` to `SECTION_DOM_READY_JS`, so the early pass doesn't start before jQuery's ready handlers have run.
5. Tests: fixture A, where a `title` `change` handler bound in `window.onload` reveals `otherTitle`: it gets filled and the server receives it. Fixture B, where `$(window).on('load', () => $('#x').on('change', () => __doPostBack('x','')))`: the postback happens through legacy, `possible` is emitted before it, and the re-rendered dependent is filled. Unit test: with `restoreEarly`, an early-written id is restored without events and reported `filled`, not `unchanged`. Add a B12 row: "Whether handlers are bound after DOMContentLoaded. Degradation: every early write is replayed on the settled DOM."

### 2. HIGH: A document reached by a postback inside the authoritative pass is decided at DOMContentLoaded, so the "no decision at DCL is final" invariant breaks (B5 orchestration, B6)

Where: B5 `runPass` `'posting' | 'fallback'`: `legacyFillField(...)` → `stamp = await readTimeOrigin(driver); wrote = true; index = i + 1`. The legacy postback uses the fast `waitForPostback`, which returns at DOMContentLoaded of the new document. Then step (4) `if (p.wrote) settle()` → step (5) `reverify()`.

Problem: when the authoritative pass hits a posting field, the server returns a **new document**. The rest of the pass (`i + 1 … end`) runs on that document at DOMContentLoaded. The second settle only waits; it doesn't re-run the pass. On that document, every DCL-time problem the authoritative pass was introduced to remove comes back:

- A field hidden at DOMContentLoaded and shown at `load` with `expected === ""` (or not applicable) is `skipped-unavailable` and never revisited. Clear deferral applies only to the early pass. Today that field is evaluated after `load` and cleared. The stale value is then saved silently, and it isn't in `report.filled`, so neither verification catches it.
- A `load`-time value reset on that document fails `reverify()` with `Readback mismatch`. Today that run succeeds.
- Finding 1's lost-event problem applies to that document too.

This path is the normal case, not an edge case. Any posting field whose value differs after the early pass reaches it. That includes every posting field on a first fill, because the early pass's legacy postback produces a new document that the authoritative pass sees as `unchanged`, but a second posting field later in the section does not.

Fix: in the authoritative pass, a new document always restarts the authoritative pass on the settled DOM.

```
// runPass('authoritative'), 'posting' | 'fallback' branch:
await legacyFillField(driver, name, entry.key, data, report, true)
const next = await readTimeOrigin(driver)
if (next !== stamp) { stamp = next; return 'postback' }   // expected new document; not counted as unexpected
wrote = true; index = i + 1

// outer loop, replacing (3)-(4):
auth: while (true) {
  p = await runPass('authoritative')
  if (p === 'reloaded') { await onReload(); continue fill }
  if (p === 'postback') {
    if (++postbacks > entries.length) throw new WorkingHolidayStop("Form reloaded repeatedly while filling; stopped.")
    if ((await settle()) === 'reloaded') { await onReload(); continue fill }
    continue auth                       // report.filled is reset by runPass; the posting field is now 'unchanged'
  }
  if (p.wrote && (await settle()) === 'reloaded') { await onReload(); continue fill }
  break
}
```

Termination: each restart follows a successful legacy readback. That field is `unchanged` on the next run, so each posting entry triggers at most one restart. The `entries.length` cap guards against a server that keeps resetting. Update B11: each AutoPostBack field changed in the authoritative pass now costs one load tail; it is no longer saved. Add fixture C: two posting selects, and the second one's response page has a field shown in `window.onload` with `expected === ""` and a non-empty current value. Expect it to be cleared after `load` and the server to receive `""`. Add fixture D: the same response page with an `onload` reset of a later field. Expect it to be rewritten, with no `Readback mismatch`.

### 3. MEDIUM: The early pass sends server postbacks before the first document's `load` handlers have run (B5 `runPass` early, B11)

Where: B5 `'posting' | 'fallback'` → `legacyFillField` runs in **both** passes. In the early pass this happens at DOMContentLoaded of the section's first document.

Problem: today every AutoPostBack happens after `load`. If `load` scripts set hidden inputs or other form state, the server then receives that state. Examples: client-state hidden fields, widget-backed hidden values, and Select2 init that normalizes the native select. Some may also have AJAX in flight. An early-pass postback POSTs before any of that runs. The authoritative pass can't undo a POST that has already happened. It is a server write (`persistence: possible`) whose payload differs from today's. B12 doesn't list this, and B6 says "Real UI interaction is kept wherever the server is involved", which covers *how* the field is set but not *when*.

Fix (choice): the early pass never sends a postback. In `runPass('early')`, a `posting` stop ends the early pass: `if (pass === 'early' && reason === 'posting') return { wrote }`. Control goes to the settle barrier, and the authoritative pass handles the posting field through legacy on the settled DOM, with Finding 2's restart. `fallback` stops in the early pass may still run legacy, because legacy for a non-posting field doesn't POST: `legacyFillField` awaits a postback only when `remoteTrigger` is true, and if it is, route it as `posting` instead. Update B11: "each AutoPostBack field: no tail saved". Add a fixture where a `load` handler sets a hidden input that the postback echoes. Assert that the server received the post-`load` value.

### 4. MEDIUM: The early pass's resume guard throws, contradicting "Early `missing`/`unavailable-required` is never fatal" (B5)

Where: the B5 pseudocode applies `if n > MAX_FIELD_RESUMES -> throw reason's existing message` before the `if pass === 'early'` branch. The rationale bullet says "Early `missing`/`unavailable-required` is never fatal", and B9 says the stop is thrown "only by the authoritative pass (or the resume guard)".

Problem: these sections conflict. A field that appears and disappears more than three times before `load` would make the early pass throw a stop that today's post-`load` evaluation would never raise. That is a regression, and the coder has to guess which rule wins.

Fix: in the early pass, exceeding the guard defers instead of throwing:

```
if (n > MAX_FIELD_RESUMES) {
  if (pass === 'early') { index = i + 1; continue }   // defer to the authoritative pass
  throw new WorkingHolidayStop(existingMessage(reason))
}
```

Add a unit case: four early `missing` stops for one key, then `ready` in the authoritative pass. Expect no stop, and the field filled.

### 5. NIT: `REMOTE_TRIGGER` escaping changes when it moves into a `String.raw` constant (B5)

Today's `remoteTrigger` lives in a normal template literal and writes `\\.submit\\s*\\(` so the page receives `\.submit\s*\(`. The design moves it into a shared constant and says all page scripts are `String.raw`. If the body is copied verbatim into `String.raw`, the page gets `\\.submit`, which matches a literal backslash. Then `form.submit(`/`fetch(` handlers stop being detected as posting, in **both** paths. Fix: write the shared constant with single backslashes inside `String.raw`. Add a unit test that evaluates `REMOTE_TRIGGER` in `node:vm` (the same approach `captcha.test.ts` uses for `captchaPending`). It must return true for inline `__doPostBack(`, `WebForm_DoPostBack`, `this.form.submit()`, `fetch(`, `XMLHttpRequest` and `sendBeacon`, and false for `return validate()`.

### 6. NIT: The CAPTCHA load wait can be silent for up to 30 s and ignores a challenge that disappears (B8)

The provider-branch loop runs before any `notify`, and it doesn't poll `captchaSubmitCandidate`/`captchaPending`. On a CAPTCHA page that never reaches `complete`, the user sees no "CAPTCHA waiting" event for up to `READY_WAIT_MS`. If a human solves the CAPTCHA and the page leaves during the wait, `readCaptchaChallenge` then runs on the destination and reports "unsupported". Fix: keep the readyState read **first** in each iteration, so `captcha.test.ts` fixtures (`readyState` → `true`) still exit before any other script and no `states` are consumed. Then add `if (!(await captchaPending(driver))) break;` after `assertSiteAvailable`. Document that the wait is normally the load tail. Add one case to `captcha-load-wait.test.ts`: the challenge disappears during the wait, and the provider is not requested.

---

## Verified assumptions

- `captcha.test.ts` `fixture()` answers any script containing `document.readyState` with `ready.shift() ?? true` (boolean). The new `"return document.readyState === 'complete'"` loop exits on its first read in every provider-mode test, and none of the existing scripts (`const captchaSubmit`, `const challengePage`, the site-busy script) collide with it. The only test with a non-empty `ready` array is manual mode ("a disappearing challenge…", three readyState reads), which never enters the provider branch. The fake-timer provider test ("unaccepted automatic token") never reaches the loop's `setTimeout`.
- `captchaGuard` today defines `checkCancelled` as a closure over `execution.getStore()`. A module-level version that reads the store at call time is equivalent under AsyncLocalStorage.
- `waitWithCaptcha` sleeps a literal 200 ms; `ready()` uses 30000; `locateField`/`waitForSection` use 20000; `waitForPostback` uses 30000, requires `complete`, then calls `waitForSection` (`run.ts:302-324, 709-717, 761-771, 836-872`).
- `saveStep` order and rules are as the design quotes them: pre-locate skips (`exemptionReason`, `lookup`), availability `!isEnabled || (kind !== "select" && !isDisplayed)`, then applicability, `remoteTrigger`, `posts && current !== expected` → `possible` + awaited postback, readback, unmapped gate, `captchaGuard`, URL check, SAVE, `[errorlabel]` count, `accepted`, reload, per-field `findElement` + `getAttribute` verify (`run.ts:1094-1215`).
- Legacy Select2 detection is `#s2id_<id> a.select2-choice` with `isDisplayed`, and a native select whose option is missing throws `Option no longer exists.` (`run.ts:627-686`).
- `SectionPostbackTimeoutError` is handled in the section loop as "no repeat POST, continue to next section" only when the URL is still the same section (`run.ts:1528-1541`), so mapping the post-SAVE settle timeout to it matches today's SAVE-wait timeout.
- `finishApplication` receives `waitForChange: condition => driver.wait(condition, 30000)` (`run.ts:1634`), and `completePayerForm` receives `options.waitForChange` (`submission.ts:194`). All four click sites (`payNow`, `nextStep`, `page.button`, payer `ok`) are followed by `options.waitForChange`. A thrown `TimeoutError` lands in `finishApplication`'s `catch` → `incomplete`, never a re-click.
- `fields.ts` kinds are `text | select | date | textarea` only. There are no radios or checkboxes in the wizard. Declarations use the committed batch `el.click()` in `submission.ts`.
- `conditions.ts` `applicable()` matches the controller/dependent table the design lists, including adviser keys gated by `representedByAdviser === "Yes"`.
- `checkpoint()` is a no-op while a section is current (`execution-controller.ts:101`).
- `selenium-webdriver` 4.51.0 ships `lib/atoms/is-displayed.js` (17,687 bytes). `lib/http.js:277` sends `isDisplayed` as that atom. There is no `exports` map, so the deep `createRequire` path resolves.
- `chooseBrowser(type, useDefaultAgent, profileName, attachPort, signal)` has no strategy parameter today, so a new trailing optional parameter is backward compatible.
- `setTimeouts({ pageLoad: 30000, script: 15000 })` (`run.ts:1337`); a 500 ms async slice is well inside it.
- `git log`: HEAD is `3f4fb30` (batched declarations, committed). `git status` shows only `.agents/` files untracked. The design edits neither `submission.ts` nor `submission.test.ts`.
- `assertSiteAvailable` runs in every `waitWithCaptcha` iteration through `captchaGuard`, so the fast `waitForSection` still detects a busy section GET before any fill.

## Unverified / wrong assumptions

- **Wrong:** "No decision taken at DOMContentLoaded is final" (B5 and B9 invariant ownership). It holds for values and availability on the section's first document. It doesn't hold for event delivery to handlers bound after DOMContentLoaded (Finding 1), or for documents reached through a postback during the authoritative pass (Finding 2).
- **Wrong/incomplete:** B6 "Real UI interaction is kept wherever the server is involved". The UI method is kept, but early-pass postbacks run before `load`, which changes the posted payload when `load` scripts touch form state (Finding 3).
- **Conflicting:** "Early `missing`/`unavailable-required` is never fatal" versus the resume guard that throws in both passes (Finding 4).
- **Unverified (live only):** when the site binds its `change`/`blur` handlers (inline, jQuery 1.x synchronous ready, jQuery 3 async ready, or `load`); native setter plus synthetic events accepted by validators; Select2 v3 re-rendering on `change`; which fields are AutoPostBack; `beforeunload`/`navigate` firing for every site navigation; the real DOMContentLoaded→`load` gap and RTT. With Findings 1–3 fixed, these all degrade to today's post-`load` behavior or to a stop, and the kill switch remains.
- **Unverified:** that `eager` is honored in `debuggerAddress` attach mode. The design cites an iteration-1 local measurement that I didn't reproduce. Not blocking; the kill switch covers it.
