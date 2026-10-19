// Real headless Chrome, pageLoadStrategy "eager", against wizard-like section fixtures on 127.0.0.1
// (P11 cases 22–29). Each page carries a slow image so `load` lags DOMContentLoaded by SLOW_IMAGE_MS.
// The full section flow runs through saveStepForTest: fill, settle, SAVE (form POST), reload, verify.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Builder } from "selenium-webdriver";
import { Options } from "selenium-webdriver/chrome";
import type { WebDriver } from "selenium-webdriver";
import { saveStepForTest, withHooksForTest } from "./run";
import { steps } from "./fields";
import { applicationDataSchema, type ApplicationData, type SectionName } from "./application-data";
import { planSection } from "./fast-fill";

/** DOMContentLoaded→load gap forced by the fixture image. */
const SLOW_IMAGE_MS = 2000;
/** Field inserted this long after DOMContentLoaded (case 28). */
const LATE_INSERT_MS = 300;
/** Server think time per POST. */
const POST_LATENCY_MS = 300;
/**
 * __doPostBack submits after this delay. The unchanged standard select entry sends TAB after the
 * option click; an immediate local submit makes chromedriver's click wait out the navigation, so the
 * TAB hits a stale element under either load strategy (probed with "normal" too). Not phase-2 behavior.
 */
const POSTBACK_SUBMIT_DELAY_MS = 250;
const SAVE_ID = "ContentPlaceHolder1_wizardPageFooter_wizardPageNavigator_validateButton";
const TEST_TIMEOUT_MS = 60000;

interface DocInfo { postbacks: number }
interface Fixture {
  section: SectionName;
  /** ASP.NET AutoPostBack markup from the start: onchange="javascript:setTimeout('__doPostBack(...)', 0)". */
  posting?: string[];
  /** Rendered with display:none. */
  hidden?: string[];
  /** Inserted LATE_INSERT_MS after DOMContentLoaded. */
  late?: string[];
  /** Minimal jQuery shim ($(x).on, jQuery._data, isReady, active). */
  jquery?: boolean;
  /** Extra page script, per rendered document. */
  script?: (doc: DocInfo) => string;
}
interface Post { at: number; body: URLSearchParams }

const ids = (section: SectionName) => Object.fromEntries(Object.entries(steps[section].fields).map(([key, f]) => [key, f.id]));
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const JQUERY_SHIM = String.raw`(function () {
  const registry = new WeakMap();
  const $ = (target) => {
    const el = typeof target === 'string' ? document.querySelector(target) : target;
    return { on(type, fn) {
      el.addEventListener(type, fn);
      if (el !== window) { const events = registry.get(el) || {}; (events[type] ||= []).push({ handler: fn }); registry.set(el, events); }
      return this; } };
  };
  $._data = (el) => registry.get(el);
  $.active = 0; $.isReady = false;
  document.addEventListener('DOMContentLoaded', () => { $.isReady = true; });
  window.jQuery = window.$ = $;
})();`;

let server: Server;
let origin: string;
let fixture: Fixture;
let data: ApplicationData;
let stored: Record<string, string>;
let posts: Post[];
let imagesDone: number[];

function render(doc: DocInfo): string {
  const entries = planSection(fixture.section, data);
  const control = (id: string) => {
    const entry = entries.find((e) => e.id === id)!;
    const field = Object.values(steps[fixture.section].fields).find((f) => f.id === id)!;
    const value = stored[id] ?? "";
    const style = fixture.hidden?.includes(id) ? ' style="display:none"' : "";
    const posting = fixture.posting?.includes(id) ? ` onchange="javascript:setTimeout('__doPostBack(\\'${id}\\',\\'\\')', 0)"` : "";
    const attrs = `id="${id}" name="${id}"${style}${posting}`;
    if (field.kind === "select") {
      const options = [...new Set(["", ...(field.options ?? []), entry.expected])];
      return `<select ${attrs}>${options.map((o) => `<option value="${esc(o)}"${o === value ? " selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
    }
    if (field.kind === "textarea") return `<textarea ${attrs}>${esc(value)}</textarea>`;
    return `<input ${attrs} value="${esc(value)}">`;
  };
  const body = entries.map((e) => (fixture.late?.includes(e.id) ? `<template class="late">${control(e.id)}</template>` : control(e.id))).join("\n");
  return `<!doctype html><html><head><title>fixture</title></head><body>
<form method="post" id="form1">
<input type="hidden" name="__EVENTTARGET" id="__EVENTTARGET" value="">
<input type="hidden" name="echo" id="echo" value="pre-load">
${body}
<input type="submit" id="${SAVE_ID}" name="save" value="SAVE">
</form>
<img src="/slow.gif?${Date.now()}" alt="">
<script>
${fixture.jquery ? JQUERY_SHIM : ""}
window.__doPostBack = (target) => setTimeout(() => {
  document.getElementById('__EVENTTARGET').value = target; document.getElementById('form1').submit(); }, ${POSTBACK_SUBMIT_DELAY_MS});
// readyState at every input event, kept across documents of this tab (no values).
document.addEventListener('input', (e) => {
  const fills = JSON.parse(sessionStorage.getItem('fills') || '[]');
  fills.push(e.target.id + '|' + document.readyState);
  sessionStorage.setItem('fills', JSON.stringify(fills));
}, true);
document.addEventListener('DOMContentLoaded', () => setTimeout(() => {
  for (const t of document.querySelectorAll('template.late')) t.replaceWith(t.content);
}, ${LATE_INSERT_MS}));
${fixture.script?.(doc) ?? ""}
</script></body></html>`;
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/slow.gif") {
      setTimeout(() => {
        imagesDone.push(Date.now());
        res.writeHead(200, { "content-type": "image/gif", "cache-control": "no-store" });
        res.end(Buffer.from("R0lGODlhAQABAAAAACw=", "base64"));
      }, SLOW_IMAGE_MS);
      return;
    }
    const send = (doc: DocInfo) => { res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" }); res.end(render(doc)); };
    if (req.method !== "POST") return send({ postbacks: posts.filter((p) => p.body.get("__EVENTTARGET")).length });
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const body = new URLSearchParams(raw);
      posts.push({ at: Date.now(), body });
      for (const [key, value] of body) if (key.startsWith("ContentPlaceHolder1_") && key !== SAVE_ID) stored[key] = value;
      setTimeout(() => send({ postbacks: posts.filter((p) => p.body.get("__EVENTTARGET")).length }), POST_LATENCY_MS);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, TEST_TIMEOUT_MS);
afterAll(() => { server?.close(); });

const sample = () => applicationDataSchema.parse(JSON.parse(readFileSync(new URL("../fixtures/sample.json", import.meta.url), "utf8")));
let logs: string[];
let events: { state: string; at: number }[];
beforeEach(() => {
  data = sample();
  stored = {};
  posts = [];
  imagesDone = [];
  logs = [];
  events = [];
  vi.spyOn(console, "log").mockImplementation((...line: unknown[]) => { logs.push(line.join(" ")); });
});
afterEach(() => { vi.restoreAllMocks(); });

async function build(strategy: "eager" | "normal"): Promise<WebDriver> {
  const options = new Options().addArguments("--headless=new", "--window-size=1280,900");
  options.setPageLoadStrategy(strategy);
  return new Builder().forBrowser("chrome").setChromeOptions(options as never).build();
}
let eager: WebDriver;
beforeAll(async () => { eager = await build("eager"); }, TEST_TIMEOUT_MS);
afterAll(async () => { await eager?.quit(); });

/** Opens the section page (returns at DCL under eager), then runs one section save. */
async function runSection(driver: WebDriver, next: Fixture, mode = { fast: true, early: true }) {
  fixture = next;
  const url = `${origin}/WorkingHoliday/Wizard/${steps[next.section].page}?ApplicationId=fx`;
  await driver.get(url);
  await driver.executeScript("sessionStorage.removeItem('fills')");
  const report = await withHooksForTest(
    { event: async (e) => { if ("state" in e) events.push({ state: e.state, at: Date.now() }); }, checkpoint: async () => {} },
    () => saveStepForTest(driver, next.section, data, mode));
  const fills = await driver.executeScript<string[]>("return JSON.parse(sessionStorage.getItem('fills') || '[]')");
  return { report, fills, timing: logs.find((l) => l.includes("timing fill")) ?? "" };
}
const expected = (section: SectionName) => Object.fromEntries(planSection(section, data).map((e) => [e.id, e.expected]));
const saves = () => posts.filter((p) => p.body.has("save"));
const postbacks = () => posts.filter((p) => p.body.get("__EVENTTARGET"));
const earlyCount = (timing: string) => Number(/early (\d+)/.exec(timing)?.[1] ?? NaN);
const noValues = (timing: string) => {
  for (const value of Object.values(expected("identification")).concat(Object.values(expected("personal"))))
    if (/[A-Za-z]/.test(value)) expect(timing).not.toContain(value);
};

test("case 22: the early pass fills while the page is still loading; SAVE posts only after load", async () => {
  const { report, fills, timing } = await runSection(eager, { section: "identification" });
  const want = expected("identification");
  expect(report.persisted).toEqual(Object.keys(ids("identification")));
  expect(fills.some((f) => f.endsWith("|interactive"))).toBe(true);
  expect(earlyCount(timing)).toBeGreaterThan(0);
  expect(saves()).toHaveLength(1);
  expect(saves()[0].at).toBeGreaterThan(imagesDone[0]);
  for (const [id, value] of Object.entries(want)) expect(saves()[0].body.get(id), id).toBe(value);
  noValues(timing);
}, TEST_TIMEOUT_MS);

test("case 23 (fixture A): a title handler bound in window.onload still reveals otherTitle; both reach the server", async () => {
  const f = ids("personal");
  const { fills } = await runSection(eager, {
    section: "personal",
    hidden: [f.otherTitle],
    script: () => `window.onload = () => {
      const title = document.getElementById('${f.title}');
      title.addEventListener('change', () => { document.getElementById('${f.otherTitle}').style.display = title.value === '6' ? '' : 'none'; });
    };`,
  });
  expect(fills).toContain(`${f.title}|interactive`); // early write before the handler existed
  expect(fills).toContain(`${f.title}|complete`); // restored silently and re-written on the settled DOM
  expect(saves()).toHaveLength(1);
  expect(saves()[0].body.get(f.title)).toBe("6");
  expect(saves()[0].body.get(f.otherTitle)).toBe(data.personal.otherTitle);
}, TEST_TIMEOUT_MS);

test("case 24 (fixture B): an AutoPostBack bound by $(window).on('load') posts via the standard entry after load", async () => {
  const f = ids("identification");
  const { timing } = await runSection(eager, {
    section: "identification",
    jquery: true,
    script: () => `$(window).on('load', () => $('#${f.identificationType}').on('change', () => setTimeout(() => __doPostBack('${f.identificationType}', ''), 0)));`,
  });
  expect(postbacks()).toHaveLength(1);
  const postback = postbacks()[0];
  expect(postback.body.get("__EVENTTARGET")).toBe(f.identificationType);
  expect(postback.at).toBeGreaterThan(imagesDone[0]);
  const possible = events.filter((e) => e.state === "possible");
  expect(possible[0].at).toBeLessThanOrEqual(postback.at);
  expect(timing).toMatch(/restarts 1\)/);
  const want = expected("identification");
  for (const [id, value] of Object.entries(want)) expect(saves()[0].body.get(id), id).toBe(value);
}, TEST_TIMEOUT_MS);

test("cases 25/26 (fixtures C, D): the second postback document's onload stale value and reset are re-decided", async () => {
  const f = ids("character");
  expect(expected("character")[f.details]).toBe("");
  const { report, timing } = await runSection(eager, {
    section: "character",
    posting: [f.convicted, f.excluded],
    script: (doc) => (doc.postbacks === 2 ? `window.onload = () => {
      document.getElementById('${f.details}').value = 'stale';
      document.getElementById('${f.charged}').value = '';
    };` : ""),
  });
  expect(postbacks().map((p) => p.body.get("__EVENTTARGET"))).toEqual([f.convicted, f.excluded]);
  expect(timing).toMatch(/restarts 2\)/);
  expect(saves()).toHaveLength(1);
  expect(saves()[0].body.get(f.details)).toBe(""); // C: cleared after load
  expect(saves()[0].body.get(f.charged)).toBe(data.character.charged); // D: rewritten, no readback mismatch
  expect(report.persisted).toContain("charged");
}, TEST_TIMEOUT_MS);

test("case 27 (finding 3): no POST before load; the AutoPostBack echoes the post-load hidden value", async () => {
  const f = ids("identification");
  await runSection(eager, {
    section: "identification",
    posting: [f.identificationType],
    script: () => `window.addEventListener('load', () => { document.getElementById('echo').value = 'post-load'; });`,
  });
  expect(posts.length).toBeGreaterThan(0);
  expect(posts[0].at).toBeGreaterThan(imagesDone[0]);
  expect(postbacks()[0].body.get("echo")).toBe("post-load");
}, TEST_TIMEOUT_MS);

test("case 28: a field inserted after DOMContentLoaded is filled as it appears, before load", async () => {
  const f = ids("identification");
  const { fills } = await runSection(eager, { section: "identification", late: [f.identificationIssued] });
  expect(fills).toContain(`${f.identificationIssued}|interactive`);
  expect(saves()[0].body.get(f.identificationIssued)).toBe(data.identification.identificationIssued);
}, TEST_TIMEOUT_MS);

test("case 29: NZWH_EARLY_FILL=0 (normal session, { fast: true, early: false }) runs no early scripts and fills after load", async () => {
  const normal = await build("normal");
  try {
    const scripts: string[] = [];
    const execute = normal.executeScript.bind(normal);
    vi.spyOn(normal, "executeScript").mockImplementation(((script: string, ...args: unknown[]) => {
      scripts.push(String(script));
      return execute(script, ...args);
    }) as never);
    const { fills, timing } = await runSection(normal, { section: "identification" }, { fast: true, early: false });
    for (const tag of ["nzwh:dom-ready", "nzwh:wait-field", "nzwh:settle", "nzwh:doc-complete"])
      expect(scripts.some((s) => s.includes(tag)), tag).toBe(false);
    expect(fills.length).toBeGreaterThan(0);
    expect(fills.every((entry) => entry.endsWith("|complete"))).toBe(true);
    expect(timing).not.toMatch(/early|settle/);
    expect(saves()).toHaveLength(1);
  } finally {
    await normal.quit();
  }
}, TEST_TIMEOUT_MS);
