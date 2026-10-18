// Offline Selenium proof: local form + fake provider; no accounts or paid tasks.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Builder } from "selenium-webdriver";
import { Options } from "selenium-webdriver/chrome";
import { captchaGuard, setFixtureOriginForTest, withHooksForTest } from "../workflow/run";
import { StopRequested } from "../lib/execution-controller";
import type { ExecutionEvent } from "../lib/execution-state";

let submits = 0;
const html = `<!doctype html><meta charset="utf-8"><title>Offline CAPTCHA fixture</title>
  <h1>Please complete the CAPTCHA</h1><form method="post" action="/rs-captcha">
  <iframe title="Offline v2 widget" src="https://www.google.com/recaptcha/api2/anchor?k=fixture-public-key-123456789&size=normal" width="304" height="78"></iframe>
  <textarea name="g-recaptcha-response" hidden></textarea><input type="submit" value="Submit"></form>`;
const server = createServer(async (req, res) => {
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-src 'none'"); // no external iframe requests
  if (req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    assert.ok(["fixture-provider-token", "fixture-human-token"].includes(new URLSearchParams(body).get("g-recaptcha-response") ?? ""));
    submits++;
    res.writeHead(302, { location: "/WorkingHoliday/Wizard/Personal1.aspx" });
    return void res.end();
  }
  res.setHeader("Content-Type", "text/html");
  res.end(req.url?.startsWith("/rs-captcha") ? html : "<!doctype html><title>Destination fixture</title><h1>Ready</h1>");
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
setFixtureOriginForTest(origin);
const originalFetch = globalThis.fetch;
let requests = 0;
let mode: "success" | "failure" | "pending" = "success";
let inFlightSignal: AbortSignal | null = null;
globalThis.fetch = async (url, options) => {
  assert.ok(String(url).startsWith("https://api.capsolver.com/"), "only the mocked provider endpoint may be fetched");
  requests++;
  const payload = JSON.parse(options?.body as string);
  if (String(url).endsWith("createTask")) {
    assert.deepEqual(payload.task, { type: "ReCaptchaV2TaskProxyLess", websiteURL: origin + "/rs-captcha", websiteKey: "fixture-public-key-123456789" });
    if (mode === "failure") return Response.json({ errorId: 1, errorCode: "ERROR_ZERO_BALANCE" });
    if (mode === "pending") return new Promise((_resolve, reject) => {
      inFlightSignal = options!.signal!;
      inFlightSignal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    });
    return Response.json({ errorId: 0, taskId: "fixture-task" });
  }
  return Response.json({ errorId: 0, status: "ready", solution: { gRecaptchaResponse: "fixture-provider-token" } });
};
const chromeOptions = new Options();
chromeOptions.addArguments("--headless=new", "--window-size=1280,900");
const driver = await new Builder().forBrowser("chrome").setChromeOptions(chromeOptions).build();
const events: ExecutionEvent[] = [];
function run(captchaMode: "manual" | "capsolver", signal?: AbortSignal) {
  return withHooksForTest({ event: async e => { events.push(e); }, checkpoint: async () => {} }, () => captchaGuard(driver), { captchaMode, signal, loadCapSolverKey: async () => "fixture-key" });
}
async function human() {
  await driver.executeScript("document.querySelector('textarea').value = 'fixture-human-token'");
}
try {
  await driver.get(origin + "/rs-captcha?redirect=private-application-id");
  const manual = run("manual");
  await driver.wait(async () => events.some(e => e.type === "captcha" && e.waiting), 2000);
  assert.equal(submits, 0);
  assert.equal(requests, 0);
  await human();
  await manual;
  assert.equal(submits, 1);
  console.log("PASS manual mode: zero provider requests; resumes after human completion");

  await driver.get(origin + "/rs-captcha?redirect=private-application-id");
  await run("capsolver");
  assert.equal(requests, 2);
  assert.equal(submits, 2);
  assert.match(await driver.getCurrentUrl(), /Personal1\.aspx$/);
  console.log("PASS automatic mode: minimal create/poll payload, one CAPTCHA submit, destination loaded");

  mode = "failure";
  events.length = 0;
  await driver.get(origin + "/rs-captcha");
  const failure = run("capsolver");
  await driver.wait(async () => events.some(e => e.type === "captcha" && e.message?.includes("không hoàn tất")), 2000);
  assert.equal(submits, 2);
  await human();
  await failure;
  assert.equal(requests, 3);
  assert.equal(submits, 3);
  console.log("PASS provider failure: no retry; human fallback completes on the same workflow");

  mode = "pending";
  const abort = new AbortController();
  await driver.get(origin + "/rs-captcha");
  const cancelled = run("capsolver", abort.signal);
  const stopped = assert.rejects(cancelled, StopRequested);
  await driver.wait(async () => Boolean(inFlightSignal), 2000);
  abort.abort();
  await stopped;
  assert.equal((inFlightSignal as AbortSignal | null)?.aborted, true);
  assert.equal(submits, 3);
  console.log("PASS cancellation: provider aborted; no token applied or form submitted");
} finally {
  globalThis.fetch = originalFetch;
  await driver.quit();
  server.close();
}
