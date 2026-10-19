import { expect, test, vi } from "vitest";
import type { WebDriver } from "selenium-webdriver";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blankApplication } from "./application-data";
const browser = vi.hoisted(() => ({ choose: vi.fn() }));
vi.mock("../browser/chooseBrowser", () => ({ chooseBrowser: browser.choose }));
import { markWindowSizedAtLaunch } from "../browser/window-size";
import { runWorkingHoliday } from "./run";

test.each([[false, 1, undefined, 1], [true, 0, undefined, 1], [false, 1, "0", 3]])("login-only confirms authentication and leaves Chrome open without touching an application (sized at launch: %s, early fill %s)", async (sized, maximizeCalls, earlyFill, readyCalls) => {
  if (earlyFill) vi.stubEnv("NZWH_EARLY_FILL", earlyFill);
  let readyReads = 0;
  const maximize = vi.fn(async () => {});
  const directory = await mkdtemp(join(tmpdir(), "nzwh-login-only-"));
  let authenticated = false;
  let url = "about:blank";
  const destinations: string[] = [];
  const clicked: string[] = [];
  const quit = vi.fn();
  const element = (selector: string) => ({ clear: async () => {}, sendKeys: async () => {},
    click: async () => { clicked.push(selector); authenticated = true; url = "https://onlineservices.immigration.govt.nz/WorkingHoliday/"; },
  });
  const driver = {
    get: async (next: string) => { destinations.push(next); url = next; },
    getCurrentUrl: async () => url, getCapabilities: async () => null,
    manage: () => ({ setTimeouts: async () => {}, window: () => ({ maximize }) }),
    sendDevToolsCommand: async () => {}, quit,
    executeScript: async (script: string) => {
      if (script.includes("return document.readyState")) { readyReads++; return "complete"; }
      if (script.includes("loginForm:")) return { loginForm: !authenticated, rejected: false, authenticated };
      return false;
    },
    findElements: async (locator: { value: string }) => locator.value.includes('input[name="username"]') ? [element(locator.value)] : [],
    findElement: (locator: { value: string }) => element(locator.value),
    wait: async (condition: unknown) => typeof condition === "function" ? (condition as () => unknown)() : element("username"),
  } as unknown as WebDriver;
  if (sized) markWindowSizedAtLaunch(driver);
  browser.choose.mockResolvedValue(driver);
  try {
    const dataPath = join(directory, "blank.json");
    await writeFile(dataPath, JSON.stringify(blankApplication()));
    const result = await runWorkingHoliday({ dataPath, mode: "loginOnly", country: "japan", credentials: { username: "fixture", password: "fixture-secret" } });
    expect(result).toMatchObject({ success: true, outcome: "loggedIn" });
    expect(clicked).toEqual(['input[type="submit"][value="LOGIN"]']);
    expect(destinations.every(destination => !/Wizard|Create|Submit|Payment/.test(destination))).toBe(true);
    expect(maximize).toHaveBeenCalledTimes(maximizeCalls);
    // E4: targeted waits replace home/login ready() calls; NZWH_EARLY_FILL=0 restores them.
    expect(readyReads).toBe(readyCalls);
    expect(quit).not.toHaveBeenCalled();
    expect(result.driver).toBe(driver);
  } finally { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); }
});
