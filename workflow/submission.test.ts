import { runInNewContext } from "node:vm";
import { expect, test, vi } from "vitest";
import type { WebDriver } from "selenium-webdriver";
import { StopRequested } from "../lib/execution-controller";
import { finishApplication, readSubmissionPage } from "./submission";

const origin = "https://onlineservices.immigration.govt.nz";
const applicationId = "fixture-123";
const path = (name: string) => `${origin}/WorkingHoliday/${name}?ApplicationId=${applicationId}`;
const footer = "ContentPlaceHolder1_wizardPageFooter_wizardPageNavigator_submitImageButton";

interface Page {
  url: string;
  message?: string;
  hiddenMessage?: boolean;
  hiddenChild?: boolean;
  body?: string;
  alert?: string;
  button?: string;
  id?: string;
  disabled?: boolean;
  disabledUntilDeclarations?: boolean;
  action?: string;
  duplicateButton?: boolean;
  declarations?: string[];
  login?: boolean;
}

/** Exercise the actual DOM script and state machine, with no target-site requests. */
function fixture(pages: Page[]) {
  let index = 0;
  const clicks: string[] = [];
  const visible = { getBoundingClientRect: () => ({ width: 100, height: 20 }) };
  const checks = pages.map(page => (page.declarations ?? []).map(label => ({
    ...visible, disabled: false, checked: false,
    labels: [{ ...visible, innerText: label }],
    form: { getAttribute: () => page.action ?? page.url },
    getAttribute: () => null,
    async isSelected() { return this.checked; },
    async click() { this.checked = true; clicks.push(label); },
  })));
  const executeScript = vi.fn(async (script: string, ...args: unknown[]) => {
    const page = pages[index];
    const form = { getAttribute: () => page.action ?? page.url };
    const buttons = page.button ? [{
      ...visible, value: page.button, id: page.id ?? "finalSubmit",
      disabled: page.disabled ?? (page.disabledUntilDeclarations && checks[index].some(control => !control.checked)) ?? false,
      form, getAttribute: () => null,
      click: async () => { clicks.push(page.id ?? "finalSubmit"); index = Math.min(index + 1, pages.length - 1); },
    }] : [];
    if (page.duplicateButton && buttons[0]) buttons.push(buttons[0]);
    const document = {
      body: { innerText: page.body ?? page.message ?? "", scrollHeight: 3000 },
      documentElement: { scrollHeight: 3000 },
      querySelector: () => page.login ? {} : null,
      querySelectorAll: (selector: string) => {
        if (selector.startsWith(".validation")) return page.alert ? [{ ...visible, innerText: page.alert }] : [];
        if (selector.startsWith("h1")) return [{
          innerText: page.hiddenChild ? "" : page.message ?? "",
          textContent: page.message ?? "",
          getBoundingClientRect: () => ({ width: page.hiddenMessage ? 0 : 100, height: 20 }),
        }];
        if (selector === 'input[type="checkbox"]') return checks[index];
        return buttons;
      },
    };
    return runInNewContext(`(function(){${script}}).apply(null, args)`, {
      document, window: { scrollTo: () => {} }, URL, location: { href: page.url }, performance: { timeOrigin: index }, args,
    });
  });
  const driver = { executeScript } as unknown as WebDriver;
  const options = {
    mode: "fillAndSubmit" as "fillAndSubmit" | "saveAll",
    filled: true, origin, applicationId,
    checkpoint: vi.fn(async () => {}),
    ready: vi.fn(async () => {}),
    submitting: vi.fn(async () => {}),
    confirmed: vi.fn(async () => {}),
    waitForChange: vi.fn(async (condition: () => Promise<boolean>) => {
      if (!(await condition())) throw new Error("timeout");
    }),
  };
  return { driver, options, clicks, checks, executeScript };
}

test("fill only stops before any declaration, CAPTCHA or final submit interaction", async () => {
  const { driver, options, clicks, executeScript } = fixture([]);
  const result = await finishApplication(driver, { ...options, mode: "saveAll" });
  expect(result).toMatchObject({ success: true, outcome: "filled" });
  expect(result.message).toContain("Chưa nộp");
  expect(executeScript).not.toHaveBeenCalled();
  expect(clicks).toEqual([]);
});

test.each(["saveAll", "fillAndSubmit"] as const)("%s cannot complete or submit with unverified sections", async mode => {
  const { driver, options, executeScript } = fixture([]);
  expect(await finishApplication(driver, { ...options, mode, filled: false })).toMatchObject({ success: false, outcome: "incomplete" });
  expect(executeScript).not.toHaveBeenCalled();
});

test("fills declarations and submits once, requiring website confirmation of the pinned application", async () => {
  const { driver, options, clicks, checks } = fixture([
    { url: path("Wizard/WorkingHoliday.aspx"), button: "SUBMIT", id: footer },
    { url: path("Application/Submit.aspx"), button: "Submit application", declarations: ["I agree to the declaration", "Subscribe to updates"] },
    { url: path("Application/Confirmation.aspx"), message: "Your application has been successfully submitted." },
  ]);
  expect(await finishApplication(driver, options)).toMatchObject({ success: true, outcome: "submitted" });
  expect(clicks).toEqual([footer, "I agree to the declaration", "finalSubmit"]);
  expect(checks[1][1].checked).toBe(false);
  expect(options.submitting).toHaveBeenCalledTimes(2);
  expect(options.confirmed).toHaveBeenCalledOnce();
  expect(options.submitting.mock.invocationCallOrder[0]).toBeLessThan(options.confirmed.mock.invocationCallOrder[0]);
});

test.each([
  { url: path("Wizard/Personal.aspx"), message: "Section saved successfully." },
  { url: `${origin}/rs-captcha?ApplicationId=${applicationId}`, message: "Your application has been submitted." },
  { url: path("Application/Submit.aspx"), message: "Your application has not been submitted." },
  { url: path("Application/Submit.aspx"), message: "Your application has been submitted. Submission failed." },
  { url: path("Application/Submit.aspx"), message: "When your application has been submitted, you will receive an email." },
  { url: path("Application/Submit.aspx"), message: "Your application has been submitted.", hiddenMessage: true },
  { url: path("Application/Submit.aspx"), message: "Your application has been submitted.", hiddenChild: true },
  { url: path("Application/Confirmation.aspx"), message: "Payment successful." },
  { url: path("Application/Confirmation.aspx"), message: "Thank you." },
  { url: path("Application/Confirmation.aspx"), message: "Your application has been submitted.", alert: "Please correct the application." },
  { url: path("Application/Confirmation.aspx").replace(applicationId, "other"), message: "Your application has been submitted." },
  { url: path("Application/Confirmation.aspx").replace(origin, "https://foreign.example"), message: "Your application has been submitted." },
  { url: path("Application/Confirmation.aspx"), message: "Your application has been submitted.", login: true },
])("does not claim submission from ambiguous, hidden, CAPTCHA or unrelated evidence: %j", async page => {
  const { driver, options, clicks } = fixture([page]);
  expect((await readSubmissionPage(driver, origin, applicationId)).confirmed).toBe(false);
  expect(await finishApplication(driver, options)).toMatchObject({ success: false, outcome: "incomplete" });
  expect(options.confirmed).not.toHaveBeenCalled();
  expect(clicks).toEqual([]);
});

test.each([
  { url: path("Application/Submit.aspx"), button: "Submit", action: "https://foreign.example/submit" },
  { url: path("Application/Submit.aspx"), button: "Submit", action: path("Application/Submit.aspx").replace(applicationId, "other") },
  { url: path("Application/Submit.aspx"), button: "Submit", disabled: true },
  { url: path("Application/Submit.aspx"), button: "Submit", duplicateButton: true },
  { url: path("Wizard/Personal.aspx"), button: "SAVE" },
])("rejects unsafe, unavailable, ambiguous or draft submit controls: %j", async page => {
  const { driver, options, clicks } = fixture([page]);
  expect(await finishApplication(driver, options)).toMatchObject({ success: false, outcome: "incomplete" });
  expect(clicks).toEqual([]);
});

test.each([
  { url: path("Application/Submit.aspx"), alert: "Required field missing." },
  { url: path("Application/Submit.aspx"), body: "Please try again later." },
  { url: path("Application/Payment.aspx"), body: "Payment is required. Pay now." },
  { url: path("Application/Submit.aspx"), button: "Submit" },
])("failed or uncertain final responses never retry or report submitted: %j", async response => {
  const { driver, options, clicks } = fixture([
    { url: path("Application/Submit.aspx"), button: "Submit" }, response,
  ]);
  expect(await finishApplication(driver, options)).toMatchObject({ success: false, outcome: "incomplete" });
  expect(clicks).toEqual(["finalSubmit"]);
  expect(options.confirmed).not.toHaveBeenCalled();
});

test("stop before final submission prevents the click", async () => {
  const { driver, options, clicks } = fixture([{ url: path("Application/Submit.aspx"), button: "Submit" }]);
  options.checkpoint.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new StopRequested());
  await expect(finishApplication(driver, options)).rejects.toBeInstanceOf(StopRequested);
  expect(clicks).toEqual([]);
  expect(options.submitting).not.toHaveBeenCalled();
});

test("declaration consent enables Submit before it is clicked", async () => {
  const { driver, options, clicks } = fixture([
    { url: path("Application/Submit.aspx"), button: "Submit", declarations: ["I have read and agree"], disabledUntilDeclarations: true },
    { url: path("Application/Confirmation.aspx"), message: "Thank you. Your application has been submitted to Immigration New Zealand." },
  ]);
  expect(await finishApplication(driver, options)).toMatchObject({ success: true, outcome: "submitted" });
  expect(clicks).toEqual(["I have read and agree", "finalSubmit"]);
});

test("a click timeout leaves submission unconfirmed and is never retried", async () => {
  const { driver, options, clicks } = fixture([{ url: path("Application/Submit.aspx"), button: "Submit" }]);
  expect(await finishApplication(driver, options)).toMatchObject({ success: false, outcome: "incomplete" });
  expect(clicks).toEqual(["finalSubmit"]);
  expect(options.submitting).toHaveBeenCalledOnce();
  expect(options.confirmed).not.toHaveBeenCalled();
});

test("selects declarations before waiting for CAPTCHA, then submits", async () => {
  const { driver, options, clicks, checks } = fixture([
    { url: path("Application/Submit.aspx"), button: "Submit", declarations: ["I understand the declaration", "I am fully aware of the requirements"] },
    { url: path("Application/Confirmation.aspx"), message: "Your application has been submitted." },
  ]);
  const waitForCaptcha = vi.fn(async () => {
    expect(checks[0].every(control => control.checked)).toBe(true);
    expect(clicks).not.toContain("finalSubmit");
    clicks.push("captcha-resolved");
  });
  expect(await finishApplication(driver, { ...options, waitForCaptcha })).toMatchObject({ success: true });
  expect(clicks).toEqual(["I understand the declaration", "I am fully aware of the requirements", "captcha-resolved", "finalSubmit"]);
});

test("does not submit when CAPTCHA completion resets a declaration", async () => {
  const { driver, options, clicks, checks } = fixture([
    { url: path("Application/Submit.aspx"), button: "Submit", declarations: ["I agree"] },
  ]);
  const waitForCaptcha = async () => { checks[0][0].checked = false; };
  expect(await finishApplication(driver, { ...options, waitForCaptcha })).toMatchObject({ outcome: "incomplete" });
  expect(clicks).toEqual(["I agree"]);
  expect(options.submitting).not.toHaveBeenCalled();
});

test("selects all declarations in one batch and logs count", async () => {
  const { driver, options, clicks } = fixture([
    { url: path("Application/Submit.aspx"), button: "Submit", declarations: ["I agree", "I understand", "I confirm"] },
    { url: path("Application/SubmitConfirmation.aspx?ApplicationId=" + applicationId), message: "Application submitted" },
  ]);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await finishApplication(driver, options);
  expect(clicks.slice(0, 3)).toEqual(["I agree", "I understand", "I confirm"]);
  expect(log.mock.calls.some(call => /Declarations: selected 3\/3 Yes in one batch/.test(String(call[0])))).toBe(true);
  log.mockRestore();
});
