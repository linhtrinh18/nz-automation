# Form-fill speedup: technical design (phase 2, revision 3)

Worktree `.worktrees/formfill-speedup`, branch `perf/formfill-speedup`, base `d25300d`. Grounded in
`formfill-pipeline-audit.md` (section/IDs `W#`, `E#`, `P#`, `X#` refer to it). Line numbers are `workflow/run.ts`
unless another file is named. Revision addressing `formfill-design-review.md` (responses in §11).

User-visible deviation (surface in the final summary): "open a new tab" is implemented as **two reused tab slots**
(main + one extra) that sections alternate between, not a fresh tab per section (§6.2).

## 1. Overview

The run stays a single Selenium session driving one Chrome. Speed comes from three layers, each independently
switchable: (a) removing round trips and full-load waits from the critical path of a single tab (E1, E2, E4-E8, plus
the W9 change gated with the pipeline); (b) a cooperative two-tab scheduler that overlaps section N's SAVE response
tail and reload-verify with section N+1's GET and fill (P1 `verify`, P2 `save`); (c) a per-section run-state model
(risk, timing marks, controller outcome lookup) so two sections can be in flight without corrupting status
reporting. All new behavior that the audit flags as unproven against the live server is behind
`NZWH_TAB_PIPELINE`, default `off`. In `off` mode the **order and count** of SAVE clicks, reload GETs and readback
scripts, and of `possible`/`accepted`/`verified` persistence events, are identical to today; probe/pre-SAVE scripts
differ because E1/E2/E6/E7 apply in all modes. Expected gain: ~4-7 s/run with defaults (single-tab items), a further ~6-9 s/run
with `save` mode if the server does not serialize per-session requests (audit §5.3 verdict).

Technology stack (locked): TypeScript (ESM, Node ≥ 22.12), `selenium-webdriver` 4.38 with chromedriver/CDP via
`chromium.Driver.sendDevToolsCommand`, `vitest` 5 for tests, `tsc --noEmit` for typecheck. No new dependencies.

## 2. Configuration

All flags are read once per run in `executeWorkingHoliday` (`:1769`) next to the existing `NZWH_FAST_FILL` /
`NZWH_EARLY_FILL` snapshots, and logged in one line: `[NZWH] Tab pipeline: <mode> (barrier <b>).`

| Flag | Values | Default | Parsing / invalid value |
|---|---|---|---|
| `NZWH_TAB_PIPELINE` | `off` \| `verify` \| `save` | `off` | trim + lowercase; anything else → `off` with log `[NZWH] Unknown NZWH_TAB_PIPELINE value; using off.` (value not echoed). Not fatal. |
| `NZWH_PIPELINE_BARRIER` | `verified` \| `accepted` | `verified` | same rules; invalid → `verified`. Only read when pipeline ≠ `off`. |

Forced `off` (logged with reason, no error): attach mode (`options.attachPort`; no anti-throttling flags, user tabs
present), `NZWH_FAST_FILL=0`, `NZWH_EARLY_FILL=0` (pipeline needs DOM-ready entry), `loginOnly`, and `fillAndSubmit`'s
submission phase (submission/payer always run in the main tab, sequentially).

Tradeoffs being gated:
- `verify`: overlaps only the read-only reload (proven once live, run `9a251153`). Risk: second concurrent GET in
  the same session. Gain ~0.5-1 s/section.
- `save`: also prefetches N+1 during N's SAVE POST. Risk: GET during POST (server session lock → zero gain, or a
  CAPTCHA/busy/denied response on the prefetch). Gain ~1.2-1.8 s/section.
- `NZWH_PIPELINE_BARRIER=accepted` is the closest form of the literal request "do not wait for the previous save to
  complete": N+1 may SAVE once N's `persistence accepted` event was emitted (path clean, DOM-ready `[errorlabel]` clean
  **and** the load-time re-scan clean, §4) even if N's reload verification has not finished. Risk: a late verification failure of N is reported after N+1 has already
  been posted (still reported, never re-posted; no data loss in N+1, but the run report shows a later section saved
  after an earlier one failed). Default `verified` blocks N+1's SAVE until N reaches a terminal outcome.
- Fully "fire SAVE and forget" with several POSTs outstanding is not offered as a value. The scheduler enforces "no
  SAVE while any tab is in phase `posted`" (§8); it does not rely on `sendKeys(SPACE)` blocking until the response
  (unverified driver behavior). `accepted` already delivers everything that remains of that request, and keeping
  one POST in flight avoids the server-side session-lock/rate-limit risk.
- Kill switches for always-on items: `NZWH_EARLY_FILL=0` restores the legacy `ready()` waits of E4 (login flow);
  `NZWH_FAST_FILL=0` restores legacy fill (disables E5/E6 paths that live in fast fill).

## 3. Single-tab improvements (apply in all modes)

E1 Overlap credential validation (`lib/execution-controller.ts`). Split `checkpoint()` into
`checkpoint()` (unchanged public behavior) and a new
`boundary(opts: { prefetch: boolean }): Promise<{ command: "continue" | "pause" | "stop"; validated?: Promise<void> }>`
used by the section loop. `boundary()` always reads `store.command` and **does not apply** `checkpoint()`'s
"no-op while an item is running" guard (the scheduler owns the safe-boundary decision, §6.5).
- `prefetch: false` (real boundary, no item in flight): stop/terminate → throws `StopRequested`; pause → runs the
  existing pause loop (which awaits validation before resuming); then returns `continue` with `validated`.
- `prefetch: true` (N still in flight): never throws and never pauses; returns `pause`/`stop` as a value so the
  scheduler can cancel the prefetch (§6.3 step 2). `validated` is only started on `continue`.
The returned `validated` promise is stored on that section's `SectionTab.validated` (sequential path: a local) and
awaited right before **that section's own** `captchaGuard`/SAVE, never another section's. The promise gets an immediate `.catch(() => {})` attached to avoid an unhandled rejection; the
original is awaited later and its rejection propagates exactly like today (fatal, run stops with the existing
credential message from `assertCurrentCredentials`). `ExecutionHooks` gains `boundary?()`; when absent (tests,
`withHooksForTest`) the loop falls back to `checkpoint()`.

E2 Single probe per poll (`waitWithCaptcha :346`, `site-busy.ts`, `auth-state.ts`). Add `PAGE_PROBE_JS` in
`workflow/page-state.ts` returning `{ site: true|"busy"|"denied", captcha: boolean, auth: AuthState }` from one
`executeScript`; it checks `document.title`, `location.pathname` and `textContent` first and reads
`document.body.innerText` only when a `textContent` regex matched (confirm visibility). `captchaGuard` and
`requireSession` accept an optional pre-read probe; `waitWithCaptcha` reads the probe once per poll and passes it
down. Predicates and thrown errors stay identical (`AccessDeniedError`, `SiteBusyError`, `SessionExpiredError`,
login-rejected stop). `captcha.test.ts` fake-driver script matching is updated deliberately: fixtures that answer
`SITE_STATE_JS`/captcha/auth scripts get a probe responder; assertions on outcomes are unchanged.

E4 Login flow (`authenticate :408`, `selectCountry :516`, `advanceToWizard :634`). Remove `ready()` after the home,
logout and login GETs and after the post-LOGIN home GET, where a targeted element wait follows (username field,
`a[href*="Logout"]`-or-login-link presence, `readAuthState().authenticated`, `editHyperLink`/country grid). The home
GET before the logout check gets a targeted wait for "logout link OR login link OR country grid present" (50 ms
poll, `READY_WAIT_MS`) so `findElements(Logout)` cannot run on a half-parsed page. Keep `ready()` on the Edit.aspx →
Wizard redirect (`:1914`) and in `selectCountry`'s post-click checks that depend on scripts. Under `NZWH_EARLY_FILL=0`
the old `ready()` calls stay (kill switch keeps legacy waits).

E5 Single settle barrier (`fastFillSection :1430-1450,1520`). The second barrier runs only if the authoritative pass
wrote at least one value that differs from the early write for that field (`stats` already counts writes; add
`changedAfterEarly`). Identical re-writes trigger no events of consequence. The pre-SAVE batched re-check stays as
the gate (requirement #2).

E6 Combined pre-SAVE script (`saveStep :1606-1630`). One `executeScript` returns `{ unmapped: string[], href,
timeOrigin, saveId: string|null, probe }`; `sectionSaveControl` (`:1114`) logic for choosing SAVE vs SUBMIT moves into
the script as id selection, then one `findElement(By.id(saveId))` returns the WebElement for the native click.
Failure mapping unchanged: unmapped → `WorkingHolidayStop` (fatal), href changed → "Unexpected navigation before
SAVE." (fatal), `saveId` null → existing save-control error.

E7 `activateChrome` (`:754`) only before native input (`sendKeys`, `clickWithFallback`), after every
`switchTo().window()`, and at CAPTCHA start. Removed from `waitForSection` and `waitForPostback` tails.

E8 `driver.sleep(300)` at `:547` → `waitWithCaptcha` on an in-viewport check of the tile
(`getBoundingClientRect` inside `innerHeight`), 50 ms poll, 2 s limit; on timeout fall through to the existing click
(same behavior as after the sleep).

X5 skip `maximize` when the window was sized at launch, i.e. not attach mode: both the spawned path
(`chooseBrowser.ts:83`) and the driver-launched path (`chooseBrowser.ts:89`) set `--window-size`, so the exposed flag
is `windowSizedAtLaunch = !attach` and both skip it; attach mode keeps `maximize`. Other backoffs/sleeps in W16 stay (they are deliberate backoffs).

Not implemented (backlog, with reason): X1 session reuse (credential isolation, no reliable account-identity
selector); X2 `pageLoadStrategy: 'none'` (eager already in place, every caller would need rewiring); X3 verify from
the SAVE response (does not prove persistence); X4 selector caching (stale elements after postback).

## 4. SAVE acceptance at DOM-ready (W9, requested change #1)

`waitForPostback` gets a `level: "complete" | "interactive"` parameter. `interactive` predicate: new `timeOrigin`,
`readyState !== 'loading'`, no async postback, `jQuery.active === 0` when defined, first field present.
`saveStep` then runs path check and `[errorlabel]` scan at DOM-ready. In `off` it emits the `persistence accepted`
event there (level `complete`, unchanged). In pipeline mode the DOM-ready result only moves the internal tab phase to
`domready`; the `persistence accepted` event is **not** emitted yet (see below).

- Pipeline `off`: level `complete` (today). The verification reload starts right after, so a DOM-ready acceptance
  would need a separate load-time re-scan on the critical path and gains nothing safely. This is the safe default.
- Pipeline `verify`/`save`: level `interactive`; the tab N background task performs a **load-time `[errorlabel]`
  re-scan** (`documentComplete` then the same scan script) before firing the reload verify. Only when the re-scan is
  clean is `persistence accepted` emitted and the tab phase set to `accepted`. A re-scan error emits keyed
  `section-result failed` (outcome `stop`, §6.4) while persistence is still `possible`, so the controller
  (`execution-controller.ts:90-94`) maps it to `failed` exactly as today, never `saved_unverified`. A load-time
  `[errorlabel]` is therefore never reported as unverified-but-saved. Barrier `accepted` and the "N+1 SAVE" gate
  both key on the emitted `persistence accepted` event, not on `domready`.

Legacy AutoPostBack fields (W8) keep `complete` in all modes (server state of dependent fields).

## 5. Run-state model changes

`workflow/run.ts` execution store: replace `risk: boolean` with `riskBySection: Map<string, boolean>` and
`currentSection?: string` (as in reverted `8f84880`). `emit()`:
- every `persistence` / `section-result` / `captcha` event carries `section?: SectionName` and `background?: true`.
  In pipeline mode every emit from `tab-pipeline.ts`, `verifySection`, `saveSection` and `captchaGuard` passes
  `section` explicitly (these functions take `name` already); `emit` falls back to `currentSection` **only when the
  pipeline is `off`**, and in pipeline mode a keyed event without `section` is a programming error (logged at
  `error`, dropped from controller routing, asserted absent in tests). Events produced inside `drain()` set
  `background: true`;
- `risk` is set per section; helper `sectionRisk(name)` replaces `execution.getStore()?.risk` (recovery `:2000`,
  re-auth `:2140`);
- `sectionMark` becomes `Map<string, number>` so the existing "Section X completed in …" log is correct with two in flight.

`lib/execution-state.ts`: add optional `section` to the `persistence`, `captcha` and `section-result` variants.
`lib/execution-controller.ts`:
- `event()` resolves the target item by `${scenario}:${section}` when `section` is present, else `current()`.
  Scenario: stored from `section-start` in a `Map<section, key>`.
- `saved_unverified` mapping (`failed` + `accepted`) unchanged, applied to the resolved item.
- events with `background: true` update only the resolved item's `status`/`detail`/`persistence` and leave
  `job.phase`/`job.message` untouched. Exception: `captcha` waiting events always update `job.message` (user must
  act). Events without the flag behave as today. Existing Vietnamese `detail` strings are reused.
- `complete()` finalizes **every** item in `running`/`waiting_captcha` (accepted → `saved_unverified`, else
  `failed`), not just the first.
- `checkpoint()` keeps "no-op while any item is running" for existing callers. `boundary()` bypasses that guard
  and returns the command to the scheduler, which owns the safe-boundary decision (§3 E1, §6.5).

## 6. Tab pipeline (`verify` / `save`)

### 6.1 Module and types

New file `workflow/tab-pipeline.ts` (pure scheduling + handle bookkeeping, unit-testable with a fake driver):

```ts
export type PipelineMode = "off" | "verify" | "save";
export type Barrier = "verified" | "accepted";
export interface SectionTab {
  name: SectionName;
  handle: string;              // window handle owning this section
  url: string;                 // section URL (no logging; contains ApplicationId)
    // "domready": POST returned, path + DOM-ready scan clean; NO persistence event yet.
  // "accepted": load-time re-scan clean AND `persistence accepted` emitted (the only phase barrier "accepted" waits for).
  phase: "loading" | "filling" | "posted" | "domready" | "accepted" | "verifying" | "done";
  stamp?: number;              // timeOrigin before the reload/navigation we are waiting on
  ticket?: SavedTicket;        // from saveSection
  outcome?: TabOutcome;        // terminal; set once
}
export type TabOutcome =
  | { kind: "verified"; report: SavedSection }
  | { kind: "unverified"; reason: "timeout" | "mismatch" | "denied"; fields?: string[]; checked?: number }
  | { kind: "busy" }
  | { kind: "stop"; error: Error };  // late [errorlabel], unexpected app, fatal
export function pipelineSnapshot(env, ctx): { mode: PipelineMode; barrier: Barrier; reason?: string };
export class TabSlots { constructor(driver, main: string); other(): Promise<string>; onTab<T>(h, fn): Promise<T>; closeExtra(): Promise<void>; isPipelineHandle(h): boolean }
```

`saveStep` is split (same as reverted `8f84880`) into `saveSection()` (fill, pre-SAVE check, the single SAVE call
site, DOM-ready checks, returns `SavedTicket`) and `verifySection(ticket, how)` (reload or already-navigated,
batched readback, mismatch → `SavedValueVerificationError`). `saveStep = saveSection + verifySection({reload:true})`
is what `off` mode calls, so `off` keeps the exact sequence.

### 6.2 Window handles and focus

- At run start the main handle is `getWindowHandle()` (spawned Chrome only; attach forces `off`).
- `TabSlots` owns at most **one extra handle**, created lazily with `driver.switchTo().newWindow('tab')` and reused.
  Sections alternate between the two slots: N in slot A, N+1 in slot B, N+2 in slot A (free because of the barrier,
  §6.3). Reuse avoids per-section `newWindow` + close cost and keeps ≤ 2 tabs at all times. This is the chosen
  reading of "open a new tab": the next section always starts in the other, idle tab.
- Every driver command against a section goes through `slots.onTab(handle, fn)`: if the tracked focused handle ≠
  `handle`, `switchTo().window(handle)` then `activateChrome`. The tracked handle is updated on every switch; nothing
  else in `run.ts` may call `switchTo()` except the CAPTCHA guard (§6.6) and `selectCountry`'s popup closer, which
  skips `slots.isPipelineHandle(h)`.
- Focus contract (hard rule). Existing helpers (`waitForSection :766`, `fastFillSection :1250`,
  `legacyFillField :1164`, `postbackAndWait :896`, `waitForPostback :921`, `captchaGuard`, `waitWithCaptcha :346`
  conditions) keep calling `driver` directly and implicitly target the **foreground handle**. The scheduler makes
  that true by construction:
  (a) `drain()` records `fg = slots.focused` on entry and in a `finally` (also on throw) does
      `switchTo().window(fg)` + `activateChrome` before returning; a failed restore is fatal (`NoSuchWindowError` path).
  (b) `drain()` is invoked only from these call sites: the `between` callback of the section-entry wait in
      `waitForSection` (`waitWithCaptcha` poll gap), the gaps between `fastFillSection` segments (after a segment's
      script resolved, before the next starts), and the pre-SAVE barrier loop. It is **never** passed to/called from
      `legacyFillField`, `postbackAndWait`, `waitForPostback`, during native `sendKeys`/click, inside `saveSection`,
      or while the CAPTCHA mutex is held (the `between` callback checks `captchaMutexHeld` and returns).
  (c) Test fake driver tracks the current handle and asserts it equals the foreground handle for every command not
      issued through `TabSlots.onTab`.
- Non-blocking navigation: `onTab(h, () => driver.executeScript("location.href = arguments[0]", url))` records
  `stamp = performance.timeOrigin` first; readiness is then polled (`timeOrigin !== stamp` + DOM-ready predicate of
  `waitForSection`). `driver.get` is never used in a background step because it blocks the single driver.
- Background tabs keep loading/running because `chooseBrowser.ts:83,90` passes the anti-throttling flags for
  spawned Chrome; `Page.setWebLifecycleState` is only sent to the tab being focused.
- `closeExtra()` closes the extra handle and switches to main; called on run end (finally), on downgrade and
  before `finishApplication`. Errors from `close()` on an already-closed window are logged at `log` level and ignored.
- `NoSuchWindowError` on any switch (user closed a tab): fatal for that section — if its `risk` is true it is
  reported `failed` (→ `saved_unverified` if accepted), the pipeline downgrades, the run stops with
  "Cửa sổ Chrome của mục đang xử lý đã bị đóng. Không tự lưu lại; kiểm tra dữ liệu trên Chrome." (new string).

### 6.3 Per-section order (`save` mode, barrier `verified`)

Sections are handled in plan order; personal is always sequential (`off` behavior) because the first SAVE triggers
the `/rs-captcha` gate in every live run. Adviser is never prefetched before personal is `done` (`conditions.ts:12-13`).
The last selected section's SAVE never runs before every earlier tab is `done` regardless of barrier (SAVE/SUBMIT
footer depends on server-side completion, `sectionSaveControl :1114`).

For section N in slot A, next section N+1 (if any and eligible) to go to slot B:
1. `boundary()` for N (already done before N started). N is filled and passes the pre-SAVE re-check (unchanged).
2. `save` mode only: `boundary({ prefetch: true })` for N+1. On `pause`/`stop`: cancel the prefetch (emit nothing
   for N+1, no navigation), finish N on the normal path (SAVE + verify, all in slot A), then call
   `boundary({ prefetch: false })` after N's outcome, which honors the command exactly as today. On `continue`:
   store `validated` on N+1's tab, emit `section-start` for N+1 (only now), non-blocking navigation of slot B.
3. On slot A: `validated` await, `captchaGuard`, native SAVE, wait level `interactive`, path + `[errorlabel]` scan,
   `domready` (pipeline) / `persistence accepted` (off). Tab A phase → `domready`.
4. Tab A background task queued: load-time `[errorlabel]` re-scan → on clean: emit `persistence accepted`, phase
   `accepted` → non-blocking reload → readback. On error: keyed `failed` (persistence still `possible`), outcome `stop`.
5. Foreground switches to slot B (in `verify` mode, N+1's `boundary()`/`section-start`/navigation happen here instead
   of step 2). N+1's waits and fill segments run through `waitWithCaptcha`; the scheduler's `drain()` is called
   between polls/segments (hook in `waitWithCaptcha` via an optional `between` callback, and after each
   `fastFillSection` segment). `drain()` performs at most one cheap step of each background tab (one probe + one
   condition/read, estimated ~2-5 ms + switch ×2 each with `activateChrome`, audit W14 5-15 ms) and returns.
   The scheduler accumulates wall time spent in `drain()` per foreground section and appends it to the existing
   "Section X completed in …" timing line as `drain Xms`, so the live A/B can confirm overhead < gain.
6. Barrier before N+1's SAVE: `verified` → loop `drain()` until tab A has an `outcome`; `accepted` → loop `drain()` until tab A
   phase is `accepted` (re-scan passed, `persistence accepted` emitted) or has an `outcome`; N+1 gets no SAVE before
   that, so a load-time `[errorlabel]` in N (outcome `stop` → `PipelineAbort`) always lands with N+1 unposted. Slot A
   must be `done` before N+2: the scheduler runs `awaitBarrier(slotA, 'done')` (a `drain()` loop) right after N+1's
   DOM-ready acceptance and before N+2's `boundary()`; N+1 is itself a background tab then, so `drain()` advances both.
7. Outcomes are applied immediately when produced (§6.4), the foreground continues with N+1's SAVE.

`verify` mode is the same without step 2: after N is `accepted`, `boundary({ prefetch: true })` for N+1 runs in
step 5 with the same pause/stop handling (N's verification then finishes read-only before the real boundary).

Credential validation with two sections: N+1's `validated` is awaited only before N+1's SAVE. If it rejects, the
scheduler drains N to its outcome (read-only), emits N+1 `section-result skipped` (nothing posted detail, §6.4) and
throws today's credential error. N+1 is never posted.

### 6.4 Outcomes and late-failure reporting

`applyOutcome(tab)` runs in the scheduler right after a tab's outcome is set, with `currentSection = tab.name`, and
reuses today's loop bodies (extracted into `completeSection`, `markUnverified`, `markBusy` helpers so the sequential
`catch` blocks and the pipeline report identically):
- `verified` → `saved[name]`, `coverage-saved.json`, `persistence verified`, `section-result completed`,
  "Đã lưu và xác minh sau khi tải lại.", timing line with `verify … (overlapped Xms)`.
- `unverified` (mismatch / postback timeout / denied-recovery unverified) → `unverifiedSections`, keyed
  `section-result failed` with today's detail strings → controller maps to `saved_unverified`. No re-SAVE. Run continues.
- `busy` → `skippedBusy`, `delete saved[name]`, both coverage files rewritten, keyed `failed` with today's busy
  detail; pipeline downgrades to `off` for the rest of the run.
- `stop` (late `[errorlabel]`, unexpected application after reload, fatal driver error) → keyed `section-result failed`
  for N with the existing "Không hoàn tất mục này…" detail; then `applyOutcome` **throws
  `PipelineAbort(sectionN, error)`** out of `drain()` (after the focus restore in `finally`). N+1's fill/wait path
  does not catch it: `PipelineAbort` is added to the rethrow lists next to `StopRequested` in `fastFillSection`,
  `waitWithCaptcha` and the section loop's per-section `catch`. The section loop catches it at top level:
  - N+1 not yet posted (`risk` false; always the case with barrier `verified`): emit N+1 `section-result skipped`
    detail "Chưa lưu: dừng vì mục trước gặp lỗi sau khi lưu. Không có dữ liệu nào được gửi cho mục này." (new);
  - N+1 posted (barrier `accepted` only): `PipelineAbort` cannot surface mid-fill there (N+1 is past SAVE, drain
    only runs at the barrier); its read-only verification is finished and reported first;
  then `closeExtra()` and throw `WorkingHolidayStop("Stopped in <N>. <reason> Later sections have not run.")` as today.
- Downgrade triggers raised inside `drain()` (busy, denied, session, 2nd pipeline CAPTCHA, unmapped error) throw
  `PipelineDowngrade(reason)` the same way. The loop applies N's outcome, then branches on `sectionRisk(N+1)`
  **before** `closeExtra()`:
  - `sectionRisk(N+1) === false` (nothing of N+1 posted; always the case under barrier `verified`): `closeExtra()`,
    mode `off`, **restart N+1 sequentially in the main tab from its GET**. N+1's item stays `running` (no extra
    `section-start`).
  - `sectionRisk(N+1) === true` (barrier `accepted`, N+1 already SAVEd): **never restart, never re-SAVE.** Finish
    N+1's read-only verification (`verifySection`) in its own tab via `onTab`. If that tab is unusable (the trigger
    was denied/session in that tab, or `NoSuchWindowError`), `closeExtra()` and run today's read-back-only recovery
    in the main tab (`recoverFromAccessDenied` read-back path / re-auth rule with risk true). Apply N+1's outcome via
    `applyOutcome`, then `closeExtra()`, mode `off`, continue sequentially with N+2.
  Owned by the section loop's `PipelineDowngrade` handler; the restart call is guarded by
  `assert(!sectionRisk(next))` so a regression fails loudly instead of re-posting.

Detection points where outcomes are drained: (a) every `drain()` between foreground polls, (b) the pre-SAVE barrier,
(c) the end of the section loop (drain all to `done`), (d) `finally`/stop path (`finalizeInFlight`, §6.5). Coverage
files are written at the moment of the outcome so a crash after detection leaves correct files.
`finishApplication` receives `filled = no busy && no unverified` computed after (c), so a late failure always
prevents `filled = true`.

### 6.5 Stop, pause, resume, recovery

- Stop/terminate read in `boundary()` → `StopRequested`; the `catch` in the loop calls `finalizeInFlight()`: for each
  open tab with phase `accepted|verifying`, finish the read-only verification only if the abort signal is not set,
  else leave it; controller `complete()` marks every running item (`accepted` → `saved_unverified`, else `failed`).
  Abort signal (`checkCancelled`) is checked on every background step too.
  Reporting: `finalizeInFlight` calls `applyOutcome(tab, { finalizing: true })` for each tab that reaches an outcome,
  so a successful background verify still writes `coverage-saved.json` and emits keyed `section-result completed`
  (resume then skips it). In finalizing mode `stop` and downgrade outcomes are **reported** (keyed
  `section-result failed`, busy coverage files) but **never thrown** (`PipelineAbort`/`PipelineDowngrade` are not
  raised); per-tab errors inside finalize are logged at `log` level and the tab is left without outcome. After all
  tabs are processed the original error (`StopRequested` / abort / `PipelineAbort` cause) is rethrown unchanged. If
  the abort signal is set, unfinished tabs get no outcome and `complete()` maps them (`accepted` → `saved_unverified`,
  else `failed`; abandoned-unposted tabs already got `skipped` per below).
- Pause/stop during a prefetch: `boundary({ prefetch: true })` returns the command as a value (§6.3 step 2). The
  prefetch is cancelled before anything for N+1 is emitted, N completes normally (its own SAVE was already gated by
  N's real boundary, so posting N is not "posting during pause" — it is finishing the section the user's command
  arrived inside, same as today where a command is only read between sections), N's verification finishes, then
  `boundary({ prefetch: false })` pauses/stops with no item running. `drain()` never issues a POST.
- If N+1 was already started (`section-start` emitted) and is abandoned with nothing posted for any reason (stop,
  abort, credential rejection), `section-result skipped` with the "Chưa lưu…" detail is emitted before `finish()`,
  so `complete()` never marks it `failed`.
- Resume (`resumeKeys`/`taskKeys`) is unchanged: `coverage-saved.json` lists only verified sections, written per outcome.
- Access-denied in any tab: pipeline downgrades (§6.7); the affected section runs today's `recoverFromAccessDenied`
  in the main tab with its own `sectionRisk(name)`; the shared access-denied budget (`beginAccessDeniedAttempt`) is
  unchanged. If the denied response came from a background reload (risk true) → read-back-only recovery → outcome
  `verified` or `unverified`. If it came from a prefetch (nothing posted) → the prefetched section is re-run
  sequentially from the start.
- Session expiry / login form in any tab: downgrade, drain/finalize, `closeExtra()`, then today's one-shot re-auth
  rule using the section's own risk; risk true → today's Vietnamese stop message.

### 6.6 CAPTCHA across tabs

- One per-driver mutex (`WeakMap<WebDriver, Promise>`, as in `8f84880`) wraps `captchaGuard` only when the pipeline is
  active. The tab that sees the challenge owns it; its handle is pinned and re-selected on every poll; `drain()` is
  suspended (no other tab touched) until completion. At most one provider solve per challenge.
- After completion, before resuming, the scheduler probes the other tab: on `/rs-captcha` with nothing posted →
  re-navigate (GET); with risk true → treat as background verification step (read-only) — the reload is retried once
  after the challenge; still on captcha → outcome `unverified` ("timeout").
- Downgrade rule: count only challenges seen **after the pipeline became active** (personal is `done`; personal's
  gate challenge is not counted). The first such challenge is solved and the pipeline continues; the **second**
  downgrades (signals throttling caused by overlap). Counter lives on the scheduler.
- Existing `captcha` events (waiting/not waiting messages) are emitted with the owning `section`.

### 6.7 Auto-downgrade

Triggers: `SiteBusyError`, `AccessDeniedError`, session expiry, second CAPTCHA challenge counted per §6.6, `NoSuchWindowError`, any
background step error not mapped to an outcome. Action: drain/finalize in-flight tabs (a tab whose section has
`sectionRisk === true` is only ever verified read-only, never restarted — same branch as §6.4), `closeExtra()`, set mode
`off`, log `[NZWH] Tab pipeline downgraded to off: <reason-code>.` and emit `phase` with
"Chuyển về xử lý tuần tự trong một tab để giữ an toàn; không gửi lại mục nào." (new). Remaining sections use the
sequential path in the main tab.

### 6.8 Server-side limits

No documented rate limit; the signals are busy / access-denied / `/rs-captcha` (audit §5.3). The design keeps
≤ 2 tabs, ≤ 1 POST in flight (physically, §2), ≤ 2 concurrent GETs, personal sequential, and downgrades on the first
signal. Recommended live A/B before changing any default: 3 runs each of `off`, `verify`, `save` on the same draft type.

## 7. Error handling summary

| Operation | Failure | Recoverable? | Caller receives | Logged |
|---|---|---|---|---|
| Flag parse | unknown value | yes (→ safe default) | default mode | log, value not echoed |
| `newWindow('tab')` | WebDriver error | yes | downgrade to `off`, section runs in main tab | log reason code |
| Non-blocking navigation | readiness timeout (`SECTION_WAIT_MS`) | prefetch: yes (re-GET sequentially); reload-verify: no re-POST → `unverified/timeout` | outcome | log |
| Switch to handle | `NoSuchWindowError` | no | stop (§6.2) | log + Vietnamese message |
| SAVE wait | timeout on same section | no re-POST | `SectionPostbackTimeoutError` → `unverified` (today) | today's log |
| DOM-ready / load-time `[errorlabel]` | flagged fields | no | `stop` outcome, run stops | today's message |
| Reload readback | mismatch | no re-SAVE | `unverified`, continues | per-field diagnostic (no values) |
| Busy / denied / login in any tab | as today | per §6.5 | as today + downgrade | log |
| Credential validation (E1) | rejects | no | run stops before any POST | today |
| Tab close at end | already closed | yes | ignored | log |

## 8. Invariants and ownership

- Exactly one SAVE call site (`saveSection`), native `sendKeys(SPACE)`, after `possible`; owned by `saveSection`.
- No re-POST on any late failure; owned by outcome helpers (no outcome path calls `saveSection`).
- At most one extra tab; owned by `TabSlots`.
- No SAVE while any tab is in phase `posted` (≤ 1 POST in flight); owned by the scheduler (`saveSection` is only
  invoked by the scheduler after checking phases).
- Foreground handle is focused whenever a non-`onTab` driver command runs; owned by `drain()`'s `finally` restore
  and its restricted call sites (§6.2).
- No SAVE of N+1 before N's outcome when barrier `verified`, and never a SAVE of the final section before all tabs
  are done; owned by the scheduler (`awaitBarrier`).
- Every in-flight item finalized on end/stop; owned by `ExecutionController.complete()` + `finalizeInFlight`.
- Live-save consent (`validateRun`, `lib/run-config.ts:54-62`, `lib/jobs.ts:244`) untouched; the worker cannot start
  without it, so the pipeline inherits it.
- Logs PII-free: no URLs with query strings, no field values; pipeline logs use section names and reason codes.

## 9. Files

| File | Change |
|---|---|
| `workflow/tab-pipeline.ts` (new) | flags snapshot, `TabSlots`, scheduler (`drain`, `awaitBarrier`, `finalizeInFlight`), types |
| `workflow/run.ts` | execution store per-section risk/marks; `saveStep` split; section loop uses scheduler when mode ≠ off; outcome helpers; E2/E4/E5/E6/E7/E8 edits; `waitForPostback` level; captcha mutex/pin |
| `workflow/page-state.ts` | `PAGE_PROBE_JS` + parser |
| `workflow/site-busy.ts`, `workflow/auth-state.ts` | accept pre-read probe; same predicates |
| `workflow/fast-fill.ts` | `changedAfterEarly` stat; probe constants |
| `lib/execution-state.ts` | optional `section` on events; `boundary?` on hooks |
| `lib/execution-controller.ts` | keyed event resolution, `boundary()`, multi-item `complete()` |
| `browser/chooseBrowser.ts` | expose whether window was sized at spawn (X5) |

## 10. Testability

- Unit (vitest, fake driver like `fast-fill-run.test.ts`): flag parsing/forced-off cases; `TabSlots` switch
  tracking and reuse; scheduler ordering (SAVE count = sections, never two SAVEs without an intervening outcome under
  `verified`; final section waits); outcome mapping for verified/unverified/busy/stop incl. late `[errorlabel]`;
  downgrade triggers; personal sequential/adviser not prefetched.
- Controller (`execution-controller.test.ts`): keyed events with two running items, `saved_unverified` mapping on a
  background item, `complete()` finalizing both, `boundary()` stop/pause semantics, deferred validation rejection.
- Browser fixture (`fast-fill-browser.test.ts` style, local 127.0.0.1 server): two-tab run with a slow SAVE endpoint
  and a slow reload, asserting overlap (timestamps), one POST per section, coverage files; a fixture whose reload
  mismatches (late failure → N failed, N+1 skipped, no POST for N+1); a busy page on reload (downgrade, N+1 restarted
  sequentially); `off` mode trace test comparing only the subset in §1 (SAVE/reload/readback order+count and
  persistence events).
- Additional unit tests from review: pause/stop arriving during prefetch issues no POST for N+1 and lands after N is
  verified; no keyed event lacks `section` while two items run; `background` events leave `job.message` alone except
  captcha waiting; fake driver asserts foreground focus on every non-`onTab` command; N+1 credential rejection
  posts nothing; CAPTCHA counter ignores personal's challenge.
- Revision 2 tests: barrier `accepted`, N's background reload returns busy (and separately access-denied) after
  N+1 posted → SAVE count for N+1 is exactly 1, N+1 outcome comes from read-only verify, N+2 runs sequentially;
  barrier `verified` downgrade still restarts N+1 from GET with 0 prior SAVEs. Controller/scheduler: stop while N is
  `verifying` and the verify succeeds → `coverage-saved.json` contains N and keyed `completed` emitted; finalize
  outcome `stop`/`busy` is reported but the rethrown error is the original `StopRequested`; abort set → no outcome,
  `complete()` maps `accepted` → `saved_unverified`. Timing line contains `drain` field in pipeline mode.
- Revision 3 tests: pipeline mode, load-time `[errorlabel]` appears on N's reload re-scan (DOM-ready scan clean) →
  item N status `failed` (NOT `saved_unverified`), no `persistence accepted` event emitted for N, and N+1 receives
  zero SAVEs under both barrier `verified` and barrier `accepted`. Barrier `accepted`: N+1 SAVE occurs only after
  N's `persistence accepted` event. `awaitBarrier(slotA,'done')` runs before N+2's `boundary()` and advances both
  background tabs. `windowSizedAtLaunch` true for spawned and driver-launched paths (maximize skipped), false in attach.
- Existing suites (`captcha.test.ts`, `access-denied*.test.ts`, `early-*.test.ts`, `credential-isolation.test.ts`,
  `submission*.test.ts`) must pass; fixture changes for E2 are deliberate and listed in the commit.
- Not verifiable offline: server session locking, prefetch landing on `/rs-captcha`, late validators, real gains.
  Before/after comparison from live `events.log` timing lines against audit §2 baselines (40-66 s without long CAPTCHA).

## 11. Responses to design review (formfill-design-review.md)

| # | Sev | Response |
|---|---|---|
| 1 | HIGH | Addressed. `boundary({ prefetch })` bypasses the running-item guard; prefetch returns pause/stop as a value, cancels N+1 before any event, N finishes normally, command honored at the next real boundary; `section-start` only after `continue`; abandoned started items get `skipped` (§3 E1, §6.3 step 2, §6.5). Test added (§10). |
| 2 | HIGH | Addressed. Hard focus contract: `drain()` restores the foreground handle in `finally`, restricted call sites listed, forbidden inside legacy fill/postback/SAVE/captcha mutex, fake-driver assertion (§6.2, §8). |
| 3 | MED | Addressed. Explicit `section` on all pipeline-path emits; `currentSection` fallback only in `off`; test (§5, §10). |
| 4 | MED | Addressed. `background?: true` flag with captcha-waiting exception (§5). |
| 5 | MED | Addressed. `PipelineAbort` / `PipelineDowngrade` thrown from `drain()`, added to rethrow lists; N+1 skipped on stop, restarted sequentially on downgrade (§6.4). |
| 6 | MED | Addressed. Per-section `validated` on `SectionTab`; N+1 rejection drains N, skips N+1, never posts (§3 E1, §6.3). |
| 7 | MED | Addressed. Only challenges after pipeline activation count; downgrade on the 2nd (§6.6, §6.7). |
| 8 | MED | Addressed. `off` equivalence restated as order/count of SAVE/reload/readback and persistence events; trace test scoped accordingly (§1, §10). |
| 9 | NIT | Addressed. Scheduler-owned "no SAVE while any tab `posted`" invariant (§2, §8). |
| 10 | NIT | Addressed. `NZWH_EARLY_FILL=0` documented as E4 kill switch (§2). |
| 11 | NIT | Addressed. Slot reuse surfaced at top of document for the user-facing summary. |

Revision 2 (second review):

| # | Sev | Response |
|---|---|---|
| 1 | HIGH | Addressed. Downgrade handler branches on `sectionRisk(N+1)`: restart from GET only when unposted (guarded by an assert); posted N+1 is verified read-only in its tab or via main-tab read-back recovery, outcome applied, then N+2 sequential (§6.4, §6.7). Test: N+1 SAVE count exactly 1 (§10). |
| 2 | MED | Addressed. `finalizeInFlight` uses `applyOutcome(tab, { finalizing: true })`: reports (coverage, keyed results) but never throws; original error rethrown; abort → `complete()` mapping (§6.5). Tests in §10. |
| 3 | NIT | Addressed. Per-section `drain Xms` in the timing line; cost marked as estimate (§6.3 step 5). |
Revision 3 (third review):
| # | Sev | Response |
|---|---|---|
| 1 | MED | Addressed. Internal phase renamed `domready`; `persistence accepted` emitted only after the load-time re-scan passes; re-scan failure emits keyed `failed` while persistence is `possible` (controller → `failed`, not `saved_unverified`); barrier `accepted` waits for the emitted event so N+1 never SAVEs before N's load-time validation (§4, §6.1, §6.3, §6.4). Tests in §10. |
| 2 | NIT | Addressed. Scheduler runs `awaitBarrier(slotA,'done')` (`drain()` loop) after N+1's DOM-ready acceptance and before N+2's `boundary()`; both tabs advance (§6.3 step 6). |
| 3 | NIT | Addressed. X5 flag redefined as `windowSizedAtLaunch = !attach`, covering `chooseBrowser.ts:83` and `:89` (§3 X5). |
