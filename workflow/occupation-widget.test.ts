// Fixture-driven widget tests: real Chrome against a local 127.0.0.1 page with shortened postback delays.
import { afterAll, beforeAll, expect, test } from "vitest";
import { Builder } from "selenium-webdriver";
import { Options } from "selenium-webdriver/chrome";
import type { WebDriver } from "selenium-webdriver";
import { runScenario } from "../scripts/fixtures/occupation-scenarios";

let driver: WebDriver;
const ms = { industry: 2500, occupation: 1500 };
beforeAll(async () => {
  driver = await new Builder().forBrowser("chrome").setChromeOptions(new Options().addArguments("--headless=new", "--window-size=1280,900") as never).build();
}, 60000);
afterAll(async () => { await driver?.quit(); });

test("slow postback: waits for results then selects", async () => {
  const o = await runScenario(driver, "slow", ms);
  expect(o.error).toBeUndefined();
  expect(o.selected).toEqual(["industryResult", "occupationResult"]);
  await o.shot!();
}, 120000);
test("empty results fall back to the alternative query", async () => {
  const o = await runScenario(driver, "fallback", ms);
  expect(o.error).toBeUndefined();
  expect(o.logs.some((l) => l.includes("thử cụm từ khác"))).toBe(true);
  await o.shot!();
}, 180000);
test("already-selected value is skipped without a search POST", async () => {
  const o = await runScenario(driver, "alreadySelected", ms);
  expect(o.error).toBeUndefined();
  expect(o.searchPosts).toBe(0);
  await o.shot!();
}, 60000);
test("no results anywhere fails with a clear Vietnamese message", async () => {
  const o = await runScenario(driver, "noResults", ms);
  expect(o.error).toMatch(/Không tìm thấy .*\[Zzz\] \(0 kết quả/);
  expect(o.logs.some((l) => l.includes("Không tìm thấy"))).toBe(true);
  await o.shot!();
}, 180000);
