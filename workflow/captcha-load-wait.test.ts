// Provider-branch CAPTCHA load wait for eager sessions (finding 6). captcha.test.ts stays unmodified.
import { afterEach, expect, test, vi } from "vitest";
import { error as webdriverError } from "selenium-webdriver";
import type { WebDriver } from "selenium-webdriver";
import { captchaGuard, markEagerDriverForTest, withHooksForTest } from "./run";
import * as configuration from "../server/cloud";
import * as provider from "./capsolver";
import * as browser from "./capsolver-browser";
import { StopRequested } from "../lib/execution-controller";
import type { ExecutionEvent } from "../lib/execution-state";

function fixture(states: boolean[], ready: boolean[], onReady?: () => void) {
  const order: string[] = [];
  const executeScript = vi.fn(async (script: string) => {
    if (script.includes("const captchaSubmit")) return null;
    if (script.includes("const challengePage")) { order.push("pending"); return states.shift() ?? false; }
    if (script.includes("document.readyState")) { order.push("ready"); onReady?.(); return ready.shift() ?? true; }
    return false; // site busy
  });
  const wait = vi.fn(async (condition: () => Promise<boolean>) => {
    order.push("wait");
    for (let poll = 0; poll < 5; poll++) if (await condition()) return true;
    throw new webdriverError.TimeoutError("timeout");
  });
  return { driver: { executeScript, wait } as unknown as WebDriver, order };
}
const challenge = { websiteURL: "https://onlineservices.immigration.govt.nz/rs-captcha", websiteKey: "public-key", pageId: 1 };
function adapters() {
  return {
    key: vi.spyOn(configuration, "loadCapSolverKey").mockResolvedValue("server-secret"),
    read: vi.spyOn(browser, "readCaptchaChallenge").mockResolvedValue(challenge),
    solve: vi.spyOn(provider, "solveRecaptchaV2").mockResolvedValue("provider-token"),
  };
}
const guard = (driver: WebDriver, captchaMode: "manual" | "capsolver", events: ExecutionEvent[] = [], signal?: AbortSignal) =>
  withHooksForTest({ event: async (e) => { events.push(e); }, checkpoint: async () => {} }, () => captchaGuard(driver), { captchaMode, signal });
afterEach(() => { vi.restoreAllMocks(); });

test("an unregistered driver makes no extra readyState read", async () => {
  const { read } = adapters();
  const { driver, order } = fixture([true, false], []);
  await expect(guard(driver, "capsolver")).resolves.toBe(true);
  expect(read).toHaveBeenCalledOnce();
  expect(order.indexOf("ready")).toBeGreaterThan(order.indexOf("wait"));
});
test("a registered driver waits for load, then reads the challenge once and requests the provider once", async () => {
  const { read, solve } = adapters();
  const { driver, order } = fixture([true, true, true, true, false], [false, false, true]);
  markEagerDriverForTest(driver);
  await expect(guard(driver, "capsolver")).resolves.toBe(true);
  expect(order.slice(0, 6)).toEqual(["pending", "ready", "pending", "ready", "pending", "ready"]);
  expect(read).toHaveBeenCalledOnce();
  expect(solve).toHaveBeenCalledOnce();
});
test("finding 6: a challenge that disappears during the load wait skips the provider and notifies nothing", async () => {
  const { read, solve, key } = adapters();
  const events: ExecutionEvent[] = [];
  const { driver, order } = fixture([true, true, false], [false, false, true]);
  markEagerDriverForTest(driver);
  const logs: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...line: unknown[]) => { logs.push(line.join(" ")); });
  await expect(guard(driver, "capsolver", events)).resolves.toBe(true);
  expect(order.slice(0, 5)).toEqual(["pending", "ready", "pending", "ready", "pending"]);
  expect(read).not.toHaveBeenCalled();
  expect(key).not.toHaveBeenCalled();
  expect(solve).not.toHaveBeenCalled();
  expect(events.filter((e) => e.type === "captcha" && e.waiting)).toEqual([]);
  expect(logs.some((l) => l.includes("challenge gone during load wait."))).toBe(true);
});
test("stop/cancel during the load wait stops without a provider request", async () => {
  const { solve, read } = adapters();
  const controller = new AbortController();
  const { driver } = fixture([true, true, true], [false, false], () => controller.abort());
  markEagerDriverForTest(driver);
  await expect(guard(driver, "capsolver", [], controller.signal)).rejects.toBeInstanceOf(StopRequested);
  expect(read).not.toHaveBeenCalled();
  expect(solve).not.toHaveBeenCalled();
});
test("manual mode with a registered driver keeps today's call sequence", async () => {
  adapters();
  const { driver, order } = fixture([true, false], []);
  markEagerDriverForTest(driver);
  await expect(guard(driver, "manual")).resolves.toBe(true);
  expect(order).toEqual(["pending", "wait", "pending", "ready"]);
});
