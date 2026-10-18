# Baseline (before speed-up changes)

All commands run from `/Users/MAC/Desktop/DEV/nz-working-holiday-automation`. No source code changed.

## Tests
Command: `npx vitest run` (vitest v5.0.5, same as `npm test`)
- Test files: 29 passed / 29
- Tests: 261 passed / 261
- Failing tests: none
- Duration: ~81s

## Type check
Command: `npx tsc --noEmit` (same as `npm run typecheck`)
- Result: exit 0, no errors

## Git state (pre-existing uncommitted user changes; must be preserved)
Commands: `git status --porcelain`, `git diff --stat`
```
 M workflow/submission.test.ts   | 12 ++++++++++++
 M workflow/submission.ts        | 31 ++++++++++++++++++++++++++++---
 2 files changed, 40 insertions(+), 3 deletions(-)
```
Do not stash, reset, revert or commit these as part of unrelated work.
