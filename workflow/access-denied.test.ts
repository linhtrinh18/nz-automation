// Access-denied redirect (https://www.immigration.govt.nz/formshelp/access-denied): detection, recovery
// paths, retry limit, stop/cancel, kill switch, CAPTCHA wait and the no-PII guarantee. Mocked WebDriver only.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { runInNewContext } from "node:vm";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { error as webdriverError, Key } from "selenium-webdriver";
import type { WebDriver } from "selenium-webdriver";
import sample from "../fixtures/sample.json";

const hoisted = vi.hoisted(() => {
  // run.ts reads NZWH_REPORT_DIR at import time; keep the coverage reports out of the source tree.
  const reportDirectory = `${process.env.TMPDIR ?? "/tmp"}/nzwh-access-denied-reports`;
  process.env.NZWH_REPORT_DIR = reportDirectory;
  return { choose: vi.fn(), reportDirectory };
});
vi.mock("../browser/chooseBrowser", () => ({ chooseBrowser: hoisted.choose }));
import { captchaGuard, runWorkingHoliday, waitWithCaptcha, withHooksForTest } from "./run";
import { steps } from "./fields";
import { planSection } from "./fast-fill";
import type { FillEntry, SegmentResult } from "./fast-fill";
import { applicationDataSchema } from "./application-data";
import { WorkingHolidayStop } from "./errors";
import {
  ACCESS_DENIED_BACKOFF_MS, MAX_ACCESS_DENIED_RECOVERIES, ACCESS_DENIED_BACKOFF_SLICE_MS, POSTBACK_WAIT_MS,
} from "./fast-fill";
import {
  abortableBackoff, AccessDeniedError, ACCESS_DENIED_DISABLED_MESSAGE, ACCESS_DENIED_GIVE_UP_MESSAGE,
  ACCESS_DENIED_MESSAGE, assertSiteAvailable, isAccessDenied, isAccessDeniedPath, SiteBusyError, SITE_STATE_JS,
} from "./site-busy";
import { StopRequested } from "../lib/execution-controller";
import type { ExecutionEvent } from "../lib/execution-state";
import * as configuration from "../server/cloud";
import * as provider from "./capsolver";
import * as browser from "./capsolver-browser";

const ORIGIN = "https://onlineservices.immigration.govt.nz";
const DENIED = "https://www.immigration.govt.nz/formshelp/access-denied";
const SAVE_ID = "ContentPlaceHolder1_wizardPageFooter_wizardPageNavigator_validateButton";
const SECRET_QUERY = "ApplicationId=SECRET123&token=TOKEN456";
const section = (name: keyof typeof steps) => `${ORIGIN}/WorkingHoliday/Wizard/${steps[name].page}?${SECRET_QUERY}`;
const HEALTH_DETAIL = /congenital/i;

// ---------------------------------------------------------------- detection

const detect = (pathname: string, extra: { title?: string; text?: string; host?: string } = {}) =>
  runInNewContext(`(function(){${SITE_STATE_JS}})()`, {
    location: { pathname, host: extra.host ?? "www.immigration.govt.nz" },
    document: { title: extra.title ?? "", body: { innerText: extra.text ?? "" } },
  });

test.each([
  ["/formshelp/access-denied", "www.immigration.govt.nz"],
  ["/formshelp/access-denied/", "onlineservices.immigration.govt.nz"],
  ["/FormsHelp/Access-Denied", "127.0.0.1:4000"],
  ["/FORMSHELP/ACCESS-DENIED/", "anything.example"],
])("the page script reports 'denied' for pathname %s on %s (query string never part of pathname)", (pathname, host) => {
  expect(detect(pathname, { host })).toBe("denied");
  expect(isAccessDeniedPath(pathname)).toBe(true);
});
test.each(["/WorkingHoliday/Wizard/Medical1.aspx", "/formshelp/error", "/formshelp/access-denied/extra", "/x/formshelp/access-deniedx", "/"])(
  "the page script does not report 'denied' for pathname %s", pathname => {
    expect(detect(pathname)).toBe(false);
    expect(isAccessDeniedPath(pathname)).toBe(false);
  });
test("body text or a title that merely mentions access denied is not the redirect", () => {
  expect(detect("/WorkingHoliday/Wizard/Medical1.aspx", { title: "Access denied", text: "Sorry, but you've been denied access to this page.\naccess denied" })).toBe(false);
});
test("the busy detector is unchanged and denied wins by pathname", () => {
  expect(detect("/WorkingHoliday/", { title: "Site Busy" })).toBe("busy");
  expect(detect("/WorkingHoliday/", { text: "x\nPlease try again later.\ny" })).toBe("busy");
  expect(detect("/formshelp/access-denied", { title: "Site Busy" })).toBe("denied");
});
test("the detector script keeps clear of the CAPTCHA fixture routing markers and is a single script", () => {
  for (const marker of ["document.readyState", "const challengePage", "const captchaSubmit", "executeAsyncScript"])
    expect(SITE_STATE_JS).not.toContain(marker);
});
const scripted = (...answers: unknown[]) => {
  const executeScript = vi.fn(async () => answers.shift());
  return { driver: { executeScript } as unknown as WebDriver, executeScript };
};
test("assertSiteAvailable: 'denied' -> AccessDeniedError; 'busy' and legacy true -> SiteBusyError; false passes", async () => {
  await expect(assertSiteAvailable(scripted("denied").driver)).rejects.toBeInstanceOf(AccessDeniedError);
  await expect(assertSiteAvailable(scripted("busy").driver)).rejects.toBeInstanceOf(SiteBusyError);
  await expect(assertSiteAvailable(scripted(true).driver)).rejects.toBeInstanceOf(SiteBusyError);
  await expect(assertSiteAvailable(scripted(false).driver)).resolves.toBeUndefined();
});
test("AccessDeniedError is a WorkingHolidayStop with a fixed message and is not a SiteBusyError", () => {
  const error = new AccessDeniedError();
  expect(error).toBeInstanceOf(WorkingHolidayStop);
  expect(error).not.toBeInstanceOf(SiteBusyError);
  expect(new SiteBusyError()).not.toBeInstanceOf(AccessDeniedError);
  expect(error.message).toBe(ACCESS_DENIED_MESSAGE);
  expect(error.name).toBe("AccessDeniedError");
  for (const text of [ACCESS_DENIED_MESSAGE, ACCESS_DENIED_GIVE_UP_MESSAGE, ACCESS_DENIED_DISABLED_MESSAGE])
    expect(text).not.toMatch(/https?:|\?|ApplicationId|token/i);
});
test("isAccessDenied is true only for 'denied', false for busy/legacy answers and tolerates a navigation in flight", async () => {
  expect(await isAccessDenied(scripted("denied").driver)).toBe(true);
  expect(await isAccessDenied(scripted(true).driver)).toBe(false);
  expect(await isAccessDenied(scripted("busy").driver)).toBe(false);
  expect(await isAccessDenied(scripted(false).driver)).toBe(false);
  const navigating = { executeScript: async () => { throw Object.assign(new Error("document unloaded while waiting for result"), { name: "JavascriptError" }); } } as unknown as WebDriver;
  expect(await isAccessDenied(navigating)).toBe(false);
  const closed = { executeScript: async () => { throw new webdriverError.NoSuchSessionError("closed"); } } as unknown as WebDriver;
  await expect(isAccessDenied(closed)).rejects.toBeInstanceOf(webdriverError.NoSuchSessionError);
});

// ---------------------------------------------------------------- guard and waits (no 20 s spin)

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

/** Routes the helper scripts like captcha.test.ts: everything else answers with the site state. */
function pageDriver(state: () => unknown) {
  const executeScript = vi.fn<(script: string) => Promise<unknown>>(async (script: string) => {
    if (script.includes("const captchaSubmit")) return null;
    if (script.includes("const challengePage")) return false;
    if (script.includes("document.readyState")) return "complete";
    return state();
  });
  return { driver: { executeScript } as unknown as WebDriver, executeScript };
}
test("captchaGuard and waitWithCaptcha throw on the first poll, never run the condition and arm no timer", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const { driver } = pageDriver(() => "denied");
  const condition = vi.fn(async () => true);
  await expect(captchaGuard(driver)).rejects.toBeInstanceOf(AccessDeniedError);
  await expect(waitWithCaptcha(driver, condition, 20000)).rejects.toBeInstanceOf(AccessDeniedError);
  expect(condition).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  expect(Date.now()).toBe(0); // no 20 s spin: no timer advance was needed
});
test("a redirect that appears while a wait is polling is detected on the next poll, not at the wait limit", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  let polls = 0;
  const { driver } = pageDriver(() => (++polls > 3 ? "denied" : false));
  let detectedAt = -1;
  const result = waitWithCaptcha(driver, async () => false, 20000, 50);
  const assertion = expect(result.catch(error => { detectedAt = Date.now(); throw error; })).rejects.toBeInstanceOf(AccessDeniedError);
  await vi.advanceTimersByTimeAsync(1000);
  await assertion;
  expect(detectedAt).toBeGreaterThanOrEqual(0);
  expect(detectedAt).toBeLessThanOrEqual(200); // four 50 ms polls, not the 20 s limit
});

// ---------------------------------------------------------------- CAPTCHA wait

const standardChallenge = { websiteURL: `${ORIGIN}/rs-captcha`, websiteKey: "public-key", pageId: 1 };
function captchaFixture(deniedAfterPending: boolean) {
  let pendingReads = 0;
  let siteReads = 0;
  const executeScript = vi.fn<(script: string) => Promise<unknown>>(async (script: string) => {
    if (script.includes("const captchaSubmit")) return null;
    if (script.includes("const challengePage")) { pendingReads++; return true; }
    if (script.includes("document.readyState")) return "complete";
    return deniedAfterPending && ++siteReads > 1 ? "denied" : false;
  });
  const wait = vi.fn(async (condition: () => Promise<boolean>) => {
    for (let poll = 0; poll < 5; poll++) if (await condition()) return true;
    throw new webdriverError.TimeoutError("timeout");
  });
  return { driver: { executeScript, wait } as unknown as WebDriver, executeScript, pendingReads: () => pendingReads };
}
test("denied during a manual CAPTCHA wait ends the wait: captcha waiting:false and AccessDeniedError", async () => {
  const events: ExecutionEvent[] = [];
  const { driver } = captchaFixture(true);
  await expect(withHooksForTest({ event: async e => { events.push(e); }, checkpoint: async () => {} }, () => captchaGuard(driver)))
    .rejects.toBeInstanceOf(AccessDeniedError);
  expect(events.some(e => e.type === "captcha" && e.waiting)).toBe(true);
  expect(events.at(-1)).toMatchObject({ type: "captcha", waiting: false });
});
test("denied during a provider attempt aborts that attempt's signal and reports waiting:false", async () => {
  vi.spyOn(configuration, "loadCapSolverKey").mockResolvedValue("server-secret");
  vi.spyOn(browser, "readCaptchaChallenge").mockResolvedValue(standardChallenge);
  vi.spyOn(browser, "applyCaptchaToken").mockResolvedValue(true);
  let providerSignal: AbortSignal | undefined;
  vi.spyOn(provider, "solveRecaptchaV2").mockImplementation((_request, _key, signal) => {
    providerSignal = signal;
    return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))));
  });
  const events: ExecutionEvent[] = [];
  const { driver } = captchaFixture(true);
  await expect(withHooksForTest({ event: async e => { events.push(e); }, checkpoint: async () => {} }, () => captchaGuard(driver), { captchaMode: "capsolver" }))
    .rejects.toBeInstanceOf(AccessDeniedError);
  expect(providerSignal?.aborted).toBe(true);
  expect(events.at(-1)).toMatchObject({ type: "captcha", waiting: false });
  expect(JSON.stringify(events)).not.toMatch(/server-secret/);
});

// ---------------------------------------------------------------- abortable backoff

test("abortableBackoff sleeps in slices and throws StopRequested within one slice of an abort", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const controller = new AbortController();
  const result = abortableBackoff(5000, controller.signal);
  const assertion = expect(result).rejects.toBeInstanceOf(StopRequested);
  await vi.advanceTimersByTimeAsync(1000);
  controller.abort();
  await vi.advanceTimersByTimeAsync(ACCESS_DENIED_BACKOFF_SLICE_MS);
  await assertion;
  expect(Date.now()).toBeLessThanOrEqual(1000 + ACCESS_DENIED_BACKOFF_SLICE_MS);
  expect(vi.getTimerCount()).toBe(0);
});
test("abortableBackoff waits the full time when not aborted and does not start when already aborted", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const done = abortableBackoff(2000);
  await vi.advanceTimersByTimeAsync(2000);
  await done;
  expect(Date.now()).toBe(2000);
  const controller = new AbortController();
  controller.abort();
  await expect(abortableBackoff(2000, controller.signal)).rejects.toBeInstanceOf(StopRequested);
});
test("the retry constants are exactly the investigated values", () => {
  expect(MAX_ACCESS_DENIED_RECOVERIES).toBe(2);
  expect([...ACCESS_DENIED_BACKOFF_MS]).toEqual([2000, 5000]);
});

// ---------------------------------------------------------------- section loop through runWorkingHoliday

type OnGet = "ok" | "denied" | "login";
type OnSave = "ok" | "denied-applied" | "denied-lost";
interface Site {
  driver: WebDriver;
  url: string;
  denied: boolean;
  login: boolean;
  /** Pop one per driver.get(). */
  onGet: OnGet[];
  /** Pop one per SAVE key press. */
  onSave: OnSave[];
  gets: { url: string; at: number }[];
  saves: number;
  fills: number;
  calls: number;
  siteReads: number;
  server: Map<string, string>;
  page: Map<string, string>;
  /** Runs inside the fill-segment script, before its result is returned. */
  midFill?: () => void;
  /** Answer for the site-state script; default derives from `denied`. */
  siteState?: () => unknown;
  /** Runs inside get(). */
  onNavigate?: (url: string) => void;
  /** Runs when the postback predicate is evaluated. */
  onPredicate?: () => void;
  origin: number;
}
let directory: string;
let dataPath: string;
let logs: string[];
let events: ExecutionEvent[];
const writeSample = async () => {
  await writeFile(dataPath, JSON.stringify(sample));
};
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "nzwh-access-denied-"));
  dataPath = join(directory, "sample.json");
  await writeSample();
  await mkdir(hoisted.reportDirectory, { recursive: true });
  logs = [];
  events = [];
  for (const level of ["log", "warn", "error"] as const)
    vi.spyOn(console, level).mockImplementation((...line: unknown[]) => { logs.push(line.join(" ")); });
  vi.stubEnv("NZWH_EARLY_FILL", "0");
  vi.stubEnv("NZWH_USERNAME", "user-not-used");
  vi.stubEnv("NZWH_PASSWORD", "pass-not-used");
});
afterEach(async () => {
  hoisted.choose.mockReset();
  await rm(directory, { recursive: true, force: true });
});

function site(start: string): Site {
  const state: Site = {
    driver: undefined as unknown as WebDriver, url: start, denied: false, login: false, onGet: [], onSave: [], gets: [],
    saves: 0, fills: 0, calls: 0, siteReads: 0, server: new Map(), page: new Map(), origin: 1,
  };
  const element = (id: string) => ({
    isDisplayed: async () => true,
    isEnabled: async () => true,
    getAttribute: async () => state.page.get(id) ?? "",
    sendKeys: async (key: string) => {
      state.calls++;
      if (id !== SAVE_ID || key !== Key.SPACE) return;
      state.saves++;
      const outcome = state.onSave.shift() ?? "ok";
      if (outcome === "ok") { state.server = new Map(state.page); state.origin++; return; }
      if (outcome === "denied-applied") state.server = new Map(state.page);
      state.denied = true;
      state.url = DENIED;
      state.origin++;
    },
  });
  const idOf = (locator: { value: string }) => /\[id="(.+)"\]/.exec(locator.value)?.[1]?.replace(/\\/g, "") ?? "";
  const executeScript = async (script: string, ...args: unknown[]) => {
    state.calls++;
    if (script.includes("nzwh:fill-segment")) {
      state.fills++;
      const entries = args[0] as FillEntry[];
      const start = args[1] as number;
      for (const entry of entries.slice(start)) state.page.set(entry.id, entry.expected);
      const out: SegmentResult = {
        results: entries.slice(start).map(entry => ({ key: entry.key, status: "filled" as const })), stop: null, timeOrigin: state.origin,
      };
      state.midFill?.();
      if (state.denied) out.timeOrigin = state.origin;
      return out;
    }
    if (script.includes("nzwh:doc-complete")) return true;
    if (script.includes("nzwh:load-gap")) return null;
    if (script.includes("nzwh:read-values")) {
      const ids = args[0] as string[];
      return { timeOrigin: state.origin, values: ids.map(id => state.page.get(id) ?? null) };
    }
    if (script.includes("get_isInAsyncPostBack")) { state.onPredicate?.(); return state.origin !== args[1] && !state.denied; }
    if (script.includes("return performance.timeOrigin")) return state.origin;
    if (script.includes("loginForm:")) return { loginForm: state.login, rejected: false, authenticated: !state.login };
    if (script.includes("const captchaSubmit")) return null;
    if (script.includes("const challengePage")) return false;
    if (script.includes("document.readyState")) return "complete";
    if (script.includes("const mapped")) return [];
    if (script.includes("[errorlabel]")) return 0;
    if (script.includes("site busy")) { state.siteReads++; return state.siteState ? state.siteState() : state.denied ? "denied" : false; }
    throw new Error(`unexpected script: ${script.slice(0, 60)}`);
  };
  state.driver = {
    executeScript,
    getCurrentUrl: async () => { state.calls++; return state.url; },
    get: async (url: string) => {
      state.calls++;
      state.gets.push({ url, at: Date.now() });
      state.onNavigate?.(url);
      const outcome = state.onGet.shift() ?? "ok";
      state.origin++;
      state.denied = outcome === "denied";
      state.login = outcome === "login";
      state.url = outcome === "denied" ? DENIED : url;
      if (outcome === "ok") state.page = new Map(state.server);
    },
    findElements: async (locator: { value: string }) => {
      state.calls++;
      if (state.denied) return [];
      const id = idOf(locator);
      return id ? [element(id)] : [];
    },
    getCapabilities: async () => { state.calls++; return null; },
    manage: () => ({ setTimeouts: async () => { state.calls++; }, window: () => ({ maximize: async () => { state.calls++; } }) }),
    sendDevToolsCommand: async () => { state.calls++; },
  } as unknown as WebDriver;
  return state;
}

/** Drives fake time while real I/O (report files) completes. */
async function drive<T>(promise: Promise<T>): Promise<T> {
  let done = false;
  const tracked = promise.finally(() => { done = true; });
  tracked.catch(() => {});
  for (let guard = 0; !done && guard < 20000; guard++) await vi.advanceTimersByTimeAsync(ACCESS_DENIED_BACKOFF_SLICE_MS);
  return tracked;
}
interface RunOptions { sections?: ("health" | "character")[]; signal?: AbortSignal }
function start(s: Site, options: RunOptions = {}) {
  hoisted.choose.mockResolvedValue(s.driver);
  return runWorkingHoliday({
    dataPath, allowFictionalDraftSave: true, sections: options.sections ?? ["health"], country: "vietnam", signal: options.signal,
    hooks: { event: async e => { events.push(e); }, checkpoint: async () => {} },
  });
}
const run = async (s: Site, options: RunOptions = {}) => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  return drive(start(s, options));
};
/** Runs the start function under fake time and resolves with its rejection (or undefined). */
const flush = async (begin: () => Promise<unknown>) => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  return drive(begin().then(() => undefined, (error: unknown) => error));
};
const persistence = () => events.filter(e => e.type === "persistence").map(e => (e as { state: string }).state);
const phases = () => events.filter(e => e.type === "phase" && e.phase === "recovery");
const sectionResults = () => events.filter(e => e.type === "section-result");
// The existing "application" event carries the draft id by design; everything this feature emits must not.
const everything = () => `${logs.join("\n")}\n${JSON.stringify(events.filter(e => e.type !== "application"))}`;
const noPii = () => {
  const text = everything();
  expect(text).not.toMatch(/SECRET123|TOKEN456|ApplicationId=|user-not-used|pass-not-used/);
  expect(text).not.toMatch(HEALTH_DETAIL);
  for (const entry of planSection("health", applicationDataSchema.parse(sample))) if (/[A-Za-z]{6,}/.test(entry.expected)) expect(text).not.toContain(entry.expected);
};
/** Starts a run on the health section page; use after configuring the site. */
const healthSite = () => site(section("health"));
const getsOf = (s: Site, url: string) => s.gets.filter(g => g.url === url).length;

test("risk false: a redirect while filling reloads the section, refills and posts exactly one SAVE", async () => {
  const s = healthSite();
  let fired = false;
  s.midFill = () => { if (!fired) { fired = true; s.denied = true; s.url = DENIED; s.origin++; } };
  const result = await run(s);
  expect(result).toMatchObject({ success: true, outcome: "filled" });
  expect(s.saves).toBe(1);
  expect(s.fills).toBe(2);
  // recovery GET + the post-SAVE verification reload
  expect(getsOf(s, section("health"))).toBe(2);
  // a redirect before any POST is not a possible save
  expect(persistence()).toEqual(["possible", "accepted", "verified"]);
  expect(events.findIndex(e => e.type === "persistence")).toBeGreaterThan(events.findIndex(e => e.type === "phase" && e.phase === "recovery"));
  expect(sectionResults().map(e => (e as { status: string }).status)).toEqual(["completed"]);
  expect(phases().length).toBeGreaterThanOrEqual(2);
  expect(logs.some(l => l.includes("access-denied redirect detected (path=/formshelp/access-denied)"))).toBe(true);
  expect(events.at(-1)).not.toMatchObject({ phase: "recovery" });
  noPii();
});
test("detection by the guard before the fill (page already denied) also recovers without a possible save", async () => {
  const s = healthSite();
  let reads = 0;
  s.siteState = () => (++reads === 2 ? "denied" : false);
  s.onNavigate = () => { /* the reload is served normally */ };
  const result = await run(s);
  expect(result).toMatchObject({ success: true });
  expect(s.saves).toBe(1);
  expect(persistence()).toEqual(["possible", "accepted", "verified"]);
  noPii();
});
test("the backoff before the first and second recovery is 2000 ms and 5000 ms", async () => {
  const s = healthSite();
  let fired = 0;
  // Deny twice before any POST: first mid-fill, then again on the recovery GET.
  s.midFill = () => { if (!fired) { fired++; s.denied = true; s.url = DENIED; s.origin++; } };
  s.onGet.push("denied");
  let deniedAt = -1;
  const detect = vi.fn();
  s.siteState = () => {
    if (s.denied && deniedAt < 0) { deniedAt = Date.now(); detect(); }
    return s.denied ? "denied" : false;
  };
  const result = await run(s);
  expect(result).toMatchObject({ success: true });
  // Recovery GET #1 after 2000 ms (denied again), recovery GET #2 after a further 5000 ms.
  const recoveryGets = s.gets.slice(0, 2).map(g => g.at);
  expect(recoveryGets[0]).toBeGreaterThanOrEqual(deniedAt + ACCESS_DENIED_BACKOFF_MS[0]);
  expect(recoveryGets[0]).toBeLessThan(deniedAt + ACCESS_DENIED_BACKOFF_MS[0] + 3 * ACCESS_DENIED_BACKOFF_SLICE_MS);
  expect(recoveryGets[1] - recoveryGets[0]).toBeGreaterThanOrEqual(ACCESS_DENIED_BACKOFF_MS[1]);
  expect(recoveryGets[1] - recoveryGets[0]).toBeLessThan(ACCESS_DENIED_BACKOFF_MS[1] + 3 * ACCESS_DENIED_BACKOFF_SLICE_MS);
  expect(s.saves).toBe(1);
  noPii();
});
test("risk true (SAVE response lost but applied): read-only verify, 'verified', no refill and no second SAVE", async () => {
  const s = healthSite();
  s.onSave.push("denied-applied");
  const result = await run(s);
  expect(result).toMatchObject({ success: true, outcome: "filled" });
  expect(s.saves).toBe(1);
  expect(s.fills).toBe(1); // no refill
  expect(persistence()).toEqual(["possible", "verified"]);
  expect(sectionResults()).toEqual([expect.objectContaining({ status: "completed", detail: expect.stringContaining("không lưu lại") })]);
  expect(getsOf(s, section("health"))).toBe(1);
  noPii();
});
test("risk true, SAVE accepted but the verification reload is redirected: verify without replaying SAVE", async () => {
  const s = healthSite();
  s.onGet.push("denied"); // the post-SAVE verification reload lands on the denied page
  const result = await run(s);
  expect(result).toMatchObject({ success: true });
  expect(s.saves).toBe(1);
  expect(s.fills).toBe(1);
  expect(persistence()).toEqual(["possible", "accepted", "verified"]);
  noPii();
});
test("risk true and a second redirect during the recovery reload: the second attempt (5000 ms) verifies", async () => {
  const s = healthSite();
  s.onSave.push("denied-applied");
  s.onGet.push("denied");
  const result = await run(s);
  expect(result).toMatchObject({ success: true });
  expect(s.saves).toBe(1);
  expect(s.gets).toHaveLength(2);
  expect(s.gets[1].at - s.gets[0].at).toBeGreaterThanOrEqual(ACCESS_DENIED_BACKOFF_MS[1]);
  noPii();
});
test("risk true and the save was lost: values differ, section is unverified, nothing is re-sent and submission is blocked", async () => {
  const s = healthSite();
  s.onSave.push("denied-lost");
  const result = await run(s);
  expect(result).toMatchObject({ success: false, outcome: "incomplete" });
  expect(s.saves).toBe(1);
  expect(s.fills).toBe(1);
  expect(persistence()).toEqual(["possible"]);
  expect(sectionResults()).toEqual([expect.objectContaining({ status: "failed", detail: expect.stringContaining("Không tự lưu lại") })]);
  noPii();
});
test("risk true with a field missing on the reloaded page is unverified, never refilled", async () => {
  const s = healthSite();
  s.onSave.push("denied-applied");
  s.onNavigate = () => { s.server.delete(steps.health.fields.tuberculosis.id); };
  const result = await run(s);
  expect(result).toMatchObject({ success: false, outcome: "incomplete" });
  expect(s.saves).toBe(1);
  expect(s.fills).toBe(1);
  expect(persistence()).not.toContain("verified");
});
test("a timeout on the access-denied page after SAVE is a redirect, not an unexpected destination", async () => {
  const s = healthSite();
  let saveAt = -1;
  s.onSave.push("ok");
  const original = s.driver.executeScript.bind(s.driver) as (script: string, ...args: unknown[]) => Promise<unknown>;
  // The guard sees a healthy page until the postback wait expires; only then is the page the denied one.
  s.driver.executeScript = (async (script: string, ...args: unknown[]) => {
    if (script.includes("get_isInAsyncPostBack")) {
      if (saveAt < 0) saveAt = Date.now();
      if (Date.now() - saveAt >= POSTBACK_WAIT_MS) { s.denied = true; s.url = DENIED; }
      return false;
    }
    return original(script, ...args);
  }) as unknown as WebDriver["executeScript"];
  const result = await run(s);
  expect(result).toMatchObject({ success: true });
  expect(logs.join("\n")).not.toContain("unexpected destination");
  expect(s.saves).toBe(1);
  expect(s.fills).toBe(1);
  noPii();
});
test("retry limit: every reload denied stops after MAX_ACCESS_DENIED_RECOVERIES with the fixed message", async () => {
  const s = healthSite();
  s.onSave.push("denied-applied");
  s.onGet.push("denied", "denied", "denied", "denied");
  const error = await flush(() => start(s));
  expect(error).toBeInstanceOf(WorkingHolidayStop);
  expect((error as Error).message).toContain(ACCESS_DENIED_GIVE_UP_MESSAGE);
  expect((error as Error).message).toContain("Stopped in health.");
  expect(s.gets).toHaveLength(MAX_ACCESS_DENIED_RECOVERIES);
  expect(s.saves).toBe(1);
  expect(sectionResults()).toEqual([expect.objectContaining({ status: "failed" })]);
  expect((error as Error).message).not.toMatch(/SECRET123|TOKEN456|http/);
  noPii();
});
test("the budget is per run: a recovery in the first section leaves one attempt for the second", async () => {
  const s = site(section("health"));
  let fired = false;
  s.midFill = () => { if (!fired) { fired = true; s.denied = true; s.url = DENIED; s.origin++; } };
  // Health recovers once (attempt 1) and saves. Opening character is denied, and so is its recovery reload:
  // attempt 2 is spent, the next denial would be attempt 3 and exceeds the run budget.
  s.onGet.push("ok", "ok", "denied", "denied");
  const error = await flush(() => start(s, { sections: ["health", "character"] }));
  expect(error).toBeInstanceOf(WorkingHolidayStop);
  expect((error as Error).message).toContain(ACCESS_DENIED_GIVE_UP_MESSAGE);
  expect((error as Error).message).toContain("Stopped in character.");
});
test("login form after the redirect with nothing posted reuses the existing one-shot re-authentication", async () => {
  const s = healthSite();
  let fired = false;
  s.midFill = () => { if (!fired) { fired = true; s.denied = true; s.url = DENIED; s.origin++; } };
  s.onGet.push("login");
  const sentinel = "fixture-stop-at-login-page";
  s.onNavigate = url => { if (/Login/i.test(url)) throw new Error(sentinel); };
  const error = await flush(() => start(s));
  expect((error as Error).message).toBe(sentinel);
  expect(s.gets.map(g => g.url)).toEqual([section("health"), `${ORIGIN}/WorkingHoliday/`, `${ORIGIN}/secure/Login+Working+Holiday.htm`]);
  expect(s.saves).toBe(0);
});
test("login form after the redirect when a save may have been applied stops with the existing session message", async () => {
  const s = healthSite();
  s.onSave.push("denied-applied");
  s.onGet.push("login");
  const error = await flush(() => start(s));
  expect(error).toBeInstanceOf(WorkingHolidayStop);
  expect((error as Error).message).toContain("Không tự điền lại");
  expect(s.saves).toBe(1);
  expect(s.fills).toBe(1);
  expect(s.gets).toHaveLength(1);
});
test("a mid-fill redirect never emits persistence 'possible' (the early/fast paths decide denied first)", async () => {
  const s = healthSite();
  let fired = false;
  s.midFill = () => { if (!fired) { fired = true; s.denied = true; s.url = DENIED; s.origin++; } };
  s.onGet.push("denied", "denied", "denied"); // exhaust the budget before any SAVE
  const error = await flush(() => start(s));
  expect((error as Error).message).toContain(ACCESS_DENIED_GIVE_UP_MESSAGE);
  expect(persistence()).toEqual([]);
  expect(s.saves).toBe(0);
});
test("a document-unloaded error while filling on the denied page is a redirect, not a possible save", async () => {
  const s = healthSite();
  const original = s.driver.executeScript.bind(s.driver) as (script: string, ...args: unknown[]) => Promise<unknown>;
  let fired = false;
  s.driver.executeScript = (async (script: string, ...args: unknown[]) => {
    if (script.includes("nzwh:fill-segment") && !fired) {
      fired = true;
      s.denied = true; s.url = DENIED; s.origin++;
      throw Object.assign(new Error("javascript error: document unloaded while waiting for result"), { name: "JavascriptError" });
    }
    return original(script, ...args);
  }) as unknown as WebDriver["executeScript"];
  const result = await run(s);
  expect(result).toMatchObject({ success: true });
  expect(persistence()).toEqual(["possible", "accepted", "verified"]);
  expect(s.saves).toBe(1);
});
test("a document-unloaded error on a normal page still marks a possible save and stops (unchanged behavior)", async () => {
  const s = healthSite();
  const original = s.driver.executeScript.bind(s.driver) as (script: string, ...args: unknown[]) => Promise<unknown>;
  s.driver.executeScript = (async (script: string, ...args: unknown[]) => {
    if (script.includes("nzwh:fill-segment"))
      throw Object.assign(new Error("javascript error: document unloaded while waiting for result"), { name: "JavascriptError" });
    return original(script, ...args);
  }) as unknown as WebDriver["executeScript"];
  const error = await flush(() => start(s));
  expect((error as Error).message).toContain("Form reloaded unexpectedly");
  expect(persistence()).toEqual(["possible"]);
});

// ---------------------------------------------------------------- stop / cancel and kill switch

test("stop during the backoff: StopRequested, no driver call after the abort, no navigation", async () => {
  const controller = new AbortController();
  const s = healthSite();
  s.onSave.push("denied-applied");
  let callsAtAbort = -1;
  let scheduled = false;
  s.siteState = () => {
    if (s.denied && !scheduled) {
      scheduled = true;
      setTimeout(() => { callsAtAbort = s.calls; controller.abort(); }, 500);
    }
    return s.denied ? "denied" : false;
  };
  const error = await flush(() => start(s, { signal: controller.signal }));
  expect(error).toBeInstanceOf(StopRequested);
  expect(s.gets).toHaveLength(0);
  expect(s.calls).toBe(callsAtAbort);
  noPii();
});
test("stop during the recovery navigation: StopRequested and no driver call after the abort", async () => {
  const controller = new AbortController();
  const s = healthSite();
  s.onSave.push("denied-applied");
  let callsAtAbort = -1;
  s.onNavigate = () => { controller.abort(); callsAtAbort = s.calls; };
  const error = await flush(() => start(s, { signal: controller.signal }));
  expect(error).toBeInstanceOf(StopRequested);
  expect(s.calls).toBe(callsAtAbort);
  expect(s.saves).toBe(1);
  expect(s.fills).toBe(1);
});
test("kill switch NZWH_ACCESS_DENIED_RECOVERY=0: detect, then stop at once with the clear message and no navigation", async () => {
  vi.stubEnv("NZWH_ACCESS_DENIED_RECOVERY", "0");
  const s = healthSite();
  s.onSave.push("denied-applied");
  const error = await flush(() => start(s));
  expect(error).toBeInstanceOf(WorkingHolidayStop);
  expect((error as Error).message).toContain(ACCESS_DENIED_DISABLED_MESSAGE);
  expect(s.gets).toHaveLength(0);
  expect(s.saves).toBe(1);
  expect(logs.some(l => l.includes("access-denied redirect detected"))).toBe(true);
  noPii();
});
test("a run without the redirect is unaffected: same events, one SAVE, no recovery phase", async () => {
  const s = healthSite();
  const result = await run(s);
  expect(result).toMatchObject({ success: true, outcome: "filled" });
  expect(persistence()).toEqual(["possible", "accepted", "verified"]);
  expect(phases()).toEqual([]);
  expect(s.saves).toBe(1);
  expect(s.siteReads).toBeGreaterThan(0);
});
test("no URL, query string, id, token, credential or field value reaches logs or events across a full recovery", async () => {
  const s = healthSite();
  s.onSave.push("denied-applied");
  s.onGet.push("denied");
  await run(s);
  noPii();
  const text = everything();
  expect(text).toContain("/formshelp/access-denied");
  expect(text).not.toMatch(/https?:\/\//);
  expect(text).not.toContain("onlineservices");
});

// ---------------------------------------------------------------- pre-wizard (login) path: no applicant data yet

const startLoginOnly = (s: Site) => {
  hoisted.choose.mockResolvedValue(s.driver);
  return runWorkingHoliday({
    dataPath, mode: "loginOnly", credentials: { username: "user-not-used", password: "pass-not-used" },
    hooks: { event: async e => { events.push(e); }, checkpoint: async () => {} },
  });
};
test("login: a redirect on the home page is retried from the home page within the shared budget (backoff 2000 ms)", async () => {
  const s = site("about:blank");
  s.onGet.push("denied");
  const sentinel = "fixture-stop-at-login-page";
  s.onNavigate = url => { if (/Login/i.test(url)) throw new Error(sentinel); };
  const error = await flush(() => startLoginOnly(s));
  expect((error as Error).message).toBe(sentinel);
  const home = `${ORIGIN}/WorkingHoliday/`;
  expect(s.gets.map(g => g.url)).toEqual([home, home, home, `${ORIGIN}/secure/Login+Working+Holiday.htm`]);
  expect(s.gets[1].at - s.gets[0].at).toBeGreaterThanOrEqual(ACCESS_DENIED_BACKOFF_MS[0]);
  expect(logs.some(l => l.includes("login: access-denied redirect detected"))).toBe(true);
  expect(everything()).not.toMatch(/user-not-used|pass-not-used/);
});
test("login: a persistent redirect stops after the recovery limit with the fixed message", async () => {
  const s = site("about:blank");
  s.onGet.push("denied", "denied", "denied", "denied", "denied");
  const error = await flush(() => startLoginOnly(s));
  expect(error).toBeInstanceOf(WorkingHolidayStop);
  expect((error as Error).message).toBe(ACCESS_DENIED_GIVE_UP_MESSAGE);
  expect(s.gets.filter(g => g.url.endsWith("/WorkingHoliday/"))).toHaveLength(2 * MAX_ACCESS_DENIED_RECOVERIES + 1); // the first GET, then a recovery GET and a step GET per attempt
  expect(everything()).not.toMatch(/user-not-used|pass-not-used/);
});
