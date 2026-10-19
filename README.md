9 kv5# NZ Working Holiday local automation

Runs the loopback API and Selenium browser workers on the user's machine. No hosting,
PostgreSQL, Prisma, direct database access, or local copy of the main app is required.
Requires Node >=22.12 and installed Chrome; Selenium Manager resolves ChromeDriver.

```sh
npm ci
# Optional local overrides: cp .env.example .env
npm start
```

The service binds localhost:3210 (loopback). Open the deployed app and sign in, allow browser local
network access, then use its existing automation tab. For developing both projects,
run the app on localhost:3211; the local automation address remains localhost:3210.
Never set DATABASE_URL, BETTER_AUTH_SECRET or shared NZWH credentials locally.
Optional Chrome binary/driver paths and CAPTCHA timeout are in `.env.example`.
No app-origin or CORS configuration is needed. CORS accepts every domain (`*`),
without cookies. Bearer authentication is still required.

The frontend sends its current Bearer session to the local API. This service calls
the calling frontend origin's authenticated `/api/automation/context` endpoint.
The app supplies authoritative document data/revisions, credentials, payer identity,
application target and CAPTCHA settings. User status and credential revisions remain
controlled by the app. The HTTP(S) Origin header supplies the app address automatically; no separate
upstream URL header is accepted. Redirects are rejected and upstream requests time
out after seven seconds. Detached workers receive this origin through the same
private pipe as their session. Non-browser clients must also send an Origin header.

## API and execution

GET `/api/runtime`, GET `/api/runs`, GET `/api/runs/:id`, GET
`/api/runs/:id/coverage-*.json`, GET `/api/runs/:id/recovery`, POST `/api/runs/plan`,
POST `/api/runs`, and POST `/api/runs/:id/control` preserve the frontend contract.
Every request requires Bearer authentication; POST also requires X-Local-Request: 1.
CORS allows all origins without cookies and supports private-network preflight. POST bodies are bounded to 1 MB. No public listener is supported.

Configuration, plan review, explicit save/submission consent, owner/revision checks,
immutable recovery snapshots, pause/continue/safe stop/immediate termination,
CAPTCHA handling and report generation retain the extracted implementation.
Workers revalidate credential revisions at the original controller checkpoints.
Missing/expired authorization, credential changes, or upstream outages fail closed.
A valid session and reachable deployed app are required throughout a run. CAPTCHA
provider failures fall back to manual solving. Never start a live submission for testing.

## Local storage and migration

- `data/runs/users/<sha256-origin-and-user>/<run-id>/`: private owner binding, input/application
  snapshots, status, commands, logs, target fingerprint and coverage reports.
- `data/profiles/`: Chrome profiles scoped to app origin, user, credential revision and profile name.

The frontend session is passed to each detached worker through an inherited pipe,
not arguments, environment variables or run files. Credentials/provider keys are
fetched into memory and registered for log redaction. Applicant snapshots and
browser cookies are still sensitive; never commit or share data directories.

Stop old workers and the old combined app server on port 3210 first. Restart any
local app development server on port 3211 before starting this service. Run and profile namespaces now include the app origin, so a different domain cannot
claim the same user ID and read another app's history or reuse its Chrome profile.
Changing the frontend domain intentionally creates a separate local namespace.
Existing user-only run folders are not reassigned automatically. To migrate an
inactive run for a known app and owner, move its user directory to the SHA-256 of
`JSON.stringify([appOrigin, userId])` under `data/runs/users/`. Only migrate data after
verifying the originating app and owner; keep run IDs, revisions and snapshots intact.
Old browser profile names also lack the app origin; use a fresh profile and sign in
again. Do not copy `.env` or database secrets. Recovery still requires fresh review
and uncertainty acknowledgement, and blocks changed credentials/application targets.

Each owner has an exclusive run lock. Visible Chrome may stay open for inspection. The optional `headless` run flag (default off) runs Chrome without a window; it cannot combine with attach mode, and CAPTCHA can only be solved by 2Captcha, CapSolver or AutoCaptcha.
Close named profiles before reuse. A machine crash can leave locks or browser processes;
inspect them before removing a lock. Do not signal unrelated processes.

## Verification

```sh
npm run typecheck
npm test
```

Unit tests cover plan hashes, scope/consent, recovery, ownership, credential isolation,
controls, termination, logs and state. Browser tests use local HTTP fixtures for CAPTCHA,
occupation selection, submission and payment-boundary logic. Provider calls are mocked.
`server/integration.test.ts` exercises the local API through an upstream fixture and a
real worker subprocess, including revocation before Chrome opens and owner isolation.
It never contacts the immigration site. The app repository separately tests the
bridge against mocked domain services and the frontend Bearer transport.

Both projects retain copies of shared schemas, plans and validation. Keep those
contracts synchronized when changing them. There is no database migration in this project.
