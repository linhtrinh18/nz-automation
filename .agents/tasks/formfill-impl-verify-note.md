# Verification note (final, all plan items implemented)

Ran in the worktree, offline only (fake drivers + local 127.0.0.1 fixture + headless Chrome). No live site, no live SAVE.
- `npm run typecheck` -> exit 0, no errors.
- `npm test` -> 41 test files, 479 tests passed (includes `workflow/tab-pipeline.test.ts` 28 tests, `workflow/pipeline-browser.test.ts` 4 tests,
  new controller/captcha/page-state/fast-fill-run/login-only cases).

## What each plan item became
1. `workflow/tab-pipeline.ts` `pipelineSnapshot` (NZWH_TAB_PIPELINE off|verify|save, default off; NZWH_PIPELINE_BARRIER; forced off for attach, FAST_FILL=0, EARLY_FILL=0, loginOnly). Logged once per run.
2. `browser/window-size.ts` + `chooseBrowser`: `maximize()` skipped when the window was sized at launch (both non-attach paths); attach keeps it. Test: `login-only.test.ts`.
3. E2: `PAGE_PROBE_JS`/`parsePageProbe` (one script for site state + CAPTCHA + auth). `waitWithCaptcha` takes the fast path only when the probe is clean; anything else falls through to the unchanged `captchaGuard`. `requireSession` itself was not changed (still its own script). Tests in `captcha.test.ts`, `page-state.test.ts`.
4. E4: `settleNavigation`/skipped `ready()` after home/logout/login/post-login GETs; `NZWH_EARLY_FILL=0` restores them (test counts readyState reads: 1 vs 3).
5. E5: the second settle barrier already ran only when the authoritative pass wrote something (`wrote`); added the `changedAfterEarly` stat and a test (one barrier vs two).
6. E6 combined pre-SAVE script (`PRE_SAVE_JS`, legacy bare-list answer still accepted), E7 `activateChrome` only before native input in fast entry, E8 viewport wait instead of `sleep(300)`.
7. `saveStep` split into `saveSection` / `verifySection`; `waitForPostback` level `complete|interactive`; off-trace test in `fast-fill-run.test.ts`.
8. Controller: keyed events (`section`, `background`), multi-item `complete()`, `boundary({prefetch})`, deferred credential validation (E1) awaited right before the section's own CAPTCHA/SAVE.
9-10. `TabScheduler`, `runPipelinedSections` (tab-pipeline.ts) and the run.ts section loop (`runPipeline`, `applyOutcome`, `finishReadOnly`, downgrade handling).
11. Tests as listed above. Finding 1: `loadTimeRescan` emits `persistence accepted` only after the load-time re-scan; a flagged field gives keyed `section-result failed` with persistence still `possible`; barrier `accepted` waits for that event; N+1 is never posted (unit tests for both barriers; browser test with a validation error that only exists after window `load`).

## Simulated timing (local fixture with artificial 600 ms GET / 500 ms SAVE / 900 ms reload delays, 3 sections, 1 sequential + 2 pipelined)
off 6.25-6.36 s vs save 5.67-5.86 s (about 8-10 % faster), three runs. This is a simulation, not the live site.

## Deliberate deviations / things to know
- ChromeDriver blocks any command on a tab whose navigation is still loading, so background navigation is scheduled with a 30 ms timer (not driver.get / Page.navigate) and background reads go over CDP `Runtime.evaluate`. Overlap is therefore of network latency, not of driver commands.
- The first section of the pipelined list always runs sequentially (personal in practice); the pipeline starts with the second and needs at least two remaining sections.
- A read-only "unverified" outcome (mismatch/timeout) does not block the next SAVE (same as the sequential run); busy/late validation errors do.
- Background CAPTCHA/denied/login on a reload downgrades to sequential (stricter than the design's "second challenge"); a CAPTCHA solved in the foreground counts and the second one downgrades.
- "Open a new tab" is implemented as two reused tab slots; at the end the tab showing the last section is kept (no extra navigation).
- Emit routing in pipeline mode: foreground events use the foreground section; background events must name their section or are dropped and logged.

## Not verified (live-only)
Real before/after wall clock on the government site, server-side session locking on concurrent GET/POST, prefetch landing on /rs-captcha, late server validators, 3x A/B of off/verify/save. Default stays `off`.
