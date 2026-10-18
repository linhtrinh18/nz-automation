# Plan: solve the Submit.aspx reCAPTCHA v2 with 2Captcha

No restructuring: this is one coherent change (one inspect script, one URL rule, tests), so the existing implement-and-review loop applies. Review verdict file: `.agents/tasks/2captcha-submit-page-review.json` (`verdict` = `APPROVED`).

## (a) Root cause

VERIFIED from code (live DOM not inspected; no Submit.aspx fixture exists in the repo, `fixtures/` only has `sample.json`):

- `captchaGuard` (workflow/run.ts ~L153) calls `readCaptchaChallenge` (workflow/capsolver-browser.ts). When it returns null, run.ts L198 emits "Chưa hỗ trợ cấu hình CAPTCHA này." and never prints "Đang đọc cấu hình" / "Đang thử 2Captcha". This matches the log.
- The first gate in the `inspect` script is the exact failing condition:
  `if (location.origin !== arguments[0] || !captchaPath(location.pathname)) return null;`
  `captchaPath` only accepts paths whose last segment contains "captcha" (e.g. `/rs-captcha`). `/WorkingHoliday/Application/Submit.aspx` does not match, so null is returned before any iframe inspection.
- Even if that gate passed, three more checks would fail on Submit.aspx: the form `action` must also satisfy `captchaPath`; the single submit button's target must satisfy `captchaPath`; and the button text must be exactly "Submit" (the INZ button is likely fine). `captchaSubmitCandidate` in run.ts has the same `captchaPath` gate.

INFERRED (needs a fixture and a real check): the Submit.aspx widget is a standard anchor iframe (`size=normal`, no `s`/`sa`, no `data-callback`, no enterprise). The user says it looks identical to the earlier one. The `g-recaptcha-response` textarea is inside the same `<form>` as the iframe and the SUBMIT button. ASP.NET WebForms usually has one big `<form>`, which also contains the 12 declaration checkboxes.

## (b) Smallest correct change

All in `workflow/capsolver-browser.ts`, with a small touch in `workflow/run.ts`.

1. Add a second allowed page kind to `inspect`: `isSubmitPage = location.pathname === '/WorkingHoliday/Application/Submit.aspx' && new URLSearchParams(location.search).has('ApplicationId')`. Do not accept the `Token` receipt URL; that is the "Submit Received" page. Gate: `if (origin mismatch || !(captchaPath(path) || isSubmitPage)) return null`.
2. Keep every other check (single visible `www.google.com`/`recaptcha.net` anchor iframe, `size=normal`, no enterprise/invisible/`data-callback`/`s`/`sa`, a single empty `g-recaptcha-response` in the same form as the iframe, a single visible "Submit" button, no foreign form target). Relax only the destination check: for the Submit page, the form action and button target must be same-origin and equal `/WorkingHoliday/Application/Submit.aspx` (a missing `action` resolves to the current URL, which is fine). Callbacks stay declined, so the "call the page callback" requirement only applies if a callback is present; then it remains unsupported and falls back to manual. Mention this in the code comment.
3. websiteURL. Today it is `origin + pathname` (query stripped, deliberately, for the private `/rs-captcha?redirect=...`). Change to `origin + pathname + search` for the Submit page only (hash dropped). The captcha path keeps the query-free URL, so the working Personal1 flow is unchanged. Note that the ApplicationId is sent to 2Captcha as part of the page URL; this is required by the 2Captcha docs, and the id is not a secret credential.
4. Update `clearCaptchaToken`'s equality check (`origin + pathname !== websiteURL`) to compare against the same computed URL: `origin + pathname + (submit page ? search : '')`. Otherwise a rejected token is never cleared on this page. Extract a small shared string constant or a helper in the script so both places use the same logic.
5. `applyCaptchaToken` already writes the token into `g-recaptcha-response` and dispatches input/change; no change besides the revalidation above.
6. `workflow/run.ts` `captchaSubmitCandidate`: leave as is. It stays restricted to captcha-path forms, so it never auto-clicks anything on Submit.aspx. Do not change the messages ("Chưa hỗ trợ cấu hình CAPTCHA này." stays byte-identical).
7. `workflow/two-captcha.ts` needs no change: it already takes `{ websiteURL, websiteKey }` and sends them to createTask (RecaptchaV2TaskProxyless). Implementer: confirm that it does not strip the query string.

## (c) Which button is clicked

No new click. On Submit.aspx the SUBMIT button IS the final application submission (`readSubmissionPage` treats a "Submit"/"Submit application" button on the declaration stage as the final submit, and it sets `declarationSubmitted`). Flow after the change:
- `finishApplication` verifies 12/12 declarations, then calls `waitForCaptcha` (`captchaGuard`).
- `captchaGuard` solves with 2Captcha and injects the token. `captchaPending` becomes false (the response is non-empty) and `captchaGuard` returns, with no click. `captchaSubmitCandidate` returns null on this path because of `captchaPath`, so there is no CAPTCHA-only click.
- `finishApplication` re-reads the page and re-checks URL, stage, declarations, the blocked/payment flags, then `submitting()`, then clicks the one gated button once. The submit-once and blocked/confirmed gates are untouched.

AMBIGUITY to flag: auto-solving here means that, in fillAndSubmit mode, the run proceeds to the final click without a human. This already happens today when the human solves the CAPTCHA, so the gating is unchanged, but the reviewer should confirm that the user intends it (yes per the stated goal). The manual path still works: if the human ticks the box first, the textarea is non-empty and the provider result is dropped (human completion wins; `applyCaptchaToken` refuses non-empty responses).

Open risk: Google's token may require a form-field-based callback that the page needs (the `data-callback` case). If the real DOM has one, the new code returns null and the run falls back to manual, so it is safe. The real DOM was NOT verified; tell the user to check the first live run.

## (d) Tests (vitest)

Run: `npx vitest run workflow/capsolver-browser.test.ts workflow/captcha.test.ts workflow/two-captcha.test.ts workflow/submission.test.ts`, then the full `npx vitest run` and the typecheck from package.json scripts (read it; likely `npx tsc --noEmit`).

In `workflow/capsolver-browser.test.ts` extend the `fixture` options with `search` (location.search/href) and a path override already exists:
- Submit page positive: path `/WorkingHoliday/Application/Submit.aspx`, search `?ApplicationId=4085718`, form action null or the same path, extracts `websiteURL = origin + path + "?ApplicationId=4085718"`, the right key, pageId.
- Captcha path unchanged: `/rs-captcha?redirect=...` still returns the query-free URL.
- Submit page negatives return null: no `ApplicationId`; Token receipt URL (`?Token=...`); foreign origin; `/WorkingHoliday/Application/Declarations.aspx`; Personal1.aspx (this existing case stays in the list); enterprise/invisible/`data-callback`/`s`/`sa`; count 0 or 2; pre-filled token; form action to another path; two buttons.
- apply and clear on the Submit page: token set only when empty and the URL matches; clear works on that URL and refuses a human token; late result after a pageId or search change is ignored.
In `workflow/captcha.test.ts` (see the "2Captcha selection" test.each around L335) add a Submit.aspx-style case, where the fixture challenge is non-null and `solveTwoCaptcha` is called with the query-included `websiteURL`. Add a case proving that a null challenge (genuinely unsupported config) still emits exactly "Chưa hỗ trợ cấu hình CAPTCHA này. Giải CAPTCHA trong Chrome; tác vụ tự tiếp tục. Chỉ nút Submit riêng của CAPTCHA được tự bấm khi có phản hồi." and never calls the solver (check whether the existing "unsupported" case already asserts this; strengthen it if not).
In `workflow/submission.test.ts`, assert that with the token injected by captchaGuard the existing single gated click and submit-once behaviour remain (only if an existing test is easy to extend; do not weaken any assertions).

Do not commit. Never print API key values; reference `loadTwoCaptchaKey` by name only.

## Verification
- Implemented in workflow/capsolver-browser.ts (Submit.aspx + ApplicationId accepted; websiteURL keeps query only there; clear check aligned), tests in capsolver-browser.test.ts and an exact-message assertion in captcha.test.ts. two-captcha.ts unchanged (passes websiteURL as given). No lint script in package.json.
- `npm run typecheck`: clean. `npx vitest run`: 29 files, 258 tests passed.
- NOT verified: real Submit.aspx DOM (fixture is minimal/assumed), any live run, paid solve, or final submission. No commit made.
- Flag: no new click; after token injection the existing gated final submit action runs (declarations verified, once-only).
