// Real headless Chrome (pageLoadStrategy "eager") against a local 127.0.0.1 wizard fixture whose server
// redirects to /formshelp/access-denied (a script redirect while the page loads, and a 302 after a POST).
// The detector is host-agnostic, so the local path stands in for www.immigration.govt.nz.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { Builder } from "selenium-webdriver";
import { Options } from "selenium-webdriver/chrome";
import type { WebDriver } from "selenium-webdriver";

const hoisted = vi.hoisted(() => {
  // run.ts reads NZWH_REPORT_DIR at import time; keep the coverage reports out of the source tree.
  const reportDirectory = `${process.env.TMPDIR ?? "/tmp"}/nzwh-access-denied-browser-reports`;
  process.env.NZWH_REPORT_DIR = reportDirectory;
  return { choose: vi.fn(), reportDirectory };
});
vi.mock("../browser/chooseBrowser", () => ({ chooseBrowser: hoisted.choose }));
import { runWorkingHoliday, saveStepForTest, setFixtureOriginForTest, withHooksForTest } from "./run";
import { steps } from "./fields";
import { applicationDataSchema, type ApplicationData } from "./application-data";
import { planSection } from "./fast-fill";
import { AccessDeniedError } from "./site-busy";
import type { ExecutionEvent } from "../lib/execution-state";
import { mkdirSync } from "node:fs";

/** The first document's DOMContentLoaded→load gap, so the redirect lands while the page still loads. */
const SLOW_IMAGE_MS = 4000;
/** The first document redirects this long after DOMContentLoaded (after the run has started). */
const REDIRECT_AFTER_MS = 1500;
const SAVE_ID = "ContentPlaceHolder1_wizardPageFooter_wizardPageNavigator_validateButton";
const TEST_TIMEOUT_MS = 90000;
const SECTION = "identification";
const PATH = `/WorkingHoliday/Wizard/${steps[SECTION].page}`;
const SAMPLE = fileURLToPath(new URL("../fixtures/sample.json", import.meta.url));

type Behavior = {
  /** The first document of the section redirects itself to the denied page. */
  redirectFirstDocument: boolean;
  /** The first POST is stored, but its response is a 302 to the denied page. */
  redirectAfterFirstPost: boolean;
};
let server: Server;
let origin: string;
let behavior: Behavior;
let data: ApplicationData;
let stored: Record<string, string>;
let posts: URLSearchParams[];
let documents: number;
let deniedHits: number;
let logs: string[];
let events: ExecutionEvent[];

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
function render(first: boolean): string {
  const entries = planSection(SECTION, data);
  const control = (id: string) => {
    const entry = entries.find((e) => e.id === id)!;
    const field = Object.values(steps[SECTION].fields).find((f) => f.id === id)!;
    const value = stored[id] ?? "";
    const attrs = `id="${id}" name="${id}"`;
    if (field.kind === "select") {
      const options = [...new Set(["", ...(field.options ?? []), entry.expected])];
      return `<select ${attrs}>${options.map((o) => `<option value="${esc(o)}"${o === value ? " selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
    }
    if (field.kind === "textarea") return `<textarea ${attrs}>${esc(value)}</textarea>`;
    return `<input ${attrs} value="${esc(value)}">`;
  };
  const redirect = first && behavior.redirectFirstDocument
    ? `document.addEventListener('DOMContentLoaded', () => setTimeout(() => location.replace('/formshelp/access-denied'), ${REDIRECT_AFTER_MS}));`
    : "";
  return `<!doctype html><html><head><title>fixture</title></head><body>
<form method="post" id="form1">
${entries.map((e) => control(e.id)).join("\n")}
<input type="submit" id="${SAVE_ID}" name="save" value="SAVE">
</form>
${first ? `<img src="/slow.gif?${Date.now()}" alt="">` : ""}
<script>${redirect}</script></body></html>`;
}
beforeAll(async () => {
  mkdirSync(hoisted.reportDirectory, { recursive: true });
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/slow.gif") {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "image/gif", "cache-control": "no-store" });
        res.end(Buffer.from("R0lGODlhAQABAAAAACw=", "base64"));
      }, SLOW_IMAGE_MS);
      return;
    }
    if (url.pathname === "/formshelp/access-denied") {
      deniedHits++;
      res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      res.end("<!doctype html><title>Access denied</title><body>Sorry, but you've been denied access to this page.</body>");
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      res.end(render(++documents === 1));
      return;
    }
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const body = new URLSearchParams(raw);
      posts.push(body);
      for (const [key, value] of body) if (key.startsWith("ContentPlaceHolder1_") && key !== SAVE_ID) stored[key] = value;
      if (behavior.redirectAfterFirstPost && posts.length === 1) {
        res.writeHead(302, { location: "/formshelp/access-denied", "cache-control": "no-store" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      res.end(render(false));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  setFixtureOriginForTest(origin);
}, TEST_TIMEOUT_MS);
afterAll(() => { server?.close(); });

let eager: WebDriver;
beforeAll(async () => {
  const options = new Options().addArguments("--headless=new", "--window-size=1280,900");
  options.setPageLoadStrategy("eager");
  eager = await new Builder().forBrowser("chrome").setChromeOptions(options as never).build();
}, TEST_TIMEOUT_MS);
afterAll(async () => { await eager?.quit(); });

beforeEach(() => {
  data = applicationDataSchema.parse(JSON.parse(readFileSync(SAMPLE, "utf8")));
  behavior = { redirectFirstDocument: false, redirectAfterFirstPost: false };
  stored = {};
  posts = [];
  documents = 0;
  deniedHits = 0;
  logs = [];
  events = [];
  for (const level of ["log", "warn", "error"] as const)
    vi.spyOn(console, level).mockImplementation((...line: unknown[]) => { logs.push(line.join(" ")); });
});
afterEach(() => { vi.restoreAllMocks(); hoisted.choose.mockReset(); });

const sectionUrl = () => `${origin}${PATH}?ApplicationId=fx&token=TOKEN456`;
const persistence = () => events.filter((e) => e.type === "persistence").map((e) => (e as { state: string }).state);
const saves = () => posts.filter((p) => p.has("save"));
const hooks = { event: async (e: ExecutionEvent) => { events.push(e); }, checkpoint: async () => {} };
const everything = () => `${logs.join("\n")}\n${JSON.stringify(events.filter((e) => e.type !== "application"))}`;
async function fullRun() {
  hoisted.choose.mockResolvedValue(eager);
  return runWorkingHoliday({ dataPath: SAMPLE, allowFictionalDraftSave: true, sections: [SECTION], country: "vietnam", hooks });
}

test("a script redirect while the page is still loading is detected during the early fill, with no possible save", async () => {
  behavior.redirectFirstDocument = true;
  await eager.get(sectionUrl());
  const started = Date.now();
  await expect(withHooksForTest(hooks, () => saveStepForTest(eager, SECTION, data, { fast: true, early: true })))
    .rejects.toBeInstanceOf(AccessDeniedError);
  // Detected at the redirect, long before the 30 s settle/postback waits could expire.
  expect(Date.now() - started).toBeLessThan(15000);
  expect(deniedHits).toBe(1);
  expect(persistence()).toEqual([]);
  expect(posts).toHaveLength(0);
}, TEST_TIMEOUT_MS);

test("denied while loading, then a healthy section: the run reloads, refills and posts exactly one SAVE", async () => {
  behavior.redirectFirstDocument = true;
  await eager.get(sectionUrl());
  const result = await fullRun();
  expect(result).toMatchObject({ success: true, outcome: "filled" });
  expect(saves()).toHaveLength(1);
  for (const entry of planSection(SECTION, data)) expect(saves()[0].get(entry.id), entry.key).toBe(entry.expected);
  expect(deniedHits).toBe(1);
  expect(persistence()).toEqual(["possible", "accepted", "verified"]);
  expect(events.some((e) => e.type === "phase" && e.phase === "recovery")).toBe(true);
  expect(logs.some((l) => l.includes("access-denied redirect detected (path=/formshelp/access-denied)"))).toBe(true);
  expect(everything()).not.toMatch(/TOKEN456|ApplicationId=/);
}, TEST_TIMEOUT_MS);

test("denied after a POST the server received: the saved values are verified read-only and the POST count stays 1", async () => {
  behavior.redirectAfterFirstPost = true;
  await eager.get(sectionUrl());
  const result = await fullRun();
  expect(result).toMatchObject({ success: true, outcome: "filled" });
  expect(posts).toHaveLength(1);
  expect(deniedHits).toBe(1);
  expect(persistence()).toEqual(["possible", "verified"]);
  expect(events.filter((e) => e.type === "section-result")).toEqual([expect.objectContaining({ status: "completed" })]);
  expect(everything()).not.toMatch(/TOKEN456|ApplicationId=/);
  for (const entry of planSection(SECTION, data)) if (/[A-Za-z]{8,}/.test(entry.expected)) expect(everything()).not.toContain(entry.expected);
}, TEST_TIMEOUT_MS);
