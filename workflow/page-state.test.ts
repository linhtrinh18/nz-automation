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
