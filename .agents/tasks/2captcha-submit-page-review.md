# Submit.aspx reCAPTCHA v2 detection for 2Captcha

Detection in `readCaptchaChallenge` now accepts `/WorkingHoliday/Application/Submit.aspx?ApplicationId=...`, so `captchaGuard` reaches the "Đang đọc cấu hình / Đang thử 2Captcha" path instead of the unsupported message. `websiteURL` keeps the query string on that page only, and the `/rs-captcha` path stays query-free. No new click was added: `captchaSubmitCandidate` is untouched and still limited to captcha paths. After the token is injected, the existing gated `finishApplication` flow runs (12/12 declarations verified, URL/stage/blocked/payment re-check, `submitting()`, one click).

Watch for: the real Submit.aspx DOM was never inspected (the fixture is assumed), and no end-to-end `captchaGuard` test uses a Submit.aspx URL (possible, non-blocking).

**Verdict**: APPROVED

## High-level view

Only the inspect script's page and destination gates changed, plus the equality check in `clearCaptchaToken`. All other restrictions stay: single visible standard anchor iframe, no enterprise/invisible/`data-callback`/`s`/`sa`, empty response textarea, a single "Submit" button in the same form, same-origin destination. A page using a callback therefore still returns null and falls back to manual, so the "call the page callback" requirement is not implemented. That is a conservative outcome and is consistent with the Personal1 path, which also declines callbacks.

The submission semantics are unchanged. The final click still sits behind declaration verification, the re-read, `submitting()` and a single click. The secret-handling code is untouched, and the key is still loaded by `loadTwoCaptchaKey`. The unsupported message is byte-identical, and `captcha.test.ts` now asserts that exact string.

<details>
<summary>Issues (3)</summary>

1. **Unverified real DOM (possible, non-blocking)** — the Submit.aspx widget structure (same-form textarea, no callback) is assumed. Check the first live run; if it fails, the run falls back to manual.
2. **No Submit.aspx-level captchaGuard test (possible, non-blocking)** — consider a test that the solver is called with the query-included URL via `captchaGuard`. Detection and URL are covered in `capsolver-browser.test.ts`.
3. **ApplicationId sent to 2Captcha (confirmed, informational)** — the query string is sent in the task page URL by design and is not a credential.

</details>

<details>
<summary>Details</summary>

## Page gate and websiteURL

`isSubmitPage` requires an exact path match and an `ApplicationId` parameter, so the `?Token=` receipt page, Declarations.aspx and Personal1.aspx are rejected (tests cover each). `clearCaptchaToken` computes the same URL, so a rejected token is cleared on Submit.aspx. A late result after the query string changes is ignored (tested).

## Safety posture

No secrets are logged. The diff has no new click path. `applyCaptchaToken` still refuses a non-empty response, so a human completion wins. The manual-fallback test for `unsupported` still resolves to true after the user solves in Chrome.

## Verification evidence

The plan file records `npm run typecheck` clean and vitest at 29 files / 258 tests passing; there is no lint script. I did not re-run them. The diff is consistent with that.

</details>

<details>
<summary>File map</summary>

- workflow/capsolver-browser.ts — Submit.aspx gate, query-keeping websiteURL, clear check
- workflow/capsolver-browser.test.ts — Submit.aspx positive, late-result and negative variants
- workflow/captcha.test.ts — exact unsupported message assertion

</details>
