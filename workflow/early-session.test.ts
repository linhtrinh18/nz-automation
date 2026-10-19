// Session wiring for phase 2: page-load strategy requested from chooseBrowser, capability mapping,
// eager-driver registration and the submission-page wait (P11 cases 11b and 15).
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { WebDriver } from "selenium-webdriver";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sample from "../fixtures/sample.json";
const browser = vi.hoisted(() => ({ choose: vi.fn() }));
vi.mock("../browser/chooseBrowser", () => ({ chooseBrowser: browser.choose }));
import { entrySessionForTest, isEagerDriverForTest, runWorkingHoliday, submissionWaitForChangeForTest } from "./run";

const STOP = "fixture-stop-after-capabilities";
let directory: string;
let dataPath: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "nzwh-early-session-"));
  dataPath = join(directory, "sample.json");
  await writeFile(dataPath, JSON.stringify(sample));
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  browser.choose.mockReset();
  await rm(directory, { recursive: true, force: true });
});

/** Driver that answers the capability read, then stops the run at the first session setup call. */
function sessionDriver(capabilities: () => Promise<unknown>): WebDriver {
  return {
    getCapabilities: capabilities,
    manage: () => { throw new Error(STOP); },
    quit: async () => {},
  } as unknown as WebDriver;
}
async function start(driver: WebDriver): Promise<unknown[]> {
  browser.choose.mockResolvedValue(driver);
  await expect(runWorkingHoliday({ dataPath, allowFictionalDraftSave: true, sections: ["health"] })).rejects.toThrow(STOP);
  return browser.choose.mock.calls[0];
}
const reporting = (strategy: string) => async () => ({ get: (key: string) => (key === "pageLoadStrategy" ? strategy : undefined) });

test.each([
  ["default switches", {}, "eager"],
  ["NZWH_FAST_FILL=0", { NZWH_FAST_FILL: "0" }, "normal"],
  ["NZWH_EARLY_FILL=0", { NZWH_EARLY_FILL: "0" }, "normal"],
])("case 15: chooseBrowser gets the strategy for %s", async (_, env, expected) => {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const args = await start(sessionDriver(reporting("eager")));
  expect(args[5]).toBe(expected);
});

test("case 11b: a rejected capability read registers the driver as eager (load preconditions on)", async () => {
  const driver = sessionDriver(async () => { throw new Error("capabilities unavailable"); });
  await start(driver);
  expect(isEagerDriverForTest(driver)).toBe(true);
});

test("case 11b: a reported 'normal' strategy does not register the driver", async () => {
  const driver = sessionDriver(reporting("normal"));
  await start(driver);
  expect(isEagerDriverForTest(driver)).toBe(false);
});

test("case 11b: under NZWH_EARLY_FILL=0 the driver is never registered", async () => {
  vi.stubEnv("NZWH_EARLY_FILL", "0");
  const driver = sessionDriver(reporting("eager"));
  await start(driver);
  expect(isEagerDriverForTest(driver)).toBe(false);
});

test("entrySession: unknown means eager for preconditions; the early pass needs a confirmed 'eager'", () => {
  expect(entrySessionForTest(true, "eager")).toEqual({ eagerSession: true, early: true });
  expect(entrySessionForTest(true, undefined)).toEqual({ eagerSession: true, early: false });
  expect(entrySessionForTest(true, "none")).toEqual({ eagerSession: true, early: false });
  expect(entrySessionForTest(true, "normal")).toEqual({ eagerSession: false, early: false });
  expect(entrySessionForTest(false, "eager")).toEqual({ eagerSession: false, early: false });
});

/** Fake driver.wait that polls the condition; executeScript answers readyState reads. */
function waitDriver(readyStates: boolean[]) {
  const scripts: string[] = [];
  const waits: number[] = [];
  const driver = {
    wait: async (condition: () => Promise<boolean>, timeout: number) => {
      waits.push(timeout);
      while (!(await condition())) await new Promise((resolve) => setTimeout(resolve, 1));
    },
    executeScript: async (script: string) => {
      scripts.push(script);
      if (script.includes("site busy")) return false;
      return readyStates.shift() ?? true;
    },
  } as unknown as WebDriver;
  return { driver, scripts, waits };
}

test("case 11b: an eager session's submission wait waits for the change, then full load", async () => {
  const f = waitDriver([false, true]);
  let changed = false;
  setTimeout(() => { changed = true; }, 5);
  await submissionWaitForChangeForTest(f.driver, true)(async () => changed);
  expect(f.waits).toHaveLength(2); // change, then load
  expect(f.scripts.filter((s) => s.includes("document.readyState === 'complete'"))).toHaveLength(2);
  expect(f.scripts.filter((s) => s.includes("site busy"))).toHaveLength(2); // guard on every load poll
});

test("case 11b: a normal session's submission wait is today's single driver.wait, no readyState read", async () => {
  const f = waitDriver([]);
  await submissionWaitForChangeForTest(f.driver, false)(async () => true);
  expect(f.waits).toEqual([30000]);
  expect(f.scripts).toEqual([]);
});
