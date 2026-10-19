# Implementation Plan: fast-fill phase 1

Repo: `/Users/MAC/Desktop/DEV/nz-working-holiday-automation` (TypeScript ESM, selenium-webdriver 4.51, vitest 5). Work directly on branch `main`. **Do not commit, stash, reset or revert anything.** Never read or print `.env`.

Source of truth: `.agents/tasks/design.md` (Part A audit, Part B design) and `.agents/tasks/design-review.md` (iteration 3, "Verified assumptions"). This plan implements the **phase-1 subset** of that design. Where phase 1 deliberately simplifies the design, the decision and its reason are stated inline.

Verification commands (from `package.json` / README):
- Tests: `npx vitest --run` (baseline: **261/261 tests pass in 29 files**, about 81 s; includes real headless-Chrome tests such as `submission-browser.test.ts` and `occupation-widget.test.ts`)
- Type check: `npx tsc --noEmit` (baseline: exit 0, no errors)
- Single file: `npx vitest --run workflow/<file>.test.ts`

## Scope

In scope (phase 1):
1. Batched in-page fill: one `executeScript` per segment, with per-field fallback to the extracted legacy path.
2. Batched post-reload verification (one script instead of 2 RTs per field), plus a batched pre-SAVE re-check.
3. `FAST_POLL_MS = 50` for fill-flow waits; all touched timeouts and intervals become named constants.
4. Condition-based post-SAVE and postback waits: new document (`performance.timeOrigin` changed) plus `readyState === 'complete'`, polled at 50 ms, with the redundant trailing re-wait removed. Full load is still awaited.
5. Kill switch `NZWH_FAST_FILL=0`, read once per run.
6. Per-section timing log (durations and counts only), including the DOMContentLoaded→load gap from Navigation Timing.
7. Shared `REMOTE_TRIGGER` constant (`String.raw`, single backslashes) with a `node:vm` test (review NIT 5).

**Out of scope (phase 2; do NOT implement):** the `eager` pageLoadStrategy and any `chooseBrowser.ts` change; filling at DOMContentLoaded; the early/authoritative two-pass fill; the pre-SAVE settle barrier, `NAV_WATCH_JS`, `PRE_SAVE_SETTLE_JS` and the post-SAVE settle beyond item 4; `restoreEarly`; `WAIT_FOR_FIELD_JS`/MutationObserver slices; the CAPTCHA provider-branch load wait (B8) and **any** other `captchaGuard` change; `waitForChangeThenLoad`; Submit.aspx/declaration/payment readiness; the login fill. Every page is still filled only after today's full-load wait (`ready()` → `readyState === 'complete'`).

Why review findings 1–4 do not apply to phase 1: they all concern work done before `load`. Findings 1–2 cover handlers bound after DOMContentLoaded and documents decided at DCL. Finding 3 covers postbacks sent before `load`. Finding 4 covers the early-pass resume guard. Phase 1 fills only after `readyState === 'complete'`, so page handlers are bound (as they are for today's typing). It has no early pass, and it sends postbacks only after `load`, the same as today.

## Design decisions specific to phase 1 (recorded here, not in design.md)

- D1. **Segment boundaries.** The in-page script stops and returns to Node at: `missing`, `unavailable-required`, `posting`, `fallback`, and `yield`. `yield` comes right after every *changed* `select`. All `conditions.ts` controllers are selects, and the next `executeScript` is a new browser task, so a controller's queued handlers (`setTimeout(0)`, promises) run before any dependent's availability is evaluated. That matches the multi-RT gap today's per-field loop leaves between fields. Text writes do not yield.
- D2. **Dependent-field race.** On `unavailable-required`, Node waits (condition-based, `FAST_POLL_MS`) up to `DEPENDENT_FIELD_TIMEOUT_MS = 5000` for the field to become available, then resumes at that field. On timeout it throws today's exact message. This is more tolerant than today, which throws at once, and it never fills an inapplicable field. On `missing`, Node waits up to `SECTION_WAIT_MS` (today's `locateField` limit) and then throws today's message. Each key may resume at most `MAX_FIELD_RESUMES = 3` times, after which the same message is thrown.
- D3. **Unexpected reload while fast-filling** (`timeOrigin` changed without our own postback, or a navigation error from the fill script): emit `persistence: possible`, then throw `WorkingHolidayStop("Form reloaded unexpectedly while filling; stopped before SAVE.")`. No automatic refill. Today the same event ends as a stale-element generic stop, so the outcome is unchanged. The stop also sets the risk flag, which today's path misses.
- D4. **Pre-SAVE batched re-check** (1 RT): `timeOrigin` must be unchanged (otherwise D3), and every key in `report.filled` must still read its expected value. On a mismatch, run the fast fill loop once more from index 0. It is idempotent: unchanged fields are not written, and posting fields go through legacy. Then re-check. A persistent mismatch throws `Readback mismatch: ${name}.${key}.`. This guards against a later field's handler or a legacy postback altering an earlier fast-filled field. Only fast mode does this.
- D5. **Select2 clears** (`expected === ""` with a shown Select2 widget) always go to legacy (cause `select2-clear`). Legacy throws "This dropdown cannot be cleared through its visible widget." when there is no close control, and a native `""` set would silently succeed where today stops. Read-only text inputs also go to legacy (cause `readonly`), because a native setter would write where today's `clear()` fails.
- D6. **Unchanged fields are not written**: `e.value === expected` and, for a shown Select2, the chosen label matches the selected option label. Today re-types them. Skipping changes no value, and it removes today's latent unawaited postback from `clear()` on posting text fields (design A4/B7).
- D7. **Missing element in batched post-reload verify**: throw `new webdriverError.NoSuchElementError("Saved field missing after reload.")`, so the section loop's generic handler shows exactly today's message. Today `driver.findElement` throws the same class.
- D8. **Field waits use targeted condition polling** (`getElementById`, atom-based availability) at `FAST_POLL_MS` inside `waitWithCaptcha`, not a MutationObserver. These paths are rare after full load, polling keeps the CAPTCHA, site-busy, session and cancel checks in every iteration, and the most it can cost is 50 ms. The MutationObserver slice design is deferred with early fill.
- D9. **`captchaGuard` is not edited.** A new module-level `checkCancelled()` is used only by new loops; `captchaGuard` keeps its own closure. Zero CAPTCHA diff, and `captcha.test.ts` is unmodified.
- D10. **Timing log runs in both modes**, so `NZWH_FAST_FILL=0` yields a baseline for A/B comparison. In legacy mode it adds only read-only `performance` reads and one log line. No fill, verify or wait behavior changes.

---

- [ ] 0. Preflight: record git state and confirm the baseline.
      Run `git status --porcelain` and `git diff --stat`. HEAD should be `3f4fb30`, with only `.agents/` untracked. If `workflow/submission.ts`, `workflow/submission.test.ts` or any other file shows uncommitted changes, **preserve them exactly**: never revert, stash, reset, overwrite or reformat them. This plan does not edit `submission.ts`, `submission.test.ts`, `payer-form.ts`, `capsolver*.ts`, `two-captcha.ts`, `section-policy.ts`, `data-validation.ts`, `conditions.ts`, `fields.ts`, `browser/chooseBrowser.ts` or `captcha.test.ts`.
      Files: none
      Verify: `npx tsc --noEmit` exits 0, and `npx vitest --run` reports 261/261 in 29 files. If the baseline differs, note it and continue; do not "fix" unrelated failures.

- [ ] 1. Create `workflow/fast-fill.ts`: constants, kill switch, atom loader, shared scripts, pure helpers and thin driver wrappers. No import from `run.ts`. Allowed imports: `./fields`, `./conditions`, `./saved-values`, `./application-data` (types), `selenium-webdriver` types, `node:module`.
      Contents (all `export`ed):
      - Constants (design B2 subset; values preserve today's literals): `PAGE_POLL_MS = 200`, `FAST_POLL_MS = 50`, `SECTION_WAIT_MS = 20000`, `POSTBACK_WAIT_MS = 30000`, `READY_WAIT_MS = 30000`, `SELECT2_RESULTS_WAIT_MS = 5000`, `DEPENDENT_FIELD_TIMEOUT_MS = 5000`, `MAX_FIELD_RESUMES = 3`, `SUBMISSION_CHANGE_WAIT_MS = 30000`, each with a one-line doc comment.
      - `fastFillEnabled(): boolean`: false only when `process.env.NZWH_FAST_FILL?.trim().toLowerCase()` is `"0"` or `"false"`. Same style as `captchaTimeoutMinutes()` (`run.ts:150`).
      - `isDisplayedAtomSource(): string | null`: memoized `createRequire(import.meta.url)("selenium-webdriver/lib/atoms/is-displayed.js")`. Return `String(fn)` if it is a function, otherwise `null`; on any throw, `null`. It is verified self-contained: selenium's own `lib/http.js:185` sends `return (${atom}).apply(null, arguments)`.
      - `REMOTE_TRIGGER_FN`: a `String.raw` function-source string `function (e) { ... }` whose body is today's `remoteTrigger` (`run.ts:719-730`) with **single** backslashes: `/__doPostBack|WebForm_DoPostBack|\.submit\s*\(|ajax|fetch\s*\(|XMLHttpRequest|sendBeacon/i`, plus the same inline `on*` attributes and `jQuery._data(e,'events')` handler sources.
      - `normalizeLabel = (s: string) => s.replace(/\s+/g, " ").trim()`.
      - `interface FillEntry { key; id; kind: FieldDefinition["kind"]; expected: string; applicable: boolean; colonsPrepared: boolean }` and `planSection(name: SectionName, data: ApplicationData): FillEntry[]`. Keep `steps[name].fields` definition order. Drop `field.lookup` entries, and drop `adviser.exemptionReason` when `!applicable(...)` (today's pre-skips, `run.ts:1103-1110`). `expected = expectedFieldValue(name, key, data[name][key])`; `colonsPrepared = expected !== source`.
      - `addFilled(report: { filled: string[] }, key)`: push only if not already present.
      - Types: `FillStatus = "filled" | "unchanged" | "skipped-unavailable" | "skipped-inapplicable"`; `StopReason = "missing" | "unavailable-required" | "posting" | "fallback" | "yield"`; `FallbackCause = "too-long" | "readonly" | "markup-unknown" | "value-rejected" | "option-missing" | "select2-clear" | "widget-mismatch" | "widget-unknown"`; `SegmentResult = { results: { key: string; status: FillStatus }[]; stop: { index: number; reason: StopReason; cause?: FallbackCause } | null; timeOrigin: number }`. **Results never carry values.**
      - `buildFillSegmentScript(atomSource: string): string`: a `String.raw` template starting with the marker comment `/* nzwh:fill-segment */`, with `const isShown = (${atomSource}); const isPosting = (${REMOTE_TRIGGER_FN});` and args `[entries, start]` (values travel only as `arguments`, never interpolated). It is memoized per atom in `fillSegment`. Per entry from `start`, in today's order (`run.ts:1114-1146`):
        1. `e = document.getElementById(id)`; if absent, stop `missing`.
        2. `available = !e.matches(':disabled') && (kind === 'select' || isShown(e))`. If not available: when `applicable && expected`, stop `unavailable-required`; otherwise record `skipped-unavailable` and continue.
        3. If `!applicable && expected`, record `skipped-inapplicable` and continue.
        4. Select2 widget = `document.querySelectorAll('#s2id_' + id + ' a.select2-choice')` has length 1 and `isShown` is true (legacy rule `run.ts:635-637`). If `e.value === expected` and (no widget, or `expected === ''`, or `normalizeLabel('#s2id_<id> .select2-chosen' text) === normalizeLabel(selected option textContent)`), record `unchanged` and continue (D6).
        5. If `isPosting(e)`, stop `posting`.
        6. Write by kind:
           - **text/date/textarea**: requires `HTMLInputElement` or `HTMLTextAreaElement`, else `markup-unknown`. `e.readOnly` gives `readonly`. `maxLength >= 0 && expected.length > maxLength` gives `too-long`. Otherwise call the native prototype `value` setter, then dispatch `input` (bubbles), `change` (bubbles), `focusout` (bubbles) and `blur`; **no focus events**. Verify `e.value === expected`, else `value-rejected`.
           - **select**: requires `HTMLSelectElement`, else `markup-unknown`. Widget plus `expected === ''` gives `select2-clear` (D5). If no `option.value === expected`, `option-missing`. Otherwise `e.value = expected` and dispatch `input` and `change` (bubbles). Without a widget, also dispatch `focusout`/`blur`, mirroring legacy's TAB. Verify `e.value === expected`, else `value-rejected`. With a widget, labels must match after normalization; otherwise `widget-mismatch`, or `widget-unknown` when `.select2-chosen` is missing.
           - On any cause, stop `fallback` with that cause.
        7. Record `filled`. If `kind === 'select'`, stop `yield` with `index = i + 1` (D1).
        Return `{ results, stop, timeOrigin: performance.timeOrigin }`.
      - `READ_FIELD_VALUES_JS` (marker `/* nzwh:read-values */`): args `[ids]`; returns `{ timeOrigin, values: (string | null)[] }` (null = element missing).
      - `FIELD_PRESENT_JS` (marker `/* nzwh:field-present */`) and `buildFieldAvailableScript(atom)` (marker `/* nzwh:field-available */`, same availability rule as step 2).
      - `LOAD_GAP_JS` (marker `/* nzwh:load-gap */`): `const n = performance.getEntriesByType('navigation')[0]; return n && n.loadEventStart > 0 ? Math.round(n.loadEventStart - n.domContentLoadedEventEnd) : null;`.
      - `isNavigationError(error)` (design B9 regex; only `JavascriptError`/`WebDriverError` names).
      - Wrappers: `readTimeOrigin(driver)`, `fillSegment(driver, atom, entries, start): Promise<SegmentResult>`, `readFieldValues(driver, ids)`, `fieldPresent(driver, id)`, `fieldAvailable(driver, atom, id)`, `readLoadGap(driver): Promise<number | null>` (catch → null).
      Files: `workflow/fast-fill.ts` (new)
      Verify: `npx tsc --noEmit` exits 0.

- [ ] 2. Add unit tests for item 1 in `workflow/fast-fill.test.ts` (new). No browser. Use `node:vm` `runInNewContext`, as `captcha.test.ts` does for `captchaPending`.
      - **REMOTE_TRIGGER vm test (NIT 5):** evaluate `(${REMOTE_TRIGGER_FN})(e)` with fake `e.attributes = [{ name: 'onchange', value }]` and no `jQuery`. Expect `true` for `__doPostBack('x','')`, `WebForm_DoPostBack(...)`, `this.form.submit()`, `fetch('/x')`, `new XMLHttpRequest()`, `navigator.sendBeacon('/x')`, and `false` for `return validate()`. Also `true` for a jQuery-bound handler: the context provides `jQuery._data` returning `{ change: [{ handler: function () { __doPostBack('a','') } }] }`.
      - **Fill-script vm tests**, built with `buildFillSegmentScript("function (e) { return e.__shown !== false; }")`. The fake DOM context supplies minimal `HTMLInputElement`/`HTMLTextAreaElement`/`HTMLSelectElement` classes with prototype `value` accessors, `Event`/`InputEvent`/`FocusEvent` constructors, `dispatchEvent` recording event types, `matches(':disabled')`, `document.getElementById`/`querySelectorAll`/`querySelector`, and `performance.timeOrigin`. Cases:
        - text, textarea and date each get `input, change, focusout, blur` in order, report `filled`, and keep the value.
        - Unchanged text gets no events and reports `unchanged`.
        - A native select gets `input, change, focusout, blur`, then a `yield` stop at `i + 1`.
        - A Select2 select whose stub listener updates `.select2-chosen` on `change` is filled. A label that differs only by `&nbsp;`/newlines/spaces still verifies. A stub that ignores `change` gives `widget-mismatch`; a missing `.select2-chosen` gives `widget-unknown`.
        - Option missing gives `option-missing`; Select2 with `expected ''` gives `select2-clear`; readonly gives `readonly`; maxlength gives `too-long`; a setter-rejecting element gives `value-rejected`.
        - A posting `onchange` gives a `posting` stop **with no write and no events**.
        - A missing element gives `missing`. Hidden + applicable + non-empty gives `unavailable-required`. Hidden with `expected ''` gives `skipped-unavailable`. Inapplicable + non-empty gives `skipped-inapplicable` with no write.
        - Every result object's keys are only `key`/`status`, and serialized results never contain the entry's `expected` string.
      - Pure: `planSection` (order, lookup exclusion, the `exemptionReason` rule, `colonsPrepared` for `health.details`, `applicable` flags); `addFilled` de-duplication; `normalizeLabel`; `fastFillEnabled` (`unset`/`"1"`/`"yes"` → true; `"0"`/`"false"`/`" FALSE "` → false, via `vi.stubEnv`); `isDisplayedAtomSource()` returns a non-empty string starting with `function`; `isNavigationError` (true for `JavascriptError("javascript error: document unloaded while waiting for result")` and `WebDriverError("target frame detached")`; false for `NoSuchSessionError` and `ScriptTimeoutError`).
      - Ordering guard (design B6): a test-local `conditionalControllers` table (`personal.title→otherTitle`; health yes/no→`details`; `character.deported→deportedDate/deportedCountry`; charge questions→`character.details`; `workingHoliday.beenToNz→previousVisitDate`; `adviser.adviserType→exemptionReason`). Assert that each controller precedes its dependent in `Object.keys(steps[section].fields)`, and that `applicable()` is false for every adviser key when `representedByAdviser !== "Yes"`.
      Files: `workflow/fast-fill.test.ts` (new)
      Verify: `npx vitest --run workflow/fast-fill.test.ts` passes; `npx tsc --noEmit` exits 0.

- [ ] 3. Make the mechanical, behavior-preserving `run.ts` changes: named constants, poll parameters, the shared trigger, and the cancel helper.
      - Import the constants and helpers from `./fast-fill`.
      - `waitWithCaptcha(driver, condition, timeout, pollMs = PAGE_POLL_MS)`: the `:313` sleep uses `pollMs`.
      - `ready(driver, pollMs = PAGE_POLL_MS)` uses `READY_WAIT_MS` (`:322`).
      - `waitForSection(driver, name, fast = false)` passes `fast ? FAST_POLL_MS : PAGE_POLL_MS` to both its `ready()` and its first-field wait, and uses `SECTION_WAIT_MS` (`:716`). Semantics are unchanged: full load, then first field present with `requireSession`.
      - `locateField(driver, id, pollMs = PAGE_POLL_MS)` uses `SECTION_WAIT_MS` (`:770`).
      - `setField`'s Select2 results wait uses `SELECT2_RESULTS_WAIT_MS` (`:683`).
      - `finishApplication`'s `waitForChange` uses `SUBMISSION_CHANGE_WAIT_MS` (`:1634`). Literal replacement only; the function is not wrapped.
      - `remoteTrigger` (`:719-730`) becomes `driver.executeScript<boolean>(\`return (${REMOTE_TRIGGER_FN})(arguments[0]);\`, element)`.
      - Add a module-level `function checkCancelled(): void { if (execution.getStore()?.signal?.aborted) throw new StopRequested(); }` for new loops only. **Do not edit `captchaGuard`** (D9).
      - Do not touch login, country, APPLY NOW, occupation or submission literals.
      Files: `workflow/run.ts`
      Verify: `npx tsc --noEmit` exits 0; `npx vitest --run` passes with the baseline count unchanged. `captcha.test.ts` is unmodified, and its 3-argument `waitWithCaptcha` calls still poll at 200 ms.

- [ ] 4. Extract today's per-field loop body into `legacyFillField` and thread `fast` through the postback waits. Still no fast path (depends on 3).
      - `async function legacyFillField(driver, name, key, field, data, report: SavedSection, fast: boolean): Promise<void>` holds the body of `run.ts:1101-1148` **verbatim**: `requireSession`, the `exemptionReason`/`lookup` pre-skips, the colons log, `locateField`, the availability rule `!isEnabled || (kind !== "select" && !isDisplayed)`, applicability, `remoteTrigger`, current value, stamp, `possible` emit when `posts && current !== expected`, `setField`, awaited `waitForPostback(driver, name, stamp, fast)`, relocate, readback, log. The only changes: `continue` becomes `return`, and `report.filled.push(key)` becomes `addFilled(report, key)`. `locateField` receives `fast ? FAST_POLL_MS : PAGE_POLL_MS`.
      - `waitForPostback(driver, name, stamp, fast = false)`: same predicate (`timeOrigin !== stamp && readyState === 'complete' && !isInAsyncPostBack && jQuery idle && first field present`, with `requireSession` each poll), `POSTBACK_WAIT_MS`, and poll `fast ? FAST_POLL_MS : PAGE_POLL_MS`. Afterwards, `fast` calls only `activateChrome(driver)`, because the predicate already proved everything `waitForSection` re-checks (design A4, review NIT 9). Legacy keeps `await waitForSection(driver, name)`.
      - `postbackAndWait(driver, trigger, name, fast = false)` passes `fast` to `waitForPostback`; stamp, `activateChrome`, the `possible` emit, `sendKeys(SPACE)` and the timeout mapping to `SectionPostbackTimeoutError` are unchanged.
      - `saveStep(driver, name, data, fast = false)`: the loop becomes `for (const [key, field] of Object.entries(steps[name].fields)) await legacyFillField(driver, name, key, field, data, report, fast);`. The rest is unchanged for now.
      - Add `export const saveStepForTest = saveStep;` (same pattern as `occupationSelectionForTest`, `run.ts:1042`).
      Files: `workflow/run.ts`
      Verify: `npx tsc --noEmit` exits 0; `npx vitest --run` passes with the baseline count.

- [ ] 5. Implement the fast fill path, the pre-SAVE re-check, batched post-reload verification and the kill-switch snapshot (depends on 1, 4).
      - `async function fastFillSection(driver, name, data, report, atom): Promise<FillStats>` in `run.ts`. `FillStats = { fast; unchanged; standard; skipped; segments; standardMs }` holds counts and ms only. Algorithm:
        ```
        entries = planSection(name, data); stamp = await readTimeOrigin(driver)
        runFill(): report.filled = []; index = 0; resumes = new Map<string, number>()
          while index < entries.length:
            checkCancelled(); await captchaGuard(driver); await requireSession(driver)   // per segment, not per field
            out = await fillSegment(driver, atom, entries, index)          // isNavigationError → D3
            if out.timeOrigin !== stamp → D3 (emit possible; throw reload stop)
            for r of out.results: count; if filled|unchanged → addFilled + (entry.colonsPrepared ? today's colons log : nothing) + today's "entered and read back." log
            if !out.stop break
            i = out.stop.index; entry = entries[i]
            yield                → index = i
            missing              → resume guard; waitWithCaptcha(() => { checkCancelled(); requireSession; fieldPresent }, SECTION_WAIT_MS, FAST_POLL_MS); TimeoutError → "Expected form control did not become available."; index = i
            unavailable-required → resume guard; same with fieldAvailable and DEPENDENT_FIELD_TIMEOUT_MS; TimeoutError → `Required conditional field unavailable: ${name}.${key}.`; index = i
            posting | fallback   → fallback logs `[NZWH] ${name}.${key}: fast entry not accepted (${cause}); using standard entry.`;
                                   await legacyFillField(..., fast = true); stamp = await readTimeOrigin(driver); index = i + 1
        runFill(); recheck(); if mismatch { runFill(); recheck() or throw `Readback mismatch: ${name}.${key}.` }   // D4
        ```
        Here `recheck` means: one `readFieldValues` over the `report.filled` ids. A changed `timeOrigin` takes D3. A `null` value throws "Expected form control did not become available.". Otherwise compare `value !== expected` in memory. **Nothing is logged with values.**
        Resume guard: if `++resumes[key] > MAX_FIELD_RESUMES`, throw the reason's message.
      - `saveStep(driver, name, data, fast = false)`: when `fast`, call `fastFillSection` in place of the legacy loop, using `atom = isDisplayedAtomSource()!` (it is non-null whenever `fast` is true). Keep everything after the loop in today's exact order: occupation lookups (unchanged), unmapped-field script, `captchaGuard`, URL check, `sectionSaveControl`, `postbackAndWait(..., fast)`, pathname check, `[errorlabel]` count and stop, `emit accepted`, `navigate(url)`, `waitForSection(driver, name, fast)`, ApplicationId check.
      - Post-reload verification when `fast`: one `readFieldValues` over the non-lookup keys of `report.filled`. A `null` throws `NoSuchElementError` (D7). Value comparison, `savedValueDiagnostic` log, `report.persisted`, occupation lookup verification, `SavedValueVerificationError`, `emit verified` and the final log are unchanged. Legacy keeps the per-field `findElement` + `getAttribute` loop (`:1191-1202`).
      - Kill switch: in `executeWorkingHoliday`, after `validateData` (`:1290`), compute `const fast = mode !== "loginOnly" && fastFillEnabled() && isDisplayedAtomSource() !== null;` once and log one line: `[NZWH] Fast entry enabled.`, or `[NZWH] Fast entry disabled (NZWH_FAST_FILL).`, or `[NZWH] Fast entry unavailable; using standard entry.`. Pass it to the section loop's `waitForSection(driver, name, fast)` (`:1466`) and `saveStep(driver, name, data, fast)` (`:1477`). In `fillAndSaveWorkingHolidaySection`, compute the same snapshot **after** the occupation early return (keeps `section-policy.test.ts`'s "Chrome must not be touched" proxy valid) and pass it at `:1262-1263`. Every other call site keeps the default `false`.
      Files: `workflow/run.ts`
      Verify: `npx tsc --noEmit` exits 0; `npx vitest --run` passes with the baseline count.

- [ ] 6. Add the per-section timing log (depends on 5).
      In `saveStep`, measure with `Date.now()`: `fillMs` (from loop start through the pre-SAVE re-check), `standardMs` (time inside `legacyFillField`, including its awaited postbacks), `saveMs` (`postbackAndWait` through the `[errorlabel]` check), `verifyMs` (`navigate(url)` through the end of value verification). Read `readLoadGap()` on three documents: section page at `saveStep` start, SAVE response after `postbackAndWait`, verification reload after `waitForSection`. Before the existing "SAVE completed" log, write one line:
      `[NZWH] ${name}: timing fill ${fillMs}ms (fast ${f}, unchanged ${u}, standard ${s} in ${standardMs}ms, skipped ${k}, segments ${g}), save ${saveMs}ms, verify ${verifyMs}ms; load gap page ${a}/save ${b}/reload ${c}ms.`
      Use `n/a` for null gaps. In legacy mode, fast/unchanged/segments are 0 and standard is the number of fields processed (D10). The line holds only the section name, counts and durations: no keys with values, no values, no tokens. Use `console.log` only, like every other `[NZWH]` line; add no new `ExecutionEvent` type (the frontend contract in `lib/execution-state.ts` is unchanged).
      Files: `workflow/run.ts`
      Verify: `npx tsc --noEmit` exits 0; `npx vitest --run` passes with the baseline count.

- [ ] 7. Add orchestration unit tests with a mocked WebDriver in `workflow/fast-fill-run.test.ts` (new, depends on 5–6). Follow `captcha.test.ts`'s `fixture()` style: a `vi.fn` `executeScript` dispatching on script content.
      Fake driver: `executeScript` routes by marker or substring:
      - `nzwh:fill-segment` → a queued `SegmentResult`
      - `nzwh:read-values` → queued
      - `nzwh:field-present` / `nzwh:field-available` → queued booleans
      - `nzwh:load-gap` → `null`
      - `return performance.timeOrigin` → the current origin
      - `loginForm:` → `{ loginForm: false, rejected: false, authenticated: true }`
      - `site busy` → `false`
      - `const challengePage` → `false`
      - `document.readyState` → `true`/`"complete"`
      - `get_isInAsyncPostBack` → `true`
      - `const mapped` → `[]`
      - `[errorlabel]` → `0`
      - `return arguments[0].value` → the readback value
      - remote-trigger script → per element
      Other members: `getCurrentUrl`, `get`, `findElements(By.id)` returning fake `WebElement`s (`isEnabled`, `isDisplayed`, `getAttribute("value")`, `clear`, `sendKeys`, `findElements(option)`), `sendDevToolsCommand`. Run calls through `withHooksForTest` to capture events. Use `saveStepForTest(driver, "identification", data, true)` with data holding unique sentinel values such as `"SENTINEL-PASSPORT-7Q"`. Cases:
      - Batched result handling: one segment returning all `filled`/`unchanged` gives `report.filled` in definition order without duplicates, no `findElements(By.id)` for fields, one SAVE, and one batched post-reload read.
      - `posting` stop: `legacyFillField` runs for that key. `possible` is emitted **before** the field's `sendKeys`. The next segment starts at `i + 1` with the new `timeOrigin`. No D3 stop.
      - `fallback` (`option-missing`): legacy runs. If the fake element has no matching option, the run stops with "Option no longer exists.". If legacy succeeds, the section completes. The fallback log contains the cause code and no value.
      - `yield`: resumes at `stop.index` with no wait.
      - `missing`, then `field-present` true on the third poll: resumes, and the field gets filled. Missing ×4 on the same key throws "Expected form control did not become available.".
      - `unavailable-required` with `field-available` never true: throws `Required conditional field unavailable: identification.<key>.`. Use fake timers or stub `DEPENDENT_FIELD_TIMEOUT_MS` through a short real timeout. No SAVE.
      - Stop/cancel: aborting the signal during a `missing` wait rejects with `StopRequested` and sends no SAVE (`sendKeys(SPACE)` never called).
      - Unexpected reload: a segment returning a different `timeOrigin` emits `possible` and throws the D3 message, with no SAVE. A fill script throwing `JavascriptError("document unloaded …")` behaves the same.
      - Pre-SAVE re-check: a mismatch on the first read, then a match after refill, completes. A mismatch twice throws `Readback mismatch: identification.<key>.`, with no SAVE.
      - Batched post-reload verify: one mismatched value gives `SavedValueVerificationError` with that key, and the diagnostic log has no value. A `null` gives `NoSuchElementError`.
      - Kill switch path: `saveStepForTest(..., false)` issues zero `nzwh:fill-segment`/`nzwh:read-values` scripts and calls `findElements(By.id)` per field (today's sequence).
      - Fast `waitForPostback`: after the predicate turns true, no `ready()` readyState poll or second first-field wait runs (only `sendDevToolsCommand`).
      - Timing log: the spied `console.log` output contains exactly one `timing fill` line per section matching the item 6 format. **No captured log line or event contains any sentinel value.**
      Files: `workflow/fast-fill-run.test.ts` (new)
      Verify: `npx vitest --run workflow/fast-fill-run.test.ts` passes; `npx tsc --noEmit` exits 0.

- [ ] 8. Add a real headless-Chrome fixture test for in-page behavior and the end-to-end kill switch (depends on 5–6). Follow `occupation-widget.test.ts` / `submission-browser.test.ts`: `Builder().forBrowser("chrome")` with `--headless=new`, and a local `node:http` server on 127.0.0.1.
      Harness `scripts/fixtures/fast-fill-harness.ts`: serves `/WorkingHoliday/Wizard/Personal1.aspx?ApplicationId=fx` with every `personalFields` id. It includes:
      - text/date inputs
      - the selects with options covering `fixtures/sample.json`
      - `countryOfBirth` as a Select2-v3 stub: a `#s2id_<id>` div with `a.select2-choice` and `.select2-chosen`, updated by a `change` listener on the hidden native select
      - `title` whose `change` reveals `otherTitle` via `setTimeout(…, 100)`
      - `representedByAdviser` with inline `onchange="__doPostBack('x','')"`, where `__doPostBack` submits the form and the server re-renders with posted values
      - the SAVE button `ContentPlaceHolder1_wizardPageFooter_wizardPageNavigator_validateButton`, which POSTs and stores the values; GET renders the stored values
      - `window.__events` recording `id:type`
      Data: a temp copy of `fixtures/sample.json` (fictional) with `title: "6"` and `representedByAdviser` set to a value different from the page default. In `beforeAll`, call `vi.stubEnv("NZWH_REPORT_DIR", mkdtemp dir)` **before** `await import("./run")`, then `setFixtureOriginForTest(base)`. Cases:
      - Fast run: `withHooksForTest` plus `fillAndSaveWorkingHolidaySection(driver, { dataPath, section: "personal", allowFictionalDraftSave: true })` resolves. The server's stored values equal `expectedFieldValue` for all applicable keys. Fill-segment scripts (spy on `driver.executeScript`, count the `nzwh:fill-segment` marker) total at most (changed selects + posting fields + 2). Text fields record `input,change,focusout,blur`; unchanged fields record none. `otherTitle` is filled after the delayed reveal. The posting select produced exactly one server postback before SAVE, and `possible` was emitted before it.
      - Kill switch: with `vi.stubEnv("NZWH_FAST_FILL", "0")` and a reset server state, the same call resolves with identical stored values and zero `nzwh:fill-segment` scripts.
      - Fallback in real DOM: an extra-page variant where `familyName` has an `input` listener resetting the value when `!event.isTrusted`. Fast fill falls back, legacy typing persists the value, and the section completes.
      - Atom parity: on a parity page, `fieldAvailable`'s in-page result equals `WebElement.isEnabled() && isDisplayed()` for `display:none`, a hidden ancestor, `visibility:hidden`, `opacity:0`, zero-size, `overflow:hidden` clipping, `disabled` and `fieldset[disabled]`.
      Files: `scripts/fixtures/fast-fill-harness.ts` (new), `workflow/fast-fill-browser.test.ts` (new)
      Verify: `npx vitest --run workflow/fast-fill-browser.test.ts` passes. No writes land in `workflow/coverage-saved.json` (check `git status`; that tracked file must be unchanged).

- [ ] 9. Run full verification and collect the facts the final report needs.
      Run `npx tsc --noEmit` (exit 0) and `npx vitest --run`: all baseline tests pass, plus the new files (29 + 3 files, 261 + new tests). Confirm with `git status --porcelain` / `git diff --stat`:
      - only `workflow/run.ts`, the new `workflow/fast-fill*.ts` files, `scripts/fixtures/fast-fill-harness.ts` and `.agents/` changed
      - `captcha.test.ts`, `submission*.ts`, `payer-form.ts`, `capsolver*`, `two-captcha*`, `conditions.ts`, `fields.ts`, `chooseBrowser.ts` and `workflow/coverage-*.json` are untouched
      - any pre-existing user changes recorded in step 0 are intact
      Run `git diff workflow/run.ts | grep -n captchaGuard` to show that only call sites changed and the function body did not.
      For the report (`.agents/tasks/form-fill-speedup-report.md`, written by the later report step), record:
      - the bottlenecks addressed (design A2, A3, A4, A5) and the ones deferred (A1 load waits → phase 2)
      - what changed, per item 1–7
      - phase-1 expected savings per section: fill RTs (personal ≈ 470 RTs → about 20–40; ≈ 0.7 s of typing and 7 Select2 UI cycles removed), post-reload verify 2N RTs → 1, and about 0.15–0.3 s of poll quantization. Estimates: personal ~1–2.5 s, identification ~0.3–0.6 s, health/character ~0.6–2.5 s, workingHoliday ~0.5–1.5 s, adviser ~1–2 s. Zero load-tail savings in phase 1.
      - unverified without the live site: native setter plus synthetic events accepted by the site's validators; Select2 version and re-render on `change`; which fields are AutoPostBack; real RTT; the actual DCL→load gap. The new timing log measures the last two, and that gap decides phase 2.
      Files: none
      Verify: both commands green; the git diff scope is exactly as listed.

## Hard-constraint checklist (the reviewer checks each)

- CAPTCHA: `captchaGuard`, `captchaPending`, `captchaSubmitCandidate`, provider adapters and the CAPTCHA `driver.wait` (200 ms, 10 s acceptance) are unmodified. `captchaGuard` still runs in every `waitWithCaptcha` iteration, before every fill segment and before SAVE. `captcha.test.ts` is unmodified and passes.
- Site busy: `assertSiteAvailable` runs in every wait iteration (through `captchaGuard`) and before every segment.
- Stop/cancel: `checkCancelled()` runs before every segment and inside every new wait condition; `captchaGuard`'s own check also runs per iteration. No new `checkpoint()` calls (a no-op mid-section, `execution-controller.ts:101`).
- Events and checkpoints: `section-start`, `possible` (before every posting field and SAVE, plus D3), `accepted`, `verified`, `section-result`, and the `coverage-*.json` writes are unchanged. `report.filled` is de-duplicated.
- No auto-submit: the fill script never clicks or submits. SAVE goes only through `sectionSaveControl`; `finishApplication` and mode gating are untouched.
- Section policy (`automatedSection`, `requestedSections`), `validateData` and the occupation exclusion are unchanged.
- No values, tokens or PII in any new log line, fill result or error message (keys, cause codes, counts and durations only).
- No new dependencies (the atom ships with `selenium-webdriver`).

## Verification evidence

Iteration 1 (no `review.json` existed). Preflight: `git status --porcelain` showed only `.agents/` untracked and `git diff --stat` was empty, so there were no user changes in `submission.ts`/`submission.test.ts` to preserve. Nothing was committed, stashed or reset.

Commands run (final state):
- `npx tsc --noEmit`: exit 0, no errors.
- `npx vitest --run`: **Test Files 32 passed (32), Tests 309 passed (309)**, 81.95 s. Baseline was 261/261 in 29 files; +3 files, +48 tests, 0 failures.
- `git diff workflow/run.ts | grep captchaGuard`: the only `+` lines are a new call before each fill segment and a doc comment. The `captchaGuard` body is unchanged.
- `git diff --quiet workflow/coverage-saved.json`: unchanged.
- Changed files: `workflow/run.ts` (modified). New: `workflow/fast-fill.ts`, `workflow/fast-fill.test.ts`, `workflow/fast-fill-run.test.ts`, `workflow/fast-fill-browser.test.ts`. `captcha.test.ts`, `submission*.ts`, `payer-form.ts`, `capsolver*`, `two-captcha*`, `conditions.ts`, `fields.ts`, `chooseBrowser.ts` are untouched.

Tests added and why:
- `workflow/fast-fill.test.ts` (31 tests, node:vm, no browser):
  - REMOTE_TRIGGER vm test (NIT 5): true for `__doPostBack(`, `WebForm_DoPostBack`, `this.form.submit()`, `fetch(`, `XMLHttpRequest` and `sendBeacon`, and for jQuery-bound handlers; false for `return validate()`.
  - Fill script against a fake DOM: event order per control type (text/textarea/date: input, change, focusout, blur; native select: the same plus a `yield` stop; Select2: input and change, with label normalization). Unchanged fields get no events.
  - Every fallback cause: option-missing, readonly, too-long, value-rejected, select2-clear, widget-mismatch, widget-unknown.
  - Stops and skips: a posting stop with no write and no events; missing, unavailable-required, skipped-unavailable and skipped-inapplicable.
  - Results carry only key and status, never values.
  - Pure helpers: `planSection`, `addFilled`, `normalizeLabel`, the kill switch env parsing, the atom loader and `isNavigationError`.
  - Controller-before-dependent ordering guard.
- `workflow/fast-fill-run.test.ts` (14 tests, mocked WebDriver through `saveStepForTest`):
  - One batched segment plus a batched pre-SAVE re-check and a batched reload verify. No per-field `findElements`.
  - A posting field goes to the standard entry, with `possible` emitted before the change and the resume at i+1.
  - Fallback to the standard entry; the log carries the cause only. A missing option stops with "Option no longer exists." and no SAVE.
  - `yield` resumes with no wait.
  - A missing field is awaited at 50 ms polling; repeated misses stop.
  - An unavailable dependent times out with today's message and no SAVE (fake timers).
  - Stop/cancel inside the new wait gives `StopRequested` and no SAVE.
  - An unexpected reload (changed timeOrigin, or a document-unloaded error) emits `possible` and stops before SAVE.
  - Pre-SAVE re-check: a refill that recovers, and a persistent mismatch that stops.
  - Batched verify: a mismatch gives `SavedValueVerificationError` with a values-free diagnostic; a missing field gives `NoSuchElementError`.
  - Kill switch (`fast=false`) issues zero fast scripts and runs today's per-field path.
  - Fast postback wait skips the redundant `waitForSection` re-wait.
  - One timing line per section in the item-6 format. No sentinel value appears in any log or event.
- `workflow/fast-fill-browser.test.ts` (3 tests, real headless Chrome on 127.0.0.1):
  - Real-DOM fill of text, textarea, date, select and a Select2 stub, with a yield after selects.
  - A delayed `otherTitle` reveal reports unavailable-required, then fills once available.
  - Idempotent re-run (all unchanged, no events).
  - A posting select is not touched.
  - An `isTrusted` guard falls back with `value-rejected`; maxlength gives `too-long`.
  - `fieldAvailable` parity with `isEnabled() && isDisplayed()` for display:none, a hidden ancestor, visibility, opacity, zero size, overflow clipping, disabled and fieldset[disabled].

Deviations from the plan:
- Step 8 is reduced. The browser test exercises `fillSegment`/`fieldAvailable` directly on a static page. It does not run the full `fillAndSaveWorkingHolidaySection` against a SAVE-capable harness (`scripts/fixtures/fast-fill-harness.ts` was not created). The end-to-end SAVE, postback and kill-switch orchestration is covered by the mocked-driver tests instead.
- The kill-switch snapshot lives in a `fastEntrySnapshot()` helper that logs the one-line status. `executeWorkingHoliday` calls it once after `validateData`; `fillAndSaveWorkingHolidaySection` calls it after the occupation early return.
- In legacy mode the timing line's `standard` counts every field definition iterated, including lookups and pre-skipped keys.

Not verifiable without the live site:
- whether the site's validators accept a native setter plus synthetic events
- the Select2 version and whether it re-renders on `change`
- which fields are AutoPostBack
- real RTT
- the actual DCL→load gap, which the new timing log now measures
