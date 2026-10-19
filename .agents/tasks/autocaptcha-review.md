# AutoCaptcha as third CAPTCHA provider (both repos)

autocaptcha.pro is added as a third provider next to CapSolver and 2Captcha. Both repos gain an `autocaptcha` mode, an `autoCaptcha` provider value, an admin route and encrypted key row (WEB), and a single-request solver (AUTO). Existing modes keep their code paths and messages. Verification evidence is recorded in autocaptcha-plan.md (typecheck, lint, build, and tests in both repos, exit 0); the suites were not re-run here.

Watch for: error categorisation rests on an assumption (HTTP 401/403 means auth), the live API was never exercised, and the execution monitor hint is still CapSolver-worded (all possible, non-blocking).

**Verdict**: APPROVED

## High-level view

The solver (`workflow/autocaptcha.ts`) uses only the endpoints the API doc establishes: one `POST https://autocaptcha.pro/apiv3/process` with `type: "recaptchav2"`, `googlesitekey`, `pageurl`. It does not invent a create/poll flow or extra endpoints. The key is sent in the JSON body only, never in a URL, and errors carry just a category.

Selection in `captchaGuard` becomes three-way with the original two branches in the same order and with identical calls and texts. The new mode adds its own missing-key message pointing at /admin/autocaptcha. Failure falls back to manual solving like the other providers.

On WEB, the Prisma enum, two migrations (enum value first, CHECK constraint second, which is correct for Postgres), singleton id 3, a distinct AAD string for encryption, the cloud-route provider enum, and status fields (`autocaptchaConfigured/Available`) follow the existing pattern. AUTO's status schema defaults the new fields to false, so older WEB payloads still parse.

<details>
<summary>Issues (3)</summary>

1. **Auth mapping assumed** (possible) — `success:false` always maps to `service`, and 401/403 to `auth`. The docs show a bad key returns a message with `success:false` (the HTTP status was not recorded), so a bad key will likely surface as `service`. Verify with a real key; non-blocking since failure falls back to manual.
2. **Monitor hint wording** (confirmed) — execution-monitor still says "Nếu CapSolver không hoàn tất" on AutoCaptcha runs. Deliberately left to preserve existing output; make it provider-neutral later.
3. **Unrelated WEB changes in working tree** (likely) — `lib/format-duration.ts` (new `formatClock`) and `lib/log-stamp.ts` are modified and look unrelated to this feature (probably earlier uncommitted work). Confirm they are not meant for this change set before committing.

</details>

<details>
<summary>Details</summary>

### Solver conforms to the doc, with unverified error semantics

The 120s deadline combines with the caller's signal via `AbortSignal.any`. `redirect: "error"` is set and there are no retries, since solving is billable. A caller abort rethrows `signal.reason`; the deadline gives `timeout`. This mirrors the CapSolver precedent. The key is registered for log redaction through `loadCapSolverKey` in server/cloud.ts (shared by all providers), and `AUTOCAPTCHA_API_KEY` is added to the redaction regex and scrubbed from worker env.

The doc gives no error code list, HTTP semantics, or solve time (autocaptcha-api.md says so explicitly). The implementation therefore uses only `timeout/service/response/auth` and never echoes provider messages. That matches the doc's guidance. The auth branch (401/403) is the only assumption, and it is listed as unverified in the plan.

### Selection and fallback

`captchaGuard` keeps the CapSolver/2Captcha ternaries first-class and adds autocaptcha as the outermost branch. There is no cross-provider fallback or ordering: the user picks one mode, as before. The plan did not ask for cross-provider failover, so this is consistent.

### Not covered

Not tested live: no real key was available. Mocked-fetch tests plus captcha.test.ts cases cover the solver and selection. No new dependencies were added.

</details>

<details>
<summary>File map</summary>

AUTO: workflow/autocaptcha.ts (+test) new solver; workflow/run.ts three-way selection; server/cloud.ts status/loader; lib/run-config, run-plan, redact, jobs env scrub; .env.example comment; tests extended.
WEB: prisma enum + 2 migrations; capsolver-config service/secret/query/type; cloud-route.ts; app/admin/autocaptcha; sidebar; automation-panel radio; run-config/run-plan/redact; docs/autocaptcha.md; README/docs/capsolver.md mentions.

</details>
