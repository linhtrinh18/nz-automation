import type { WebDriver } from "selenium-webdriver";

export type PageState = "home" | "create" | "captcha" | "wizard" | "login" | "other";

/** URL-only classification. Foreign origins are always "other". */
export function classifyUrl(url: string, allowedOrigin: string): PageState {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "other";
  }
  if (parsed.origin !== allowedOrigin) return "other";
  const path = parsed.pathname;
  if (/captcha/i.test(path)) return "captcha";
  if (/^\/WorkingHoliday\/Application\/Create\.aspx$/i.test(path)) return "create";
  if (/^\/WorkingHoliday\/Wizard\//i.test(path)) return "wizard";
  if (/login/i.test(path)) return "login";
  if (/^\/WorkingHoliday\/?$/i.test(path)) return "home";
  return "other";
}

/** URL first; DOM signals (CAPTCHA heading/widget, login form) for URLs that do not decide it. */
export async function classifyPage(driver: WebDriver, allowedOrigin: string): Promise<PageState> {
  const byUrl = classifyUrl(await driver.getCurrentUrl(), allowedOrigin);
  if (byUrl === "other" && !(await driver.getCurrentUrl()).startsWith(allowedOrigin)) return "other";
  if (byUrl === "captcha" || byUrl === "create" || byUrl === "wizard") return byUrl;
  const dom = await driver.executeScript<"captcha" | "login" | null>(`
    const pageText = document.body?.innerText || '';
    const visible = e => e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0;
    if (/please complete the captcha/i.test(pageText)
      || Array.from(document.querySelectorAll('iframe[src*="recaptcha"],.g-recaptcha')).some(visible)) return 'captcha';
    if (document.querySelector('input[name="username"]')) return 'login';
    return null;
  `);
  return dom ?? byUrl;
}

import type { AuthState } from "./auth-state";
export interface PageProbe { site: false | true | "busy" | "denied"; captcha: boolean; auth: AuthState }
/**
 * One executeScript that answers the site-state, CAPTCHA and auth questions of a poll.
 * Each part is the existing single-purpose script wrapped in a function, so predicates stay identical.
 */
export function buildPageProbeScript(parts: { site: string; captcha: string; auth: string }): string {
  return `
    const nzwhSite = (function () {${parts.site}})();
    const nzwhCaptcha = (function () {${parts.captcha}})();
    const nzwhAuth = (function () {${parts.auth}})();
    return { nzwhProbe: 1, site: nzwhSite, captcha: nzwhCaptcha, auth: nzwhAuth };
  `;
}
/** Returns the probe only for a well-formed answer; anything else (older fakes, navigation) is null. */
export function parsePageProbe(raw: unknown): PageProbe | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const auth = value.auth as Record<string, unknown> | null | undefined;
  if (value.nzwhProbe !== 1 || typeof value.captcha !== "boolean" || typeof auth !== "object" || auth === null) return null;
  if (!(value.site === false || value.site === true || value.site === "busy" || value.site === "denied")) return null;
  return { site: value.site, captcha: value.captcha, auth: auth as unknown as AuthState };
}
