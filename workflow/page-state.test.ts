import { expect, test, vi } from "vitest";
import type { WebDriver } from "selenium-webdriver";
import { classifyPage, classifyUrl } from "./page-state";

const o = "https://onlineservices.immigration.govt.nz";
test("classifies the four known pages by URL", () => {
  expect(classifyUrl(`${o}/WorkingHoliday/`, o)).toBe("home");
  expect(classifyUrl(`${o}/WorkingHoliday`, o)).toBe("home");
  expect(classifyUrl(`${o}/WorkingHoliday/Application/Create.aspx?CountryId=109&OffShore=1&STZ=0`, o)).toBe("create");
  expect(classifyUrl(`${o}/rs-captcha?redirect=%2FWorkingHoliday%2FWizard%2FPersonal1.aspx%3FApplicationId%3D4085216%26IndividualType%3DPrimary`, o)).toBe("captcha");
  expect(classifyUrl(`${o}/WorkingHoliday/Wizard/Personal1.aspx?ApplicationId=4085216&IndividualType=Primary`, o)).toBe("wizard");
  expect(classifyUrl(`${o}/secure/Login+Working+Holiday.htm`, o)).toBe("login");
});
test("foreign origins and garbage are other", () => {
  expect(classifyUrl("https://evil.example/WorkingHoliday/", o)).toBe("other");
  expect(classifyUrl("not a url", o)).toBe("other");
});
function driverAt(url: string, dom: string | null) {
  const executeScript = vi.fn(async () => dom);
  return { driver: { getCurrentUrl: async () => url, executeScript } as unknown as WebDriver, executeScript };
}
test("URL-decided pages need no DOM check", async () => {
  const { driver, executeScript } = driverAt(`${o}/WorkingHoliday/Application/Create.aspx?CountryId=109`, null);
  await expect(classifyPage(driver, o)).resolves.toBe("create");
  expect(executeScript).not.toHaveBeenCalled();
});
test("a CAPTCHA widget in front of the home URL is captcha", async () => {
  const { driver } = driverAt(`${o}/WorkingHoliday/`, "captcha");
  await expect(classifyPage(driver, o)).resolves.toBe("captcha");
});
test("home stays home without CAPTCHA signals; foreign origin skips DOM", async () => {
  await expect(classifyPage(driverAt(`${o}/WorkingHoliday/`, null).driver, o)).resolves.toBe("home");
  const foreign = driverAt("https://evil.example/x", "captcha");
  await expect(classifyPage(foreign.driver, o)).resolves.toBe("other");
  expect(foreign.executeScript).not.toHaveBeenCalled();
});
import { buildPageProbeScript, parsePageProbe } from "./page-state";
test("page probe: parser accepts only well-formed answers", () => {
  const auth = { loginForm: false, rejected: false, authenticated: true };
  expect(parsePageProbe({ nzwhProbe: 1, site: false, captcha: false, auth })).toEqual({ site: false, captcha: false, auth });
  expect(parsePageProbe({ nzwhProbe: 1, site: "busy", captcha: true, auth })).toMatchObject({ site: "busy", captcha: true });
  for (const bad of [null, false, "complete", [], { loginForm: false }, { nzwhProbe: 1, site: "x", captcha: false, auth }, { nzwhProbe: 1, site: false, captcha: 1, auth }, { nzwhProbe: 1, site: false, captcha: false }])
    expect(parsePageProbe(bad)).toBeNull();
});
test("page probe: one script wraps the three existing scripts", () => {
  const script = buildPageProbeScript({ site: "return 'denied';", captcha: "return true;", auth: "return {a:1};" });
  expect(script).toContain("(function () {return 'denied';})()");
  expect(script).toContain("nzwhProbe: 1");
});
