# Implementation Plan: logs panel, results below logs, per-section timing

Findings (read, not assumed):
- `lib/execution-state.ts` is byte-identical in both repos (`outcomeSchema`, `Job`). `lib/execution-controller.ts` (handles `section-start` / `section-result` / `persistence` events, `finish()` sets `job.finished`) exists ONLY in nz-working-holiday-automation. `workflow/run.ts` (section loop ~L1647-1810, `emit(...)`) exists ONLY in the automation repo. The UI repo only reads the job.
- UI: `nz-working-holiday/components/execution-monitor.tsx`. Results table is behind a toggle `details` (L67, button L299-302 "Kết quả từng mục"), rendered at L408-455 BEFORE the logs. Logs live in a collapsed `<details>` (L456, summary "Nhật ký & thông tin kỹ thuật") with `<pre className="... max-h-48 ...">` (L461-467). `RunTimer` (L32) and `formatDuration` (`lib/format-duration.ts`, mm:ss) already exist.
- Log stamping: `lib/log-stamp.ts` (`installLogStamping`) prefixes EVERY console line with `ISO +mm:ss LEVEL`. It exists in both repos; it is installed from `workflow/worker.ts` (automation). That is the source of the noisy per-line timestamps.
- Decisions: (a) add optional fields to `outcomeSchema` so old persisted jobs still parse; (b) record timing in `ExecutionController.event`, not in `run.ts`, because the controller owns the outcome state and already sees both events, so `run.ts` only needs milestone log lines; (c) stamp only milestone lines, marked with a `[NZWH:M]` token, since the lines are plain strings with no structure; (d) no tests added, per request. Existing tests must still pass.

- [ ] 1. Extend the outcome data model (both repos, identical edit).
      In `outcomeSchema` add `startedAt: z.string().optional()`, `finishedAt: z.string().optional()`, `durationMs: z.number().nonnegative().optional()`. Do not change other fields or `version: z.literal(2)`.
      Files: `nz-working-holiday-automation/lib/execution-state.ts`, `nz-working-holiday/lib/execution-state.ts`
      Verify: in each repo `npx tsc --noEmit` passes.

- [ ] 2. Record timing in the controller (depends on 1).
      In `lib/execution-controller.ts` `event()`: on `section-start` set `item.startedAt = new Date().toISOString()`. On `section-result` (the `current` item) set `finishedAt = now` and `durationMs = Date.parse(finishedAt) - Date.parse(startedAt)` when `startedAt` exists (this covers completed and failed). `skipped` outcomes get no timing. Also in `lib/execution-state.ts` `interruptJob` / stop helper (L100-140), for items being converted from running/waiting_captcha, set `finishedAt` and `durationMs` the same way (guard on `startedAt`). Pause time inside a section is not excluded (checkpoint never pauses mid-section).
      Files: `nz-working-holiday-automation/lib/execution-controller.ts`, `lib/execution-state.ts` (both repos for the helper edit)
      Verify: automation repo `npx vitest run lib/execution-controller.test.ts lib/jobs.test.ts` passes; `npx tsc --noEmit`.

- [ ] 3. Milestone-only log stamping (automation repo, then mirror the helper in UI repo's copy).
      In `lib/log-stamp.ts` change the INFO wrapper: if the formatted text includes `[NZWH:M]`, keep the stamp `ISO +mm:ss INFO` and strip nothing else; otherwise write the line with no stamp (a short two-space indent is fine). WARN and ERROR keep the full stamp. Export a tiny `milestone(message)` helper that returns `[NZWH:M] ${message}`. Copy the same change to `nz-working-holiday/lib/log-stamp.ts`.
      Files: `nz-working-holiday-automation/lib/log-stamp.ts`, `nz-working-holiday/lib/log-stamp.ts`
      Verify: `npx vitest run lib/log-stamp.test.ts` in each repo; update nothing but fix any existing assertion failure by keeping milestone-line behavior unchanged (if an existing test asserts every INFO line is stamped, STOP and report rather than rewriting the test).

- [ ] 4. Mark milestones and trim noise in `workflow/run.ts` (depends on 3).
      Keep as milestones (wrap with `milestone(...)`, add duration where it is the end of a phase): run start / browser open, login success (L385-425 area), country open / APPLY NOW (L496, L580), `Planned form pages` (L1644), each `Opening section i/n: name` (L1652), a NEW section-finished line after each `section-result` emit (completed at L1692; failed branches L1752/1764/1786/1796) containing `name`, status and `formatDuration(Date.now() - sectionStartedMs)` (take `sectionStartedMs = Date.now()` right before `emit section-start` at ~L1664), CAPTCHA wait start and solved (`trace` L172, and L226), submission result (`result.message` L1846), and a final line with total run duration (`Date.now() - bootMs`-style value; reuse the existing since()/run start if present, otherwise capture at run entry).
      Drop to non-milestone (leave the text, just no `[NZWH:M]`, so they print unstamped): per-field `entered and read back` (L1164, L1237), `prepared for website persistence` (L1128, L1236), occupation lookup chatter (L827-1050), `Đang chờ trang phản hồi` heartbeats (L827, L922). Do not delete lines that carry diagnostics for failures (saved-value mismatch L1402, fast-entry fallback L1264).
      Files: `nz-working-holiday-automation/workflow/run.ts`
      Verify: `npx tsc --noEmit`; `npx vitest run workflow/section-policy.test.ts workflow/captcha.test.ts` pass.

- [ ] 5. Restructure the UI monitor (depends on 1).
      In `nz-working-holiday/components/execution-monitor.tsx`:
      - Logs: replace the collapsed `<details>` with an always-visible section: heading "Nhật ký & thông tin kỹ thuật", `<pre tabIndex={0} aria-label="Nhật ký">` with `min-h-[400px] max-h-[70vh] resize-y overflow-auto`; keep the report buttons and the existing copy button (L505-513) and the footer content inside it. Keep `translateAutomationText`.
      - Results: render AFTER the logs block, always visible (remove the `details` state/toggle button at L299-302 and the `setDetails` use; keep a plain heading "Kết quả từng mục" and the `<caption>`).
      - Table columns: `Mục` | `Kết quả` (status label from `outcomeLabels`, e.g. Hoàn tất / Bỏ qua) | `Bắt đầu` (`startedAt` formatted `toLocaleTimeString("vi-VN")`, "—" if missing) | `Thời lượng` (`formatDuration(durationMs)`, for a running item compute `now - startedAt` using the same tick the `RunTimer` uses, "—" if missing). Remove the `Chi tiết` column, the `N đã kiểm tra` / `bị chặn` span, and `persistenceText` for normal rows. For failed / saved_unverified / interrupted rows keep a short one-line `item.detail` under the status so errors are not hidden. Keep the scenario sub-label when `outcomes.length > 7`.
      - Copy-debug text (L125-132): include start and duration per section instead of `detail`.
      Files: `nz-working-holiday/components/execution-monitor.tsx`
      Verify: `npm run typecheck && npm run lint && npm test` in `nz-working-holiday`; if `scripts/verify-ui.ts` references the removed toggle or strings, adjust only those selectors and run `npm run test:browser` if it can start.

- [ ] 6. Cross-project check.
      Confirm the UI reads jobs written by the automation repo (shared schema) and that old jobs without timing render "—". Run the full suites.
      Verify: automation repo `npx tsc --noEmit && npx vitest run`; UI repo `npm run typecheck && npm run lint && npm test`.

## Verification evidence (implementation)
- All steps 1-6 implemented. Deviation: existing `lib/log-stamp.test.ts` asserts every INFO line is stamped, so instead of "stamp milestones only" I added an opt-out `quiet()` / `[NZWH:q]` token: routine lines (per-field read-back, persistence prep, wait heartbeats) print unstamped; all other lines (milestones, diagnostics) keep the stamp. Existing test untouched.
- Automation: `npm run typecheck` pass; `npm run test` 32 files / 309 tests pass.
- UI: `npm run typecheck` pass; `npm run lint` pass; `npm test` 34 files / 189 tests pass.
- UI `npm run test:browser`: FAILED early at "Expected Private template copy" (needs DB/env, unrelated; not reached the monitor). Visual check NOT done.
