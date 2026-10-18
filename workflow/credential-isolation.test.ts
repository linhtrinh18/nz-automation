import { expect, test, vi } from "vitest";
import type { WebDriver } from "selenium-webdriver";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sample from "../fixtures/sample.json";
const browser = vi.hoisted(() => ({ choose: vi.fn() }));
vi.mock("../browser/chooseBrowser", () => ({ chooseBrowser: browser.choose }));
import { runWorkingHoliday } from "./run";
function loginProbe() {
  const typed: string[] = [];
  let url = "https://onlineservices.immigration.govt.nz/secure/Login+Working+Holiday.htm";
  const element = { clear: async () => {}, sendKeys: async (value: string) => { typed.push(value); await Promise.resolve(); if (typed.length % 2 === 0) throw new Error("fixture-stop-before-submit"); } };
  const driver = {
    get: async (next: string) => { url = next; },
    getCurrentUrl: async () => url,
    getCapabilities: async () => null,
    manage: () => ({ setTimeouts: async () => {}, window: () => ({ maximize: async () => {} }) }),
    sendDevToolsCommand: async () => {},
    executeScript: async (script: string) => script.includes("return document.readyState") ? "complete" : script.includes("const pageText") ? "login" : false,
    findElements: async (locator: { value: string }) => locator.value.includes('input[name="username"]') ? [element] : [],
    findElement: () => element,
    wait: async () => element,
  } as unknown as WebDriver;
  return { driver, typed };
}
test("two automation runs and repeated logins type only their assigned pair despite shared environment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nzwh-login-isolation-"));
  vi.stubEnv("NZWH_USERNAME", "shared-user"); vi.stubEnv("NZWH_PASSWORD", "shared-secret");
  try {
    const dataPath = join(directory,"sample.json"); await writeFile(dataPath,JSON.stringify(sample));
    const a=loginProbe(),b=loginProbe();
    browser.choose.mockImplementation(async (_type, _agent, profile) => profile === "a" ? a.driver : b.driver);
    for(let retry=0;retry<2;retry++) {
      const results=await Promise.allSettled([
        runWorkingHoliday({ dataPath, profileName: "a", credentials: { username: "user-a", password: "secret-a" }, allowFictionalDraftSave: true, sections: ["health"] }),
        runWorkingHoliday({ dataPath, profileName: "b", credentials: { username: "user-b", password: "secret-b" }, allowFictionalDraftSave: true, sections: ["health"] }),
      ]);
      expect(results.every(result=>result.status==="rejected" && result.reason.message==="fixture-stop-before-submit")).toBe(true);
    }
    expect(a.typed).toEqual(["user-a","secret-a","user-a","secret-a"]);
    expect(b.typed).toEqual(["user-b","secret-b","user-b","secret-b"]);
  } finally { vi.unstubAllEnvs(); await rm(directory,{recursive:true,force:true}); }
});
