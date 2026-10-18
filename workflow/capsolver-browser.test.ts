import { expect, test } from "vitest";
import { runInNewContext } from "node:vm";
import type { WebDriver } from "selenium-webdriver";
import { readCaptchaChallenge, applyCaptchaToken, clearCaptchaToken } from "./capsolver-browser";
const origin = "https://onlineservices.immigration.govt.nz";
const sitekey = "public-site-key-1234567890";
function fixture(options: { host?: string; path?: string; src?: string; count?: number; token?: string; unsupported?: boolean; sameForm?: boolean; action?: string; pageId?: number; buttons?: number; buttonAction?: string; search?: string } = {}) {
  const frame = { src: options.src ?? `https://www.google.com/recaptcha/api2/anchor?k=${sitekey}&size=normal`, getBoundingClientRect: () => ({ width: 304, height: 78 }) };
  const button = { value: "Submit", disabled: false, getBoundingClientRect: frame.getBoundingClientRect, getAttribute: () => options.buttonAction ?? null };
  const form = { contains: () => options.sameForm !== false, getAttribute: () => options.action ?? "/rs-captcha", querySelectorAll: () => Array(options.buttons ?? 1).fill(button) };
  const response = { value: options.token ?? "", form, dispatchEvent: () => {} };
  const host = options.host ?? origin;
  const path = options.path ?? "/rs-captcha";
  const driver = { executeScript: async (script: string, ...args: unknown[]) => runInNewContext(`(() => {${script}})()`, {
    arguments: args, URL, URLSearchParams, Event, performance: { timeOrigin: options.pageId ?? 123 },
    location: { origin: host, pathname: path, search: options.search ?? "?redirect=private-application-id", href: `${host}${path}?redirect=private-application-id#private-fragment` },
    document: {
      querySelector: () => options.unsupported ? {} : null,
      querySelectorAll: (selector: string) => selector === "iframe" ? Array(options.count ?? 1).fill(frame) : [response],
    },
  }) } as unknown as WebDriver;
  return { driver, response };
}

test("extracts only a public key and query-free page URL from a standard v2 form", async () => {
  const { driver } = fixture();
  const challenge = await readCaptchaChallenge(driver, origin);
  expect(JSON.parse(JSON.stringify(challenge))).toEqual({ websiteURL: origin + "/rs-captcha", websiteKey: sitekey, pageId: 123 });
});

test.each([
  { host: "https://foreign.invalid" }, { path: "/WorkingHoliday/Wizard/Personal1.aspx" },
  { src: `https://www.google.com/recaptcha/enterprise/anchor?k=${sitekey}&size=normal` },
  { src: `https://www.google.com/recaptcha/api2/anchor?k=${sitekey}&size=invisible` },
  { src: `https://www.google.com/recaptcha/api2/anchor?k=${sitekey}&size=normal&s=private` },
  { src: `https://www.google.com/recaptcha/api2/anchor?k=${sitekey}&size=normal&sa=submit` },
  { src: `https://www.google.com.evil.invalid/recaptcha/api2/anchor?k=${sitekey}&size=normal` },
  { src: "about:blank" }, { count: 2 }, { count: 0 }, { token: "human-token" },
  { unsupported: true }, { sameForm: false }, { action: "/WorkingHoliday/Wizard/Submit.aspx" },
  { buttons: 2 }, { buttonAction: "https://foreign.invalid/rs-captcha" },
])("falls back without extracting unsupported or unsafe challenges: %j", async options => {
  await expect(readCaptchaChallenge(fixture(options).driver, origin)).resolves.toBeNull();
});

test("sets only the matching empty response, and clears only its own rejected token", async () => {
  const { driver, response } = fixture();
  const challenge = (await readCaptchaChallenge(driver, origin))!;
  await expect(applyCaptchaToken(driver, origin, challenge, "provider-token")).resolves.toBe(true);
  expect(response.value).toBe("provider-token");
  response.value = "human-token";
  await clearCaptchaToken(driver, origin, challenge, "provider-token");
  expect(response.value).toBe("human-token");
  response.value = "provider-token";
  await clearCaptchaToken(driver, origin, challenge, "provider-token");
  expect(response.value).toBe("");
});

test("ignores a late result after navigation, widget change or human completion", async () => {
  const expected = (await readCaptchaChallenge(fixture().driver, origin))!;
  for (const options of [{ pageId: 456 }, { token: "human-token" }, { src: `https://www.google.com/recaptcha/api2/anchor?k=other-public-key-123456789&size=normal` }]) {
    const { driver, response } = fixture(options);
    expect(await applyCaptchaToken(driver, origin, expected, "provider-token")).toBeFalsy();
    expect(response.value).not.toBe("provider-token");
  }
});

// Minimal fixture: the real Submit.aspx DOM was NOT verified (standard visible checkbox + SUBMIT assumed).
const submit = { path: "/WorkingHoliday/Application/Submit.aspx", search: "?ApplicationId=4085718", action: "/WorkingHoliday/Application/Submit.aspx" };
test("Submit.aspx: keeps the query string in websiteURL and applies/clears the token", async () => {
  const { driver, response } = fixture(submit);
  const challenge = (await readCaptchaChallenge(driver, origin))!;
  expect(JSON.parse(JSON.stringify(challenge))).toEqual({ websiteURL: origin + submit.path + submit.search, websiteKey: sitekey, pageId: 123 });
  await expect(applyCaptchaToken(driver, origin, challenge, "provider-token")).resolves.toBe(true);
  expect(response.value).toBe("provider-token");
  await clearCaptchaToken(driver, origin, challenge, "provider-token");
  expect(response.value).toBe("");
});
test("Submit.aspx: ignores a late result after the query string changes", async () => {
  const expected = (await readCaptchaChallenge(fixture(submit).driver, origin))!;
  const { driver, response } = fixture({ ...submit, search: "?ApplicationId=999" });
  expect(await applyCaptchaToken(driver, origin, expected, "provider-token")).toBeFalsy();
  expect(response.value).toBe("");
});
test.each([
  { search: "" }, { search: "?Token=abc" }, { path: "/WorkingHoliday/Application/Declarations.aspx", action: "/WorkingHoliday/Application/Declarations.aspx" },
  { action: "/WorkingHoliday/Wizard/Personal1.aspx" }, { buttonAction: "/WorkingHoliday/Wizard/Personal1.aspx" },
  { count: 0 }, { count: 2 }, { token: "human-token" }, { buttons: 2 }, { unsupported: true }, { host: "https://foreign.invalid" },
])("Submit.aspx: falls back to manual for unsupported variants: %j", async options => {
  await expect(readCaptchaChallenge(fixture({ ...submit, ...options }).driver, origin)).resolves.toBeNull();
});
