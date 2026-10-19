# autocaptcha.pro API findings

## Source and what was retrieved
- Postman documenter page (https://documenter.getpostman.com/view/18090353/2s9YC8vAoo) is JS-rendered. Not parsed directly.
- Underlying published collection fetched successfully: `https://documenter.gw.postman.com/api/collections/18090353/2s9YC8vAoo` (HTTP 200, JSON, published 2023-09-19). Everything below comes from that collection (request bodies and saved example responses).
- Collection description (Vietnamese): "Captcha solving API for autocaptcha.pro. Solving needs only ONE request, unlike other captcha-solving services."
- One live probe was made without a real key: `GET https://autocaptcha.pro/apiv3/balance?key=invalid` returned `{"success":false,"message":"Api key không chính xác"}` ("API key incorrect"). No real key was used, nothing was solved.

## Not documented (cannot be implemented from docs alone)
- No error code list. Only a `success` boolean and a Vietnamese `message` are shown. Only failure examples seen: bad key (above) and geetest `{"success":false,"message":"ERROR","captcha":"ERROR"}`.
- No documented HTTP status semantics, rate limits, retry guidance, or server-side solve time / timeout. The request descriptions in the collection are empty.
- No docs on balance/insufficient-funds message text, unsolvable text, or IP/proxy errors. Error categorisation must be conservative (see below) and verified with a real key.
- Pricing is only referenced ("see website").

## Authentication
- API key sent as `key`: query param on GET (`/apiv3/balance?key=<KEY>`) and as a `"key"` field in the JSON body on POST. No header auth documented. Prefer the JSON body for POST so the key never appears in a URL/logs.

## Endpoints (base `https://autocaptcha.pro`)
- `GET /apiv3/balance?key=<KEY>` -> `{"success":true,"message":"Thành công","balance":200}`
- `POST /apiv3/process` (JSON body, `Content-Type: application/json`) is the ONLY solve endpoint. It is single-step and synchronous: there is NO separate create-task and NO result-polling endpoint. The HTTP response is held open until the solution is ready. Consequence: the solver must use one long-lived request with AbortSignal/overall deadline, not a poll loop. The solve duration is undocumented, so the deadline is our choice (existing precedent: CapSolver 120s, 2Captcha 180s).

## Response shape (all types)
```json
{ "success": true, "message": "Thành công", "captcha": "<solution>" }
```
- `success` boolean; `message` "Thành công" (= "Success") on success; `captcha` holds the solution (string for most types; object for geetestv4/cloudflare; array/JSON string for compleximagetask). Some responses also include `userAgent` and `respKey` (null in examples).
- Failure: `success:false` with a `message`; `captcha` may be "ERROR" or absent.

## Request shapes by type (`type` field, lowercase)
| type | fields | result in `captcha` |
|---|---|---|
| `recaptchav2` | `googlesitekey`, `pageurl`, optional `invi:"1"` (invisible) | g-recaptcha-response token string |
| `recaptchav2enterpire` (sic, spelling as documented) | `googlesitekey`, `pageurl` | token string |
| `recaptchav3` | `googlesitekey`, `pageurl`, `score` (>=0.7 switches to highscore pricing), optional `proxy` ("ip:port:user:pwd"), `actionv3` | token |
| `recaptchav3highscore` | `googlesitekey`, `pageurl` | token |
| `compleximagetask` | `class` ("recaptcha"/"funcaptcha"), `imageUrls[]` or `imagesBase64[]`, `metadata{Task,Grid}`, `convert` | bool array / index |
| `imagetotext` | `img` (URL, base64 or data URI incl. svg), optional `casesensitive`, `colors` | text |
| `speechtotext` | `body` (base64 audio) | text |
| `getcode` | `img` | comma separated codes |
| `funcaptcha` | `websitekey`, `pageurl`, `blob` | token |
| `hcaptcha` | `websitekey`, `pageurl` | token |
| `mtcaptcha` | `websitekey`, `pageurl`, `proxy` | token |
| `geetest` | `gt`, `challenge`, `pageurl` | (example is an error) |
| `geetestv4` | `captchaId`, `pageurl` | object (captcha_id, captcha_output, gen_time, lot_number, pass_token, ...) |
| `cloudflare` (Turnstile) | `websitekey`, `pageurl` | `{token, clearance}` |

Example recaptchav2 request (key redacted; note docs example URL is the NZ Working Holiday submit page):
```json
{ "key": "<KEY>", "type": "recaptchav2",
  "googlesitekey": "<site key>",
  "pageurl": "https://onlineservices.immigration.govt.nz/workingholiday/application/submit.aspx?applicationid=..." }
```
Success response: `{"success":true,"message":"Thành công","captcha":"<token>"}`.

## Match against the CAPTCHA types our flow encounters
(From autocaptcha-flow-map.md.) The flow only auto-solves a same-origin dedicated CAPTCHA page with a single normal-size reCAPTCHA v2 checkbox (no enterprise, hCaptcha, Turnstile, invisible, data-s, callback). Both existing solvers take `{websiteURL, websiteKey}` and return a g-recaptcha token.
- MATCH: `recaptchav2` (documented with exactly the NZ immigration page as example). Map `websiteURL` -> `pageurl`, `websiteKey` -> `googlesitekey`, omit `invi`. Token = `captcha` string. Use ONLY this type.
- Do not use: recaptchav2enterpire, recaptchav3*, hcaptcha, cloudflare, funcaptcha, geetest*, mtcaptcha, imagetotext, speechtotext, getcode, compleximagetask (flow never reaches them, and the existing flow gates them to manual).
- Not documented: proxyless behaviour for `recaptchav2` (no `proxy` field shown for it), and whether `pageurl` query strings are required or ignored. Existing plan text says only the parameterless URL is sent; confirm this is acceptable with a real key.
- Not documented: whether the token's session binding (`recaptcha-ca-e/-t` "session" errors seen with CapSolver) occurs.

## Implementation implications / open questions for later steps
1. Interface: `solveRecaptchaV2(challenge, apiKey, signal, log?) => Promise<string>` can wrap a single `fetch` POST with `AbortSignal.any([signal, AbortSignal.timeout(deadline)])`, `redirect:"error"`, no retries (solving is billable).
2. Error categories: only `timeout`, `service`, `response`, and `auth` (from the observed "Api key không chính xác") can be justified by evidence. Do not invent balance/unsolvable categories or provider codes; map any `success:false` to a generic category and never echo `message` (could be attacker/provider controlled; keep secret-free). Optionally map the known bad-key message, but matching on Vietnamese text is brittle; flag to user.
3. Never include the key in URLs; use body. Register with `registerLogSecret` as other providers do.
4. Needs a real key to verify: actual solve time, the failure messages (insufficient balance, unsolvable), HTTP status codes on failure, whether a hung request is possible.

## Verdict
Docs were fetched and are sufficient to implement the happy path for `recaptchav2` (auth, endpoint, request, success response). They are NOT sufficient for error-code mapping or timeouts; implement those conservatively and report them as unverified.
