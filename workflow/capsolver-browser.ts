import type { WebDriver } from "selenium-webdriver";

export interface CaptchaChallenge {
  websiteURL: string;
  websiteKey: string;
  pageId: number;
}

// Standard v2 checkbox on a dedicated same-origin CAPTCHA form only. Explicit
// callbacks are declined; no callback is invoked. Unknown variants stay manual.
const inspect = `
  const capsolverChallenge = true;
  const captchaPath = path => /\\/(?:[a-z0-9_-]*captcha[a-z0-9_-]*)(?:\\.(?:aspx|html?))?$/i.test(path);
  if (location.origin !== arguments[0] || !captchaPath(location.pathname)) return null;
  const visible = e => e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0;
  if (document.querySelector('script[src*="/recaptcha/enterprise"],iframe[src*="hcaptcha"],.h-captcha,.cf-turnstile,[data-callback],[data-s],[data-action],[data-size="invisible"]')) return null;
  const frames = Array.from(document.querySelectorAll('iframe')).filter(e => {
    try {
      const url = new URL(e.src);
      return ['www.google.com', 'www.recaptcha.net'].includes(url.hostname)
        && url.protocol === 'https:' && url.pathname === '/recaptcha/api2/anchor' && visible(e);
    } catch { return false; }
  });
  if (frames.length !== 1) return null;
  const frame = frames[0];
  const url = new URL(frame.src);
  if (url.searchParams.get('size') !== 'normal' || url.searchParams.has('s') || url.searchParams.has('sa')) return null;
  const key = url.searchParams.get('k');
  if (!key || !/^[a-zA-Z0-9_-]{20,200}$/.test(key)) return null;
  const responses = Array.from(document.querySelectorAll('textarea[name="g-recaptcha-response"]'));
  if (responses.length !== 1 || responses[0].value.trim()) return null;
  const response = responses[0];
  const form = response.form;
  if (!form || !form.contains(frame)) return null;
  const destination = new URL(form.getAttribute('action') || location.href, location.href);
  if (destination.origin !== location.origin || !captchaPath(destination.pathname)) return null;
  const buttons = Array.from(form.querySelectorAll('input[type="submit"],button[type="submit"],button:not([type])'))
    .filter(e => !e.disabled && visible(e) && /^submit$/i.test((e.value || e.textContent || '').trim()));
  if (buttons.length !== 1) return null;
  const target = new URL(buttons[0].getAttribute('formaction') || destination.href, location.href);
  if (target.origin !== location.origin || !captchaPath(target.pathname)) return null;
  const challenge = { websiteURL: location.origin + location.pathname, websiteKey: key, pageId: performance.timeOrigin };
`;

export async function readCaptchaChallenge(driver: WebDriver, origin: string): Promise<CaptchaChallenge | null> {
  return driver.executeScript(`${inspect} return challenge;`, origin);
}

/** Revalidate page, widget and empty response immediately before applying a result. */
export async function applyCaptchaToken(driver: WebDriver, origin: string, expected: CaptchaChallenge, token: string): Promise<boolean> {
  return driver.executeScript(`${inspect}
    const expected = arguments[1];
    if (challenge.pageId !== expected.pageId || challenge.websiteURL !== expected.websiteURL || challenge.websiteKey !== expected.websiteKey) return false;
    response.value = arguments[2];
    response.dispatchEvent(new Event('input', { bubbles: true }));
    response.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  `, origin, expected, token);
}

/** Remove only our own unaccepted token, never a replacement supplied by the user. */
export async function clearCaptchaToken(driver: WebDriver, origin: string, expected: CaptchaChallenge, token: string): Promise<void> {
  await driver.executeScript(`
    if (location.origin !== arguments[0] || performance.timeOrigin !== arguments[1].pageId
      || location.origin + location.pathname !== arguments[1].websiteURL) return;
    for (const e of document.querySelectorAll('textarea[name="g-recaptcha-response"]')) {
      if (e.value === arguments[2]) e.value = '';
    }
  `, origin, expected, token);
}
