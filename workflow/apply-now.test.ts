import { runInNewContext } from "node:vm";
import { expect, test, vi } from "vitest";
import type { WebDriver } from "selenium-webdriver";
import { clickApplyNow } from "./run";
import { WorkingHolidayStop } from "./errors";

/** Runs the real page script against a tiny fake DOM so the matcher itself is tested. */
function page(elements: { selector: string; text: string; visible?: boolean }[], bodyText = "") {
  const nodes = elements.map(e => ({
    value: e.selector.startsWith("input") ? e.text : "",
    innerText: e.selector.startsWith("input") ? "" : e.text,
    textContent: e.text,
    disabled: false,
    alt: "",
    getAttribute: () => null,
    getBoundingClientRect: () => ({ width: e.visible === false ? 0 : 100, height: e.visible === false ? 0 : 30 }),
  }));
  const document = { querySelectorAll: () => nodes, body: { innerText: bodyText } };
  return { nodes, document };
}
function driverFor(dom: ReturnType<typeof page>, urls: string[]) {
  const click = vi.fn();
  const driver = {
    executeScript: vi.fn(async (script: string) => {
      if (script.includes("scrollIntoView")) return undefined;
      if (script.includes("apply")) return runInNewContext(`(function(){${script}})()`, { document: dom.document });
      if (script.includes("please complete")) return null;
      return undefined;
    }),
    getCurrentUrl: vi.fn(async () => urls.shift() ?? urls[0] ?? ""),
    click,
  };
  return { driver: driver as unknown as WebDriver, click };
}
test("unavailable scheme is reported without clicking anything", async () => {
  const dom = page([{ selector: "a", text: "Return to homepage" }], "Scheme is not available");
  const { driver } = driverFor(dom, []);
  await expect(clickApplyNow(driver)).resolves.toBe("unavailable");
});
test("missing APPLY NOW (and no unavailable text) is a clear stop", async () => {
  const { driver } = driverFor(page([{ selector: "a", text: "Return to homepage" }], "Scheme is available"), []);
  await expect(clickApplyNow(driver)).rejects.toBeInstanceOf(WorkingHolidayStop);
});
test("clicks exactly the APPLY NOW control (input/button/anchor, any case) and nothing else", async () => {
  for (const [selector, text] of [["input", "APPLY NOW"], ["button", " Apply   Now "], ["a", "apply now"]]) {
    const dom = page([
      { selector: "a", text: "Return to homepage" },
      { selector: "a", text: "Apply now", visible: false },
      { selector, text },
    ]);
    const clicks: number[] = [];
    dom.nodes.forEach((n, i) => Object.assign(n, { click: async () => void clicks.push(i) }));
    const { driver } = driverFor(dom, []);
    Object.assign(driver, {
      sendDevToolsCommand: async () => undefined,
      getCurrentUrl: async () => "https://onlineservices.immigration.govt.nz/rs-captcha?redirect=x",
    });
    await expect(clickApplyNow(driver)).resolves.toBe("clicked");
    expect(clicks).toEqual([2]);
  }
});
