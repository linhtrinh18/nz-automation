# Implementation Plan: logs/timing follow-up

Decisions
- All 4 review findings are in the automation repo (`workflow/run.ts`, `lib/log-stamp.ts`). Part B is UI-only (`components/execution-monitor.tsx`).
- Quiet semantics (read in `lib/log-stamp.ts`): an INFO line containing `[NZWH:q]` is DROPPED from output entirely (the wrapper returns early), not printed unstamped. Quieting a line therefore hides it. So only quiet lines that are truly routine; keep milestones and anything diagnostic stamped. (Review wording "unstamped" is inaccurate; do not change `log-stamp.ts` behaviour, since the user wants only milestones visible.)
- UI repo has uncommitted pre-existing changes (`lib/format-duration.ts`, `lib/format-duration.test.ts`, `lib/log-stamp.ts`, untracked `.agents/tasks/exec-monitor-duration/`). Do not stage them. Commit only the files this plan changes, by name.
- Auto-scroll: use `scrollTop = scrollHeight` on the `<pre>` itself (never `scrollIntoView`, which can scroll the page). Track stick-to-bottom in a ref (not state) to avoid re-renders. Threshold 24px.

- [ ] 1. Finding 3 + 2: use `quiet()` helper and quiet remaining routine chatter in `workflow/run.ts`.
      Import `quiet` from `../lib/log-stamp`. Replace every hardcoded `` `[NZWH:q] ...` `` literal (lines ~836, 931, 975, 980, 983, 997, 1000, 1017, 1032, 1045, 1059, 1137, 1173, 1245, 1246) with `console.log(quiet(`...`))`. Remove the doubled `[NZWH:q] [NZWH]` pattern so the text is `quiet("[NZWH] ...")`.
      Then quiet remaining routine lines, judged by reading each: line ~947 (lookup timeout, `${tag}` prefix), ~1042 (`${tag} ${message}` lookup chatter), ~1273 (fast entry not accepted fallback), ~1311/1315/1318 (fast entry mode notices), ~553/625 (country re-check polling, only if repeated per poll; read first). KEEP stamped: section started/finished, Section result lines, sign-in/signed-out, country OPEN/reached, APPLY NOW, "saved and verified after reload", saved-value mismatch, occupation excluded, planned pages, CAPTCHA submit, errors, result message, run total.
      Check `lib/log-stamp.test.ts` and any test asserting these strings (`grep -rn` the text in `workflow/*.test.ts`); update expectations only if they match a newly quieted line.
      Files: workflow/run.ts (and tests only if needed)
      Verify: `npm run typecheck && npm test` in the automation repo pass.

- [ ] 2. Finding 1: reset run baseline at start of `executeWorkingHoliday` (workflow/run.ts ~line 1497).
      Add `runStartMs = Date.now();` as the first statement of the function body (before `dataSchema.parse`). Keep the existing reset in `fillAndSaveWorkingHolidaySection` (~1453).
      Files: workflow/run.ts
      Verify: `npm run typecheck && npm test` pass.

- [ ] 3. Commit automation repo (local only, no push).
      `git add workflow/run.ts` (plus any test file touched) and commit `fix(logs): quiet routine chatter, use quiet() helper, reset run baseline`. Do not stage `.agents/`.

- [ ] 4. Part B: auto-scroll the logs panel in /Users/MAC/Desktop/DEV/nz-working-holiday/components/execution-monitor.tsx.
      Before coding, skim `node_modules/next/dist/docs/01-app` for client component guidance; the file is already a client component (uses hooks), so plain React is used and no Next API is needed.
      - Add `const logRef = useRef<HTMLPreElement | null>(null);` and `const stickRef = useRef(true);` next to the other refs (~line 80-85).
      - Compute `const logText = translateAutomationText(job.log) || "Chưa có nhật ký.";` once near the render (reuse at ~line 421; leave the copy function at ~143 alone).
      - `<pre ref={logRef} onScroll={...}>` (~line 417): handler sets `stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 24`.
      - `useEffect(() => { const el = logRef.current; if (el && stickRef.current) el.scrollTop = el.scrollHeight; }, [logText]);` Initial mount scrolls to bottom since stickRef starts true. Hooks must be placed before any early return in the component.
      - Keep existing classes (`max-h-[70vh] overflow-auto resize-y`), `tabIndex`, `aria-label`.
      Files: components/execution-monitor.tsx
      Verify: in the UI repo `npm run typecheck && npm run lint && npm test` pass.

- [ ] 5. Browser verification (Part C, covers finding 4).
      Start UI dev server (`npm run dev`, port 3211) in the background. Render the monitor with growing logs via a real run if feasible, otherwise a temporary mock/fixture (temp file or route, removed afterwards) that appends a log line every ~300ms. Confirm: (a) the panel scrolls to the newest line as lines append; (b) scrolling up inside the panel stops auto-scroll; (c) scrolling back near the bottom resumes it; (d) `window.scrollY` is unchanged by the panel's auto-scroll; (e) logs panel is open with ~400px+ height and the results table shows Mục / Kết quả / Bắt đầu / Thời lượng below it. Use the available browser tooling (e.g. Playwright via `npm run test:browser` style scripts) or manual check; if a real run fails early on the unrelated Private template step, use the fixture. Stop the dev server and delete all temporary fixtures afterwards; confirm `git status` shows only intended changes.
      Do not add new test suites.

- [ ] 6. Commit UI repo (local only, no push).
      `git add components/execution-monitor.tsx` only (not the pre-existing modified files or `.agents/`), commit `feat(monitor): auto-scroll logs panel with stick-to-bottom`.

Files changed summary
- Automation repo: workflow/run.ts (items 1-2); tests only if an assertion needs updating. `lib/log-stamp.ts` unchanged.
- UI repo: components/execution-monitor.tsx only.
- Commits: one per repo; no pushes.
