# Fast-fill design: NZ Working Holiday wizard sections

Status: third iteration. Revised against the iteration-2 `design-review.json` / `design-review.md` (verdict CHANGES_REQUESTED, 2 HIGH, 2 MEDIUM, 4 NIT). All eight findings are addressed; responses for both review rounds are listed at the end. This step is audit and design only. No source was changed.

## Overview

The wizard flow (`executeWorkingHoliday` → per-section loop → `saveStep` → SAVE → reload → verify → next section) loses its client-side time in three places:

- Chrome's full `load` event, which blocks about 3 page loads per section.
- 13 to 20+ WebDriver round trips per field: find, clear, type, TAB, verify, plus a CAPTCHA and session probe on every lookup.
- 200 ms poll quantization in every `waitWithCaptcha` wait.

Server time stays the same: section GET, SAVE POST, verification reload GET, and AutoPostBack round trips. Removing any of it would mean dropping the reload verification, and this design keeps that.

The design makes six changes:

1. Use the `eager` page-load strategy. Filling starts at DOMContentLoaded, once a DOM-ready predicate holds: DOM parsed, stylesheets applied, no async postback running, and the target field present.
2. Fill each section with one in-page script per segment. The script sets values through native setters and dispatches `input`/`change`/`blur`. It decides availability with the same Selenium `isDisplayed` atom that today's code uses, so the rules match exactly. It stops at any boundary that needs Node-side handling.
3. Send AutoPostBack fields, rejected fast fills and unknown widgets through the existing per-field code. That code is extracted unchanged into `legacyFillField`.
4. Add a pre-SAVE settle barrier: `load` complete, no async postback, jQuery idle, no pending navigation, same document. After it, one authoritative fill pass re-evaluates every field on the settled DOM (writes only what differs), then re-verification, the unmapped-field gate, `captchaGuard` and SAVE run. The post-SAVE `[errorlabel]` check also waits for the settled state.
5. Batch the pre-SAVE re-verification and the post-reload verification into one script each.
6. Restore today's "page is loaded" precondition wherever `eager` would otherwise remove it from a consumer that depends on it: CAPTCHA provider reads inside `captchaGuard`, the post-SAVE server-validation check, and every click-driven navigation in `finishApplication` (submission and payer form, through the `waitForChange` option).

Every existing safety step stays: CAPTCHA guard, site-busy, session check, unmapped-field check, SAVE control selection, server-validation check, reload verification, and event reporting. The kill switch `NZWH_FAST_FILL=0` restores today's behavior. It is read once per run.

Technology stack (locked): TypeScript (ESM, existing tsconfig); `selenium-webdriver` (installed 4.51.0, range ^4.38) using `executeScript`, `executeAsyncScript` and `chrome.Options#setPageLoadStrategy`; its bundled `lib/atoms/is-displayed.js` atom, loaded through `node:module` `createRequire`; browser-side vanilla JS strings in the same style as the existing inline scripts; vitest unit tests plus real headless Chrome fixture tests (same pattern as `submission-browser.test.ts` and `occupation-widget.test.ts`). No new dependencies.

---

## Part A: Bottleneck audit

Measured locally in the first iteration (headless Chrome against a 127.0.0.1 fixture, temp script since deleted):

| Operation | Cost |
|---|---|
| `executeScript("return 1")` | 1.2–1.6 ms |
| `findElements(By.id)` | 1.6–2.1 ms |
| `isDisplayed()` | 1.6–1.9 ms |
| Today's text-field loop (find + clear + sendKeys 19 chars + TAB + readback), 25 fields | 603–625 ms (about 24 ms/field) |
| One script setting 25 fields with native setter + events | 1 ms |
| `driver.get` with a 2 s slow image, `normal` strategy | 2036 ms |
| Same, `eager` strategy (standalone / debuggerAddress-attach) | 46 ms / 1 ms |

Live pages are heavier (ASP.NET WebForms, jQuery, Select2) and live round trips are slower. The per-page numbers below are estimates that have not been checked on the live site.

### A1. Waits for full page load before any interaction

| Where | What | Effect |
|---|---|---|
| `run.ts:1337` + default capabilities | `pageLoadStrategy` is `normal` | Every `driver.get`, and every click or keypress that navigates, blocks until `load` (images, iframes, async scripts) |
| `run.ts:317-324` `ready()` | polls `readyState === 'complete'` | Called by `waitForSection` (`:712`) before the first-field check |
| `run.ts:709-717` `waitForSection` | `ready()` then first-field wait | **3+ times per section**: main loop `:1466`, after each postback `:871`, after the verification reload `:1185` |
| `run.ts:855-872` `waitForPostback` | predicate requires `readyState === 'complete'` | After each AutoPostBack field and after SAVE |
| `run.ts:1035` | `ready()` after each occupation selection | Occupation is excluded by `section-policy.ts`, so it is not on the live path |
| `run.ts:1621-1629` | Submit.aspx waits for `complete` (inline reCAPTCHA) | Once per run. Unchanged (backlog) |

Cost per section: (3 + P) × (load − DOMContentLoaded), where P is the number of AutoPostBack fields whose value changes. The live tail is unknown. 0.2–1.5 s per load is plausible.

### A2. One field at a time (`saveStep`, `run.ts:1094-1150`)

Round trips per non-posting text/date/textarea field:

| Step | Line | RTs |
|---|---|---|
| `requireSession` | 1101 | 1 |
| `locateField` → `waitWithCaptcha` → `captchaGuard` (`assertSiteAvailable` + `captchaPending`) + `requireSession` + `findElements` | 1114, 765 | 4 |
| `isEnabled` + `isDisplayed` | 1116-1117 | 2 |
| `remoteTrigger` | 1125 | 1 |
| `getAttribute("value")` | 1126 | 1 |
| `setField`: `clear` + `sendKeys(value)` (per-char key events) + `sendKeys(TAB)` | 690-692 | 3 |
| readback `executeScript` | 1139-1145 | 1 |
| **Total** | | **13** |

A Select2 select (non-posting) costs the same 8, plus the `setField` Select2 UI cycle (`:640-686`): findElements `s2id`, isDisplayed, label script, widget click, findElements search, isDisplayed, sendKeys label, `driver.wait` for results (selenium default 200 ms poll, 5 s cap), findElements choices, **`getText()` per visible choice (k RTs)**, choice click, and readback. That is **≥ 20 + k RTs**, plus up to 200 ms when results are not rendered on the first poll.

An AutoPostBack field whose value changes costs all of the above, plus `waitForPostback` (200 ms polls, each poll = captchaGuard 2 + requireSession 1 + script 1), `waitForSection` (2 CDP + `ready` ≥3 + wait ≥4), and `locateField` again (4).

Post-reload verification (`:1191-1202`) costs **2 RTs per filled field** (`findElement` + `getAttribute`).

Field mix (`fields.ts`), excluding the lookup-only occupation section:

| Section | Fields | text/date/textarea | select |
|---|---|---|---|
| personal | 25 | 18 | 7 |
| identification | 6 | 5 | 1 |
| health | 9 | 1 | 8 |
| character | 11 | 2 | 9 |
| adviser (only when represented) | 20 | 16 | 4 |
| workingHoliday | 7 | 2 | 5 |

Example, personal today: about 18×13 + 7×(21+k) + 2×25 + about 40 fixed per section ≈ **470+ RTs**, about 0.7 s of typing, and 7 Select2 UI cycles.

### A3. Fixed sleeps and long polling intervals

| Where | Interval | On wizard path? | Decision |
|---|---|---|---|
| `run.ts:313` `waitWithCaptcha` sleep | 200 ms | Yes, every wait | Fill-flow waits get `FAST_POLL_MS = 50` through a new optional param. Default stays 200 |
| `run.ts:225-276` CAPTCHA `driver.wait` poll | 200 ms | When a CAPTCHA appears | **Unchanged** (tested in `captcha.test.ts`) |
| `run.ts:265` token acceptance window | 10 s | CAPTCHA only | Unchanged |
| `capsolver.ts:69` / `two-captcha.ts:143,151` provider polls | 3 s / 5 s | CAPTCHA only | Unchanged (provider-mandated) |
| `run.ts:669` Select2 results `driver.wait` | 200 ms poll, 5 s cap | Every Select2 field | Avoided by the fast path. Kept in the fallback |
| `run.ts:495` sleep after country-tile scroll | 300 ms | Once per run | Unchanged |
| `run.ts:460` `countryPollMs` closed country/scheme re-check | 15 s | Pre-wizard | Unchanged (deliberate rate limit) |
| `run.ts:949` occupation search backoff, `:917` idle settle | 2 s/5 s, 3 s | Occupation only (excluded) | Unchanged |
| `run.ts:1634` `waitForChange` | 200 ms | Submission only | Unchanged |
| `chooseBrowser.ts:45` DevTools readiness | 250 ms | Startup once | Unchanged |

Quantization loss today: about 3 multi-poll waits per section × about 100 ms average ≈ 0.3 s per section. With 50 ms polls it drops to about 75 ms.

### A4. Redundant page-state checks and re-reads

- `waitForSection` runs before `saveStep` (`:1466`), and again inside `waitForPostback` (`:871`) right after the postback predicate has already confirmed the first field.
- `requireSession` runs once per field (`:1101`) and again in every `locateField` poll (`:767`).
- `captchaGuard` (2 RTs) runs on every `locateField` call on a page whose document hasn't changed.
- `remoteTrigger`, `getAttribute`, `isEnabled` and `isDisplayed` are 4 RTs for facts one script can return.
- Unchanged values are still cleared and retyped. For an AutoPostBack text field, `clear()` fires `change` and starts an unawaited postback (existing latent hazard).
- `activateChrome` (2 CDP) runs on every `waitForSection` and before every click. It is cheap and stays.

### A5. Slow waits after "Next"

There is no client-side Next. Each section is persisted by SAVE (`sectionSaveControl` → `postbackAndWait`, `sendKeys(SPACE)`, `:848`), then the same URL is re-fetched for verification (`:1184`), then the next section is fetched (`:1465`). Each of those three blocks on `load` (A1) and then on 200 ms polls (A3).

---

## Part B: Design

### B1. Files and responsibilities

| File | Change |
|---|---|
| `workflow/fast-fill.ts` (new) | Named constants; `fastFillEnabled()`; `isDisplayedAtomSource()`; `isNavigationError()`; pure `planSection()`, `fieldMismatch()`, `normalizeLabel()`, `addFilled()`; browser-script strings `NAV_WATCH_JS`, `SECTION_DOM_READY_JS`, `FILL_SEGMENT_JS`, `PRE_SAVE_SETTLE_JS`, `WAIT_FOR_FIELD_JS`, `READ_FIELD_VALUES_JS`; thin driver wrappers `readTimeOrigin()`, `fillSegment()`, `waitForFieldInPage()`, `readFieldValues()`, `sectionDomReady()`, `readSettleState()`, `waitForChangeThenLoad()`. Imports only `fields`, `conditions`, `saved-values`, `selenium-webdriver` types and `node:module`. **No import from `run.ts`** (avoids a cycle). |
| `workflow/run.ts` | Module-level `checkCancelled()`; one load wait in `captchaGuard` (B8); optional `pollMs` on `waitWithCaptcha`; `fast` parameter on `waitForSection`/`waitForPostback`/`postbackAndWait`/`saveStep`; `fastFillSection()` (two-pass, B5); existing loop body extracted verbatim into `legacyFillField()`; pre-SAVE settle + authoritative pass + re-verify; post-SAVE settle before `[errorlabel]`; batched post-reload verify; `finishApplication`'s `waitForChange` wrapped with `waitForChangeThenLoad` when `fast` (B4); named constants for touched literals; per-section timing log. |
| `browser/chooseBrowser.ts` | New optional trailing param `pageLoadStrategy: "normal" \| "eager" = "normal"` → `options.setPageLoadStrategy(...)`. Existing callers are unaffected. |
| `workflow/conditions.ts` | **Not modified.** The controller/dependent table used by the ordering test lives in `fast-fill.test.ts`. |
| `workflow/fast-fill.test.ts`, `workflow/captcha-load-wait.test.ts`, `workflow/submission-load-wait.test.ts` (new) | Unit tests with fake drivers. |
| `workflow/fast-fill-browser.test.ts` + `scripts/fixtures/fast-fill-harness.ts` (new) | Real headless Chrome against a local 127.0.0.1 fixture. |
| `workflow/submission.ts`, `submission.test.ts`, `payer-form.ts`, `capsolver*.ts`, `two-captcha.ts`, `section-policy.ts`, `data-validation.ts`, `captcha.test.ts` | **Not modified.** The user's batched-declaration change in `submission.ts`/`submission.test.ts` was uncommitted at baseline. It is now committed by the user as `3f4fb30` (`git status` is clean apart from `.agents/`). It is built on and never edited or reverted. |

### B2. Named constants (`fast-fill.ts`, reused by `run.ts`)

```ts
export const PAGE_POLL_MS = 200;                 // existing waitWithCaptcha default; CAPTCHA driver.wait unchanged
export const FAST_POLL_MS = 50;                  // fill-flow waits (section, postback, settle, field waits)
export const FIELD_WAIT_SLICE_MS = 500;          // max in-page MutationObserver wait before returning to Node
export const SECTION_WAIT_MS = 20000;            // existing first-field / locateField limit
export const POSTBACK_WAIT_MS = 30000;           // existing postback limit
export const READY_WAIT_MS = 30000;              // existing ready() limit; also the CAPTCHA load wait
export const PRE_SAVE_SETTLE_WAIT_MS = 30000;    // same bound as READY_WAIT_MS
export const SETTLE_STABLE_POLLS = 2;            // consecutive settled reads required before SAVE
export const DEPENDENT_FIELD_TIMEOUT_MS = 5000;  // required conditional field to become available
export const MAX_FIELD_RESUMES = 3;              // per-key missing/unavailable resume guard
export const MAX_UNEXPECTED_RELOADS = 2;         // undetected reloads tolerated per section
export const SUBMISSION_CHANGE_WAIT_MS = 30000;  // existing finishApplication waitForChange limit
```

`run.ts` replaces these literals with the constants, without changing their values: `:313` (`PAGE_POLL_MS`), `:716`/`:770` (`SECTION_WAIT_MS`), `:870` (`POSTBACK_WAIT_MS`), `:323` (`READY_WAIT_MS`) and `:1634` (`SUBMISSION_CHANGE_WAIT_MS`). The script timeout (`:1337`, 15000 ms) is well above `FIELD_WAIT_SLICE_MS`.

### B3. Kill switch, snapshotted per run

`fastFillEnabled(): boolean` returns `false` only when `process.env.NZWH_FAST_FILL` is `"0"` or `"false"` (case-insensitive). Otherwise it returns `true`. This follows the env-helper pattern of `captchaTimeoutMinutes()`.

It is read **once**:

- In `executeWorkingHoliday`: `const fast = fastFillEnabled() && isDisplayedAtomSource() !== null;`, before `chooseBrowser`. Then `chooseBrowser(..., fast ? "eager" : "normal")`.
- In `fillAndSaveWorkingHolidaySection`: the same expression at entry. Its driver is caller-provided, so the strategy is whatever the caller chose. Fast fill works under `normal` too; it just saves no load tails.

The boolean is passed explicitly as a `fast` parameter to `saveStep`, `waitForSection`, `waitForPostback`, `postbackAndWait` and `legacyFillField`. The default is `false`, so every unlisted call site (`authenticate`, `selectCountry`, occupation, submission) keeps today's behavior. When `fast` is false, the code paths are today's: `ready()`-based `waitForSection`, the `complete` postback predicate, 200 ms polls, the per-field legacy loop, and per-field post-reload verification. The only exception is the CAPTCHA load wait (B8). It exits on its first check, because `readyState` is already `complete` under `normal`.

### B4. Early fill: page-load strategy, DOM-ready predicate, visibility

**Decision: `pageLoadStrategy: "eager"`** when `fast` is true.

Alternatives considered:
- `none`: commands return before parsing finishes. That is too fragile for ASP.NET pages whose inline scripts run during parsing.
- Keep `normal` and navigate from `executeScript`: chromedriver still blocks the next command until `load`, so nothing is gained.

`eager` was measured to work in `debuggerAddress` attach mode, which `chooseBrowser` uses.

Effect on the rest of the run, corrected from iteration 1: explicit `navigate` + `ready()` pairs (`authenticate :375-386,416-418`, `selectCountry :470-472,519,543`, `advanceToWizard :615,623`) still wait for `complete`. **Click-driven navigations do not.** `clickApplyNow :568→:574`, the LOGIN click `:409→:414` and the country tile click `:496→:498` enter `waitWithCaptcha` → `captchaGuard` at DOMContentLoaded. Under `normal`, `click()` used to block until `load`. The only consumer that depends on `load` there is `readCaptchaChallenge`, which needs the reCAPTCHA anchor iframe. B8 restores that precondition inside `captchaGuard`, the single entry point. The other predicates in those waits (`currentState`, `readAuthState`, URL/handle checks) are URL or server-rendered-DOM checks, and they keep polling until true. `navigate`'s timeout fallback (`:331-352`) is unchanged. The CAPTCHA widget's own Submit click inside `captchaGuard` is already followed by a `readyState === 'complete'` wait (`:230`), so it needs no change.

**Submission and payment click sites.** `pageLoadStrategy` is per session, so in `fillAndSubmit` mode `finishApplication` also runs under `eager`. Four click-driven navigations there used to block until `load` inside `click()`:

| Site | Followed by | Risk under `eager` without a fix |
|---|---|---|
| `submission.ts:178` `page.payNow.click()` | `waitForChange(url changed)`, then `read()` and `options.ready()` | Low (`ready()` waits for `complete`), but `read()` runs first |
| `submission.ts:187` `nextStep.click()` | `waitForChange(url changed)` → `completePayerForm` | **Payer name filled at DOMContentLoaded of the gateway page**; a `load` script could reset or re-render it after readback, so OK is clicked with an unverified value |
| `submission.ts:276` `page.button.click()` (open declarations / final declaration submit) | `waitForChange(confirmed \| blocked \| payment \| url/stamp changed)` | `read()` classifies a page whose `load` scripts have not run; the loop's next `options.ready()` mitigates it but only after the classification used to break |
| `payer-form.ts:48` `current.ok.click()` | `waitForChange(form gone or changed)` | Card-page classification (`cardPage`) read before `load` |

Fix, in `run.ts` only (`submission.ts`/`payer-form.ts` stay byte-identical): when `fast`, the `waitForChange` option passed to `finishApplication` is `condition => waitForChangeThenLoad(driver, condition)`. `completePayerForm` receives the same function through `options.waitForChange` (`submission.ts:194`), so all four sites are covered.

```ts
// fast-fill.ts
/** Click-driven navigations no longer block until `load` under `eager`; restore that after the change condition holds. */
export async function waitForChangeThenLoad(
  driver: WebDriver,
  condition: () => Promise<boolean>,
  changeTimeoutMs = SUBMISSION_CHANGE_WAIT_MS,
  loadTimeoutMs = READY_WAIT_MS,
): Promise<void> {
  await driver.wait(condition, changeTimeoutMs);
  await driver.wait(
    () => driver.executeScript<boolean>("return document.readyState === 'complete'"),
    loadTimeoutMs,
  );
}
```

No `checkpoint()` is added inside it, so stop handling in the submission area is exactly today's (a stop request after a click is still honored at the next existing `options.checkpoint()`). A load timeout throws `TimeoutError`, which `finishApplication`'s existing `catch` turns into an `incomplete` result. Nothing is re-clicked or re-submitted. Under `normal` (kill switch) the existing `condition => driver.wait(condition, SUBMISSION_CHANGE_WAIT_MS)` is passed unchanged.

**Visibility parity (`isShown`).** Today's availability rule is `!(await isEnabled()) || (kind !== "select" && !(await isDisplayed()))` (`:1115-1118`). In selenium-webdriver, `WebElement.isDisplayed()` is not a native command. `lib/http.js:277` turns it into `executeScript("return (" + atom + ").apply(null, arguments)")` with the `lib/atoms/is-displayed.js` atom (`isShownElement`). The design embeds **the same atom source** in the in-page scripts. That gives exact parity, so no heuristic `getClientRects` or ancestor walk is needed:

```ts
// fast-fill.ts
import { createRequire } from "node:module";
let atom: string | null | undefined;
/** Same function selenium-webdriver sends for WebElement.isDisplayed(); null if unavailable. */
export function isDisplayedAtomSource(): string | null {
  if (atom !== undefined) return atom;
  try {
    const fn = createRequire(import.meta.url)("selenium-webdriver/lib/atoms/is-displayed.js");
    atom = typeof fn === "function" ? String(fn) : null;
  } catch { atom = null; }
  return atom;
}
```

The scripts define `const isShown = (${atomSource});` and `const enabled = e => !e.matches(':disabled');`. `:disabled` is the W3C "is element enabled" rule for form controls, including inherited `fieldset[disabled]`. So `available(e, kind) = enabled(e) && (kind === 'select' || isShown(e))`, identical to today.

If the atom cannot be loaded (package layout change), `fast` is false for the run. The log line is `[NZWH] Fast entry unavailable; using standard entry.` A unit test pins that the atom loads as a function. A fixture test asserts parity of `isShown`/`enabled` against `WebElement.isDisplayed()`/`isEnabled()` across `display:none`, hidden ancestor, `visibility:hidden`, `opacity:0`, zero-size, `overflow:hidden` clipping, `disabled` and `fieldset[disabled]`. The atom is about 17 KB per script call. On a local WebDriver connection that is well under 1 ms.

**Navigation watch** `NAV_WATCH_JS` is a shared prefix concatenated at the top of `SECTION_DOM_READY_JS`, `FILL_SEGMENT_JS` and `PRE_SAVE_SETTLE_JS`, so every document that the fill, the barrier or the DOM-ready wait reads is watched, including a document reached through a legacy posting field or a legacy refill. It is idempotent per document and passive:

```js
if (!window.__nzwhNavWatch) {
  window.__nzwhNavWatch = true; window.__nzwhNavigating = false;
  addEventListener('beforeunload', () => { window.__nzwhNavigating = true; });           // never preventDefault
  if (window.navigation) navigation.addEventListener('navigate', ev => {
    if (!ev.destination.sameDocument) window.__nzwhNavigating = true; });
}
```

**DOM-ready predicate** `SECTION_DOM_READY_JS` (= `NAV_WATCH_JS` + the body below), with args `[firstFieldId]`, is used by the fast `waitForSection` and the fast `waitForPostback`:

```js
const manager = typeof Sys !== 'undefined' && Sys.WebForms && Sys.WebForms.PageRequestManager
  ? Sys.WebForms.PageRequestManager.getInstance() : null;
const sheetsLoaded = Array.from(document.querySelectorAll('link[rel~="stylesheet"]')).every(l => l.sheet);
return document.readyState !== 'loading'
  && (sheetsLoaded || document.readyState === 'complete')
  && !(manager && manager.get_isInAsyncPostBack())
  && (typeof jQuery === 'undefined' || jQuery.active === 0)
  && !!document.getElementById(arguments[0]);
```

The stylesheet clause exists because `isShown` and the `[errorlabel]` check depend on layout. A stylesheet that never loads never gets `.sheet`, so `complete` unblocks that case.

**Fast `waitForSection(driver, name, fast = true)`**: `activateChrome` → `waitWithCaptcha(driver, async () => { await requireSession(driver); return sectionDomReady(driver, firstId); }, SECTION_WAIT_MS, FAST_POLL_MS)`. There is no separate `ready()`.

**Fast `waitForPostback(driver, name, stamp, fast = true)`**: the same predicate plus `performance.timeOrigin !== stamp`, with `POSTBACK_WAIT_MS` and `FAST_POLL_MS`. Then **only `activateChrome`**. The trailing `waitForSection` is dropped, because the predicate already covers it. Legacy (`fast = false`) is unchanged and keeps the trailing `waitForSection`. A partial UpdatePanel postback still times out into `SectionPostbackTimeoutError`, exactly as today.

**Early-field detection.** Server-rendered WebForms fields exist by DOMContentLoaded, so the fill script runs as soon as the predicate holds. A field that is missing, or required but unavailable, is waited for with `waitForFieldInPage`. That is a `MutationObserver` inside `executeAsyncScript` that resolves the moment the condition holds. Node loops slices inside `waitWithCaptcha(..., limit, FAST_POLL_MS)`, so cancel, site-busy, CAPTCHA and session checks still run at least every ~550 ms.

Helper signatures (`fast-fill.ts`):

```ts
export type FieldWaitMode = "present" | "available";
/** "ready": condition holds. "loaded": untilLoad was set and the document reached `complete` first. "pending": slice elapsed. */
export type FieldWaitResult = "ready" | "loaded" | "pending";

export const readTimeOrigin = (driver: WebDriver): Promise<number> =>
  driver.executeScript<number>("return performance.timeOrigin");

/** One bounded in-page wait (≤ sliceMs). Navigation errors resolve "pending"; the next fillSegment sees the reload. */
export async function waitForFieldInPage(
  driver: WebDriver, id: string, mode: FieldWaitMode, sliceMs: number, untilLoad: boolean,
): Promise<FieldWaitResult>;
```

Node usage: `waitWithCaptcha(driver, async () => { checkCancelled(); const r = await waitForFieldInPage(driver, id, mode, FIELD_WAIT_SLICE_MS, untilLoad); return r === "pending" ? null : r; }, limit, FAST_POLL_MS)`. The first pass sets `untilLoad = true`; the authoritative pass sets it `false` (B5).

`WAIT_FOR_FIELD_JS` (args `[id, mode, slice, untilLoad]`):

```js
const [id, mode, slice, untilLoad] = arguments, done = arguments[arguments.length - 1];
const isShown = (/* atom source */);
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

### B5. Batched fill: planner, in-page script, orchestration

**Pure planner** `planSection(name: SectionName, data: ApplicationData): FillEntry[]`:

```ts
export interface FillEntry {
  key: string; id: string; kind: FieldDefinition["kind"];
  expected: string;          // expectedFieldValue(name, key, data[name][key])
  applicable: boolean;       // applicable(data, name, key)
  colonsPrepared: boolean;   // expected !== source, for the existing log line
}
```

The planner keeps definition order and applies today's pre-locate skips exactly: it drops `field.lookup` entries, and drops `adviser.exemptionReason` when not applicable (`:1102-1108`). The in-page script decides the availability and applicability rules when each field is reached, in today's order (`:1115-1124`): availability first, then applicability.

**In-page script** `FILL_SEGMENT_JS` (= `NAV_WATCH_JS` + body) is one `executeScript` call, with args `[entries, start, deferClears]`. Values travel only as `arguments`, never interpolated into script text. All page scripts are written as `String.raw` templates (the `payer-form.ts` style), so regex escapes such as `\s` reach the page intact. It processes entries from `start` in order and stops at the first boundary:

```
for i from start:
  e = getElementById(id)                                     -> stop {i, 'missing'}
  if !(enabled(e) && (kind === 'select' || isShown(e))):
      if applicable && expected -> stop {i, 'unavailable-required'}
      else result 'skipped-unavailable'; continue
  if !applicable && expected: result 'skipped-inapplicable'; continue
  if e.value === expected: result 'unchanged'; continue        // no events, no postback
  if deferClears && expected === '': result 'deferred'; continue   // early pass only (B5 orchestration)
  if REMOTE_TRIGGER(e): stop {i, 'posting'}                    // Node handles via legacy path
  apply by kind (table below); verify in-page; on failure stop {i, 'fallback', cause}
  result 'filled'
return { results: [{ key, status }], stop: { index, reason, cause? } | null, timeOrigin: performance.timeOrigin }
```

**Result contract:** results carry `{ key, status }` (`filled | unchanged | deferred | skipped-unavailable | skipped-inapplicable`), and stops carry `{ index, reason, cause? }`. They never carry field values. That way no later log line can echo applicant data by accident.

`REMOTE_TRIGGER` is today's `remoteTrigger` body (`:723-728`), moved into a shared string constant. Both paths use the identical regex. Availability is re-evaluated after the earlier fields' events have run synchronously. That keeps today's sequential semantics for client-side show/hide handlers.

**Per control type: chosen method** (fast path, in-page):

| Control | Fast path | Verify (in-page) | Fallback cause → `legacyFillField` |
|---|---|---|---|
| text / textarea | If `maxLength >= 0 && expected.length > maxLength` → `too-long`, because typing would truncate and legacy then reproduces today's readback stop. Otherwise use the native setter `Object.getOwnPropertyDescriptor(HTMLInputElement\|HTMLTextAreaElement.prototype,'value').set.call(e, v)`, then dispatch `InputEvent('input',{bubbles})`, `Event('change',{bubbles})`, `FocusEvent('focusout',{bubbles})`, `FocusEvent('blur')`. **No `focus` dispatch.** | `e.value === expected` | `too-long`, `value-rejected` |
| date (`*_DatePicker` text inputs) | Same as text. No `focus`/`focusin`, so a picker overlay never opens | `e.value === expected` | `value-rejected` |
| native `<select>` (no shown `#s2id_<id> a.select2-choice`) | If no `option.value === expected` → `option-missing` (legacy throws today's "Option no longer exists."). Otherwise set `e.value = expected`, then dispatch `input`, `change` (bubbles) | `e.value === expected` | `option-missing`, `value-rejected` |
| Select2 v3 select (detected exactly as legacy `setField` does, `:637`: `document.querySelector('#s2id_' + id + ' a.select2-choice')` exists and `isShown` is true) | Same native set + `change`. Select2 v3 binds `change` on the original element and re-renders the chosen label. Clearing (`""`) works only when a `""` option exists; otherwise `clear-unsupported` | native value **and** `normalizeLabel(#s2id_<id> .select2-chosen text) === normalizeLabel(selected option textContent)` (skipped for `""`), where `normalizeLabel = s => s.replace(/\s+/g, ' ').trim()` (identical in page and Node). Missing `.select2-chosen` → `widget-unknown` | `option-missing`, `clear-unsupported`, `widget-mismatch`, `widget-unknown` |
| radio / checkbox | None exist in `fields.ts`. Declarations keep the committed batch in `submission.ts` (real `el.click()`), unchanged | n/a | n/a |
| AutoPostBack field (any kind, value changes) | **Not fast-filled.** The script stops with `posting`. Node runs `legacyFillField`: emit `persistence: possible` → stamp → UI `setField` → `waitForPostback` → relocate → readback. Real UI interaction is kept wherever the server is involved | legacy readback | always legacy |
| Occupation widget (search + results + Selected Value label) | **Unchanged.** Excluded by `section-policy.ts` (`automatedSection('occupation') === false`). The legacy `occupationSelection`/`typeQuery` keystroke path stays as it is | n/a | n/a |
| Login form, payer name | Unchanged (once per run, about 4 RTs; credentials stay on `sendKeys`) | | |

A `fallback` stop logs `[NZWH] ${name}.${key}: fast entry not accepted (${cause}); using standard entry.` with the cause code only.

**Module-level cancel check** (`run.ts`), also reused inside `captchaGuard` in place of its closure:

```ts
function checkCancelled(): void {
  if (execution.getStore()?.signal?.aborted) throw new StopRequested();
}
```

**Report bookkeeping.** `addFilled(report, key)` pushes only when `!report.filled.includes(key)`, so `report.filled` stays de-duplicated in first-recorded order. Refills after a reload never double-count in `coverage-saved.json`, `section-result.checked` or the post-reload verification. Statuses `filled` and `unchanged` record the key. `skipped-*` and `deferred` do not, which matches today, where skipped fields are never pushed. `legacyFillField` uses `addFilled` too, so legacy mode sees no change because each key is visited once. **`report.filled` is rebuilt per document**: it is reset to `[]` at the start of each pass and inside `onReload`, so it always describes the settled document SAVE will post. Nothing in a section is persisted before SAVE, so discarding entries from an earlier pass or document loses nothing. `report.persisted`/`report.lookups` are only written after SAVE and are untouched.

**Orchestration** `fastFillSection(driver, name, data, report, url)`:

The section is filled in **two passes over the same `entries`**. The *early pass* fills each field the moment it exists, starting at DOMContentLoaded. The *authoritative pass* runs after the settle barrier, on the DOM that today's code would see (after `load`), and re-evaluates every field with today's rules. Fields already correct are `unchanged` (no events, no write), so on a typical page the second pass is one round trip. This is what makes early fill safe against `load`-time show/hide, value resets and widget init: no decision taken at DOMContentLoaded is final.

```
entries = planSection(name, data); reloads = 0
stamp = await readTimeOrigin(driver)
resumes = { early: new Map<string, number>(), authoritative: new Map<string, number>() }   // per key; NOT reset on reload
onReload = async () => {                       // shared by both passes and both settle barriers
  await emit({ type: 'persistence', state: 'possible' })   // conservative for session recovery
  if (++reloads > MAX_UNEXPECTED_RELOADS) throw new WorkingHolidayStop("Form reloaded repeatedly while filling; stopped.")
  await waitForSection(driver, name, true); stamp = await readTimeOrigin(driver)
  report.filled = []                           // keys from the old document are not evidence for the new one
}

runPass(pass: 'early' | 'authoritative'): Promise<'reloaded' | { wrote: boolean }> {
  report.filled = []; index = 0; wrote = false
  while index < entries.length:
    checkCancelled()
    await requireSession(driver)               // 1 RT per segment, not per field
    out = await fillSegment(driver, entries, index, /* deferClears */ pass === 'early')
                                               // navigation error -> {results:[], stop:null, timeOrigin:NaN}
    if (!(out.timeOrigin === stamp)) return 'reloaded'      // NaN also takes this branch; checked before stop
    for r of out.results:
      if r.status in {filled, unchanged} addFilled(report, r.key)
      if r.status === 'filled' wrote = true
      existing per-key log line (key + status only)
    if (!out.stop) break
    { index: i, reason } = out.stop; entry = entries[i]
    switch reason:
      'missing' | 'unavailable-required':
         n = (resumes[pass].get(entry.key) ?? 0) + 1; resumes[pass].set(entry.key, n)
         if n > MAX_FIELD_RESUMES -> throw reason's existing message (below)
         mode = reason === 'missing' ? 'present' : 'available'
         if pass === 'early':
           // Wait for the field OR for `load`, whichever comes first. Never fatal here.
           r = await waitForField(entry.id, mode, untilLoad: true, limit: PRE_SAVE_SETTLE_WAIT_MS)  // TimeoutError -> 'loaded'
           index = r === 'ready' ? i : i + 1    // 'loaded': defer to the authoritative pass
         else:
           r = await waitForField(entry.id, mode, untilLoad: false,
                 limit: reason === 'missing' ? SECTION_WAIT_MS : DEPENDENT_FIELD_TIMEOUT_MS)
           TimeoutError -> throw reason's existing message
           index = i
      'posting' | 'fallback':                  // always advance; no resume guard needed
         await legacyFillField(driver, name, entry.key, data, report, true)
         stamp = await readTimeOrigin(driver); wrote = true; index = i + 1
  return { wrote }
}

fill: while (true) {
  if ((await runPass('early')) === 'reloaded')  { await onReload(); continue fill }      // (1) early pass
  if ((await settle()) === 'reloaded')          { await onReload(); continue fill }      // (2) settle barrier
  p = await runPass('authoritative')                                                       // (3) authoritative pass
  if (p === 'reloaded')                         { await onReload(); continue fill }
  if (p.wrote && (await settle()) === 'reloaded') { await onReload(); continue fill }    // (4) settle again if it wrote
  await reverify()                                                                         // (5) batched, no refill
  break
}
// (6) occupation lookups (excluded)  (7) unmapped-field check (existing script, unchanged)
// (8) captchaGuard  (9) URL check  (10) sectionSaveControl → postbackAndWait(fast)
// (11) post-SAVE settle, then the existing [errorlabel] check and post-SAVE steps (below)
```

`waitForField(id, mode, untilLoad, limit)` is `waitWithCaptcha(driver, async () => { checkCancelled(); const r = await waitForFieldInPage(driver, id, mode, FIELD_WAIT_SLICE_MS, untilLoad); return r === "pending" ? null : r; }, limit, FAST_POLL_MS)`.

The reasons' existing messages are reused verbatim, and only the authoritative pass (or the resume guard) throws them: `missing` → `"Expected form control did not become available."`, and `unavailable-required` → `` `Required conditional field unavailable: ${name}.${key}.` ``.

Why each rule exists:

- **Early `missing`/`unavailable-required` is never fatal.** At DOMContentLoaded a field can be legitimately hidden until a `load` handler shows it. Today that field is evaluated after `load` and filled. The early pass waits for it event-driven and fills it the moment it appears; if `load` arrives first (`readystatechange` → `complete` fires before `load` handlers, so the field may still appear), it defers. The authoritative pass then decides on the settled DOM with today's rule plus a bounded wait (`DEPENDENT_FIELD_TIMEOUT_MS` / `SECTION_WAIT_MS`), so a required field that never becomes available still stops with today's message.
- **The early pass defers clears (`expected === ""`).** The only early write whose effect the authoritative pass could not detect is a clear into a field that `load` then hides (hidden + `""` is `skipped-unavailable`, which is not an error). Today that field would not be touched. Deferring clears to the authoritative pass removes the case. A non-empty early write into a field that `load` hides is still caught: hidden + applicable + non-empty → `unavailable-required` → today's stop.
- **`report.filled` is rebuilt by the authoritative pass.** A key filled early and hidden or made inapplicable at `load` is not in `report.filled`, so re-verify and post-reload verification do not demand a value the settled page does not carry (no spurious `Readback mismatch`). A field shown late is in it (`filled`/`unchanged`), so it is verified before SAVE and after reload.
- **Second settle only if the authoritative pass wrote.** If every field was `unchanged`, the pass dispatched no events and started no async work, so the barrier's result still holds.
- **Re-verify has no refill.** The authoritative pass is the refill (one fast attempt per field, with legacy fallback inside it). A value that changes again after it is a page behavior the automation cannot reason about, so it stops with today's `Readback mismatch`, which is stricter than today (today such a change surfaces only in post-reload verification).
- **Bounds.** Each pass is bounded by `entries.length` plus `MAX_FIELD_RESUMES` per key; the outer loop is bounded by `MAX_UNEXPECTED_RELOADS`. Legacy postbacks update `stamp` and are not "unexpected".

**Settle barrier** `settle(): Promise<'settled' | 'reloaded'>`:

```ts
// fast-fill.ts
export const PRE_SAVE_SETTLE_JS = NAV_WATCH_JS + String.raw`
  const manager = typeof Sys !== 'undefined' && Sys.WebForms && Sys.WebForms.PageRequestManager
    ? Sys.WebForms.PageRequestManager.getInstance() : null;
  return { timeOrigin: performance.timeOrigin,
           navigating: window.__nzwhNavigating === true,
           settled: document.readyState === 'complete'
             && !(manager && manager.get_isInAsyncPostBack())
             && (typeof jQuery === 'undefined' || jQuery.active === 0) };`;
```

In `run.ts`, with `stable = 0`, run `waitWithCaptcha(driver, async () => { await requireSession(driver); const s = await readSettleState(driver); ... }, PRE_SAVE_SETTLE_WAIT_MS, FAST_POLL_MS)`. The condition returns:

- `"reloaded"` for any read with `s.timeOrigin !== stamp`.
- `false` and `stable = 0` if `s === null` (navigation error, see B9), `s.navigating`, or `!s.settled`. A navigation is in flight or the page is still busy. A navigation in flight always resolves into a later read with a new `timeOrigin`.
- `"settled"` once `++stable >= SETTLE_STABLE_POLLS`. Otherwise `false`.

On timeout it throws `WorkingHolidayStop("Page did not settle before SAVE; stopped.")`.

The two-read requirement, `FAST_POLL_MS` apart, covers `setTimeout(..., 0)`-deferred postbacks and handlers that start AJAX in the next task. The navigation watch covers the case the review raised, `setTimeout(() => form.submit(), 0)` on the last field. While the request is in flight, the old document stays alive with `readyState === 'complete'` and an unchanged `timeOrigin`. `beforeunload`/`navigate` flags it, so the barrier keeps waiting until the new document arrives, and then `"reloaded"` takes the reload path. Because `PRE_SAVE_SETTLE_JS` itself starts with `NAV_WATCH_JS`, the watch is installed on every document the barrier reads, even one reached through a legacy posting field or a legacy fallback where no `fillSegment` ran (in that case the first barrier read installs it, which can only miss a navigation started before that read; such a navigation still surfaces as a new `timeOrigin` on a later read). Filling still starts at DOMContentLoaded. Only the authoritative pass, verify and SAVE wait for `load`.

**Re-verify** `reverify()`: one `readFieldValues` RT (`READ_FIELD_VALUES_JS`) over `report.filled`, in order. Per id it returns `{ value: string, chosenLabel: string | null, optionLabel: string | null } | null`. `chosenLabel` is `null` unless the Select2 widget is detected with the same rule as the fill script (`#s2id_<id> a.select2-choice` exists and `isShown`), in which case it is the `#s2id_<id> .select2-chosen` text. `optionLabel` is the selected option's `textContent` for selects, otherwise `null`. Values are compared in Node memory and never logged. The comparison is the pure function `fieldMismatch(entry, read)`:

```ts
/** Same normalization as the in-page Select2 verify (nbsp and line breaks collapse to one space). */
export const normalizeLabel = (s: string): string => s.replace(/\s+/g, " ").trim();

// null read -> caller throws WorkingHolidayStop("Expected form control did not become available.")
export function fieldMismatch(entry: FillEntry, read: FieldRead): boolean {
  return read.value !== entry.expected ||
    (entry.kind === "select" && entry.expected !== "" && read.chosenLabel !== null &&
     normalizeLabel(read.chosenLabel) !== normalizeLabel(read.optionLabel ?? ""));
}
```

The first mismatch throws `` `Readback mismatch: ${name}.${key}.` `` (key only). JavaScript's `\s` includes U+00A0, so `&nbsp;` in option text never creates a new stop that today's value-only check would not raise.

**Fast SAVE path.** `postbackAndWait(driver, save, name, true)` is today's function. It stamps, calls `activateChrome`, emits `possible`, then `sendKeys(SPACE)`. The only difference is that it calls the fast `waitForPostback`. The pathname check and `emit accepted` are unchanged.

**Post-SAVE settle before the server-validation check** (fast mode only; `run.ts` `saveStep`, between the pathname check and the `[errorlabel]` count at `:1176-1182`). Today the count runs after `load` (the old `waitForPostback` required `complete`). If the site's script reveals error labels in a `load` handler, counting at DOMContentLoaded would return 0, and a mandatory flag on a field the automation never fills (blank in the data, or a branch the server still requires) would not be in `report.filled`, so reload verification would not catch it either. The design therefore restores the `load` precondition for this check:

```ts
try {
  await waitWithCaptcha(driver, async () => {
    await requireSession(driver);
    const s = await readSettleState(driver);          // null on navigation error -> keep polling
    return s !== null && s.settled;                   // complete, no async postback, jQuery idle
  }, READY_WAIT_MS, FAST_POLL_MS);
} catch (error) {
  if (error instanceof Error && error.name === "TimeoutError") throw new SectionPostbackTimeoutError(name);
  throw error;
}
// then the existing [errorlabel] script, message and stop, unchanged
```

It deliberately ignores `navigating` (only `settled` matters here), so a stuck navigation flag cannot block it. A timeout maps to `SectionPostbackTimeoutError`, the same class today's `complete`-based SAVE wait throws when the response page never finishes loading, so the existing handling (never replayed) applies. The SAVE response page's load tail is therefore no longer saved (B11).

**Post-reload verification**: `navigate` + fast `waitForSection` + the existing URL/ApplicationId check, then one `readFieldValues` RT over `report.filled` (rebuilt by the authoritative pass, so it lists exactly the keys present and applicable on the settled pre-SAVE document). It reads values at DOM-ready: these are the server-rendered values, which is what "persisted" means; a `load` script that later rewrites a value is not the server's doing. A `null` read throws `WorkingHolidayStop("Expected form control did not become available.")`. Today a `NoSuchElementError` there also stops the run. The value comparison (`actual !== expected`, value only, as today), `savedValueDiagnostic` logging, `SavedValueVerificationError` and `emit verified` are unchanged.

**`legacyFillField(driver, name, key, data, report, fast)`** is today's loop body (`:1101-1148`) moved verbatim. The two changes are `addFilled` in place of `push`, and passing `fast` to `waitForPostback`. With `fast = false` the legacy path is `for (key of keys) await legacyFillField(...)`, followed by today's post-loop code. The kill switch therefore runs today's logic.

**Timing log** (no values): `[NZWH] ${name}: fill ${a}ms (fast ${f}, unchanged ${u}, standard ${s}), settle ${t}ms, save ${b}ms, verify ${c}ms.` This line measures the live savings.

### B6. Correctness: dependent and conditional fields

- **Order invariant (owner: `fields.ts` definition order, guarded by a test).** A `conditionalControllers` table defined **inside `fast-fill.test.ts`** (not exported from production code; `conditions.ts` is unchanged) lists `{section,key}` dependents with `{section,key}` controllers: `personal.title`→`personal.otherTitle`; health Yes/No → `health.details`; `character.deported`→`deportedDate`/`deportedCountry`; charge questions → `character.details`; `workingHoliday.beenToNz`→`previousVisitDate`; `adviser.adviserType`→`adviser.exemptionReason`; `personal.representedByAdviser`→all adviser keys. The ordering test asserts "controller precedes dependent" **only when both are in the same section**. The cross-section adviser dependency is enforced by the existing section skip (`run.ts:1446-1450`, "Adviser skipped"), and a test asserts that `applicable()` returns false for every adviser key when `representedByAdviser !== "Yes"`.
- **Client-side dependents** (no postback): the controller's events run synchronously before the dependent's availability is checked. If a required dependent is not available yet (animation, `setTimeout`), Node waits event-driven (early pass: until it appears or `load`; authoritative pass: up to `DEPENDENT_FIELD_TIMEOUT_MS`), then resumes. Today such a field fails immediately after `load`, so this is more tolerant and never fills inapplicable fields.
- **Server-side dependents** (AutoPostBack): the controller goes through the legacy path and waits for the full postback. The next segment then sees the re-rendered dependents. Earlier values were posted with the form. If the server cleared any, the authoritative pass refills them.
- **Late page scripts and async work**: `window.onload` handlers (widget init, value resets, show/hide), deferred postbacks and AJAX all complete before the settle barrier passes. Every availability, applicability and value decision is then re-taken by the authoritative pass on the settled DOM, so a field shown at `load` is filled, a field hidden at `load` drops out of `report.filled` (or stops with today's message if it is required), and a value reset at `load` is rewritten. Re-verify, the unmapped-field gate and SAVE run only after that pass and, if it wrote anything, a second settle. If the authoritative pass triggers a postback that reveals branch fields, the unmapped-field gate still sees them (step order 1-7).
- **Server validation after SAVE**: counted only after the SAVE response page has settled (`load` complete), as today, so mandatory flags on fields the automation does not fill still stop the run.
- **payer-form**: a single field outside the wizard, unchanged.

### B7. Additional speedups

| Change | Rationale |
|---|---|
| Skip writing fields whose value already matches | Saves the write and avoids the unawaited-postback hazard of `clear()`. SAVE still posts all values, and the reload verifies them |
| One session probe per segment instead of 2 per field | The session can only change through navigation, which the `timeOrigin` check and settle barrier detect |
| CAPTCHA/site-busy probe once per wait iteration instead of per field | Same detector. It still runs in every wait, during settle, and right before SAVE |
| Batched pre-SAVE and post-reload verification (2N → 1 RT) | Same comparison logic, written as a pure function |
| 50 ms polls for fill-flow waits | Cuts about 75% of quantization delay. Polls are local `executeScript` calls |
| Reuse the Selenium atom instead of a hand-written visibility check | Exact parity with today's `isDisplayed()` and no extra RT per field |
| Selector caching | **Rejected.** IDs are static and `getElementById` is O(1). Cached `WebElement`s go stale across postbacks |
| Parallel tabs / prefetching the next section | **Rejected.** A single ASP.NET session with ViewState risks server-side races and unverifiable writes |
| Submit.aspx DOM-only ready | **Backlogged** (below) |

### B8. Hard constraints and how each is kept

- **CAPTCHA (manual, auto-submit, provider fallbacks).** `captchaPending`, `captchaSubmitCandidate`, `capsolver*`, `two-captcha` and the CAPTCHA `driver.wait` (200 ms, 10 s acceptance) are not modified. **One addition in `captchaGuard`**, inside the provider branch (`captchaMode` is `capsolver` or `2captcha`), immediately before `readCaptchaChallenge`:

  ```ts
  // Under the eager page-load strategy a CAPTCHA page can be seen before its widget
  // script inserted the anchor iframe. Wait (cancel-aware, bounded) for the load event
  // that `normal` used to guarantee, then read the challenge as today.
  // Boolean form, as at run.ts:230/:339; captcha.test.ts's fixture answers readyState scripts with a boolean.
  const loadDeadline = Date.now() + READY_WAIT_MS;
  while (Date.now() < loadDeadline &&
         !(await driver.executeScript<boolean>("return document.readyState === 'complete'"))) {
    checkCancelled();
    await assertSiteAvailable(driver);
    await new Promise(resolve => setTimeout(resolve, PAGE_POLL_MS));
  }
  // On deadline fall through unchanged: readCaptchaChallenge decides as today.
  ```

  It is placed in the provider branch rather than right after `captchaPending`, so manual mode keeps its exact call sequence. The existing `captcha.test.ts` case "a disappearing challenge waits for its destination page to finish loading" counts `readyState` reads in manual mode. Manual mode doesn't read the challenge, and its `driver.wait` keeps polling for the CAPTCHA-only Submit and completion. Under `normal`, and against the existing `captcha.test.ts` fixture (`fixture()` lines 16-21 return `ready.shift() ?? true` for any script containing `document.readyState`, and every provider-mode test passes an empty `ready` array), the loop exits on its first read, so those ~15 provider tests see one extra `executeScript` call and no delay. The only test that passes a non-empty `ready` array (line 54) is manual mode, which never enters this branch. Inline widgets that appear only after `load` on wizard pages are caught by the `captchaGuard` that runs after the settle barrier (which waits for `complete`) and before SAVE. `waitWithCaptcha` gains only an optional `pollMs` (default `PAGE_POLL_MS`). `captcha.test.ts` is not edited.
- **Site-busy, stop/cancel, checkpoint, events.** `assertSiteAvailable` runs in every `waitWithCaptcha` iteration and in the CAPTCHA load wait. `checkCancelled()` runs before every fill RT, in every wait iteration, and at least every `FIELD_WAIT_SLICE_MS + FAST_POLL_MS` (≈550 ms) during field waits. `checkpoint()` is a deliberate no-op inside a running section (`execution-controller.ts:101`), and no new checkpoints are added. Events: `section-start`, `persistence possible` (before every posting field and SAVE, plus conservatively on unexpected reloads), `accepted`, `verified`, `section-result` and the coverage files are unchanged. `report.filled` is de-duplicated, so counts stay correct.
- **No auto-submit of the final application or any unsafe submission.** The fill code never clicks. It only sets values and dispatches non-submitting events. The navigation watch is passive and never calls `preventDefault`. SAVE goes only through `sectionSaveControl`, which refuses final SUBMIT. `finishApplication` and its mode gating are untouched. The existing `fillAndSubmit` mode still submits only when the user explicitly chose it; this design neither adds nor removes that. Because `eager` would otherwise let the submission and payer-form steps read pages before `load`, `run.ts` passes `waitForChangeThenLoad` as `waitForChange` (B4), which restores the `load` precondition after each of the four click sites without editing `submission.ts` or `payer-form.ts`. The payer name is therefore still filled and read back only on a fully loaded gateway page, and the declaration/receipt classification still sees the loaded page. Section policy (`automatedSection`, `requestedSections`) and `validateData` are untouched.
- **No secrets/PII in logs.** New log lines carry keys, status/cause codes, counts and durations only. Fill-script results exclude values. `readFieldValues` values are compared in memory and reach logs only through the existing `savedValueDiagnostic`, which never prints values.
- **User's submission changes.** These are now committed (`3f4fb30`). `submission.ts` and `submission.test.ts` are not edited.
- **No new dependencies.** The atom ships inside the existing `selenium-webdriver`.

### B9. Error handling

Shared helper in `fast-fill.ts`:

```ts
const NAVIGATION_ERROR = /document unloaded|target frame detached|execution context was destroyed|no such execution context|navigat/i;
export function isNavigationError(error: unknown): boolean {
  return error instanceof Error &&
    (error.name === "JavascriptError" || error.name === "WebDriverError") &&
    NAVIGATION_ERROR.test(error.message);
}
```

`NoSuchWindowError`, `NoSuchSessionError` and `ScriptTimeoutError` are deliberately excluded. They are not reloads and keep today's handling.

| Operation | Failure | Recoverable? | Caller receives | Logged |
|---|---|---|---|---|
| `fillSegment` | `isNavigationError` | yes, bounded by `MAX_UNEXPECTED_RELOADS` | `{ results: [], stop: null, timeOrigin: NaN }` → reload path; beyond the bound `WorkingHolidayStop("Form reloaded repeatedly while filling; stopped.")` | `[NZWH] ${name}: form reloaded while filling; refilling.` (no values) |
| `fillSegment` | other error | no | rethrown → section loop generic handling (as today) | existing |
| `waitForFieldInPage` | `isNavigationError` | yes | `"pending"`; the next `fillSegment` detects the reload | none |
| early-pass field wait | field neither appears nor `load` arrives within `PRE_SAVE_SETTLE_WAIT_MS` | yes | treated as `"loaded"` → deferred to the authoritative pass (which applies today's stop) | none |
| `waitForFieldInPage` | other error | no | rethrown | existing |
| `readSettleState` | `isNavigationError` | yes | `null` → barrier keeps waiting; the next read sees the new `timeOrigin` → reload path | none |
| settle barrier | not settled within `PRE_SAVE_SETTLE_WAIT_MS` | no | `WorkingHolidayStop("Page did not settle before SAVE; stopped.")` | message |
| settle barrier | navigation flag stuck: `beforeunload`/`navigate` fired but the navigation was cancelled or produced no new document (e.g. a 204 response, a download) | no | the flag stays `true` on the live document, so the barrier never counts a stable read and ends in the timeout row above, a safe stop before SAVE | message |
| post-SAVE settle | SAVE response page not `complete`/idle within `READY_WAIT_MS` | no (never replayed) | `SectionPostbackTimeoutError(name)` (same class as today's SAVE wait timeout) | existing |
| `waitForChangeThenLoad` (submission/payer) | change or `load` not reached within 30 s | no | `TimeoutError` → `finishApplication`'s existing `catch` → `incomplete` result; nothing re-clicked | existing `incomplete` message |
| `readFieldValues` (pre-SAVE, post-reload) | any error, including navigation | no | rethrown → today's generic stop | existing |
| field missing | not present within `SECTION_WAIT_MS`, or resumes > `MAX_FIELD_RESUMES` | no | `WorkingHolidayStop("Expected form control did not become available.")` | existing message |
| required dependent | not available within `DEPENDENT_FIELD_TIMEOUT_MS`, or resumes > max | no | `` WorkingHolidayStop(`Required conditional field unavailable: ${name}.${key}.`) `` | existing |
| fast value not accepted | any fallback cause | yes | legacy path; its errors as today | cause code |
| pre-SAVE re-verify | mismatch after the authoritative pass (and second settle, if it wrote) | no | `` WorkingHolidayStop(`Readback mismatch: ${name}.${key}.`) `` | key only |
| CAPTCHA load wait | deadline | yes | falls through to `readCaptchaChallenge` (today's decision) | none |
| CAPTCHA load wait | abort / site busy | no | `StopRequested` / `SiteBusyError` | existing |
| postback wait | timeout | no (never replayed) | `SectionPostbackTimeoutError` (existing handling) | existing |
| CAPTCHA / session / stop elsewhere | as today | as today | `captchaGuard` / `SessionExpiredError` / `StopRequested` | existing |
| post-reload verify | element missing | no | `WorkingHolidayStop` (stop, as today) | existing |
| post-reload verify | value mismatch | per existing design | `SavedValueVerificationError` | `savedValueDiagnostic` only |
| atom load | module missing / not a function | yes | `fast = false` for the run | `Fast entry unavailable; using standard entry.` |

**Input validation.** Entries come from static `fields.ts` IDs and zod-validated data (`application-data.ts`: strings ≤ 250, plus `validateData`). The planner rejects nothing new. Option existence, `maxLength` and widget state are checked in-page and become fallbacks, never silent acceptance. `NZWH_FAST_FILL` is optional; only `"0"`/`"false"` disable fast fill, and any other value, or none, enables it.

**Invariant ownership.**
- Node owns applicability and section policy (`planSection` + `applicable` + `automatedSection`), because that is where the data lives and where they are unit-testable.
- The page owns field availability, decided with the same atom as today, because only the live DOM knows it at fill time.
- "Posting fields use legacy and emit possible" is split: the page detects, and Node acts, because events and persistence state live in Node.
- "Nothing is verified or saved before the page settles" belongs to the Node barrier, which is the single gate before the authoritative pass, re-verify and SAVE.
- "No decision taken at DOMContentLoaded is final" belongs to `fastFillSection`'s pass order (early pass → settle → authoritative pass), because only Node sees both passes; `report.filled` is rebuilt by the last pass on the document SAVE posts.
- "Server validation and submission reads happen on a loaded page" belongs to `run.ts` (post-SAVE settle; `waitForChangeThenLoad`), because `run.ts` chose the `eager` strategy and owns the waits passed to `submission.ts`.
- Node's verify passes own final value correctness.

### B10. Testing

Unit, no browser (`fast-fill.test.ts`):
- `planSection`: order, lookup exclusion, the `exemptionReason` rule, colon preparation, `applicable` flags.
- `conditionalControllers` (table local to the test file): same-section ordering against `steps`. Cross-section adviser keys are not applicable when `representedByAdviser !== "Yes"`.
- `fastFillEnabled` env parsing. `isDisplayedAtomSource()` returns a non-empty function source.
- `isNavigationError`: true for `JavascriptError("javascript error: document unloaded while waiting for result")` and `WebDriverError("target frame detached")`; false for `NoSuchSessionError`, `ScriptTimeoutError` and unrelated messages.
- `fieldMismatch`: value mismatch; Select2 label mismatch; `chosenLabel: null` compares value only; `expected === ""` ignores labels; labels differing only by `&nbsp;`/line breaks/extra spaces do **not** mismatch (`normalizeLabel`).
- `readTimeOrigin` returns the script result; `waitForFieldInPage` maps a navigation error to `"pending"` and rethrows others.
- `addFilled` de-duplication.
- `waitWithCaptcha` honors a custom `pollMs` (fake timers), and the default stays 200.
- Orchestration with a fake driver: resume counter per key and pass (authoritative-pass missing ×4 → stop with the existing message; not reset by a reload); early-pass `missing`/`unavailable-required` with a `"loaded"` wait result defers instead of throwing; `posting`/`fallback` advance; `NaN` timeOrigin goes to the reload path before the `stop` check; `report.filled` is reset by each pass and by `onReload`; the second settle runs only when the authoritative pass wrote; settle barrier returns `reloaded` on a timeOrigin change, waits while `navigating`, requires `SETTLE_STABLE_POLLS`, and times out to the stop message (also when `navigating` never clears).
- Post-SAVE settle: the `[errorlabel]` script is not called until a `settled: true` read; a timeout throws `SectionPostbackTimeoutError`.

Submission load wait (`submission-load-wait.test.ts`, new; `submission*.test.ts` unchanged):
- `waitForChangeThenLoad` with a fake driver: the `readyState === 'complete'` script is not called until the change condition returns true; it then polls `false, false, true` and resolves; a never-complete page rejects with `TimeoutError` after `loadTimeoutMs` (small value in the test).

CAPTCHA load wait (`captcha-load-wait.test.ts`, new; `captcha.test.ts` unchanged):
- Compatibility: provider mode with a fixture shaped like `captcha.test.ts`'s (`readyState` scripts → `true`) resolves the load wait on its first read; the whole `captchaGuard` call finishes in under 1 s with real timers.
- Provider mode with a fake driver that answers `return document.readyState === 'complete'` with `false`, `false`, `true`, and a spied `readCaptchaChallenge` that returns the challenge only once `complete` was reached. The provider is requested exactly once.
- Abort during the wait → `StopRequested`, and no provider request.
- Manual mode makes no extra `readyState` read before `driver.wait`.

Browser fixture (`fast-fill-browser.test.ts`, headless Chrome, `setFixtureOriginForTest`, `withHooksForTest` with a signal; exported `fastFillSectionForTest`, plus a full `fillAndSaveWorkingHolidaySection` run with `NZWH_REPORT_DIR` stubbed before a dynamic import of `run.ts`, `fixtures/sample.json` (fictional), `allowFictionalDraftSave: true`). The page has all personal IDs, a 3 s slow image and an event recorder.
1. All fields filled and verified with ≤ 3 fill `executeScript` calls (spy count). Changed fields get `input`+`change`+`blur`, unchanged fields get none.
2. **Early fill:** the fill finishes while `readyState !== 'complete'`. SAVE happens only after `load` (settle barrier).
3. A field inserted 300 ms after DOMContentLoaded is filled with no fixed sleep.
4. A client-side dependent (`title=6` reveals `otherTitle` after 200 ms) is filled. A required dependent that never appears stops with today's message within `DEPENDENT_FIELD_TIMEOUT_MS` + margin.
5. An AutoPostBack select (inline `onchange` → `__doPostBack` → form POST → re-render with a dependent) goes through legacy, with `possible` emitted before the postback, the dependent filled afterwards, and earlier values preserved.
6. An input that rejects untrusted events → fallback → the typed value is accepted.
7. `maxlength` shorter than the value → fallback → today's `Readback mismatch` stop.
8. A Select2-v3 stub that updates on `change` → fast path. A stub that ignores `change` → `widget-mismatch` → the legacy UI path succeeds.
9. Abort during a dependent wait → `StopRequested` within about 600 ms.
10. Full SAVE → reload → verify happy path. A server-mutated value → `SavedValueVerificationError`.
11. `NZWH_FAST_FILL=0` → legacy path (no fill-segment scripts).
12. **`window.onload` reset:** a handler resets one field 300 ms after DCL. The authoritative pass rewrites it before SAVE, and the server receives the expected value.
13. **Deferred submit on the last field:** a `change` handler runs `setTimeout(() => form.submit(), 0)`. The reload is detected, `possible` is emitted, the section is refilled, and there is no SAVE on the stale document.
14. **Refill reveals a branch field:** an authoritative-pass rewrite of a posting field (reset at `load`) re-renders with an unmapped visible field → the unmapped-field stop, with no SAVE.
15. **Visibility parity:** `isShown`/`enabled` equal `isDisplayed()`/`isEnabled()` for `display:none`, hidden ancestor, `visibility:hidden`, `opacity:0`, zero-size, `overflow:hidden` clip, `disabled`, `fieldset[disabled]`.
16. **`eager` + CAPTCHA page:** a click-navigated fixture CAPTCHA page inserts the anchor iframe on `load` (after a slow resource). In provider mode with mocked adapters, the challenge is read once and the provider is requested.
17. **Late-shown field:** `otherTitle` is hidden at DOMContentLoaded and shown by `window.onload` (page has a 1 s slow image). It is filled (early pass on appearance or authoritative pass), is in `report.filled`, and the server receives it.
18. **Required field that never appears:** a required, applicable field is hidden at DOMContentLoaded and stays hidden after `load`. The run stops with `Required conditional field unavailable: personal.<key>.` within `load` + `DEPENDENT_FIELD_TIMEOUT_MS` + margin, and no SAVE is sent.
19. **Filled then hidden after reload:** a key is filled early, then an unexpected reload (deferred `form.submit()`) renders it hidden and not applicable. No `Readback mismatch`; the key is absent from `report.filled`; SAVE proceeds.
20. **Clear deferred:** a field with `expected === ""` and a non-empty current value is not touched before `load` (event recorder) and is cleared by the authoritative pass; when `load` hides it instead, it is left untouched, as today.
21. **Post-SAVE `load`-time validation:** the SAVE response page's `load` handler (after a slow resource) reveals `[errorlabel="mandatory"]` for an unmapped, unfilled field. The run stops with today's `Server validation flagged 1 fields in personal; stopped before next section.` and does not emit `accepted`.
22. **Watch on legacy-reached documents:** the last entry is a posting field; on the re-rendered document a `setTimeout(() => form.submit(), 0)` runs. The barrier sees the flag (installed by `PRE_SAVE_SETTLE_JS`) and takes the reload path; no SAVE on the stale document.
23. **Select2 label whitespace:** option text `"New&nbsp;Zealand\n"` with a chosen label `"New Zealand"` verifies without fallback or mismatch.

The existing suite (`vitest run`) and `tsc --noEmit` must stay green. `captcha.test.ts`, `submission*.test.ts` and `occupation-widget.test.ts` are not edited.

### B11. Expected savings per section (estimates, client side only)

| Section | Fill today (est.) | Fill new (est.) | Other savings |
|---|---|---|---|
| personal | 1.1–2.5 s | < 50 ms (+ legacy time per changed AutoPostBack field) | ~0.1 s verify, ~0.2 s polls, 1 × load tail (+ P × tail), plus fill/load overlap |
| identification | 0.25–0.45 s | < 20 ms | ~0.2 s + 1 × tail |
| health | 0.5–2.1 s | < 20 ms | ~0.2 s + 1 × tail |
| character | 0.6–2.4 s | < 20 ms | ~0.2 s + 1 × tail |
| adviser (if used) | 0.9–1.7 s | < 40 ms | ~0.25 s + 1 × tail |
| workingHoliday | 0.4–1.4 s | < 20 ms | ~0.2 s + 1 × tail |

"Load tail" is the live DOMContentLoaded→`load` gap. Per section, after this revision:

- **Verification reload page: one tail saved in full** (value reads run at DOM-ready).
- **SAVE response page: not saved.** The `[errorlabel]` count waits for `load` again (post-SAVE settle), as today.
- **Section's first page: partly saved.** The early pass and AutoPostBack legacy work run inside the tail; the settle barrier then waits for `load`, and the authoritative pass costs about 1 RT when nothing changed at `load`. In the common case the whole fill overlaps the tail.
- **Each AutoPostBack field whose value changes: one tail saved**, since the fast `waitForPostback` resumes at DOM-ready and the next segment fills during that page's tail.

The settle barrier adds ≥ 1 × `FAST_POLL_MS` (50 ms) per section for the stability read, and the authoritative pass adds one fill RT (plus a second settle only if it wrote). The "Other savings" column above is therefore `1 × tail` (+ `P × tail` for changed AutoPostBack fields); iteration 2 claimed `2 × tail`. At an unmeasured 0.2–1.5 s tail, the load savings are 0.2–1.5 s per section (more on pages with changed AutoPostBack fields) on top of the fill savings. Submission/payment pages get no load savings: `waitForChangeThenLoad` restores the `load` wait there by design. Server time and deliberate safety waits are unchanged. On re-runs over a filled draft, most fields are `unchanged` and skip writes.

### B12. What only the live site can confirm, and how the design degrades

| Unverified on live site | Degradation |
|---|---|
| Whether validators/handlers accept native-setter values plus synthetic events on every text/date control | In-page verify falls back to legacy typing on rejection. The `[errorlabel]` check after SAVE and the reload verification still run |
| Select2 version/markup and whether native `change` updates the display | The `.select2-chosen` check falls back to the legacy Select2 UI path on mismatch or unknown markup. Re-verify applies the same label rule |
| Whether any control relies on `keyup`/`keypress` side effects (masks, counters) | Server validation and reload verification catch it. Escape hatch: `NZWH_FAST_FILL=0` |
| Which fields are AutoPostBack, and whether any postback is partial | Detection regex unchanged; posting fields use legacy. Undetected full postbacks are caught by the navigation watch and `timeOrigin` in the settle barrier (emit `possible`, refill idempotently). Undetected partial postbacks are awaited by the barrier (`isInAsyncPostBack`, `jQuery.active`) before re-verify |
| Whether `beforeunload`/`navigate` fire for every navigation the site starts | Fixture-verified for `form.submit()` and `__doPostBack` in Chrome. If one is missed, the next barrier read after the new document commits still sees the new `timeOrigin`. The two-read stability rule narrows the window. The reload verification remains the final check |
| Whether DOMContentLoaded-time layout is enough for visibility decisions | The predicate waits for stylesheet `.sheet`. The atom gives today's exact rule on the DOM as it is. Kill switch |
| Whether `[errorlabel]` display after SAVE is final at DOMContentLoaded | Not relied on. The post-SAVE settle waits for `load` and idle before counting, as today |
| Whether any field's visibility, value or existence changes at `load` | Not relied on. The authoritative pass re-decides every field on the settled DOM; required fields that end up unavailable stop with today's message |
| Whether the payment gateway or declaration pages run `load` scripts that matter | Not relied on. `waitForChangeThenLoad` restores today's `load` precondition after each submission/payer click |
| Whether a `load` script on the verification reload rewrites a saved value | Values are read at DOM-ready, i.e. the server-rendered values. Such a rewrite would be invisible to verification (today it would show as a mismatch); it is a client-side display change, not a persistence failure. Kill switch if the live log ever suggests otherwise |
| CAPTCHA pages under `eager` (iframe timing, provider reads) | The provider branch waits for `complete` up to `READY_WAIT_MS`. On deadline it behaves as today (unsupported → manual) |
| Real DCL→load gap, live RTT, actual savings | The per-section timing log reports fill/settle/save/verify durations without values |
| Occupation widget | Not exercised (excluded by policy). Unchanged |

### Backlog / deferred

- **Submit.aspx DOM-only ready** (`run.ts:1621-1629`). Declaration scripts may run on `load`, and an early read could report a spurious `incomplete`. It is once per run and in the final-submission area. Revisit after the live timing log shows the gap.
- **Batched login fill.** It runs once per run (about 4 RTs) with credentials, so the gain is negligible.

---

## Responses to design review (iteration 1)

| # | Severity | Response |
|---|---|---|
| 1 | HIGH | **Addressed.** Added a cancel/site-busy-aware `readyState === 'complete'` wait (`READY_WAIT_MS`, `PAGE_POLL_MS`) in `captchaGuard` before `readCaptchaChallenge` (B8). Corrected the B4 claim about click-driven navigations. Tests: `captcha-load-wait.test.ts` + fixture 16. Deviation from the suggested placement: the wait is inside the provider branch, not right after `captchaPending`, so manual mode's call sequence (asserted by the existing `captcha.test.ts` readyState count) is untouched. Manual mode never reads the challenge, and wizard inline widgets are re-checked after the settle barrier. |
| 2 | HIGH | **Addressed.** Added `PRE_SAVE_SETTLE_JS` plus the barrier: `complete`, no async postback, jQuery idle, two stable reads, and a reload path on a `timeOrigin` change. Strengthened beyond the suggestion with a passive `beforeunload`/Navigation API watch, because during an in-flight `form.submit()` the old document still reports `complete` and the same `timeOrigin`. Timeout stop message as suggested. B6, B11 and B12 corrected. Fixtures 12-13. |
| 3 | MEDIUM | **Addressed differently.** Instead of a hand-written ancestor walk with a runtime disagreement fallback, the scripts embed the exact `is-displayed.js` atom that selenium-webdriver executes for `isDisplayed()`, which gives parity by construction. The fallback is per run: if the atom can't load, fast fill is off. Parity fixture 15 covers the listed cases. |
| 4 | MEDIUM | **Addressed.** Fixed order: settle → re-verify/refills → settle again if refilled (+ final no-refill re-verify) → occupation (excluded) → unmapped check → `captchaGuard` → URL check → SAVE. Fixture 14. |
| 5 | MEDIUM | **Addressed.** `isNavigationError` helper. `fillSegment` → `NaN` reload path, checked before `stop`. `waitForFieldInPage` → `false`. `readSettleState` → `null`, keep waiting. `readFieldValues` → rethrow. B9 rows added. |
| 6 | MEDIUM | **Addressed.** `fieldMismatch` formula as suggested, the missing-element rule, and a bounded refill (one fast, one re-read, one legacy), plus the final no-refill check after the second settle. |
| 7 | MEDIUM | **Addressed.** `resumes` per key, only for `missing`/`unavailable-required`, never reset on reload, throwing the reason's existing message. `posting`/`fallback` always advance. `addFilled` de-duplicates. |
| 8 | NIT | **Addressed.** Module-level `checkCancelled()`, reused in `captchaGuard`. |
| 9 | NIT | **Addressed.** The fast `waitForPostback` drops the trailing `waitForSection` and keeps `activateChrome`. Legacy is unchanged. |
| 10 | NIT | **Addressed.** `{section,key}` keyed map; same-section ordering test; adviser covered by the existing section skip and an `applicable` test. |
| 11 | NIT | **Addressed.** `fast` is computed once per run (`executeWorkingHoliday`, `fillAndSaveWorkingHolidaySection`) and passed explicitly. |
| 12 | NIT | **Addressed.** Results carry `{key,status}` and stops `{index,reason,cause?}`, never values. B10 says "existing suite". |

Note on iteration-1 rows 4 and 6: the "re-verify with bounded refills" step they describe is superseded in iteration 3 by the authoritative pass (iteration-2 finding 3). The ordering guarantee of row 4 and the one-fast-plus-one-legacy bound of row 6 still hold inside that pass.

## Responses to design review (iteration 2)

| # | Severity | Response |
|---|---|---|
| 1 | HIGH | **Addressed.** The CAPTCHA load wait now reads `executeScript<boolean>("return document.readyState === 'complete'")`, the form already used at `run.ts:230/:339` (B8). Against `captcha.test.ts`'s fixture (`ready.shift() ?? true`) it exits on its first read, so the ~15 provider tests stay fast and `captcha.test.ts` stays unedited. `captcha-load-wait.test.ts` fakes `false, false, true` for that script and adds a compatibility case (fixture shaped like `captcha.test.ts`, provider mode, resolves in < 1 s) (B10). |
| 2 | HIGH | **Addressed.** In fast mode `saveStep` waits for `readSettleState().settled` (`READY_WAIT_MS`, `FAST_POLL_MS`, cancel/CAPTCHA/session-aware through `waitWithCaptcha`) between the pathname check and the `[errorlabel]` count; a timeout maps to `SectionPostbackTimeoutError`, as today's SAVE wait does (B5 "Post-SAVE settle"). B11 now saves one tail per section (verification reload), not two. B12's "reload verification catches it" claim is removed. Fixture 21 covers a `load`-time mandatory flag on an unmapped, unfilled field. |
| 3 | MEDIUM | **Addressed.** After the settle barrier, an authoritative pass runs from index 0 with `report.filled` reset, on the settled DOM, with today's availability and applicability rules (B5 orchestration). It writes only what differs, settles again only if it wrote, then runs `reverify()` with no refill. `onReload` also resets `report.filled`. Two refinements beyond the suggested fix: (a) early-pass `missing`/`unavailable-required` waits for the field *or* `load` and then defers instead of throwing, so a field that a `load` handler shows is never stopped on prematurely; (b) the early pass defers clears (`expected === ""`), so it never writes into a field that `load` hides and the settled pass would then leave alone. Fixtures 17 (late-shown), 18 (required, never appears), 19 (filled then hidden after reload), 20 (deferred clear). |
| 4 | MEDIUM | **Addressed.** B4 now lists the four click sites (`payNow`, `nextStep`, `page.button`, payer `ok`). In fast mode `run.ts` passes `waitForChangeThenLoad` (in `fast-fill.ts`: change condition, then `readyState === 'complete'` within `READY_WAIT_MS`) as `finishApplication`'s `waitForChange`; `completePayerForm` receives it via `submission.ts:194`. `submission.ts`/`payer-form.ts` stay unedited. The `30000` literal becomes `SUBMISSION_CHANGE_WAIT_MS`. No `checkpoint()` is added, so stop behavior in the submission area is unchanged. Unit test: `submission-load-wait.test.ts`. Applied only when `fast`, so the kill switch keeps today's exact call sequence. |
| 5 | NIT | **Addressed.** `NAV_WATCH_JS` is a shared prefix of `SECTION_DOM_READY_JS`, `FILL_SEGMENT_JS` and `PRE_SAVE_SETTLE_JS` (B4, B5). The stuck-flag case (navigation cancelled after `beforeunload`, e.g. 204) is in B9: it ends in the settle timeout, a safe stop before SAVE. The post-SAVE settle ignores the flag. Fixture 22. |
| 6 | NIT | **Addressed.** The fast path and `readFieldValues` detect Select2 with legacy's selector, `#s2id_<id> a.select2-choice`, plus `isShown`. Labels are compared with `normalizeLabel = s => s.replace(/\s+/g, " ").trim()` both in the page and in `fieldMismatch`. Page scripts are `String.raw` templates so the escape survives. Unit test + fixture 23. |
| 7 | NIT | **Addressed.** `conditionalControllers` is defined in `fast-fill.test.ts`; `conditions.ts` is not modified (B1, B6). |
| 8 | NIT | **Addressed.** `readTimeOrigin(driver): Promise<number>` and `waitForFieldInPage(driver, id, mode, sliceMs, untilLoad): Promise<FieldWaitResult>` are defined in B4, and the `waitForField` loop in B5. Deviation: the result is `"ready" \| "loaded" \| "pending"` rather than `boolean`, because the early pass (finding 3) must tell "field appeared" apart from "`load` arrived first". |

Git state note: the baseline recorded the user's `submission.ts`/`submission.test.ts` changes as uncommitted. They are now committed by the user as `3f4fb30` and the working tree is clean apart from `.agents/`. This design does not edit either file.
