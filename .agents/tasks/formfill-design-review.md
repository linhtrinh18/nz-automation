# Design review: formfill-design.md (revision 2) — round 3

Verdict: CHANGES_REQUESTED (1 MEDIUM, 2 NIT)

Prior-round HIGH/MEDIUM items (prefetch pause/stop, focus contract, keyed events, background flag, PipelineAbort/Downgrade, per-section validation, CAPTCHA counter, off-mode equivalence, posted-N+1 downgrade branch, finalize reporting) are resolved in the text.

## Findings

1. MEDIUM: late `[errorlabel]` reports the wrong status in pipeline mode (§4, §6.4, §7 conflict).
   Today `saveStep` runs the `[errorlabel]` scan (`run.ts:1635`) before it emits `persistence accepted` (`run.ts:1642`). A validation error therefore produces `section-result failed` with persistence still `possible`, and the controller (`execution-controller.ts:91-94`) maps that to `failed`. Under §4, pipeline mode emits `accepted` at DOM-ready and runs the load-time re-scan later. When the re-scan finds an error, §6.4 emits keyed `failed`, but the controller sees `accepted` and maps it to `saved_unverified`. §7 says "stop outcome, run stops, today's message", which implies `failed`. Two problems follow. A server-rejected section would be shown as "saved, unverified". And barrier `accepted` would let N+1 SAVE before N's load-time validation has passed, which contradicts §2's definition of `accepted` ("DOM-ready `[errorlabel]` clean").
   Fix: split the internal phase from the persistence event. In pipeline mode:
   - The tab phase becomes `accepted` at DOM-ready (path + DOM-ready scan clean), but the `persistence accepted` event is emitted only after the load-time re-scan passes. Rename the internal phase to `domready` so the two can't be confused.
   - Barrier `accepted` waits for the re-scan to pass, meaning the `persistence accepted` event has been emitted for N.
   - A re-scan failure emits keyed `section-result failed` while persistence is still `possible`, so the controller maps it to `failed` exactly as today.
   - Add a unit test: a load-time `[errorlabel]` in pipeline mode yields item status `failed` (not `saved_unverified`), and N+1 gets no SAVE under either barrier.

2. NIT: §6.3 step 6 under barrier `accepted` says "before N+2 starts in slot A, tab A must be `done`", but it doesn't name the call site that waits. State that the scheduler runs `awaitBarrier(slotA, "done")` (a `drain()` loop) right after N+1's DOM-ready acceptance and before N+2's `boundary()`. During that wait N+1 is itself a background tab, so `drain()` advances both tabs.

3. NIT: X5 says "skip maximize when spawned with `--window-size`". The non-spawned `options.addArguments` path (`chooseBrowser.ts:89-91`) also passes `--window-size`. Define the exposed flag as "window sized at launch, i.e. not attach mode" so both non-attach paths skip `maximize`.

## Verified assumptions

- `checkpoint()` returns early when an item is running and calls `validateCredentials` synchronously after reading the command (`execution-controller.ts:107-113`). This is why `boundary()` must bypass the guard.
- The `saved_unverified` mapping is `failed` + `persistence === "accepted"` on `current` (`execution-controller.ts:90-94`). `captcha` events update `current` only.
- The `[errorlabel]` scan comes before `emit accepted` in `saveStep` (`run.ts:1635`, `:1642`).
- The anti-throttling flags (`--disable-background-timer-throttling`, `--disable-backgrounding-occluded-windows`, `--disable-renderer-backgrounding`) and `--window-size=1440,1000` are passed for spawned Chrome (`chooseBrowser.ts:83`) and for the driver-launched path (`:89`).
- The consent safeguards sit outside the workflow (`validateRun`, `jobs.ts`). The design leaves them untouched, and all new behavior defaults to `NZWH_TAB_PIPELINE=off` with safe parsing.

## Unverified / wrong assumptions

- Wrong (finding 1): pipeline-mode `accepted` at DOM-ready keeps the `failed` mapping for late validation errors. It doesn't.
- Unverified, and correctly marked by the design as needing a live A/B: server session locking, whether a prefetch lands on `/rs-captcha`, whether load-time validators exist, and that `drain()` overhead stays below the gain.
- Unverified: whether `sendKeys(SPACE)` blocks until DCL. The design no longer relies on it (§2 scheduler invariant), which is the right call.
