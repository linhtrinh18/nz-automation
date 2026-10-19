// waitForChangeThenLoad: submission, declaration and payment clicks keep the full-load precondition under eager.
import { expect, test, vi } from "vitest";
import { error as webdriverError } from "selenium-webdriver";
import type { WebDriver } from "selenium-webdriver";
import { PAGE_POLL_MS, waitForChangeThenLoad } from "./fast-fill";
import { StopRequested } from "../lib/execution-controller";
import { SiteBusyError } from "./site-busy";

function fake(ready: boolean[]) {
  const calls: string[] = [];
  const polls: number[] = [];
  const driver = {
    executeScript: vi.fn(async (script: string) => {
      calls.push(script.includes("document.readyState") ? "readyState" : script);
      return ready.shift() ?? false;
    }),
    // Same contract as WebDriver#wait: poll until truthy, TimeoutError at the limit.
    wait: vi.fn(async (condition: () => Promise<boolean>, timeout: number, _message?: string, poll = 0) => {
      polls.push(poll);
      for (let elapsed = 0; elapsed <= timeout; elapsed += Math.max(poll, 1000)) if (await condition()) return true;
      throw new webdriverError.TimeoutError("Wait timed out");
    }),
  } as unknown as WebDriver;
  return { driver, calls, polls };
}

test("no readyState read and no guard call until the change condition holds", async () => {
  const { driver, calls } = fake([true]);
  const guard = vi.fn();
  const changes = [false, false, true];
  const condition = vi.fn(async () => { expect(calls).toEqual([]); expect(guard).not.toHaveBeenCalled(); return changes.shift()!; });
  await waitForChangeThenLoad(driver, condition, guard);
  expect(condition).toHaveBeenCalledTimes(3);
  expect(calls).toEqual(["readyState"]);
  expect(guard).toHaveBeenCalledTimes(1);
});
test("waits through false, false, true at PAGE_POLL_MS", async () => {
  const { driver, calls, polls } = fake([false, false, true]);
  await waitForChangeThenLoad(driver, async () => true, () => undefined);
  expect(calls).toEqual(["readyState", "readyState", "readyState"]);
  expect(polls[1]).toBe(PAGE_POLL_MS);
});
test("a never-complete page rejects with TimeoutError", async () => {
  const { driver } = fake([]);
  await expect(waitForChangeThenLoad(driver, async () => true, () => undefined, 1000, 3000)).rejects.toBeInstanceOf(webdriverError.TimeoutError);
});
test("stop/cancel during the load phase aborts within one poll", async () => {
  const { driver, calls } = fake([false, false, false]);
  const controller = new AbortController();
  let polls = 0;
  const guard = () => { if (++polls === 2) controller.abort(); if (controller.signal.aborted) throw new StopRequested(); };
  await expect(waitForChangeThenLoad(driver, async () => true, guard)).rejects.toBeInstanceOf(StopRequested);
  expect(calls).toHaveLength(1);
});
test("a site-busy guard error propagates", async () => {
  const { driver } = fake([false]);
  await expect(waitForChangeThenLoad(driver, async () => true, () => { throw new SiteBusyError(); })).rejects.toBeInstanceOf(SiteBusyError);
});
