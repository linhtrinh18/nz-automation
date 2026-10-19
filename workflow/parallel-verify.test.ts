// Hybrid verify tab (NZWH_PARALLEL_VERIFY=1): the SAVE stays in the main tab, the read-only reload of the
// saved section runs in a second tab while the next section loads. Mocked multi-window WebDriver only.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Key } from "selenium-webdriver";
import type { WebDriver } from "selenium-webdriver";
import sample from "../fixtures/sample.json";
const hoisted = vi.hoisted(() => {
  const reportDirectory = `${process.env.TMPDIR ?? "/tmp"}/nzwh-parallel-verify-reports`;
  process.env.NZWH_REPORT_DIR = reportDirectory;
  return { choose: vi.fn(), reportDirectory, atFinish: [] as unknown[] , onFinish: undefined as undefined | (() => unknown) };
});
vi.mock("../browser/chooseBrowser", () => ({ chooseBrowser: hoisted.choose }));
vi.mock("./submission", async original => {
  const actual = await original<typeof import("./submission")>();
  return {
    ...actual,
    finishApplication: vi.fn(async (...args: Parameters<typeof actual.finishApplication>) => {
      hoisted.atFinish.push(hoisted.onFinish?.());
      return actual.finishApplication(...args);
    }),
  };
});
import { runWorkingHoliday } from "./run";
import { steps } from "./fields";
import type { FillEntry, SegmentResult } from "./fast-fill";
import { ACCESS_DENIED_BACKOFF_SLICE_MS } from "./fast-fill";
import { WorkingHolidayStop } from "./errors";
import type { ExecutionEvent } from "../lib/execution-state";

const ORIGIN = "https://onlineservices.immigration.govt.nz";
const DENIED = "https://www.immigration.govt.nz/formshelp/access-denied";
const SAVE_ID = "ContentPlaceHolder1_wizardPageFooter_wizardPageNavigator_validateButton";
const QUERY = "ApplicationId=SECRET123";
type Name = "identification" | "health" | "character";
const SECTIONS: Name[] = ["identification", "health", "character"];
const section = (name: Name) => `${ORIGIN}/WorkingHoliday/Wizard/${steps[name].page}?${QUERY}`;
const nameOf = (url: string) => SECTIONS.find(name => url.split("?")[0] === section(name).split("?")[0]);

type LoadOutcome = "ok" | "busy" | "denied" | "login" | "captcha" | "mismatch";
interface Win { url: string; page: Map<string, string>; origin: number; state: "ok" | "busy" | "denied"; login: boolean; captchaReads: number }
interface Command { handle: string; kind: string }
interface Site {
  driver: WebDriver;
  windows: Map<string, Win>;
  current: string;
  server: Map<string, string>;
  commands: Command[];
  saves: Record<string, number>;
  fills: Record<string, number>;
  /** Pop one per load in the verify tab (location.href). */
  onVerifyLoad: LoadOutcome[];
  /** Pop one per driver.get() in the main tab. */
  onMainGet: LoadOutcome[];
  midFill?: (name: Name) => void;
  /** Runs after a CAPTCHA pending read. */
  onCaptchaRead?: () => void;
  postInFlight: boolean;
  newWindows: number;
  closed: string[];
}
let directory: string;
let dataPath: string;
let logs: string[];
let events: ExecutionEvent[];
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "nzwh-parallel-verify-"));
  dataPath = join(directory, "sample.json");
  await writeFile(dataPath, JSON.stringify(sample));
  await mkdir(hoisted.reportDirectory, { recursive: true });
  logs = [];
  events = [];
  hoisted.atFinish.length = 0;
  hoisted.onFinish = undefined;
  for (const level of ["log", "warn", "error"] as const)
    vi.spyOn(console, level).mockImplementation((...line: unknown[]) => { logs.push(line.join(" ")); });
  vi.stubEnv("NZWH_EARLY_FILL", "0");
  vi.stubEnv("NZWH_PARALLEL_VERIFY", "1");
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  hoisted.choose.mockReset();
  await rm(directory, { recursive: true, force: true });
});

function site(start: string): Site {
  const s: Site = {
    driver: undefined as unknown as WebDriver, windows: new Map(), current: "main", server: new Map(), commands: [],
    saves: {}, fills: {}, onVerifyLoad: [], onMainGet: [], postInFlight: false, newWindows: 0, closed: [],
  };
  s.windows.set("main", { url: start, page: new Map(), origin: 1, state: "ok", login: false, captchaReads: 0 });
  let originSeq = 10;
  const win = () => {
    const w = s.windows.get(s.current);
    if (!w) throw Object.assign(new Error("no such window"), { name: "NoSuchWindowError" });
    return w;
  };
  const record = (kind: string) => s.commands.push({ handle: s.current, kind });
  const load = (w: Win, url: string, outcome: LoadOutcome) => {
    w.origin = ++originSeq;
    w.state = outcome === "busy" ? "busy" : outcome === "denied" ? "denied" : "ok";
    w.login = outcome === "login";
    w.url = outcome === "denied" ? DENIED : url;
    w.captchaReads = outcome === "captcha" ? 3 : 0;
    w.page = new Map(s.server);
    if (outcome === "mismatch") w.page.set(steps.identification.fields[Object.keys(steps.identification.fields)[0]].id, "different");
  };
  const element = (id: string) => ({
    isDisplayed: async () => true,
    isEnabled: async () => true,
    getAttribute: async () => win().page.get(id) ?? "",
    getText: async () => "",
    sendKeys: async (key: string) => {
      record("sendKeys");
      if (id !== SAVE_ID || key !== Key.SPACE) return;
      const w = win();
      const name = nameOf(w.url) ?? "?";
      // Invariant: exactly one POST in flight, only from the main tab.
      expect(s.postInFlight).toBe(false);
      expect(s.current).toBe("main");
      s.saves[name] = (s.saves[name] ?? 0) + 1;
      s.server = new Map(w.page);
      w.origin = ++originSeq;
    },
  });
  const idOf = (locator: { value: string }) => /\[id="(.+)"\]/.exec(locator.value)?.[1]?.replace(/\\/g, "") ?? "";
  const executeScript = async (script: string, ...args: unknown[]) => {
    const w = win();
    if (script.startsWith("location.href = arguments[0]")) {
      record("location.href");
      load(w, args[0] as string, s.onVerifyLoad.shift() ?? "ok");
      return null;
    }
    record("script");
    if (script.includes("nzwh:fill-segment")) {
      const name = nameOf(w.url) ?? "?";
      s.fills[name] = (s.fills[name] ?? 0) + 1;
      const entries = args[0] as FillEntry[];
      const start = args[1] as number;
      for (const entry of entries.slice(start)) w.page.set(entry.id, entry.expected);
      const out: SegmentResult = {
        results: entries.slice(start).map(entry => ({ key: entry.key, status: "filled" as const })), stop: null, timeOrigin: w.origin,
      };
      s.midFill?.(name as Name);
      out.timeOrigin = win().origin;
      return out;
    }
    if (script.includes("nzwh:doc-complete")) return true;
    if (script.includes("nzwh:load-gap")) return null;
    if (script.includes("nzwh:read-values")) {
      const ids = args[0] as string[];
      return { timeOrigin: w.origin, values: ids.map(id => w.page.get(id) ?? null) };
    }
    if (script.includes("get_isInAsyncPostBack")) return w.origin !== args[1] && w.state !== "denied";
    if (script.includes("return performance.timeOrigin")) return w.origin;
    if (script.includes("loginForm:")) return { loginForm: w.login, rejected: false, authenticated: !w.login };
    if (script.includes("const captchaSubmit")) return null;
    if (script.includes("const challengePage")) {
      record("captcha-pending");
      const pending = w.captchaReads > 0;
      if (pending) w.captchaReads--;
      s.onCaptchaRead?.();
      return pending;
    }
    if (script.includes("document.readyState")) return "complete";
    if (script.includes("const mapped")) return [];
    if (script.includes("[errorlabel]")) return 0;
    if (script.includes("site busy")) return w.state === "ok" ? false : w.state;
    throw new Error(`unexpected script: ${script.slice(0, 60)}`);
  };
  s.driver = {
    executeScript,
    getCurrentUrl: async () => { record("url"); return win().url; },
    get: async (url: string) => {
      record("get");
      load(win(), url, s.onMainGet.shift() ?? "ok");
    },
    findElements: async (locator: { value: string }) => {
      record("find");
      const w = win();
      if (w.state === "denied" || w.login) return [];
      const id = idOf(locator);
      return id ? [element(id)] : [];
    },
    getCapabilities: async () => null,
    manage: () => ({ setTimeouts: async () => {}, window: () => ({ maximize: async () => {} }) }),
    sendDevToolsCommand: async () => { record("cdp"); },
    getWindowHandle: async () => { record("getWindowHandle"); return s.current; },
    getAllWindowHandles: async () => { record("getAllWindowHandles"); return [...s.windows.keys()]; },
    close: async () => { record("close"); s.closed.push(s.current); s.windows.delete(s.current); },
    wait: async (condition: () => Promise<unknown>, timeout = 0, _message?: string, poll = 0) => {
      const deadline = Date.now() + timeout;
      while (true) {
        const value = await condition();
        if (value) return value;
        if (Date.now() >= deadline) throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
        await new Promise(resolve => setTimeout(resolve, poll || 50));
      }
    },
    switchTo: () => ({
      window: async (handle: string) => {
        record("switchTo");
        if (!s.windows.has(handle)) throw Object.assign(new Error("no such window"), { name: "NoSuchWindowError" });
        s.current = handle;
      },
      newWindow: async () => {
        record("newWindow");
        s.newWindows++;
        const handle = `verify${s.newWindows}`;
        s.windows.set(handle, { url: "about:blank", page: new Map(), origin: ++originSeq, state: "ok", login: false, captchaReads: 0 });
        s.current = handle;
      },
    }),
  } as unknown as WebDriver;
  return s;
}
async function drive<T>(promise: Promise<T>): Promise<T> {
  let done = false;
  const tracked = promise.finally(() => { done = true; });
  tracked.catch(() => {});
  for (let guard = 0; !done && guard < 20000; guard++) await vi.advanceTimersByTimeAsync(ACCESS_DENIED_BACKOFF_SLICE_MS);
  return tracked;
}
const start = (s: Site, extra: { attachPort?: number } = {}) => {
  hoisted.choose.mockResolvedValue(s.driver);
  vi.useFakeTimers();
  vi.setSystemTime(0);
  return drive(runWorkingHoliday({
    dataPath, allowFictionalDraftSave: true, sections: SECTIONS, country: "vietnam", ...extra,
    hooks: { event: async e => { events.push(e); }, checkpoint: async () => {} },
  }).then(result => ({ result, error: undefined as unknown }), (error: unknown) => ({ result: undefined, error })));
};
const results = () => events.filter(e => e.type === "section-result") as Extract<ExecutionEvent, { type: "section-result" }>[];
const windowCommands = (s: Site) => s.commands.filter(c => /newWindow|switchTo|getWindowHandle|location\.href|close/.test(c.kind));
/** Each section's SAVE clicked at most once; the mock already asserts one POST in flight from the main tab. */
const oneSavePerSection = (s: Site) => { for (const count of Object.values(s.saves)) expect(count).toBeLessThanOrEqual(1); };
/** Results are reported in section order and each section-result follows its own section-start. */
const resultsBeforeNextStart = () => {
  let open: string | undefined;
  for (const event of events) {
    if (event.type === "section-start") { expect(open).toBeUndefined(); open = event.section; }
    if (event.type === "section-result") { expect(open).toBeDefined(); open = undefined; }
  }
};

test.each([undefined, "0"])("flag %s: sequential flow, no second tab and identical command sequences", async flag => {
  if (flag === undefined) vi.stubEnv("NZWH_PARALLEL_VERIFY", undefined as unknown as string);
  else vi.stubEnv("NZWH_PARALLEL_VERIFY", flag);
  const s = site(section("identification"));
  const { result } = await start(s);
  expect(result).toMatchObject({ success: true, outcome: "filled" });
  expect(windowCommands(s)).toEqual([]);
  expect(s.saves).toEqual({ identification: 1, health: 1, character: 1 });
  expect(logs.some(l => l.includes("Parallel verify"))).toBe(false);
  expect(logs.some(l => l.includes("Timing summary mode=sequential") && l.includes("fallback=none"))).toBe(true);
  // Same commands whatever the off value, in the sequential order: GET N+1 only after N's reload verified.
  const kinds = s.commands.map(c => c.kind).join(",");
  const other = site(section("identification"));
  vi.stubEnv("NZWH_PARALLEL_VERIFY", flag === undefined ? "0" : "");
  vi.useRealTimers();
  await start(other);
  expect(other.commands.map(c => c.kind).join(",")).toBe(kinds);
  expect(s.commands.filter(c => c.kind === "get")).toHaveLength(5); // health, character + three verify reloads
  resultsBeforeNextStart();
});

test("flag on: each saved section is verified in the verify tab, reported before the next section starts", async () => {
  const s = site(section("identification"));
  hoisted.onFinish = () => ({ windows: [...s.windows.keys()], current: s.current, completed: results().length });
  const { result } = await start(s);
  expect(result).toMatchObject({ success: true, outcome: "filled" });
  expect(s.newWindows).toBe(1);
  expect(s.commands.filter(c => c.kind === "location.href").map(c => c.handle)).toEqual(["verify1", "verify1", "verify1"]);
  // Main tab only loads the next sections; no blocking verify reload in the main tab.
  expect(s.commands.filter(c => c.kind === "get").map(c => c.handle)).toEqual(["main", "main"]);
  expect(results().map(r => r.status)).toEqual(["completed", "completed", "completed"]);
  oneSavePerSection(s);
  resultsBeforeNextStart();
  // Drained before finishApplication: last section reported, verify tab closed, driver on the main tab.
  expect(hoisted.atFinish).toEqual([{ windows: ["main"], current: "main", completed: 3 }]);
  expect(logs.some(l => l.includes("Timing summary mode=parallel") && l.includes("fallback=none"))).toBe(true);
  expect(logs.some(l => /timing next-load \d+ms/.test(l))).toBe(true);
  expect(logs.join("\n")).not.toContain("SECRET123");
});

test("mismatch in the verify tab marks the section unverified without a second SAVE and blocks submission", async () => {
  const s = site(section("identification"));
  s.onVerifyLoad.push("mismatch");
  const { result } = await start(s);
  expect(result).toMatchObject({ success: false, outcome: "incomplete" });
  expect(s.saves).toEqual({ identification: 1, health: 1, character: 1 });
  expect(s.fills.identification).toBe(1);
  expect(results().map(r => r.status)).toEqual(["failed", "completed", "completed"]);
  expect(results()[0].detail).toContain("Không tự lưu lại");
  expect(s.newWindows).toBe(1); // a mismatch is a valid read, not a fallback
  resultsBeforeNextStart();
});

test.each(["busy", "denied", "login"] as const)("%s in the verify tab: tab closed, sequential for the rest, pending section verified in the main tab", async outcome => {
  const s = site(section("identification"));
  s.onVerifyLoad.push(outcome);
  const { result } = await start(s);
  expect(result).toMatchObject({ success: true, outcome: "filled" });
  expect(s.newWindows).toBe(1);
  expect(s.closed).toEqual(["verify1"]);
  expect(logs.filter(l => l.includes("Parallel verify off for the rest of this run"))).toHaveLength(1);
  expect(s.commands.filter(c => c.kind === "location.href")).toHaveLength(1);
  // identification re-verified in the main tab (GET), then health/character run sequentially.
  const mainGets = s.commands.filter(c => c.kind === "get");
  expect(mainGets.every(c => c.handle === "main")).toBe(true);
  expect(mainGets).toHaveLength(6); // health prefetch, identification verify, health, health verify, character, character verify
  expect(s.saves).toEqual({ identification: 1, health: 1, character: 1 });
  expect(results().map(r => r.status)).toEqual(["completed", "completed", "completed"]);
  expect(logs.some(l => l.includes("Timing summary mode=parallel") && !l.includes("fallback=none"))).toBe(true);
  resultsBeforeNextStart();
});

test("CAPTCHA in the verify tab: the guard owns tab 2 for the whole wait, the main tab is parked, one prompt", async () => {
  const s = site(section("identification"));
  s.onVerifyLoad.push("captcha");
  let marks: [number, number] | undefined;
  let hijacked = false;
  s.onCaptchaRead = () => {
    // Something switches the driver mid-wait: the guard must switch back before its next read.
    if (s.current === "verify1" && !hijacked && s.windows.get("verify1")!.captchaReads === 1) { hijacked = true; s.current = "main"; }
  };
  const hooks = { event: async (e: ExecutionEvent) => {
    events.push(e);
    if (e.type === "captcha") {
      if (e.waiting && !marks) marks = [s.commands.length, -1];
      else if (!e.waiting && marks) marks[1] = s.commands.length;
    }
  }, checkpoint: async () => {} };
  hoisted.choose.mockResolvedValue(s.driver);
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const result = await drive(runWorkingHoliday({ dataPath, allowFictionalDraftSave: true, sections: SECTIONS, country: "vietnam", hooks }));
  expect(result).toMatchObject({ success: true, outcome: "filled" });
  expect(hijacked).toBe(true);
  expect(events.filter(e => e.type === "captcha" && e.waiting)).toHaveLength(1);
  const during = s.commands.slice(marks![0], marks![1]);
  // Only the guard's window switch-back may come from the hijacked main handle; nothing else runs there.
  expect(during.filter(c => c.handle === "main").map(c => c.kind)).toEqual(expect.arrayContaining(["getWindowHandle", "switchTo"]));
  expect(during.filter(c => c.handle === "main" && !["getWindowHandle", "switchTo"].includes(c.kind))).toEqual([]);
  expect(during.filter(c => c.kind === "captcha-pending").every(c => c.handle === "verify1")).toBe(true);
  expect(during.some(c => c.kind === "get" || c.kind === "sendKeys")).toBe(false);
  oneSavePerSection(s);
  expect(results().map(r => r.status)).toEqual(["completed", "completed", "completed"]);
});

test("per-section risk: a redirect while filling N+1 refills N+1 only; N (saved, verify pending) is never refilled", async () => {
  const s = site(section("identification"));
  let fired = false;
  s.midFill = name => {
    if (name === "health" && !fired) { fired = true; const w = s.windows.get("main")!; w.state = "denied"; w.url = DENIED; w.origin++; }
  };
  const { result } = await start(s);
  expect(result).toMatchObject({ success: true, outcome: "filled" });
  expect(s.fills).toEqual({ identification: 1, health: 2, character: 1 });
  expect(s.saves).toEqual({ identification: 1, health: 1, character: 1 });
  oneSavePerSection(s);
});

test("per-section risk: session expiry after N+1's SAVE stops without refilling or re-sending", async () => {
  const s = site(section("identification"));
  // health is verified in tab 2 -> login (fallback); the main-tab verify reload also lands on login.
  s.onVerifyLoad.push("ok", "login");
  s.onMainGet.push("ok", "ok", "login");
  const { error } = await start(s);
  expect(error).toBeInstanceOf(WorkingHolidayStop);
  expect((error as Error).message).toMatch(/Không tự điền lại/);
  expect(s.saves).toEqual({ identification: 1, health: 1 });
  expect(s.fills).toEqual({ identification: 1, health: 1 });
});

test("attach mode with the flag on stays sequential", async () => {
  const s = site(section("identification"));
  const { result } = await start(s, { attachPort: 9222 });
  expect(result).toMatchObject({ success: true });
  expect(s.newWindows).toBe(0);
  expect(s.commands.some(c => c.kind === "location.href")).toBe(false);
  expect(logs.some(l => l.includes("Parallel verify unavailable when attaching"))).toBe(true);
  oneSavePerSection(s);
});
