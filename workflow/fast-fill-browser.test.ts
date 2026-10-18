// Real headless Chrome against a local 127.0.0.1 page: in-page fast entry and isDisplayed parity.
import { afterAll, beforeAll, expect, test } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Builder, By } from "selenium-webdriver";
import { Options } from "selenium-webdriver/chrome";
import type { WebDriver } from "selenium-webdriver";
import { fieldAvailable, fillSegment, isDisplayedAtomSource, type FillEntry } from "./fast-fill";

const page = `<!doctype html><html><body>
<input id="text" maxlength="20"><textarea id="area"></textarea><input id="date">
<select id="title"><option value=""></option><option value="1">Mr</option><option value="6">Other</option></select>
<input id="otherTitle" style="display:none">
<select id="country" style="display:none"><option value=""></option><option value="NZ">New Zealand</option></select>
<div id="s2id_country"><a class="select2-choice" href="#" style="display:inline-block;width:200px;height:20px"><span class="select2-chosen"></span></a></div>
<select id="posting" onchange="__doPostBack('posting','')"><option value="No">No</option><option value="Yes">Yes</option></select>
<input id="guarded">
<div id="parity">
  <input id="p-none" style="display:none"><div style="display:none"><input id="p-ancestor"></div>
  <input id="p-visibility" style="visibility:hidden"><input id="p-opacity" style="opacity:0">
  <input id="p-zero" style="width:0;height:0;border:0;padding:0">
  <div style="overflow:hidden;height:0"><input id="p-clipped"></div>
  <input id="p-disabled" disabled><fieldset disabled><input id="p-fieldset"></fieldset><input id="p-visible">
</div>
<script>
window.__events = [];
for (const e of document.querySelectorAll('input,select,textarea'))
  for (const type of ['input','change','focusout','blur','focus']) e.addEventListener(type, () => __events.push(e.id + ':' + type));
document.getElementById('title').addEventListener('change', e => {
  setTimeout(() => { document.getElementById('otherTitle').style.display = e.target.value === '6' ? '' : 'none'; }, 100);
});
const country = document.getElementById('country');
country.addEventListener('change', () => { document.querySelector('#s2id_country .select2-chosen').textContent = '\\n  ' + country.options[country.selectedIndex].text.replace(' ', '\\u00a0') + ' '; });
document.getElementById('guarded').addEventListener('input', e => { if (!e.isTrusted) e.target.value = ''; });
window.__doPostBack = () => { window.__posted = true; };
</script></body></html>`;

let driver: WebDriver;
let server: Server;
let base: string;
const atom = isDisplayedAtomSource()!;
const entry = (key: string, kind: FillEntry["kind"], expected: string): FillEntry =>
  ({ key, id: key, kind, expected, applicable: true, colonsPrepared: false });

beforeAll(async () => {
  server = createServer((_, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(page); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  driver = await new Builder().forBrowser("chrome").setChromeOptions(new Options().addArguments("--headless=new", "--window-size=1280,900") as never).build();
}, 60000);
afterAll(async () => { await driver?.quit(); server?.close(); });

test("fills text, textarea, date, select and Select2 in real Chrome, yielding after selects", async () => {
  await driver.get(base);
  const entries = [
    entry("text", "text", "Alpha"), entry("area", "textarea", "one\ntwo"), entry("date", "date", "14 June, 2032"),
    entry("title", "select", "6"), entry("otherTitle", "text", "Dr"), entry("country", "select", "NZ"),
  ];
  const first = await fillSegment(driver, atom, entries, 0);
  expect(first.results.map((r) => r.status)).toEqual(["filled", "filled", "filled", "filled"]);
  expect(first.stop).toEqual({ index: 4, reason: "yield" });
  // otherTitle is revealed 100 ms after title's change: the next segment reports it unavailable.
  const second = await fillSegment(driver, atom, entries, 4);
  expect(second.stop).toEqual({ index: 4, reason: "unavailable-required" });
  await driver.wait(() => fieldAvailable(driver, atom, "otherTitle", "text"), 2000, "reveal", 20);
  const third = await fillSegment(driver, atom, entries, 4);
  expect(third.results).toEqual([{ key: "otherTitle", status: "filled" }, { key: "country", status: "filled" }]);
  const events = await driver.executeScript<string[]>("return window.__events");
  expect(events.filter((e) => e.startsWith("text:"))).toEqual(["text:input", "text:change", "text:focusout", "text:blur"]);
  expect(events.filter((e) => e.startsWith("country:"))).toEqual(["country:input", "country:change"]);
  const values = await driver.executeScript<string[]>("return ['text','area','date','title','otherTitle','country'].map(id => document.getElementById(id).value)");
  expect(values).toEqual(["Alpha", "one\ntwo", "14 June, 2032", "6", "Dr", "NZ"]);
  // Re-running is idempotent: everything unchanged, no new events.
  const before = events.length;
  const again = await fillSegment(driver, atom, entries, 0);
  expect(again.results.every((r) => r.status === "unchanged")).toBe(true);
  expect((await driver.executeScript<string[]>("return window.__events")).length).toBe(before);
}, 60000);

test("posting controls and untrusted-event guards are left to the standard entry", async () => {
  await driver.get(base);
  const posting = await fillSegment(driver, atom, [entry("posting", "select", "Yes")], 0);
  expect(posting.stop).toEqual({ index: 0, reason: "posting" });
  expect(await driver.executeScript("return [document.getElementById('posting').value, !!window.__posted]")).toEqual(["No", false]);
  const guarded = await fillSegment(driver, atom, [entry("guarded", "text", "Beta")], 0);
  expect(guarded.stop).toEqual({ index: 0, reason: "fallback", cause: "value-rejected" });
  const tooLong = await fillSegment(driver, atom, [entry("text", "text", "x".repeat(21))], 0);
  expect(tooLong.stop).toEqual({ index: 0, reason: "fallback", cause: "too-long" });
}, 60000);

test("in-page availability matches WebElement.isEnabled() && isDisplayed()", async () => {
  await driver.get(base);
  const ids = ["p-none", "p-ancestor", "p-visibility", "p-opacity", "p-zero", "p-clipped", "p-disabled", "p-fieldset", "p-visible"];
  for (const id of ids) {
    const element = await driver.findElement(By.id(id));
    const expected = (await element.isEnabled()) && (await element.isDisplayed());
    expect(await fieldAvailable(driver, atom, id, "text"), id).toBe(expected);
  }
}, 60000);
