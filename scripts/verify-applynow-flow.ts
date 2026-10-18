// Fixture end-to-end check: grid -> Japan -> Create.aspx -> APPLY NOW -> rs-captcha (human hand-off) -> Personal1.
// Local 127.0.0.1 server only. Never touches the real site; no CAPTCHA is solved by code.
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { Builder } from "selenium-webdriver";
import { Options } from "selenium-webdriver/chrome";
import type { WebDriver } from "selenium-webdriver";
import { advanceToWizard, setFixtureOriginForTest, withHooksForTest } from "../workflow/run";
import { WorkingHolidayStop } from "../workflow/errors";
import type { ExecutionEvent } from "../lib/execution-state";

const dir = "scripts/fixtures/";
const html = Object.fromEntries(
  await Promise.all(
    ["country-grid", "create-japan", "captcha", "personal1"].map(async (n) => [n, await readFile(`${dir}${n}.html`, "utf8")]),
  ),
);
const shots = ".agents/tasks/country-selector/";
let applyHits = 0, logoutHits = 0, captchaSubmitHits = 0, solved = false;
const server = createServer((req, res) => {
  const url = req.url ?? "";
  if (/logout/i.test(url)) logoutHits++;
  if (req.method === "POST" && /ApplyNow/i.test(url)) {
    applyHits++;
    res.writeHead(302, { location: "/rs-captcha?redirect=%2FWorkingHoliday%2FWizard%2FPersonal1.aspx%3FApplicationId%3D4085216%26IndividualType%3DPrimary" });
    return void res.end();
  }
  if (req.method === "POST" && /rs-captcha/i.test(url)) captchaSubmitHits++;
  if (/^\/rs-captcha/i.test(url) && solved) {
    res.writeHead(302, { location: "/WorkingHoliday/Wizard/Personal1.aspx?ApplicationId=4085216&IndividualType=Primary" });
    return void res.end();
  }
  res.setHeader("content-type", "text/html");
  if (/^\/WorkingHoliday\/?$/i.test(url)) res.end(html["country-grid"]);
  else if (/Create\.aspx/i.test(url)) res.end(html["create-japan"]);
  else if (/^\/rs-captcha/i.test(url)) res.end(html["captcha"]);
  else if (/Personal1\.aspx/i.test(url)) res.end(html["personal1"]);
  else res.end("");
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
setFixtureOriginForTest(base);
const check = (ok: boolean, msg: string) => { if (!ok) throw new Error(`FAIL: ${msg}`); console.log(`ok: ${msg}`); };
const driver: WebDriver = await new Builder().forBrowser("chrome").setChromeOptions(new Options().addArguments("--window-size=1280,800") as never).build();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
function run(events: ExecutionEvent[]) {
  return withHooksForTest({ event: async (e) => void events.push(e), checkpoint: async () => undefined }, () => advanceToWizard(driver, "japan"));
}
try {
  await mkdir(shots, { recursive: true });
  // Main path from the home grid.
  await driver.get(`${base}/WorkingHoliday/`);
  const events: ExecutionEvent[] = [];
  let done = false;
  const main = run(events).then(() => (done = true));
  await wait(4000);
  const url = await driver.getCurrentUrl();
  check(/\/rs-captcha/.test(url), `parked on rs-captcha (${new URL(url).pathname})`);
  check(applyHits === 1, "APPLY NOW clicked exactly once");
  check(events.some((e) => e.type === "captcha" && e.waiting), "waiting-for-human (captcha waiting:true) reported");
  check(!done, "run not finished while CAPTCHA unsolved");
  check(captchaSubmitHits === 0, "no SUBMIT click while response token is empty");
  await writeFile(`${shots}applynow-captcha-waiting-fixture.png`, Buffer.from(await driver.takeScreenshot(), "base64"));
  solved = true; // simulate the human finishing: the fixture now redirects to Personal1.aspx
  await driver.navigate().refresh();
  await main;
  check(/Personal1\.aspx/.test(await driver.getCurrentUrl()), "resumed and reached Personal1.aspx");
  check(events.some((e) => e.type === "captcha" && !e.waiting), "captcha waiting:false reported");
  // Direct landings.
  const landings: [string, boolean][] = [
    ["/WorkingHoliday/Application/Create.aspx?CountryId=109&OffShore=1&STZ=0", false],
    ["/rs-captcha?redirect=x", false],
    ["/WorkingHoliday/Wizard/Personal1.aspx?ApplicationId=4085216", true],
  ];
  for (const [path] of landings) {
    solved = true;
    await driver.get(`${base}${path}`);
    await advanceToWizard(driver, "japan");
    check(/Personal1\.aspx/.test(await driver.getCurrentUrl()), `direct landing ${path.split("?")[0]} reaches wizard`);
  }
  check(logoutHits === 0, "no Logout request on any start/resume");
  // Timeout variant: unsolved CAPTCHA with 1 minute limit is a stop, not a bypass.
  solved = false;
  process.env.NZWH_CAPTCHA_TIMEOUT_MINUTES = "1";
  await driver.get(`${base}/rs-captcha?redirect=x`);
  const t0 = Date.now();
  const outcome = await advanceToWizard(driver, "japan").then(() => "resolved", (e) => e);
  check(outcome instanceof WorkingHolidayStop && Date.now() - t0 >= 55000, "unsolved CAPTCHA ends in WorkingHolidayStop after the configured timeout");
  console.log("PASS");
} finally {
  await driver.quit();
  server.close();
}
