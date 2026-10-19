# Implementation Plan: autocaptcha.pro as third CAPTCHA provider

AUTO = /Users/MAC/Desktop/DEV/nz-working-holiday-automation
WEB = /Users/MAC/Desktop/DEV/nz-working-holiday

Inputs: AUTO/.agents/tasks/autocaptcha-flow-map.md, AUTO/.agents/tasks/autocaptcha-api.md.
API is determined for the happy path (POST https://autocaptcha.pro/apiv3/process, single synchronous request, key in JSON body, type `recaptchav2`). No error-code list or solve time is documented, so errors and timeouts are conservative and reported as unverified.

## Decisions
- Naming: Prisma/cloud provider value `autoCaptcha` (camelCase like `twoCaptcha`), run mode `"autocaptcha"` (lowercase like `"2captcha"`), singleton id 3, admin route `/admin/autocaptcha`, env name `AUTOCAPTCHA_API_KEY` (scrub/redact only, no env fallback).
- Selection: there is no ordering chain today (one `captchaMode` per run, failure falls back to manual). A third mode is added; existing providers' order and behavior are untouched.
- Solver: one long-lived POST (no create/poll endpoint), `redirect:"error"`, deadline 120s via `AbortSignal.any([signal, AbortSignal.timeout(...)])`, no retries (billable). Error categories only `timeout|service|response|auth`. Never echo provider `message`. Key goes in the body, never the URL.
- Do not touch capsolver/2captcha code paths except to widen unions/ternaries into explicit three-way maps with unchanged outputs for old values.
- No new dependencies.

## WEB (do first: schema/cloud contract)

- [ ] 1. Prisma enum + migration.
      Add `autoCaptcha` to `enum CaptchaProvider` in WEB/prisma/schema/CapSolverConfig/CapSolverConfig.prisma. Create a new migration dir under WEB/prisma/migrations/ (timestamp after 20261018100000, e.g. 20261019000000_autocaptcha_provider) with `ALTER TYPE "CaptchaProvider" ADD VALUE 'autoCaptcha';` and a SEPARATE following step/migration that drops and re-adds CHECK "CapSolverConfig_provider_id" to allow `id=3 AND provider='autoCaptcha'` (new enum value cannot be used in the same transaction it was added, so use two migration directories). Keep existing id=1/id=2 clauses.
      Files: the .prisma file, two new migration.sql files; update WEB/prisma/schema/CapSolverConfig/provider-migration.test.ts to assert the new SQL.
      Verify: in WEB `npm run db:generate` succeeds, `npx vitest run prisma/schema/CapSolverConfig/provider-migration.test.ts` passes.

- [ ] 2. Types, service, encryption (depends on 1).
      WEB/prisma/schema/CapSolverConfig/capsolver-config-type.ts: `captchaProviderSchema = z.enum(["capsolver","twoCaptcha","autoCaptcha"])`.
      WEB/server/domains/CapSolverConfig/capsolver-config-service.ts: replace `singletonFor` ternary with a map capsolver=1, twoCaptcha=2, autoCaptcha=3.
      WEB/server/domains/CapSolverConfig/capsolver-key-secret.ts: replace `aad` ternary with a map; add `"nzwh:shared-autocaptcha-key:v1"`; existing two AAD strings unchanged.
      Add WEB/server/automation/autocaptcha-config.ts mirroring WEB/server/automation/two-captcha-config.ts (`autoCaptchaConfigured`, `loadAutoCaptchaKey`).
      Tests: extend WEB/prisma/schema/CapSolverConfig/capsolver-config.test.ts (autoCaptcha rows isolated, uses AAD distinct from others, legacy ciphertext still readable, errors secret-free, demotion), add WEB/server/automation/autocaptcha-config.test.ts mirroring two-captcha-config.test.ts, update capsolver-config-type.type-test.ts.
      Verify: `npm run typecheck` and `npx vitest run prisma/schema/CapSolverConfig server/automation`.

- [ ] 3. Admin route, client query, UI (depends on 2).
      WEB/prisma/index.ts: add `.route("/admin/autocaptcha", captchaConfigRoutes("autoCaptcha"))` after the 2captcha mount (capsolver-config-route.ts already generic).
      WEB/prisma/schema/CapSolverConfig/capsolver-config-query.ts: replace both binary endpoint ternaries with a three-way lookup (client.api.admin.autocaptcha).
      WEB/app/admin/_components/capsolver-settings.tsx: display-name map adds "AutoCaptcha".
      Create WEB/app/admin/autocaptcha/page.tsx mirroring WEB/app/admin/2captcha/page.tsx.
      WEB/app/admin/_components/admin-sidebar.tsx: add `["/admin/autocaptcha","AutoCaptcha"]`.
      Tests: update capsolver-config-query.test.ts (autoCaptcha CRUD hits only its endpoint), prisma/api-routing.test.ts, capsolver-settings.test.tsx, admin-sidebar.test.tsx.
      Verify: `npm run typecheck`, `npm run lint`, `npx vitest run prisma app/admin`.

- [ ] 4. Cloud route + run config + automation panel (depends on 2).
      WEB/server/automation/cloud-route.ts: `provider: z.enum([...,"autoCaptcha"]).optional()`; `status` adds `autocaptchaConfigured` and `autocaptchaAvailable` via existing `providerStatus(...)` (catch => false/false); existing fields unchanged. Provider op already passes `input.provider ?? "capsolver"` to `loadCapSolverKey`; no other change, response stays `{result: key|null}` noStore.
      WEB/lib/run-config.ts: mode enum adds `"autocaptcha"` (keep in sync with AUTO).
      WEB/components/automation-panel.tsx: add radio option `["autocaptcha","Tự động giải bằng AutoCaptcha (thử nghiệm)"]`, `Runtime` gains `autocaptchaConfigured?`, per-provider "not configured" hint linking /admin/autocaptcha; keep existing options/order.
      WEB/components/execution-monitor.tsx (~L271): make the hardcoded "Nếu CapSolver không hoàn tất" hint provider-neutral only if it does not change existing output for capsolver; otherwise leave it and note it in findings.
      Tests: extend WEB/server/automation/cloud-route.test.ts (status reports autocaptcha independently with no secrets; provider op returns autoCaptcha key only after owner binding), WEB/lib/run-config.test.ts, WEB/components/automation-panel.test.tsx (radios still mutually exclusive, manual default, new hint).
      Verify: `npm run typecheck`, `npm run lint`, `npx vitest run server/automation lib components`.

- [ ] 5. WEB docs.
      Add WEB/docs/autocaptcha.md modeled on WEB/docs/2captcha.md (single synchronous request, billable, sends only site key and parameterless URL, failure => manual, unverified items). Update WEB/README.md and WEB/prisma/README.md provider lists.
      Verify: n/a (prose); full gate in step 11.

## AUTO

- [ ] 6. Solver (independent of WEB, do after cloud contract is fixed).
      Create AUTO/workflow/autocaptcha.ts: `AutoCaptchaError(category: "timeout"|"service"|"response"|"auth")` with message `AutoCaptcha ${category}` (no bodies/URLs/keys); `solveRecaptchaV2(challenge:{websiteURL,websiteKey}, apiKey, signal, log?) : Promise<string>` exported under a distinct name (e.g. `solveAutoCaptcha`) to avoid import clash with capsolver's. POST JSON `{key, type:"recaptchav2", googlesitekey, pageurl}` to https://autocaptcha.pro/apiv3/process; headers Content-Type json; `redirect:"error"`; overall 120s deadline, signal.aborted => rethrow `signal.reason`; deadline/TimeoutError => `timeout`; network error/non-2xx => `service`; zod-parse `{success, message?, captcha?}`; `success:true` with non-empty string `captcha` => token, `success:false` => `service` (optionally `auth` only if HTTP 401/403, not by matching Vietnamese text), malformed => `response`; no retry. Mirror structure of AUTO/workflow/capsolver.ts.
      Test: AUTO/workflow/autocaptcha.test.ts mirroring capsolver.test.ts: exactly one request with minimal body and key only in body (not URL); success returns token; success:false/malformed/network errors sanitized (message and key absent from error text); no retry; cancel in-flight rethrows reason; deadline => timeout (fake timers).
      Verify: in AUTO `npx vitest run workflow/autocaptcha.test.ts`.

- [ ] 7. Cloud client, config, env scrub, plan notes (depends on 6 not strictly; depends on WEB step 4 contract).
      AUTO/server/cloud.ts: `statusSchema` adds `autocaptchaConfigured`, `autocaptchaAvailable` (optional/default false so older WEB payloads still parse); provider union adds `"autoCaptcha"`; add `loadAutoCaptchaKey(signal)` wrapper like `loadTwoCaptchaKey`.
      AUTO/lib/run-config.ts L45: enum adds `"autocaptcha"`.
      AUTO/lib/jobs.ts (~L316): also delete `AUTOCAPTCHA_API_KEY` from workerEnv. AUTO/lib/redact.ts: add to `keyValue` env-name regex.
      AUTO/lib/run-plan.ts (~L68): add Vietnamese note for autocaptcha ("at most one attempt, billable, sends only site key and parameterless URL, failure => manual").
      Tests: extend AUTO/lib/run-config.test.ts (accepts "autocaptcha", still rejects unknown/both/apiKey), lib/redact.test.ts, lib/run-plan.test.ts, server/integration.test.ts mock status, any cloud client test.
      Verify: `npm run typecheck` and `npx vitest run lib server`.

- [ ] 8. Selection in captchaGuard (depends on 6, 7).
      AUTO/workflow/run.ts: widen mode unions at ~L71, L92, L122 to include `"autocaptcha"`; import `loadAutoCaptchaKey`, `solveAutoCaptcha`, `AutoCaptchaError`. In `captchaGuard` (~L182-340) replace binary `providerName` with a map (capsolver->"CapSolver", 2captcha->"2Captcha", autocaptcha->"AutoCaptcha"); provider path condition includes autocaptcha; key loader and solver selection become three-way with identical calls for old modes; missing-key message adds the /admin/autocaptcha variant without changing the two existing texts; error mapping accepts AutoCaptchaError `.category` (no hints/providerCode for it beyond generic). Preserve: human completion wins, token apply/clear after 10s, no retry, CAPTCHA-only submit, `captchaTimeoutMinutes()`, finally cleanup, key never logged (length only). Add a `context` hook for tests (e.g. `loadAutoCaptchaKey`) like `loadCapSolverKey`, and a hook for injecting the solver only if the existing tests inject one; otherwise use vi.mock as captcha.test.ts does.
      Tests in AUTO/workflow/captcha.test.ts (new cases only, existing untouched): autocaptcha mode applies one token, submits only CAPTCHA, waits for acceptance; solver failure => manual wait continues with a sanitized notice; missing key => manual; human completion cancels in-flight autocaptcha solve; run cancellation aborts it; capsolver/2captcha cases remain green (also add one 2captcha-branch regression test if cheap).
      Verify: `npx vitest run workflow/captcha.test.ts`, then `npm run typecheck`.

- [ ] 9. AUTO docs/env.
      AUTO/.env.example: keep NZWH_CAPTCHA_TIMEOUT_MINUTES; add a comment that provider keys (including AutoCaptcha) are stored in the web app admin (/admin/autocaptcha), not env; do not add a key variable. Add a short AutoCaptcha note to AUTO/.agents/tasks/design.md only if it already documents providers.
      Verify: n/a (prose).

## Final verification

- [ ] 10. WEB full gate: in WEB run `npm run db:generate`, `npm run check` (typecheck + lint), `npm test`, `npm run build`. Fix regressions caused by this change only.
- [ ] 11. AUTO full gate: in AUTO run `npm run typecheck` and `npm test` (no build/lint scripts exist).
- [ ] 12. Review gate: reviewer inspects both diffs, confirms existing CapSolver/2Captcha behavior and tests unchanged, no key in logs/responses/URLs, no new dependencies, then writes AUTO/.agents/tasks/autocaptcha-review.json with `{"verdict":"APPROVED"|"CHANGES_REQUESTED", ...}` last.

## Final report must state
Verified: typecheck, lint, build, unit tests in both repos, mocked-fetch solver tests.
Not verified: live autocaptcha.pro solve (no real key); real solve time and failure messages (balance, unsolvable, IP); HTTP status semantics; whether `pageurl` without query is accepted; token session binding; `npm run db:migrate` against a real DB unless a DB is available; the Postman page itself is JS-rendered, details came from its published collection JSON.

## Verification note (implementation iteration 1)
Implemented steps 1-9 (WEB: enum + two migrations 20261019000000/20261019000100, service/AAD maps, autocaptcha-config, /admin/autocaptcha route+page+sidebar, cloud-route provider enum + status fields, run-config mode, automation panel radio, run-plan note, redact, docs/autocaptcha.md; AUTO: workflow/autocaptcha.ts, cloud.ts status/loader, run-config, jobs env scrub, redact, run-plan, run.ts three-way selection, .env.example comment). execution-monitor.tsx hint ("Nếu CapSolver không hoàn tất") left unchanged to preserve existing output; it is CapSolver-worded for AutoCaptcha runs. WEB prisma/README.md had no provider list, so not edited.
Ran (all exit 0):
- WEB: `npm run db:generate` ok; `npm run check` (tsc --noEmit + eslint --max-warnings 0) clean; `npm test` 35 files / 198 tests passed; `npm run build` (next build) succeeded, lists /admin/autocaptcha.
- AUTO: `npm run typecheck` clean; `npm test` 39 files / 431 tests passed (incl. new workflow/autocaptcha.test.ts and AutoCaptcha selection cases in workflow/captcha.test.ts).
Not verified: live autocaptcha.pro solve (no key), real solve time/failure messages, HTTP status semantics, parameterless pageurl acceptance, token session binding, `npm run db:migrate` against a real DB (no DB run; migration SQL only asserted by text tests), 401/403 -> auth mapping is an assumption.
