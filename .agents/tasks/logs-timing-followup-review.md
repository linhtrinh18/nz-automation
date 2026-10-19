# Log timing follow-up and logs panel auto-scroll

Automation commit 7e73ecb resets `runStartMs`, swaps `[NZWH:q]` literals for `quiet()`, and quiets lookup/fast-entry chatter. UI commit f3beaec adds stick-to-bottom auto-scroll on the logs `<pre>`. Watch for: no browser verification (possible, justified); one possibly noisy stamped line at run.ts:1316.

**Verdict**: APPROVED

## High-level view

Part A: all four findings are addressed. `runStartMs = Date.now()` is set at the start of `executeWorkingHoliday`; no `[NZWH:q]` literals remain in the diff additions; the fast-entry fallback cause stays stamped on purpose (a test asserts it). Browser verification was not performed; the commit gives an explicit reason (no Playwright/puppeteer dependency, installing one out of scope), which satisfies the finding's "explicit justification" clause.

Part B: auto-scroll uses a `logRef` on the `<pre>` and sets `el.scrollTop = el.scrollHeight`, so only the container scrolls. A `stickRef` is updated in `onScroll` with a 24px near-bottom threshold, which pauses on scroll-up and resumes near the bottom. No `scrollIntoView` or `window` calls (confirmed in diff).

Part C: both commits record results. Automation: typecheck clean, full vitest passed. UI: typecheck, lint clean, 34 files / 190 tests passed. Suites were not re-run.

<details>
<summary>Issues (2)</summary>

1. **No browser check of auto-scroll** (confirmed, non-blocking) — behavior is verified only by reasoning and unit tests; do a manual check when convenient.
2. **Unquieted fallback line at run.ts:1316** (possible, non-blocking) — "Fast entry unavailable; using standard entry." is stamped; confirm it is a once-per-section milestone and not per-field.

</details>

<details>
<summary>Details</summary>

## Evidence gaps
The automation commit does not mention lint or a browser outcome. Lint is not clearly part of that repo's scripts, and the browser limitation is documented in the UI commit, so this is not blocking. The automation working tree has uncommitted changes in lib/format-duration*.ts and lib/log-stamp.ts that are outside this commit.

</details>

<details>
<summary>File map</summary>

- nz-working-holiday-automation/workflow/run.ts: baseline reset, quiet() usage
- nz-working-holiday/components/execution-monitor.tsx: container-scoped stick-to-bottom scroll

</details>
