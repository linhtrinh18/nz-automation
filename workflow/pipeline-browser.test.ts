// Real headless Chrome against a local 127.0.0.1 wizard fixture (never the real site): tab pipeline with slow
// SAVE and reload endpoints, one POST per section, a load-time validation failure and a busy reload.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { mkdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { Builder } from "selenium-webdriver";
import { Options } from "selenium-webdriver/chrome";
import type { WebDriver } from "selenium-webdriver";
const hoisted = vi.hoisted(() => {
  const reportDirectory = `${process.env.TMPDIR ?? "/tmp"}/nzwh-pipeline-browser-reports`;
  process.env.NZWH_REPORT_DIR = reportDirectory;
  return { choose: vi.fn(), reportDirectory };
});
vi.mock("../browser/chooseBrowser", () => ({ chooseBrowser: hoisted.choose }));
import { runWorkingHoliday, setFixtureOriginForTest } from "./run";
import { steps } from "./fields";
import { applicationDataSchema, type ApplicationData, type SectionName } from "./application-data";
import { planSection } from "./fast-fill";
import type { ExecutionEvent } from "../lib/execution-state";
const SAVE_ID = "ContentPlaceHolder1_wizardPageFooter_wizardPageNavigator_validateButton";
const SAMPLE = fileURLToPath(new URL("../fixtures/sample.json", import.meta.url));
const SECTIONS: SectionName[] = ["identification", "health", "character"];
const TEST_TIMEOUT_MS = 120000;
const SAVE_DELAY_MS = 500;
const RELOAD_DELAY_MS = 900;
const LOAD_DELAY_MS = 3000;
/** The live site's first GET of a section took ~1 s in the audit; model part of it. */
const GET_DELAY_MS = 600;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
interface Behavior { lateErrorOn?: SectionName; busyReloadOn?: SectionName }
let server: Server;
let origin: string;
let behavior: Behavior;
let data: ApplicationData;
let stored: Record<string, Record<string, string>>;
let requests: { method: string; section: SectionName; at: number; done?: number }[];
let events: ExecutionEvent[];
let logs: string[];
let driver: WebDriver;
const sectionOfPath = (path: string) => SECTIONS.find((name) => path.endsWith(`/${steps[name].page}`));
function render(section: SectionName, options: { lateError?: boolean } = {}): string {
  const entries = planSection(section, data);
  const control = (id: string) => {
    const field = Object.values(steps[section].fields).find((f) => f.id === id)!;
    const entry = entries.find((e) => e.id === id)!;
    const value = stored[section]?.[id] ?? "";
    const attrs = `id="${id}" name="${id}"`;
    if (field.kind === "select") {
      const choices = [...new Set(["", ...(field.options ?? []), entry.expected])];
      return `<select ${attrs}>${choices.map((o) => `<option value="${esc(o)}"${o === value ? " selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
    }
    if (field.kind === "textarea") return `<textarea ${attrs}>${esc(value)}</textarea>`;
    return `<input ${attrs} value="${esc(value)}">`;
  };
  const late = options.lateError
    ? `<img src="/slow.gif?${Date.now()}" alt=""><script>window.addEventListener('load', () => { const s = document.createElement('span'); s.setAttribute('errorlabel', 'mandatory field'); s.style.cssText = 'display:inline-block;width:20px;height:10px'; document.body.appendChild(s); });</script>`
    : "";
  return `<!doctype html><html><head><title>fixture</title></head><body><form method="post" id="form1">
${entries.map((e) => control(e.id)).join("\n")}
<input type="submit" id="${SAVE_ID}" name="save" value="SAVE"></form>${late}</body></html>`;
}
beforeAll(async () => {
  mkdirSync(hoisted.reportDirectory, { recursive: true });
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/slow.gif") {
      setTimeout(() => { res.writeHead(200, { "content-type": "image/gif" }); res.end(Buffer.from("R0lGODlhAQABAAAAACw=", "base64")); }, LOAD_DELAY_MS);
      return;
    }
    const section = sectionOfPath(url.pathname);
    if (!section) { res.writeHead(404); res.end(); return; }
    const entry = { method: req.method ?? "GET", section, at: Date.now() } as (typeof requests)[number];
    requests.push(entry);
    const respond = (html: string, delay: number) => setTimeout(() => {
      entry.done = Date.now();
      res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      res.end(html);
    }, delay);
    if (req.method !== "POST") {
      const reload = requests.filter((r) => r.method === "POST" && r.section === section).length > 0;
      if (reload && behavior.busyReloadOn === section) return respond("<!doctype html><title>Site busy</title><body>Please try again later</body>", 0);
      return respond(render(section), reload ? RELOAD_DELAY_MS : GET_DELAY_MS);
    }
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const body = new URLSearchParams(raw);
      stored[section] ??= {};
      for (const [key, value] of body) if (key.startsWith("ContentPlaceHolder1_") && key !== SAVE_ID) stored[section][key] = value;
      respond(render(section, { lateError: behavior.lateErrorOn === section }), SAVE_DELAY_MS);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  setFixtureOriginForTest(origin);
  const options = new Options().addArguments("--headless=new", "--window-size=1280,900", "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding");
  options.setPageLoadStrategy("eager");
  driver = await new Builder().forBrowser("chrome").setChromeOptions(options as never).build();
}, TEST_TIMEOUT_MS);
afterAll(async () => { await driver?.quit(); server?.close(); });
beforeEach(() => {
  data = applicationDataSchema.parse(JSON.parse(readFileSync(SAMPLE, "utf8")));
  behavior = {};
  stored = {};
  requests = [];
  events = [];
  logs = [];
  for (const level of ["log", "warn", "error"] as const)
    vi.spyOn(console, level).mockImplementation((...line: unknown[]) => { logs.push(line.join(" ")); });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); hoisted.choose.mockReset(); });
const hooks = { event: async (e: ExecutionEvent) => { events.push(e); }, checkpoint: async () => {} };
const posts = (section?: SectionName) => requests.filter((r) => r.method === "POST" && (!section || r.section === section));
async function run(pipeline: "off" | "save" | "verify") {
  vi.stubEnv("NZWH_TAB_PIPELINE", pipeline);
  await driver.get(`${origin}/WorkingHoliday/Wizard/${steps.identification.page}?ApplicationId=fx`);
  hoisted.choose.mockResolvedValue(driver);
  const started = Date.now();
  const result = await runWorkingHoliday({ dataPath: SAMPLE, allowFictionalDraftSave: true, sections: SECTIONS, country: "vietnam", hooks });
  return { result, ms: Date.now() - started };
}
const resultsOf = () => events.filter((e) => e.type === "section-result").map((e) => (e as { status: string; section?: string }));
async function handlesOpen() { return (await driver.getAllWindowHandles()).length; }

test("save mode: one POST per section, tabs overlap, extra tab is closed, and it is faster than off", async () => {
  const off = await run("off");
  expect(posts()).toHaveLength(SECTIONS.length);
  expect(resultsOf().map((r) => r.status)).toEqual(["completed", "completed", "completed"]);
  requests = []; events = []; stored = {};
  const save = await run("save");
  expect(save.result).toMatchObject({ success: true });
  expect(SECTIONS.map((s) => posts(s).length)).toEqual([1, 1, 1]);
  expect(resultsOf().map((r) => r.status)).toEqual(["completed", "completed", "completed"]);
  expect(events.filter((e) => e.type === "persistence").map((e) => (e as { state: string }).state).filter((s) => s === "verified")).toHaveLength(3);
  // The first section runs sequentially; from the second on, N+1's GET is issued before N's SAVE response (prefetch).
  const first = (section: SectionName, method: string) => requests.find((r) => r.section === section && r.method === method)!;
  expect(first("character", "GET").at).toBeLessThan(first("health", "POST").done!);
  expect(await handlesOpen()).toBe(1);
  expect(logs.some((l) => l.includes("timing") && l.includes("drain"))).toBe(true);
  process.stderr.write(`pipeline timing: off ${off.ms}ms, save ${save.ms}ms\n`);
  expect(save.ms).toBeLessThan(off.ms);
}, TEST_TIMEOUT_MS);

test("a validation error that only appears at load time fails N, posts nothing for N+1, and never reports accepted", async () => {
  behavior.lateErrorOn = "health";
  await expect(run("save")).rejects.toThrow(/Stopped in health/);
  expect(posts("health")).toHaveLength(1);
  expect(posts("character")).toHaveLength(0);
  const health = events.filter((e) => e.type === "persistence" && (e as { section?: string }).section === "health").map((e) => (e as { state: string }).state);
  expect(health).not.toContain("accepted");
  expect(resultsOf()).toContainEqual(expect.objectContaining({ status: "failed", section: "health" }));
  expect(await handlesOpen()).toBe(1);
}, TEST_TIMEOUT_MS);

test("a busy reload downgrades to sequential: the next section is posted exactly once, nothing is re-sent", async () => {
  behavior.busyReloadOn = "health";
  await run("save");
  expect(SECTIONS.map((s) => posts(s).length)).toEqual([1, 1, 1]);
  expect(resultsOf()).toContainEqual(expect.objectContaining({ status: "failed", section: "health" }));
  expect(resultsOf().filter((r) => r.status === "completed")).toHaveLength(2); // identification and the restarted character
  expect(logs.some((l) => l.includes("Tab pipeline downgraded to off: busy"))).toBe(true);
  expect(await handlesOpen()).toBe(1);
}, TEST_TIMEOUT_MS);

test("verify mode: N+1 starts after N's load-time re-scan; one POST per section, all verified", async () => {
  await run("verify");
  expect(SECTIONS.map((s) => posts(s).length)).toEqual([1, 1, 1]);
  expect(resultsOf().map((r) => r.status)).toEqual(["completed", "completed", "completed"]);
  expect(await handlesOpen()).toBe(1);
}, TEST_TIMEOUT_MS);
