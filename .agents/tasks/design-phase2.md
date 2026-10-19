# Fast-fill phase 2 design addendum: fill before full page load

Status: iteration 4 of the phase-2 addendum, revised for `design-phase2-review.md` (iteration 3: 1 MEDIUM, 3 NIT; earlier iterations 1 and 2; responses at the end). It builds on the committed phase-1 code (`e58534f` on `perf/fast-fill`: `workflow/fast-fill.ts`, `fastFillSection`/`legacyFillField`/`saveStep` in `workflow/run.ts`), not on the pre-phase-1 design. It applies `design-review.md` (iteration 3) findings 1, 2, 3, 4 and 6 exactly as prescribed. Finding 5 (`REMOTE_TRIGGER_FN` single-backslash `String.raw`) shipped in phase 1. This step is design only. No source was changed.

## Overview

Phase 1 removed the per-field round trips but kept every `readyState === 'complete'` wait. Phase 2 removes the load tail from the two places where it can be removed safely:

- **The section's first document.** Filling starts as soon as the DOM is parsed and jQuery's ready handlers have run (the *early pass*). It overlaps the DOMContentLoaded→`load` gap. A settle barrier then waits for `load` and idle. An *authoritative pass* replays every early write on the settled DOM and re-decides every field with today's rules. Only then do the re-check, the unmapped-field gate, `captchaGuard` and SAVE run.
- **The verification reload.** Saved values are read once the server-rendered DOM is ready, without waiting for `load`.

Everything else keeps the full-load precondition: AutoPostBack round trips, the SAVE response and its `[errorlabel]` check, CAPTCHA provider reads, and the submission, declaration and payment pages (`waitForChangeThenLoad`). The early pass never sends a server postback.

Technology stack (locked, unchanged from phase 1): TypeScript (ESM, existing tsconfig); `selenium-webdriver` 4.51.0 (`executeScript`, `executeAsyncScript`, `chrome.Options#setPageLoadStrategy`); the bundled `lib/atoms/is-displayed.js` atom already used by phase 1; browser-side vanilla JS in `String.raw` constants in `fast-fill.ts`; vitest with fake drivers, `node:vm` fake DOMs and real headless Chrome on 127.0.0.1 (the phase-1 test pattern). No new dependencies.

---

## P1. Finding: is `eager` honored in `debuggerAddress` attach mode?

What I checked, in `node_modules/selenium-webdriver` 4.51.0:

- `lib/capabilities.js:168,432`: `setPageLoadStrategy(s)` sets the top-level W3C capability `pageLoadStrategy`.
- `chromium.js:274`: `debuggerAddress(addr)` only writes `goog:chromeOptions.debuggerAddress`.
- `Builder.build()` sends both in the same new-session request. The client doesn't filter or drop `pageLoadStrategy` when `debuggerAddress` is set. Both `chooseBrowser` branches (spawned Chrome + attach, and the `--headless`/no-binary branch) go through this one `Builder`.

So the client side is fine. Whether the strategy is applied depends on chromedriver. Chromedriver keeps the page-load strategy per session and applies it in its navigation tracker, and an attach session is still a chromedriver session. The iteration-1 audit measured `driver.get` with a 2 s slow image at 1 ms under `eager` in attach mode (Part A). **I did not re-run that measurement in this step**, and the iteration-3 reviewer didn't either.

The design doesn't rely on it:

1. **Runtime check, with the session property separated from the feature flag.** After `chooseBrowser`, `executeWorkingHoliday` already calls `driver.getCapabilities().catch(() => null)` (`run.ts:1542` in the current branch head `7e73ecb`). It derives two values:

   ```ts
   const requestedEager = early;                                    // captured before chooseBrowser
   const reported = capabilities?.get?.("pageLoadStrategy");        // undefined when the read failed
   /** The session may skip `load`: restore load preconditions. Unknown => assume eager (safe side). */
   const eagerSession = requestedEager && reported !== "normal";
   if (eagerSession) eagerDrivers.add(driver);                      // P8 CAPTCHA load wait
   /** The early pass runs only when eager is confirmed. */
   early = requestedEager && reported === "eager";
   if (requestedEager && !early) console.log("[NZWH] Early fill: page-load strategy not confirmed as eager; early pass inactive.");
   ```

   `eagerSession` gates everything that restores a load precondition (P8 CAPTCHA wait, P9 `waitForChangeThenLoad`). `early` gates only the early pass. A failed or odd capability read therefore turns off the speedup but never the safety waits. Under `NZWH_FAST_FILL=0` or `NZWH_EARLY_FILL=0`, `requestedEager` is false, the session is `normal`, and both values are false.
2. **Behavioral self-degradation.** Chromedriver could report `eager` and still block until `load`. In that case, the early pass reads `document.readyState === 'complete'` at section entry and is skipped (P5, step 0). The section then runs exactly as in phase 1. Early fill never assumes the strategy. It decides from its own DOM-ready predicate and from `readyState`.

## P2. Switches

| Env | Effect | Read |
|---|---|---|
| `NZWH_FAST_FILL=0`/`false` | Full legacy. `normal` page-load strategy, per-field `legacyFillField`, no early pass, no settle barrier, no `waitForChangeThenLoad`, no CAPTCHA load wait. Exactly today's pre-phase-1 code path. | once per run (`fastEntrySnapshot`, existing) |
| `NZWH_EARLY_FILL=0`/`false` (new) | Phase 1 exactly. Batched fill and batched verify, `normal` strategy, `ready()`-based `waitForSection`, no early pass, no settle barrier, no postback restart, no `waitForChangeThenLoad`, no CAPTCHA load wait. | once per run (`earlyEntrySnapshot`, new) |
| neither set | Phase 2: `eager` + early pass + everything in this document | |

```ts
// fast-fill.ts
/** NZWH_EARLY_FILL=0 (or false) keeps batched entry but waits for full page load first. */
export function earlyFillEnabled(): boolean {
  const raw = process.env.NZWH_EARLY_FILL?.trim().toLowerCase();
  return raw !== "0" && raw !== "false";
}
```

```ts
// run.ts
/** Phase-2 snapshot; only meaningful when fast entry is on. */
function earlyEntrySnapshot(fast: boolean): boolean {
  if (!fast) return false;
  if (!earlyFillEnabled()) { console.log("[NZWH] Early fill disabled (NZWH_EARLY_FILL)."); return false; }
  console.log("[NZWH] Early fill enabled.");
  return true;
}
```

The run carries one `EntryMode`: `type EntryMode = { fast: boolean; early: boolean }`. It replaces the bare `fast` boolean on `waitForSection`, `saveStep` and `fastFillSection`. `legacyFillField`, `waitForPostback` and `postbackAndWait` keep their `fast` boolean, and their behavior doesn't change in phase 2. The default is `{ fast: false, early: false }`, so every call site not listed here keeps its current behavior.

- `executeWorkingHoliday`: `const fast = mode !== "loginOnly" && fastEntrySnapshot(); let early = earlyEntrySnapshot(fast);` before `chooseBrowser(..., options.signal, early ? "eager" : "normal")`. Then comes the P1 runtime check, which computes `eagerSession` (registers `eagerDrivers`) and may set `early = false`. The run keeps both: `const entry: EntryMode = { fast, early }` and `eagerSession` for P9.
- `saveStep(driver, name, data, mode: EntryMode)`. The test export keeps its boolean form for phase-1 tests: `saveStepForTest(driver, name, data, mode: boolean | EntryMode = false)` normalizes with `typeof mode === "boolean" ? { fast: mode, early: false } : mode`. `fast-fill-run.test.ts:136,195` stay unchanged.
- `fillAndSaveWorkingHolidaySection`: the driver is caller-provided and its strategy is unknown, and the function calls `ready()` before filling, so the early pass could never run. It uses `{ fast, early: false }` (phase-1 behavior exactly) and does not call `earlyEntrySnapshot`. This also avoids a DOM-ready verification reload on a caller-supplied eager driver that is not in `eagerDrivers`.

The timing log (phase 1, section 5) is extended to compare modes: `early ${e}` (early-pass writes), `restarts ${r}` (finding-2 restarts) and `settle ${t}ms`. It stays counts and milliseconds only:

```
[NZWH] personal: timing fill 140ms (fast 22, unchanged 0, standard 2 in 95ms, skipped 1, segments 11, early 20, restarts 2), settle 410ms, save 1800ms, verify 900ms; load gap page 600/save 650/reload 580ms.
```

A/B procedure: run the same section with `NZWH_EARLY_FILL=0` and with it unset, and compare `fill + settle` and `verify`.

## P3. Files

| File | Change |
|---|---|
| `browser/chooseBrowser.ts` | New trailing optional param `pageLoadStrategy: "normal" \| "eager" = "normal"` → `options.setPageLoadStrategy(pageLoadStrategy)` before `new Builder()`. Existing callers are unaffected. |
| `workflow/fast-fill.ts` | New constants (P4). `earlyFillEnabled()`. `NAV_WATCH_JS`, `SECTION_DOM_READY_JS`, `buildWaitForFieldScript(atom)`, `PRE_SAVE_SETTLE_JS`. Fill script gains `deferClears`/`restoreEarly` args and the `deferred` status. Wrappers `sectionDomReady()`, `waitForFieldInPage()`, `readSettleState()`, `documentComplete()`, `waitForChangeThenLoad()`. Still no import from `run.ts`. |
| `workflow/run.ts` | `EntryMode`, `earlyEntrySnapshot`, `eagerDrivers` WeakSet. Early branch in `waitForSection`. Two-pass `fastFillSection` with settle barrier and postback restart. CAPTCHA provider-branch load wait in `captchaGuard`. `waitForChangeThenLoad` passed to `finishApplication` when `early`. Timing-log fields. |
| `workflow/fast-fill.test.ts` | New unit cases (P11). |
| `workflow/fast-fill-run.test.ts` | New orchestration cases with a mocked driver (P11). |
| `workflow/fast-fill-browser.test.ts` | New real-Chrome fixtures under `eager` (P11). |
| `workflow/captcha-load-wait.test.ts`, `workflow/submission-load-wait.test.ts` (new) | P8 and P9. |
| `captcha.test.ts`, `submission.ts`, `submission*.test.ts`, `payer-form.ts`, `conditions.ts`, `fields.ts`, `section-policy.ts`, `data-validation.ts`, `capsolver*.ts`, `two-captcha.ts`, `occupation-widget.test.ts` | **Not modified.** |

## P4. Named constants (`fast-fill.ts`)

The phase-1 constants are unchanged. New:

```ts
/** Max in-page MutationObserver wait before returning to Node for cancel/CAPTCHA/busy checks. */
export const FIELD_WAIT_SLICE_MS = 500;
/** Limit for the page to settle (load complete, no async postback, jQuery idle) before the authoritative pass and SAVE. */
export const PRE_SAVE_SETTLE_WAIT_MS = 30000;
/** Consecutive settled reads, FAST_POLL_MS apart, required by the settle barrier. */
export const SETTLE_STABLE_POLLS = 2;
/** Limit for an early-pass field wait; on expiry the field is deferred, never fatal. */
export const EARLY_FIELD_WAIT_MS = PRE_SAVE_SETTLE_WAIT_MS;
/** Early section entry replaces ready() + first-field wait; keep their combined budget. */
export const EARLY_SECTION_WAIT_MS = READY_WAIT_MS + SECTION_WAIT_MS;
```

`READY_WAIT_MS` (30 s) and `SECTION_WAIT_MS` (20 s) are both already declared in `fast-fill.ts`, so `EARLY_SECTION_WAIT_MS` is 50 s, the same total budget as today's `ready()` followed by the first-field wait.

The script timeout (`setTimeouts({ script: 15000 })`) is far above `FIELD_WAIT_SLICE_MS`.

## P5. Early section entry

### DOM-ready predicate

`SECTION_DOM_READY_JS` is `NAV_WATCH_JS` + the body below, with args `[firstFieldId]`. It includes the finding-1 jQuery clause:

```js
const manager = typeof Sys !== 'undefined' && Sys.WebForms && Sys.WebForms.PageRequestManager
  ? Sys.WebForms.PageRequestManager.getInstance() : null;
const sheetsLoaded = Array.from(document.querySelectorAll('link[rel~="stylesheet"]')).every(l => l.sheet);
return document.readyState !== 'loading'
  && (sheetsLoaded || document.readyState === 'complete')
  && !(manager && manager.get_isInAsyncPostBack())
  && (typeof jQuery === 'undefined' || jQuery.active === 0)
  && (typeof jQuery === 'undefined' || jQuery.isReady === true)
  && !!document.getElementById(arguments[0]);
```

- The stylesheet clause is there because `isShown` (the selenium atom) depends on layout.
- `jQuery.isReady` makes sure the early pass starts only after jQuery's ready handlers have run. In jQuery 3 those run in a task after DOMContentLoaded.

`NAV_WATCH_JS` is passive and idempotent per document. It never calls `preventDefault`:

```js
if (!window.__nzwhNavWatch) {
  window.__nzwhNavWatch = true; window.__nzwhNavigating = false;
  addEventListener('beforeunload', () => { window.__nzwhNavigating = true; });
  if (window.navigation) navigation.addEventListener('navigate', ev => {
    if (!ev.destination.sameDocument) window.__nzwhNavigating = true; });
}
```

`NAV_WATCH_JS` is prepended to `SECTION_DOM_READY_JS`, the fill script and `PRE_SAVE_SETTLE_JS`, so every document that the early pass, the barrier or the authoritative pass reads is watched.

### `waitForSection(driver, name, mode)`

- `!mode.fast`: today's code.
- `mode.fast && !mode.early`: phase-1 code (`ready()` at 50 ms, then the first-field wait).
- `mode.early`: `activateChrome`, then `waitWithCaptcha(driver, async () => { checkCancelled(); await requireSession(driver); return sectionDomReady(driver, firstId); }, EARLY_SECTION_WAIT_MS, FAST_POLL_MS)`. There is no `ready()`; the single wait keeps the combined `READY_WAIT_MS + SECTION_WAIT_MS` budget, so a slow page that is ready after 20 s but before 50 s still succeeds, as today.

The section loop's call (`run.ts` section loop) and the post-SAVE verification reload both use this. `assertSiteAvailable` and `captchaPending` still run in every iteration through `captchaGuard`, so a busy page or a CAPTCHA is caught before any fill.

### MutationObserver field wait

`buildWaitForFieldScript(atom)` runs through `executeAsyncScript` with args `[id, mode, sliceMs, untilLoad]`. It returns `"ready" | "loaded" | "pending"`:

```js
const [id, mode, slice, untilLoad] = arguments, done = arguments[arguments.length - 1];
const isShown = (/* atom */);
const ok = () => { const e = document.getElementById(id); if (!e) return false;
  return mode === 'present' || (!e.matches(':disabled') && (e.tagName === 'SELECT' || isShown(e))); };
const loaded = () => untilLoad && document.readyState === 'complete';
if (ok()) return done('ready');
if (loaded()) return done('loaded');
const observer = new MutationObserver(() => { if (ok()) finish('ready'); });
const onState = () => { if (ok()) finish('ready'); else if (loaded()) finish('loaded'); };
const timer = setTimeout(() => finish('pending'), slice);
function finish(v) { observer.disconnect(); clearTimeout(timer);
  document.removeEventListener('readystatechange', onState); done(v); }
document.addEventListener('readystatechange', onState);
observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true,
  attributeFilter: ['style', 'class', 'disabled', 'hidden'] });
```

`waitForFieldInPage(driver, atom, id, mode, sliceMs, untilLoad)` maps `isNavigationError` to `"pending"` (the next fill script sees the new `timeOrigin`) and rethrows anything else.

The Node loop runs in slices: `waitWithCaptcha(driver, async () => { checkCancelled(); await requireSession(driver); const r = await waitForFieldInPage(...); return r === "pending" ? null : r; }, limit, FAST_POLL_MS)`. Cancel, site-busy, CAPTCHA and session checks therefore run at least every ~550 ms.

- **Early pass:** uses this wait with `untilLoad = true`.
- **Authoritative pass:** keeps the phase-1 `fieldPresent`/`fieldAvailable` polls (50 ms). The DOM is settled there, so those waits are rare, and keeping them leaves phase-1 code and tests untouched.

## P6. Fill script changes (`buildFillSegmentScript`)

New args: `arguments[2] = deferClears` (early pass only) and `arguments[3] = restoreEarly` (authoritative pass only, and only when `early`). `fillSegment(driver, atom, entries, start, opts = { deferClears: false, restoreEarly: false })` passes them. Phase-1 callers get `false, false`, which is identical to phase-1 behavior.

`FillStatus` gains `"deferred"`. Additions, in loop order:

```js
const rec = deferClears || restoreEarly ? (window.__nzwhEarly ||= {}) : null;
const nativeSet = (e, v) => {
  const proto = e instanceof HTMLSelectElement ? HTMLSelectElement.prototype
    : e instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, v);
};
// Before the entry loop: one silent sweep restores EVERY recorded id before any decision.
// Every authoritative pass starts at start === 0 on a settled document, so no posting entry
// (deferred or not in the early pass) can be reached while an early write is still unreplayed.
if (restoreEarly && start === 0 && window.__nzwhEarly) {
  for (const id of Object.keys(window.__nzwhEarly)) {
    const el = document.getElementById(id);
    if (el) { nativeSet(el, window.__nzwhEarly[id]); delete window.__nzwhEarly[id]; }   // NO events
  }
}
// ...for each entry, right after `const e = document.getElementById(entry.id); if (!e) return done(missing)`:
// fallback for an id that was missing at sweep time and appeared later in this pass:
if (restoreEarly && Object.prototype.hasOwnProperty.call(rec, entry.id)) {
  nativeSet(e, rec[entry.id]);          // NO events
  delete rec[entry.id];
}
// ...availability, applicability and the 'unchanged' check exactly as phase 1...
if (deferClears && expected === '') { results.push({ key: entry.key, status: 'deferred' }); continue; }
if (isPosting(e)) return done({ index: i, reason: 'posting' });
// ...immediately before the first value write on either branch (select or text):
if (deferClears && !Object.prototype.hasOwnProperty.call(rec, entry.id)) rec[entry.id] = e.value;
```

The record write is exactly the prescribed `(window.__nzwhEarly ||= {})[id] = previousValue`, guarded so that the value kept is the first (original) one. The record lives only in the page. **It is never returned to Node or logged.** The result contract is still `{ key, status }` and `{ index, reason, cause? }`. A unit test asserts that `JSON.stringify(result)` contains no sentinel value.

After the restore, the entry runs through today's decision order on the settled DOM: availability, applicability, unchanged, posting, write. Because `current !== expected` again, `REMOTE_TRIGGER_FN` is evaluated against the handlers that are bound *now*:

- A posting field becomes a `posting` stop and goes to `legacyFillField` (emit `possible` → stamp → UI `setField` → awaited postback), as today.
- A non-posting field is written again with events, and the handlers bound at or after `load` receive them.
- A field that `load` made unavailable keeps its restored (pre-early) value, which is today's untouched state. If it is required, it stops with today's message.

A missing element leaves its record in place. The record dies with the document, and the authoritative pass reaches that entry again after its wait.

## P7. Two-pass orchestration (`fastFillSection` with `mode.early`)

`mode.early === false` runs the phase-1 `fastFillSection` unchanged (one `runFill`, `recheck`, one refill). The early variant reuses phase-1's helpers and semantics: `unexpectedReload()` (emit `possible`, then **stop** before SAVE), `stats`, the per-key log lines, `addFilled`, `recheck`, and the per-segment `checkCancelled` + `captchaGuard` + `requireSession`.

Phase 2 does **not** add refill-after-unexpected-reload. Any `timeOrigin` change that isn't the expected result of our own legacy postback stops the run, as in phase 1. That's stricter and simpler.

```
entries = planSection(name, data); stamp = await readTimeOrigin(driver)

// (0) Skip the early pass when the page is already complete (normal strategy, cached page, attach mode
//     not honoring eager, fillAndSaveWorkingHolidaySection). The section then behaves exactly like phase 1.
earlyWanted = !(await documentComplete(driver))

// (1) Early pass: fill as fields appear; never post, never throw for availability.
if (earlyWanted) await runEarly()

// (2)-(3) Settle, then authoritative pass; any new document from our own postback restarts it (finding 2).
// One counter per section, shared by the initial pass and the re-check refill; the total is capped at entries.length.
postbacks = 0
await authoritative()                    // settle + authoritative pass with restarts
if (key = await recheck()) {             // phase-1 batched pre-SAVE re-check
  await authoritative()                  // phase-1's single refill, now as a full authoritative pass
  if (key = await recheck()) throw WorkingHolidayStop(`Readback mismatch: ${name}.${key}.`)
}
// then phase-1 saveStep continues: unmapped-field gate -> captchaGuard -> URL check -> SAVE
```

### Early pass

```
runEarly():
  index = 0; resumes = new Map<string, number>()       // early-pass counter, separate from the authoritative pass
  while index < entries.length:
    checkCancelled(); await captchaGuard(driver); await requireSession(driver)
    out = await fillSegment(driver, atom, entries, index, { deferClears: true, restoreEarly: false })
                                                       // isNavigationError -> unexpectedReload()
    stats.segments++
    if out.timeOrigin !== stamp -> unexpectedReload()
    count results: 'filled' -> stats.early++          // report.filled is NOT touched by the early pass
    if !out.stop: return
    i = out.stop.index; entry = entries[i]
    switch out.stop.reason:
      'yield': index = i
      'missing' | 'unavailable-required':
        n = (resumes.get(entry.key) ?? 0) + 1; resumes.set(entry.key, n)
        if n > MAX_FIELD_RESUMES { index = i + 1; continue }     // finding 4: defer, never throw
        r = await waitForField(entry.id, reason === 'missing' ? 'present' : 'available',
                               untilLoad = true, EARLY_FIELD_WAIT_MS)   // TimeoutError -> treated as 'loaded'
        index = r === 'ready' ? i : i + 1                        // 'loaded': defer to the authoritative pass
      'posting':  return                                         // finding 3: never post before load
      'fallback': return                                         // see decision below
```

- **Finding 3 (posting stop ends the early pass).** No `legacyFillField` runs in the early pass, so no server POST is ever sent before `load`. The authoritative pass handles the posting field through legacy on the settled DOM.
- **`fallback` also ends the early pass.** This is a decision that is stricter than the review's allowance. The review allowed early legacy fallbacks for non-posting fields. I end the pass instead, because a legacy write (UI typing) is not recorded in `window.__nzwhEarly`. Finding 1's replay would then miss it, and late-bound handlers would never see it. Fallbacks are rare (rejected values, `maxlength`, Select2 mismatch), so the authoritative pass taking them costs little.
- **The authoritative pass restores every recorded id at index 0 before any decision**, so deferrals in the early pass (`'loaded'`, wait timeout, resume-guard overflow) cannot leave an unreplayed write. Scenario: entry j is deferred, k > j is early-written, j posts on the settled DOM. The sweep at `start === 0` resets k silently before j is reached. So the postback for j submits k's pre-early value, the server re-renders k with that value, and the restarted pass writes k with events (or legacy if it now posts). A new document produced by the postback has no record and needs none.
- **No early-pass stop is fatal.** It only throws `StopRequested`, `SiteBusyError`, `SessionExpiredError`, CAPTCHA outcomes, or `unexpectedReload`, all as in phase 1. Availability problems always defer.

### Settle barrier

`settle(): Promise<void>` waits via `waitWithCaptcha(driver, async () => { checkCancelled(); await requireSession(driver); s = await readSettleState(driver); ... }, PRE_SAVE_SETTLE_WAIT_MS, FAST_POLL_MS)`.

`PRE_SAVE_SETTLE_JS` is `NAV_WATCH_JS` + a body that returns `{ timeOrigin, navigating: window.__nzwhNavigating === true, settled: readyState === 'complete' && !isInAsyncPostBack && (no jQuery || jQuery.active === 0) }`.

For each read:

- `s.timeOrigin !== stamp` → `unexpectedReload()` (emit `possible`, stop).
- `s === null` (navigation error), `s.navigating` or `!s.settled` → `stable = 0`, keep waiting.
- Otherwise `++stable >= SETTLE_STABLE_POLLS` → settled.
- Timeout → `WorkingHolidayStop("Page did not settle before SAVE; stopped.")`.

`stats.settleMs` accumulates.

### Authoritative pass with restarts (findings 1 and 2)

```
authoritative():
  auth: while (true) {
    await settle()
    p = await runAuthoritative()
    if (p === 'postback') {
      if (++postbacks > entries.length)
        throw new WorkingHolidayStop("Form reloaded repeatedly while filling; stopped.")
      stats.restarts++
      continue auth                       // restart on the settled new document
    }
    if (p.wrote) await settle()           // handlers fired by our writes finish before the re-check
    return
  }

runAuthoritative(): Promise<'postback' | { wrote: boolean }>
  report.filled = []; index = 0; wrote = false; resumes = new Map()   // phase-1 runFill semantics
  while index < entries.length:
    checkCancelled(); await captchaGuard(driver); await requireSession(driver)
    out = await fillSegment(driver, atom, entries, index, { deferClears: false, restoreEarly: true })
    if out.timeOrigin !== stamp -> unexpectedReload()
    results: filled/unchanged -> addFilled + phase-1 log lines; filled -> wrote = true
    if !out.stop: break
    switch out.stop.reason:
      'yield': index = i
      'missing' / 'unavailable-required': phase-1 code (resume guard throws; SECTION_WAIT_MS /
                                          DEPENDENT_FIELD_TIMEOUT_MS waits; today's messages)
      'posting' | 'fallback':
        await legacyFillField(driver, name, key, field, data, report, true)   // phase-1 call, unchanged
        next = await readTimeOrigin(driver)
        if (next !== stamp) { stamp = next; return 'postback' }   // expected new document; not "unexpected"
        wrote = true; index = i + 1
  return { wrote }
```

- **Finding 2.** Any document reached by a postback during the authoritative pass gets a `settle()` and then a full authoritative pass from index 0 on that settled DOM. No decision on a post-postback document is taken before `load`. The cap is `entries.length` restarts in total per section: one `postbacks` counter is shared by the initial authoritative pass and the re-check refill (fails closed); exceeding it throws `WorkingHolidayStop`. Each restart follows a successful legacy readback, after which that posting field reads `unchanged`. So each posting entry triggers at most one restart under normal behavior.
- **`waitForPostback` is unchanged from phase 1.** The fast predicate still requires `readyState === 'complete'`. A DOM-ready postback wait would save nothing here, because `settle()` waits for `load` right after it. Keeping it leaves the legacy and postback paths byte-identical to phase 1.
- **Finding 1.** Every early-written field is restored and written again, so `wrote` is true after an early pass that wrote anything. The second settle then always runs. Cost: one extra fill round trip per segment boundary, plus about 2 × `FAST_POLL_MS`, and it all happens after `load`.
- **The re-check refill uses `authoritative()`**, so it inherits settle and restarts. The phase-1 bound is kept: one refill, then `Readback mismatch`.

### SAVE, server validation and verification reload

- **SAVE.** `postbackAndWait(driver, save, name, true)` is unchanged from phase 1. Its `waitForPostback` waits for a new `complete`, idle document. The `[errorlabel]` count therefore still runs after `load`, exactly as today. The extra post-SAVE settle from the old design B5 isn't needed.
- **Verification reload.** `navigate(url)` returns at DOMContentLoaded under `eager`. Next come the early `waitForSection` (DOM-ready predicate), the URL/ApplicationId check and the phase-1 batched `readFieldValues` over `report.filled`. That reads the server-rendered values, which is what "persisted" means. The comparison, `savedValueDiagnostic`, `SavedValueVerificationError` and the `verified` event are unchanged.
- **Next section.** `navigate` under `eager`, then the early `waitForSection`, then `saveStep`.

## P8. CAPTCHA provider-branch load wait (finding 6)

Under `eager`, click-driven navigations (LOGIN, country tile, Apply Now) reach `captchaGuard` at DOMContentLoaded, before the reCAPTCHA anchor iframe exists. The provider branch then needs today's `load` precondition back. The wait is added in `captchaGuard`'s provider branch, immediately before `readCaptchaChallenge`, and only for drivers registered in `eagerDrivers`:

```ts
// run.ts (module level)
/** Drivers whose session may use eager (eagerSession in P1; set only by executeWorkingHoliday). */
const eagerDrivers = new WeakSet<WebDriver>();
/** Test only. */
export const markEagerDriverForTest = (driver: WebDriver) => { eagerDrivers.add(driver); };

// captchaGuard, provider branch, before readCaptchaChallenge:
if (eagerDrivers.has(driver)) {
  // eager no longer guarantees `load`; the challenge iframe may not exist yet. Normally this is the load tail.
  const loadDeadline = Date.now() + READY_WAIT_MS;
  while (Date.now() < loadDeadline) {
    if (await driver.executeScript<boolean>("return document.readyState === 'complete'")) break;   // readyState FIRST
    checkCancelled();
    await assertSiteAvailable(driver);
    if (!(await captchaPending(driver))) break;      // challenge gone (solved by a human or page left)
    await new Promise(resolve => setTimeout(resolve, PAGE_POLL_MS));
  }
  // On deadline or disappearance fall through: readCaptchaChallenge decides as today.
}
```

- **Placement and gating.** The wait sits inside the provider branch, so manual mode keeps its exact call sequence. The `WeakSet` gate means drivers not registered as eager (every `captcha.test.ts` fake driver, `fillAndSaveWorkingHolidaySection` callers, and both kill switches) make **zero** extra calls. `captcha.test.ts` stays unmodified and needs nothing new. The WeakSet is per driver, so it is safe with concurrent runs, adds no round trip, and is garbage-collected with the driver.
- **readyState first (finding 6).** The `readyState` read comes first in each iteration. On a fixture that answers `readyState` with `true`, the loop exits before any other script and consumes no fixture `states`.
- **Challenge disappears during the wait (phase-2 review NIT 3).** `captchaPending` turns false and the loop breaks. After the loop, a local flag skips the provider block so the misleading "unsupported" notification is never sent:

  ```ts
  let skipProvider = false;                          // declared before the provider branch
  if (eagerDrivers.has(driver)) {
    /* load-wait loop above */
    if (!(await captchaPending(driver))) { skipProvider = true; trace("challenge gone during load wait."); }
  }
  if (!skipProvider) {
    challenge = await readCaptchaChallenge(driver, origin);
    /* ...today's provider block unchanged: trace, key load, solver start, or notify(unsupported/unconfigured)... */
  }
  // falls through to today's driver.wait, which completes on its first poll when the page is complete
  ```

  The flag lives inside the provider branch only, so the manual branch (`else await notify(manual)`) and every unregistered driver keep a byte-identical call sequence. With `skipProvider`, no provider key is loaded, no solver is started, and nothing is notified. The `trace` line carries no token or page data.
- **Silence.** The wait is normally just the load tail, and with the disappearance break it can't hang on a solved challenge. Its worst case is `READY_WAIT_MS` on a CAPTCHA page that never completes. This is documented as accepted, since today's `click()` blocked for the same page-load timeout.

## P9. Submission, declaration and payment pages keep full load

When `eagerSession` (P1; not `early`, so an unconfirmed strategy keeps the wait), `run.ts` passes `waitForChange: condition => waitForChangeThenLoad(driver, condition, async () => { checkCancelled(); await assertSiteAvailable(driver); })` to `finishApplication`. Otherwise it passes today's `condition => driver.wait(condition, SUBMISSION_CHANGE_WAIT_MS)`. `completePayerForm` receives the same function through `options.waitForChange` (`submission.ts:194`). All four click sites (`submission.ts:178,187,276`, `payer-form.ts:48`) therefore wait for the change **and** for `readyState === 'complete'` before anything is read or filled.

```ts
// fast-fill.ts
/** Waits for the click's change, then for full load; `guard` runs every load poll (stop/cancel, site busy). */
export async function waitForChangeThenLoad(driver: WebDriver, condition: () => Promise<boolean>,
  guard: () => void | Promise<void>,
  changeTimeoutMs = SUBMISSION_CHANGE_WAIT_MS, loadTimeoutMs = READY_WAIT_MS): Promise<void> {
  await driver.wait(condition, changeTimeoutMs);
  await driver.wait(async () => {
    await guard();                                   // StopRequested / SiteBusyError propagate
    return driver.executeScript<boolean>("return document.readyState === 'complete'");
  }, loadTimeoutMs, undefined, PAGE_POLL_MS);
}
```

- **Stop/cancel and site busy (phase-2 review finding 1).** `fast-fill.ts` must not import `run.ts`, so the guard is injected. It is called only after the change condition is true, once per load poll (`PAGE_POLL_MS`). A Stop therefore takes effect within one poll on the submission, declaration and payment pages. `submission.ts:283` already rethrows `StopRequested`, and `SiteBusyError` propagates as it does from today's waits, so `submission.ts` needs no edit.
- A `TimeoutError` lands in `finishApplication`'s existing `catch`, which returns `incomplete`. Nothing is re-clicked or re-submitted.
- The `ready` option already waits for `complete` on every page, including Submit.aspx.
- `submission.ts`, `payer-form.ts` and the declaration batch stay byte-identical.

## P10. Error handling

| Operation | Failure | Recoverable? | Caller receives | Logged |
|---|---|---|---|---|
| `getCapabilities().pageLoadStrategy` | read fails or value not `"eager"` | yes | `early = false`; `eagerSession` stays true unless the value is `"normal"`, so CAPTCHA and submission load waits remain | `Early fill: page-load strategy not confirmed as eager; early pass inactive.` |
| `documentComplete` (step 0) | navigation error | yes | treated as `false` (run the early pass). The next fill script's `timeOrigin` check decides | none |
| early `waitForSection` | not ready within `EARLY_SECTION_WAIT_MS` | no | `TimeoutError` (same total budget as today: `READY_WAIT_MS + SECTION_WAIT_MS`), handled by the section loop's generic path | existing |
| early `fillSegment` | `isNavigationError` or `timeOrigin` change | no | `unexpectedReload()`: emit `possible`, then `WorkingHolidayStop("Form reloaded unexpectedly while filling; stopped before SAVE.")` | message (no values) |
| early field wait | not ready within `EARLY_FIELD_WAIT_MS`, `"loaded"`, or resumes > `MAX_FIELD_RESUMES` | yes | entry deferred (`index = i + 1`) | none |
| early `posting`/`fallback` | n/a | yes | early pass ends; the authoritative pass handles it | fallback cause line is logged once, by the authoritative pass |
| `waitForFieldInPage` | other script error | no | rethrown → section loop | existing |
| `readSettleState` | navigation error | yes | `null` → keep waiting; a later read sees the new `timeOrigin` | none |
| settle barrier | `timeOrigin` changed | no | `unexpectedReload()` stop | message |
| settle barrier | not settled within `PRE_SAVE_SETTLE_WAIT_MS` (including a stuck `navigating` flag after a cancelled navigation, e.g. a 204 response) | no | `WorkingHolidayStop("Page did not settle before SAVE; stopped.")` | message |
| authoritative pass | required field / missing field / resume guard | no | phase-1 messages (`Required conditional field unavailable: …`, `Expected form control did not become available.`) | existing |
| authoritative pass | restarts > `entries.length` | no | `WorkingHolidayStop("Form reloaded repeatedly while filling; stopped.")` | message |
| `legacyFillField` | any | as today | as today (`SectionPostbackTimeoutError` on postback timeout, readback stop, …) | existing |
| pre-SAVE re-check | mismatch after one refill | no | `Readback mismatch: ${name}.${key}.` | key only |
| CAPTCHA load wait | deadline | yes | falls through to `readCaptchaChallenge` (today's decision) | none |
| CAPTCHA load wait | challenge disappeared | yes | `skipProvider`: no provider, no notify; today's `driver.wait` completes | trace `challenge gone during load wait.` |
| `waitForChangeThenLoad` load phase | abort / site busy | no | `StopRequested` / `SiteBusyError` (rethrown by `submission.ts:283`) | existing |
| CAPTCHA load wait | abort / site busy | no | `StopRequested` / `SiteBusyError` | existing |
| `waitForChangeThenLoad` | change or load timeout | no | `TimeoutError` → `incomplete` result | existing |

**Input validation.**

- `NZWH_EARLY_FILL` is optional. Only `"0"` and `"false"` (case-insensitive, trimmed) disable early fill. Any other value, or none, enables it. This matches `NZWH_FAST_FILL`.
- The `pageLoadStrategy` param is a TypeScript union, so no runtime validation is needed.
- Entries still come from static `fields.ts` IDs and zod-validated data, and `validateData` is unchanged.
- Field values reach the page only as script arguments, never as interpolated script text.

**Invariant ownership.**

- *"No server postback before `load`"* is owned by `runEarly` (Node), which ends on a `posting` stop and never calls `legacyFillField`. The page only detects; Node decides whether to post.
- *"Every DCL-time decision is re-decided on the settled DOM, including after postbacks"* is owned by `authoritative()` (Node), the only code that sees both passes and every `timeOrigin`. The page owns the replay (`restoreEarly`), because only the page holds the early record.
- *"Early writes never leave the page"* is owned by the fill script. The record lives only in `window.__nzwhEarly`, and the result type has no value field. A unit test enforces it.
- *"Server validation, CAPTCHA provider reads and submission reads happen on a loaded page"* is owned by `run.ts`: the unchanged `waitForPostback` for SAVE, the `eagerDrivers`-gated wait in `captchaGuard`, and `waitForChangeThenLoad`. `run.ts` chose `eager`, so it owns restoring the precondition.

## P11. Tests

All existing tests must stay green. `npx vitest --run` and `npx tsc --noEmit` both run. `captcha.test.ts` is not edited.

`fast-fill.test.ts` (unit, `node:vm` fake DOM):

1. `earlyFillEnabled` parsing.
2. `SECTION_DOM_READY_JS` is false while `jQuery.isReady === false`, `readyState === 'loading'`, an async postback is in flight, or the field is missing. It is true when there is no jQuery and the DOM is interactive.
3. Fill script with `deferClears`:
   - records the pre-write value in `window.__nzwhEarly` once (a second write keeps the original);
   - reports `deferred` for `expected === ""`;
   - stops with `posting` without writing;
   - leaves `JSON.stringify(result)` free of the sentinel value and the record.
4. Fill script with `restoreEarly`:
   - an early-written id is restored with **no events** (event recorder), then re-written with events and reported `filled`, not `unchanged`, and its record is deleted;
   - a restored id whose `onchange` now contains `__doPostBack` stops with `posting`;
   - a restored id that is now hidden and not required is `skipped-unavailable` and holds its pre-early value;
   - **sweep:** record ids `a` (entry index 2) and `b` (entry index 0, now posting); call with `restoreEarly`, `start = 0`: `a` is restored with no events before the `posting` stop at index 0, and its record is gone;
   - with `start > 0` no sweep runs (only the per-entry fallback).
5. `buildWaitForFieldScript`: `ready` on insertion via MutationObserver, `loaded` on `readystatechange` → complete with `untilLoad`, `pending` after the slice.
6. `waitForChangeThenLoad` (`submission-load-wait.test.ts`): no `readyState` call and no `guard` call until the condition is true; `false, false, true` resolves; a never-complete page rejects with `TimeoutError`; an abort during the load phase (guard = `checkCancelled`) rejects with `StopRequested` within one poll; a guard throwing `SiteBusyError` propagates it.

`fast-fill-run.test.ts` (mocked driver through `saveStepForTest(driver, name, data, { fast: true, early: true })`):

7. Step 0: `readyState === 'complete'` at entry → no early-pass script. The call sequence then equals the phase-1 sequence plus the settle reads.
8. **Finding 4:** four early `missing` stops for one key, then `ready` in the authoritative pass → no stop, and the field is filled.
9. **Finding 3:** an early `posting` stop → no `possible` event, no `sendKeys`, and no legacy call before the first settled read. The authoritative pass then emits `possible` and runs legacy.
10. Early `fallback` ends the early pass, and legacy runs only in the authoritative pass.
11. **Finding 2:** a legacy postback in the authoritative pass (new `timeOrigin`) → `settle()` reads → the pass restarts from index 0 (fill script called with `start = 0` again) and `report.filled` is rebuilt. More than `entries.length` restarts → `Form reloaded repeatedly while filling; stopped.`
11a. **Deferred-then-posting:** the early pass defers j (`loaded`) and writes k; the authoritative pass posts at j → restart. Assert the first authoritative fill script (with the sweep, `start = 0`) ran before the legacy call for j.
11b. **Capability read rejects** (`getCapabilities` → reject) with early requested: driver registered in `eagerDrivers`, `early === false`, `waitForChangeThenLoad` passed to `finishApplication`. `reported === "normal"`: not registered, `driver.wait` passed.
12. A `timeOrigin` change seen by the settle barrier or a fill script that isn't our postback → `possible`, then the unexpected-reload stop, and no SAVE.
13. The settle barrier requires `SETTLE_STABLE_POLLS` consecutive settled reads, resets on `navigating`, and times out to its message.
14. Cancel during an early field wait → `StopRequested` within ~600 ms (fake timers).
15. `NZWH_EARLY_FILL=0` → `{ fast: true, early: false }` produces the phase-1 call sequence (no `nzwh:dom-ready`, `nzwh:settle` or `nzwh:wait-field` scripts). `NZWH_FAST_FILL=0` → no fast scripts at all, and `chooseBrowser` is called with `"normal"`.
15a. Early section-entry budget: `sectionDomReady` returns false for 25 s (fake timers), then true → `waitForSection` with `{ fast: true, early: true }` does not throw. It throws `TimeoutError` only past `EARLY_SECTION_WAIT_MS`.
16. The timing line contains `early`, `restarts` and `settle`, and no sentinel value.

`captcha-load-wait.test.ts` (new):

17. Unregistered driver → no extra `readyState` read (compatibility with `captcha.test.ts`'s call sequence).
18. Registered driver, provider mode, `readyState` answers `false, false, true` → the challenge is read once after `complete`, and the provider is requested once.
19. **Finding 6:** registered driver, provider mode; `readyState` answers `false` for the first two reads (load wait), then `true`; `captchaPending` turns false on the second iteration → the loop breaks, `skipProvider` is set, and `captchaGuard` resolves `true` through the existing `driver.wait`. Assert: provider key loader and solver never called, no "unsupported" notification, `readCaptchaChallenge` ran at most once (zero with `skipProvider`).
20. Abort during the wait → `StopRequested`, and no provider request.
21. Manual mode with a registered driver → no extra `readyState` read before `driver.wait`.

`fast-fill-browser.test.ts` (real headless Chrome, `eager` set via the new `chooseBrowser` param or directly on `Options`, fixture page with a 2–3 s slow image):

22. The early pass fills while `readyState !== 'complete'`. SAVE happens only after `load`.
23. **Fixture A (finding 1a):** a `title` `change` handler bound in `window.onload` reveals `otherTitle`. Both are filled, and the server receives both.
24. **Fixture B (finding 1b):** `$(window).on('load', () => $('#x').on('change', () => __doPostBack('x','')))`. The postback goes through legacy in the authoritative pass, `possible` is emitted before it, and the re-rendered dependent is filled.
25. **Fixture C (finding 2):** two posting selects. The second one's response page shows, in `window.onload`, a field with `expected === ""` and a non-empty value. After `load` it is cleared, and the server receives `""`.
26. **Fixture D (finding 2):** the same response page resets a later field in `onload`. It is rewritten, with no `Readback mismatch`.
27. **Finding 3:** a `load` handler sets a hidden input that the AutoPostBack echoes. The server receives the post-`load` value, and no POST arrives before `load` (server-side timestamp vs the page's `loadEventStart`).
28. A field inserted 300 ms after DCL is filled with no fixed sleep (MutationObserver).
29. `NZWH_EARLY_FILL=0` on the same fixture: no early-pass scripts, and the fill starts after `load`.

What is unit-tested versus integration-tested:

- Unit (fake DOM or mocked driver): decision rules, the record/restore contract, orchestration order, bounds and switches.
- Real headless Chrome: event-delivery timing (handlers bound at `load`), real postbacks, and the eager-strategy behavior.

## P12. Hard constraints and how each is kept

- **CAPTCHA (manual solving, auto-submit, provider fallbacks).** `captchaPending`, `captchaSubmitCandidate`, the CAPTCHA `driver.wait` (200 ms, 10 s acceptance), the providers and the fallbacks are unmodified. The single addition is the `eagerDrivers`-gated provider-branch load wait (P8). It ends on `complete`, on challenge disappearance, on its deadline (falling through to today's decision), on cancel, or on site busy. `captcha.test.ts` is unmodified, and its drivers never enter the new code.
- **Site-busy, stop/cancel, checkpoint, events.** Every new wait loop runs through `waitWithCaptcha`, which calls `captchaGuard` → `assertSiteAvailable` each iteration, or calls `assertSiteAvailable` directly (the CAPTCHA load wait). Every new loop also calls `checkCancelled()`: the DOM-ready wait, the early field wait (at least every ~550 ms), the settle barrier, the early-pass segment loop and the CAPTCHA load wait. `waitForChangeThenLoad`'s load wait calls an injected guard (`checkCancelled` + `assertSiteAvailable`) every `PAGE_POLL_MS` (P9); no checkpoint is added. `checkpoint()` remains a no-op inside sections. No new checkpoints are added and none are removed. Events: `possible` before every postback (only in the authoritative pass) and SAVE, and on unexpected reloads. `accepted`, `verified`, `section-start` and `section-result`, plus the coverage files, are unchanged.
- **Never auto-submit the final application or any unsafe submission.** The fill and wait scripts never click or submit. The nav watch is passive. SAVE still goes only through `sectionSaveControl`. `finishApplication`'s mode gating is untouched.
- **Full-load precondition on submission, declaration and payment pages.** `waitForChangeThenLoad` at all four click sites, plus the existing `ready` option (P9).
- **Section policy and data validation.** `automatedSection`, `requestedSections`, `validateData`, `planSection`'s pre-skips and `applicable()` are unchanged.
- **Occupation widget.** Unchanged and still excluded by policy.
- **No secrets, tokens or PII in logs.** New log lines carry keys, counts, durations and cause codes only. The early-write record lives only in `window.__nzwhEarly`. It is never returned to Node or logged (tests 3, 16).
- **No early-pass server postbacks.** A `posting` stop ends the early pass, and AutoPostBack fields are handled only on the settled DOM (P7, tests 9, 27).
- **Every DCL-time decision is re-decided on the settled DOM**, including on documents reached via a postback: the authoritative pass after `settle()`, `restoreEarly` replay, and the restart on any postback document (P7, tests 11, 23–26).
- **Timeout budgets not reduced.** The early section entry keeps today's `READY_WAIT_MS + SECTION_WAIT_MS` budget (`EARLY_SECTION_WAIT_MS`); every other wait keeps its phase-1 limit.
- **Named constants.** `FIELD_WAIT_SLICE_MS`, `PRE_SAVE_SETTLE_WAIT_MS`, `SETTLE_STABLE_POLLS`, `EARLY_FIELD_WAIT_MS`, `EARLY_SECTION_WAIT_MS`, plus the existing phase-1 constants.
- **No new dependencies.**

## P13. Expected savings (estimates, not measured live)

Per section, with T = the live DOMContentLoaded→`load` gap:

- **Section's first page:** up to T saved. The early pass runs inside the tail. After `load`, the settle barrier costs about 2 × 50 ms, and the authoritative pass costs one segment round trip per yield boundary plus the re-writes of the early fields (in-page, under 50 ms) and a second settle. Net is about T − 0.15 s. If T is under ~150 ms, this is roughly break-even.
- **Verification reload:** T saved in full.
- **SAVE response page:** nothing saved (the `[errorlabel]` check still waits for `load`).
- **Each AutoPostBack field whose value changes:** nothing saved (it posts only after `load`, and each one adds a restart: settle plus one authoritative pass, about 0.1–0.2 s). Sections with several changed posting fields can come out slightly slower than phase 1 on a first fill. Re-runs over a filled draft have mostly `unchanged` posting fields, so they don't restart.

At a plausible T of 0.2–1.5 s, expect about 0.3–2.8 s per section on top of the phase-1 fill savings. Submission and payment pages get no load savings, by design. Use the timing log to decide whether to keep phase 2 on: compare `fill + settle` and `verify` between `NZWH_EARLY_FILL=0` and the default.

## P14. Remaining risks and what only the live site can confirm

| Risk / unverified | Degradation |
|---|---|
| Whether chromedriver honors `eager` in attach mode (client side verified, behavior not re-measured) | P1 runtime capability check, plus step 0 (skip the early pass when already complete). Worst case is phase-1 behavior. |
| When the site binds `change`/`blur` handlers (inline, jQuery ready, `load`) | Every early write is replayed on the settled DOM, so late-bound handlers receive it. |
| Side effects of events the early pass delivered to DCL-bound handlers on a field that `load` then hides (the restore is silent, so client state may reflect the early value) | Rare: requires visible-at-DCL, hidden-at-`load`, not required, and a handler with visible side effects. Caught by the unmapped-field gate (extra visible fields stop before SAVE), server validation and reload verification. Clears are deferred, so the early pass never writes a clear. Kill switch: `NZWH_EARLY_FILL=0`. |
| A handler undetected by `REMOTE_TRIGGER_FN` that posts when the early pass fires `change` (e.g. a delegated document-level handler) | The same detection gap exists in phase 1 after `load`. Here the POST could happen before `load`. The nav watch and `timeOrigin` checks detect it, emit `possible` and stop before SAVE. Not prevented. Live log: any `Form reloaded unexpectedly` line means set `NZWH_EARLY_FILL=0`. |
| `jQuery.isReady` absent (non-jQuery ready frameworks) or Sys/ASP.NET AJAX init at `load` | Early decisions are never final; the authoritative pass re-decides. |
| Layout at DCL (stylesheets, fonts) affecting `isShown` | The predicate waits for `.sheet`, and the authoritative pass re-decides. |
| A `load` script on the verification reload that rewrites a saved value | Reads use server-rendered values. A rewrite would not show as a mismatch (today it would). It's a client-side change, not persistence. |
| Real T, RTT, number of changed posting fields, and therefore net savings | Timing log `fill`/`settle`/`verify`/`load gap`/`restarts`. |
| CAPTCHA pages under `eager` (iframe timing) | Provider-branch load wait. On its deadline it behaves as today (unsupported → manual). |
| `beforeunload`/`navigate` firing for every site navigation | A missed flag still surfaces as a new `timeOrigin` on the next barrier read. Two stable reads narrow the window. |
| Payment gateway or declaration `load` scripts | Not relied on: `waitForChangeThenLoad` and `ready`. |

Nothing in this addendum has been run against the live site. All verification is fake-DOM, mocked-driver and local headless Chrome.

---

## Responses to `design-review.md` (iteration 3)

| # | Severity | Response |
|---|---|---|
| 1 | HIGH | **Addressed as prescribed.** In the early pass (`deferClears`), each write first records `(window.__nzwhEarly ||= {})[id] = previousValue` in the page only. That value is never returned to Node or logged, and the result contract is unchanged. `restoreEarly` (4th arg, authoritative pass only) puts the recorded value back with the native setter and **no events**, deletes the record, and then runs today's decision order on the settled DOM. A posting field goes to `legacyFillField`; a non-posting one is re-written with events. `SECTION_DOM_READY_JS` gains `&& (typeof jQuery === 'undefined' \|\| jQuery.isReady === true)`. Cost stated in P7/P13. Tests 3, 4, 23, 24; risk row in P14. Addition: the early pass also ends on `fallback`, so no unrecorded legacy write can bypass the replay. |
| 2 | HIGH | **Addressed as prescribed.** In the authoritative pass, a `legacyFillField` that produces a new `timeOrigin` returns `'postback'`. `authoritative()` then runs `settle()` and restarts the authoritative pass from index 0 on the settled new document (`report.filled` rebuilt). The cap is `entries.length` restarts, beyond which it throws `WorkingHolidayStop("Form reloaded repeatedly while filling; stopped.")`. Difference from the review's sketch: an unexpected reload (not our postback) still **stops** with phase-1's `unexpectedReload()` instead of refilling, which is stricter. Tests 11, 25, 26; savings corrected in P13. |
| 3 | MEDIUM | **Addressed as prescribed.** A `posting` stop ends the early pass; `legacyFillField` is never called in the early pass. The authoritative pass handles the posting field on the settled DOM, with finding 2's restart. Stricter than the review: `fallback` also ends the early pass (reason in P7). Tests 9, 10, 27. |
| 4 | MEDIUM | **Addressed as prescribed.** The early-pass resume guard defers (`index = i + 1; continue`) instead of throwing. Its counter is separate from the authoritative pass's, which keeps phase-1's throwing guard. Test 8. |
| 5 | NIT | **Already done in phase 1** (`REMOTE_TRIGGER_FN` single-backslash `String.raw`, `node:vm` test). |
| 6 | NIT | **Addressed as prescribed.** The provider-branch load wait reads `readyState` **first** in each iteration, then `checkCancelled` and `assertSiteAvailable`, then breaks when `captchaPending` turns false. It is documented as normally the load tail. It is also gated to eager-registered drivers, so `captcha.test.ts` drivers make no extra calls. `captcha-load-wait.test.ts` adds the disappearing-challenge case (test 19), where the provider is not requested. |

## Responses to `design-phase2-review.md` (iteration 1)

| # | Severity | Response |
|---|---|---|
| 1 | HIGH | **Addressed as prescribed.** The fill script runs one silent sweep when `restoreEarly && start === 0`: every id in `window.__nzwhEarly` is reset with the native setter, no events, and its record deleted, before any entry decision. Every authoritative pass (first, restart, re-check refill) starts at index 0, so an early-pass deferral can no longer leave a write unreplayed ahead of a posting entry. The per-entry restore stays only as a fallback for ids missing at sweep time. The P7 bullet is replaced. Tests: fast-fill unit "sweep" case (P11 item 4), orchestration case 11a. |
| 2 | MEDIUM | **Addressed as prescribed.** P1 separates `eagerSession = requestedEager && reported !== "normal"` (unknown ⇒ eager, safe side) from `early = requestedEager && reported === "eager"`. `eagerDrivers` registration (P8) and `waitForChangeThenLoad` (P9) are gated on `eagerSession`; only the early pass is gated on `early`. Test 11b. Note for implementation: `credential-isolation.test.ts` fakes `getCapabilities: async () => null` in a non-loginOnly run, so that driver is registered; its fake never enters the CAPTCHA provider branch, and if it reaches `finishApplication` the fake must answer `readyState` (adjust the fake, not the assertion). |
| 3 | NIT | **Addressed as prescribed.** `saveStepForTest(driver, name, data, mode: boolean \| EntryMode = false)` normalizes booleans to `{ fast: mode, early: false }`; existing calls at `fast-fill-run.test.ts:136,195` are unchanged (P2). |

## Responses to `design-phase2-review.md` (iteration 2)

| # | Severity | Response |
|---|---|---|
| 1 | MEDIUM | **Addressed as prescribed.** `waitForChangeThenLoad` takes an injected `guard`, which `run.ts` supplies as `checkCancelled()` + `assertSiteAvailable(driver)`. The guard is polled in the `readyState` wait every `PAGE_POLL_MS`, and only after the change condition is true. `submission.ts` is unchanged (it already rethrows `StopRequested` at line 283). P9, P10 row, P12 wording corrected, test 6 extended (abort within one poll, `SiteBusyError` propagates, guard not called before the change). |
| 2 | NIT | **Addressed as prescribed.** Test 19's `readyState` is `false, false`, then `true`, so the manual `driver.wait` completes. It asserts `captchaGuard` resolves `true` with no provider calls. |
| 3 | NIT | **Addressed as prescribed.** After the load wait, `captchaPending` is re-checked. If it is false, a local `skipProvider` flag skips the provider block (no `readCaptchaChallenge`, no key load, no solver, no "unsupported" notify) and execution goes straight to today's `driver.wait`. The flag is scoped to the provider branch, so manual mode and unregistered drivers keep an identical call sequence (P8, P10 row, test 19). |

## Responses to `design-phase2-review.md` (iteration 3)

| # | Severity | Response |
|---|---|---|
| 1 | MEDIUM | **Addressed as prescribed.** New `EARLY_SECTION_WAIT_MS = READY_WAIT_MS + SECTION_WAIT_MS` (P4) is the limit of the early `waitForSection` (P5). The P10 row now reads "not ready within `EARLY_SECTION_WAIT_MS` → `TimeoutError` (same total budget as today)". Test 15a: predicate false for 25 s, then true, no throw. P12 states that no timeout budget is reduced. |
| 2 | NIT | **Addressed.** P7 states one `postbacks` counter per section, shared by the initial pass and the refill, total capped at `entries.length`. Code unchanged. |
| 3 | NIT | **Addressed (preferred option).** `fillAndSaveWorkingHolidaySection` uses `{ fast, early: false }` and no longer calls `earlyEntrySnapshot` (P2). |
| 4 | NIT | **Addressed.** P1 cites the capability read at `run.ts:1542`, its line at the current branch head `7e73ecb` (the reviewer's 1537 predates the logging commits). |
