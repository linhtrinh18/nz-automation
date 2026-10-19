import { afterEach, expect, test, vi } from "vitest";
import { runInNewContext } from "node:vm";
import { error as webdriverError } from "selenium-webdriver";
import type { WebDriver, WebElement } from "selenium-webdriver";
import { captchaGuard, captchaPending, captchaSubmitCandidate, waitWithCaptcha, withHooksForTest } from "./run";
import { WorkingHolidayStop } from "./errors";
import { SiteBusyError } from "./site-busy";
import * as configuration from "../server/cloud";
import * as provider from "./capsolver";
import * as twoCaptcha from "./two-captcha";
import * as autoCaptcha from "./autocaptcha";
import * as twoConfig from "../server/cloud";
import * as browser from "./capsolver-browser";
import { StopRequested } from "../lib/execution-controller";
import type { ExecutionEvent } from "../lib/execution-state";

function fixture(states: boolean[], busy = false, ready: boolean[] = []) {
  const executeScript = vi.fn<(script: string) => Promise<unknown>>(async (script: string) => {
    if (script.includes("const captchaSubmit")) return null;
    if (script.includes("const challengePage")) return states.shift() ?? false;
    if (script.includes("document.readyState")) return ready.shift() ?? true;
    return busy;
  });
  const wait = vi.fn(async (condition: () => Promise<boolean>) => {
    for (let poll = 0; poll < 5; poll++) if (await condition()) return true;
    throw new webdriverError.TimeoutError("timeout");
  });
  return { driver: { executeScript, wait } as unknown as WebDriver, wait, executeScript };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

test("manual completion resumes automatically with 200 ms polling", async () => {
  const { driver, wait } = fixture([true, true, true, false]);
  await expect(captchaGuard(driver)).resolves.toBe(true);
  expect(wait).toHaveBeenCalledExactlyOnceWith(expect.any(Function), 30 * 60 * 1000, expect.any(String), 200);
});

test("no pending CAPTCHA proceeds without a manual confirmation or wait", async () => {
  const { driver, wait } = fixture([false]);
  await expect(captchaGuard(driver)).resolves.toBe(false);
  expect(wait).not.toHaveBeenCalled();
});

test("an unresolved CAPTCHA never proceeds", async () => {
  const { driver } = fixture(Array(6).fill(true));
  await expect(captchaGuard(driver)).rejects.toBeInstanceOf(WorkingHolidayStop);
});

test("site-busy responses are not mistaken for solved CAPTCHAs", async () => {
  const { driver } = fixture([true], true);
  await expect(captchaGuard(driver)).rejects.toBeInstanceOf(SiteBusyError);
});

test("a disappearing challenge waits for its destination page to finish loading", async () => {
  const { driver, executeScript } = fixture([true, false, false, false], false, [false, false, true]);
  await expect(captchaGuard(driver)).resolves.toBe(true);
  expect(executeScript.mock.calls.filter(([script]) => script.includes("document.readyState"))).toHaveLength(3);
});

test("a closed browser is reported as a browser error, not CAPTCHA expiry", async () => {
  const { driver, wait } = fixture([true]);
  wait.mockRejectedValueOnce(new webdriverError.NoSuchSessionError("closed"));
  await expect(captchaGuard(driver)).rejects.toBeInstanceOf(webdriverError.NoSuchSessionError);
});

test("two minutes solving CAPTCHA do not expire a 20-second page wait", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const { driver, wait } = fixture([true]);
  wait.mockImplementationOnce(async () => {
    vi.setSystemTime(120000);
    return true;
  });
  const condition = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce("ready");
  const result = waitWithCaptcha(driver, condition, 20000);
  const assertion = expect(result).resolves.toBe("ready");
  await vi.advanceTimersByTimeAsync(200);
  await assertion;
  expect(condition).toHaveBeenCalledTimes(2);
});

test("ordinary page waits still time out when there is no CAPTCHA", async () => {
  vi.useFakeTimers();
  const { driver } = fixture([false]);
  const result = waitWithCaptcha(driver, async () => false, 400);
  const assertion = expect(result).rejects.toBeInstanceOf(webdriverError.TimeoutError);
  await vi.advanceTimersByTimeAsync(400);
  await assertion;
});

test("later CAPTCHAs are handled by the same wait without restarting work", async () => {
  vi.useFakeTimers();
  const { driver, wait } = fixture([true, false, true, false, false]);
  const condition = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  const result = waitWithCaptcha(driver, condition, 20000);
  await vi.advanceTimersByTimeAsync(400);
  await expect(result).resolves.toBe(true);
  expect(wait).toHaveBeenCalledTimes(2);
  expect(condition).toHaveBeenCalledTimes(3);
});

// Execute the actual detector script against representative DOM observations.
test.each([
  { name: "challenge URL needs manual Submit even with a token", path: "/Captcha.aspx", text: "", widget: false, token: "solved", pending: true },
  { name: "inline instruction", path: "/WorkingHoliday/", text: "Please complete the CAPTCHA", widget: false, token: "", pending: true },
  { name: "visible unsolved widget", path: "/form", text: "", widget: true, token: "", pending: true },
  { name: "solved inline widget", path: "/form", text: "", widget: true, token: "solved", pending: false },
  { name: "hidden unused widget", path: "/form", text: "", widget: false, token: "", pending: false },
  { name: "page transition with no body", path: "/form", text: null, widget: false, token: "", pending: false },
])("CAPTCHA detection: $name", async ({ path, text, widget, token, pending }) => {
  const driver = {
    executeScript: async (script: string) => runInNewContext(`(() => {${script}})()`, {
      location: { pathname: path },
      document: {
        body: text === null ? null : { innerText: text },
        querySelectorAll: (selector: string) => selector.startsWith("iframe")
          ? [{ getBoundingClientRect: () => ({ width: widget ? 300 : 0, height: widget ? 80 : 0 }) }]
          : [{ value: token }],
      },
    }),
  } as unknown as WebDriver;
  await expect(captchaPending(driver)).resolves.toBe(pending);
});

function submitFixture(options: { path?: string; token?: string; origin?: string; action?: string; buttonAction?: string; count?: number; disabled?: boolean; sameForm?: boolean; visible?: boolean; label?: string } = {}) {
  const host = options.origin ?? "https://onlineservices.immigration.govt.nz";
  const path = options.path ?? "/WorkingHoliday/Captcha.aspx";
  const form = { getAttribute: () => options.action ?? path };
  const button = {
    form, value: options.label ?? "Submit", disabled: options.disabled ?? false,
    getBoundingClientRect: () => ({ width: options.visible === false ? 0 : 100, height: 30 }),
    getAttribute: () => options.buttonAction ?? null,
  };
  const response = { value: options.token ?? "manually-solved-token", form: options.sameForm === false ? {} : form };
  const driver = {
    executeScript: async (script: string, expectedOrigin: string) => runInNewContext(`(() => {${script}})()`, {
      arguments: [expectedOrigin], URL, performance: { timeOrigin: 123 },
      location: { origin: host, pathname: path, href: host + path },
      document: { querySelectorAll: (selector: string) => selector.startsWith("textarea") ? [response] : Array(options.count ?? 1).fill(button) },
    }),
  } as unknown as WebDriver;
  return { driver, button };
}

test("the solved CAPTCHA's own Submit button is selected", async () => {
  const { driver, button } = submitFixture();
  const result = await captchaSubmitCandidate(driver);
  expect(result?.button).toBe(button);
  expect(result?.completionId).toMatch(/^123:/);
  expect(result?.completionId).not.toContain("manually-solved-token");
});

test.each([
  { token: "" },
  { path: "/WorkingHoliday/Wizard/Declaration.aspx" },
  { path: "/WorkingHoliday/Wizard/Character.aspx" },
  { origin: "https://example.invalid" },
  { action: "/WorkingHoliday/Wizard/Submit.aspx" },
  { action: "https://example.invalid/Captcha.aspx" },
  { buttonAction: "/WorkingHoliday/Wizard/Submit.aspx" },
  { count: 2 }, { disabled: true }, { visible: false }, { sameForm: false },
  { label: "Submit application" },
])("never selects an unsafe or unresolved CAPTCHA submission: %j", async (options) => {
  const { driver } = submitFixture(options);
  await expect(captchaSubmitCandidate(driver)).resolves.toBeNull();
});

test("auto-submit clicks once per solved response then waits for acceptance", async () => {
  const { driver, executeScript } = fixture([true, true, true, false]);
  const click = vi.fn().mockResolvedValue(undefined);
  let reads = 0;
  const fallback = executeScript.getMockImplementation()!;
  executeScript.mockImplementation(async (script: string) => {
    if (script.includes("const captchaSubmit")) {
      reads++;
      return reads <= 3 ? { button: { click } as unknown as WebElement, completionId: "123:456" } : null;
    }
    return fallback(script);
  });
  await expect(captchaGuard(driver)).resolves.toBe(true);
  expect(click).toHaveBeenCalledOnce();
  expect(reads).toBe(4);
});
test("NZWH_CAPTCHA_TIMEOUT_MINUTES configures the human wait; bad values fall back to 30", async () => {
  for (const [value, minutes] of [["2", 2], ["0", 30], ["999", 30], ["abc", 30]] as const) {
    vi.stubEnv("NZWH_CAPTCHA_TIMEOUT_MINUTES", value);
    const { driver, wait } = fixture([true, true, false]);
    await captchaGuard(driver);
    expect(wait).toHaveBeenCalledWith(expect.any(Function), minutes * 60 * 1000, expect.any(String), 200);
  }
  vi.unstubAllEnvs();
});
test("CAPTCHA timeout stops the run instead of bypassing", async () => {
  const { driver } = fixture(Array(8).fill(true));
  await expect(captchaGuard(driver)).rejects.toThrow(/not completed within 30 minutes/);
});

// Workflow tests mock only the provider/browser adapter boundaries. Existing
// tests above continue to exercise the real CAPTCHA detector and submit guard.
const standardChallenge = { websiteURL: "https://onlineservices.immigration.govt.nz/rs-captcha", websiteKey: "public-key", pageId: 1 };
function automatic(driver: WebDriver, signal?: AbortSignal) {
  const events: ExecutionEvent[] = [];
  const promise = withHooksForTest({ event: async e => { events.push(e); }, checkpoint: async () => {} },
    () => captchaGuard(driver), { captchaMode: "capsolver", signal });
  return { promise, events };
}
function adapters() {
  const key = vi.spyOn(configuration, "loadCapSolverKey").mockResolvedValue("server-secret");
  const read = vi.spyOn(browser, "readCaptchaChallenge").mockResolvedValue(standardChallenge);
  const apply = vi.spyOn(browser, "applyCaptchaToken").mockResolvedValue(true);
  const solve = vi.spyOn(provider, "solveRecaptchaV2").mockResolvedValue("provider-token");
  return { read, apply, solve, key };
}

test("manual mode makes no provider request even with a configured key", async () => {
  const { solve, read, key } = adapters();
  await captchaGuard(fixture([true, true, false]).driver);
  expect(solve).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
  expect(key).not.toHaveBeenCalled();
});

test("automatic mode applies one result, submits only CAPTCHA, and waits for acceptance", async () => {
  const { apply, solve } = adapters();
  const { driver, executeScript } = fixture([true, true, false]);
  const click = vi.fn().mockResolvedValue(undefined);
  let injected = false;
  apply.mockImplementation(async () => { injected = true; return true; });
  const fallback = executeScript.getMockImplementation()!;
  executeScript.mockImplementation(async script => script.includes("const captchaSubmit") && injected
    ? { button: { click }, completionId: "page:provider" } : fallback(script));
  const { promise, events } = automatic(driver);
  await expect(promise).resolves.toBe(true);
  expect(solve).toHaveBeenCalledExactlyOnceWith({ websiteURL: standardChallenge.websiteURL, websiteKey: standardChallenge.websiteKey }, "server-secret", expect.any(AbortSignal));
  expect(apply).toHaveBeenCalledOnce();
  expect(click).toHaveBeenCalledOnce();
  expect(events.some(e => e.type === "captcha" && e.message?.includes("CapSolver"))).toBe(true);
  expect(events.at(-1)).toEqual({ type: "captcha", waiting: false });
  expect(JSON.stringify(events)).not.toMatch(/server-secret|provider-token/);
});

test.each(["missing-key", "database-failure", "unsupported", "service-failure", "stale-result"])("%s falls back to manual without retry", async kind => {
  const { read, solve, apply, key } = adapters();
  if (kind === "missing-key") {
    vi.stubEnv("CAPSOLVER_API_KEY", "obsolete-key-must-be-ignored");
    key.mockResolvedValue(null);
  }
  if (kind === "database-failure") key.mockRejectedValue(new Error("private-database-details"));
  if (kind === "unsupported") read.mockResolvedValue(null);
  if (kind === "service-failure") solve.mockRejectedValue(new Error("server-secret"));
  if (kind === "stale-result") apply.mockResolvedValue(false);
  const { promise, events } = automatic(fixture([true, true, true, false]).driver);
  await expect(promise).resolves.toBe(true);
  expect(solve).toHaveBeenCalledTimes(["missing-key", "database-failure", "unsupported"].includes(kind) ? 0 : 1);
  if (kind === "unsupported") {
    expect(key).not.toHaveBeenCalled();
    expect(events.some(e => e.type === "captcha" && e.message === "Chưa hỗ trợ cấu hình CAPTCHA này. Giải CAPTCHA trong Chrome; tác vụ tự tiếp tục. Chỉ nút Submit riêng của CAPTCHA được tự bấm khi có phản hồi.")).toBe(true);
  }
  expect(events.some(e => e.type === "captcha" && e.message?.includes("Giải CAPTCHA trong Chrome"))).toBe(true);
  expect(JSON.stringify(events)).not.toMatch(/server-secret|private-database-details|obsolete-key/);
});

test("human completion cancels an in-flight solve and never applies its late result", async () => {
  const { solve, apply } = adapters();
  let providerSignal: AbortSignal | undefined;
  solve.mockImplementation(async (_challenge, _key, signal) => new Promise(resolve => {
    providerSignal = signal;
    signal.addEventListener("abort", () => resolve("late-provider-token"), { once: true });
  }));
  const { driver, executeScript } = fixture([true, false]);
  const click = vi.fn().mockResolvedValue(undefined);
  const fallback = executeScript.getMockImplementation()!;
  executeScript.mockImplementation(async script => script.includes("const captchaSubmit")
    ? { button: { click }, completionId: "page:human" } : fallback(script));
  await expect(automatic(driver).promise).resolves.toBe(true);
  expect(providerSignal?.aborted).toBe(true);
  expect(apply).not.toHaveBeenCalled();
  expect(click).toHaveBeenCalledOnce();
});

test("run cancellation aborts provider work and exits the CAPTCHA wait", async () => {
  const { solve, apply } = adapters();
  const abort = new AbortController();
  let providerSignal: AbortSignal | undefined;
  solve.mockImplementation(async (_challenge, _key, signal) => {
    providerSignal = signal;
    abort.abort();
    throw new Error("cancelled");
  });
  const { promise, events } = automatic(fixture([true, true]).driver, abort.signal);
  await expect(promise).rejects.toBeInstanceOf(StopRequested);
  expect(providerSignal?.aborted).toBe(true);
  expect(apply).not.toHaveBeenCalled();
  expect(events.at(-1)).toEqual({ type: "captcha", waiting: false, message: "Đã kết thúc chờ CAPTCHA; chưa xác nhận hoàn tất." });
});

test("an unaccepted automatic token is cleared after 10 seconds and never retried", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const { apply, solve } = adapters();
  const clear = vi.spyOn(browser, "clearCaptchaToken").mockResolvedValue(undefined);
  const { driver, executeScript } = fixture([true, true, true, true, false]);
  const fallback = executeScript.getMockImplementation()!;
  let injected = false;
  apply.mockImplementation(async () => { injected = true; return true; });
  const click = vi.fn().mockResolvedValue(undefined);
  executeScript.mockImplementation(async script => {
    if (script.includes("const captchaSubmit") && injected) {
      vi.setSystemTime(11000);
      return { button: { click }, completionId: "page:provider" };
    }
    return fallback(script);
  });
  const { promise, events } = automatic(driver);
  await expect(promise).resolves.toBe(true);
  expect(clear).toHaveBeenCalledExactlyOnceWith(driver, expect.any(String), standardChallenge, "provider-token");
  expect(solve).toHaveBeenCalledOnce();
  expect(click).toHaveBeenCalledOnce();
  expect(events.some(e => e.type === "captcha" && e.message?.includes("chưa chấp nhận"))).toBe(true);
});

test("cancelling during database lookup exits before a provider request or CAPTCHA submit", async () => {
  const { key, solve } = adapters();
  const abort = new AbortController();
  key.mockImplementation(signal => new Promise((_resolve, reject) => {
    signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
  }));
  const { driver, wait } = fixture([true]);
  const { promise } = automatic(driver, abort.signal);
  const assertion = expect(promise).rejects.toBeInstanceOf(StopRequested);
  await vi.waitFor(() => expect(key).toHaveBeenCalledOnce());
  abort.abort();
  await assertion;
  expect(solve).not.toHaveBeenCalled();
  expect(wait).not.toHaveBeenCalled();
});

// Mocked provider selection and shared fallback path; no paid API calls.
test.each(["success", "error", "missing", "unsupported", "database-failure"])("2Captcha selection: %s", async kind => {
  const { solve: capsolver, read, apply, key } = adapters();
  const lookup = vi.spyOn(twoConfig, "loadTwoCaptchaKey").mockResolvedValue(kind === "missing" ? null : "two-secret");
  if (kind === "database-failure") lookup.mockRejectedValue(new Error("private-database-details"));
  const solve = vi.spyOn(twoCaptcha, "solveRecaptchaV2").mockResolvedValue("two-token");
  if (kind === "error") solve.mockRejectedValue(new twoCaptcha.TwoCaptchaError("service"));
  if (kind === "unsupported") read.mockResolvedValue(null);
  const events: ExecutionEvent[] = [];
  await withHooksForTest({ event: async e => { events.push(e); }, checkpoint: async () => {} },
    () => captchaGuard(fixture([true, true, true, false]).driver), { captchaMode: "2captcha" });
  expect(capsolver).not.toHaveBeenCalled();
  expect(key).not.toHaveBeenCalled();
  expect(solve).toHaveBeenCalledTimes(kind === "missing" || kind === "unsupported" || kind === "database-failure" ? 0 : 1);
  expect(apply).toHaveBeenCalledTimes(kind === "success" ? 1 : 0);
  if (kind !== "success") expect(events.some(e => e.type === "captcha" && e.message?.includes("Giải CAPTCHA trong Chrome"))).toBe(true);
  expect(JSON.stringify(events)).not.toMatch(/two-secret|two-token|private-database-details/);
});

test.each(["success", "error", "missing", "unsupported", "database-failure"])("AutoCaptcha selection: %s", async kind => {
  const { solve: capsolver, read, apply, key } = adapters();
  const lookup = vi.spyOn(twoConfig, "loadAutoCaptchaKey").mockResolvedValue(kind === "missing" ? null : "auto-secret");
  if (kind === "database-failure") lookup.mockRejectedValue(new Error("private-database-details"));
  const solve = vi.spyOn(autoCaptcha, "solveAutoCaptcha").mockResolvedValue("auto-token");
  if (kind === "error") solve.mockRejectedValue(new autoCaptcha.AutoCaptchaError("service"));
  if (kind === "unsupported") read.mockResolvedValue(null);
  const events: ExecutionEvent[] = [];
  await withHooksForTest({ event: async e => { events.push(e); }, checkpoint: async () => {} },
    () => captchaGuard(fixture([true, true, true, false]).driver), { captchaMode: "autocaptcha" });
  expect(capsolver).not.toHaveBeenCalled();
  expect(key).not.toHaveBeenCalled();
  expect(solve).toHaveBeenCalledTimes(kind === "missing" || kind === "unsupported" || kind === "database-failure" ? 0 : 1);
  expect(apply).toHaveBeenCalledTimes(kind === "success" ? 1 : 0);
  if (kind !== "success") expect(events.some(e => e.type === "captcha" && e.message?.includes("Giải CAPTCHA trong Chrome"))).toBe(true);
  if (kind === "missing") expect(events.some(e => e.type === "captcha" && e.message?.includes("/admin/autocaptcha"))).toBe(true);
  if (kind !== "unsupported") expect(events.some(e => e.type === "captcha" && e.message?.includes("AutoCaptcha"))).toBe(true);
  expect(JSON.stringify(events)).not.toMatch(/auto-secret|auto-token|private-database-details/);
});
const cleanAuth = { loginForm: false, rejected: false, authenticated: true };
test("E2: a clean page probe replaces the separate site and CAPTCHA scripts for a poll", async () => {
  const executeScript = vi.fn(async (script: string) => {
    if (script.includes("nzwhProbe")) return { nzwhProbe: 1, site: false, captcha: false, auth: cleanAuth };
    throw new Error(`unexpected script: ${script.slice(0, 40)}`);
  });
  await expect(waitWithCaptcha({ executeScript } as unknown as WebDriver, async () => true, 1000)).resolves.toBe(true);
  expect(executeScript).toHaveBeenCalledTimes(1);
});
test("E2: a probe that sees busy falls through to the full guard, which throws as before", async () => {
  const { driver, executeScript } = fixture([false], true);
  const fallback = executeScript.getMockImplementation()!;
  executeScript.mockImplementation(async script => script.includes("nzwhProbe") ? { nzwhProbe: 1, site: "busy", captcha: false, auth: cleanAuth } : fallback(script));
  await expect(waitWithCaptcha(driver, async () => true, 1000)).rejects.toBeInstanceOf(SiteBusyError);
});
test("E2: a probe that sees a CAPTCHA hands the poll to the guard", async () => {
  const { driver, executeScript } = fixture([true, false, false], false);
  const fallback = executeScript.getMockImplementation()!;
  executeScript.mockImplementation(async script => script.includes("nzwhProbe") ? { nzwhProbe: 1, site: false, captcha: true, auth: cleanAuth } : fallback(script));
  await expect(waitWithCaptcha(driver, async () => true, 1000)).resolves.toBe(true);
  expect(executeScript.mock.calls.some(([script]) => script.includes("const challengePage"))).toBe(true);
});
