// Fixture check of the country step in local Chrome. Never touches the real site.
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { Builder } from "selenium-webdriver";
import { Options } from "selenium-webdriver/chrome";
import { selectCountry, setFixtureOriginForTest } from "../workflow/run";

const grid = await readFile("scripts/fixtures/country-grid.html", "utf8");
let vietnamOpen = false;
const server = createServer((req, res) => {
  const url = req.url ?? "";
  res.setHeader("content-type", "text/html");
  if (/^\/WorkingHoliday\/?$/i.test(url)) {
    res.end(
      vietnamOpen
        ? grid.replace(/<div class="tile closed">VIETNAM<br>CLOSED<\/div>/, '<a class="tile" href="/WorkingHoliday/Application/Create.aspx?CountryId=999&OffShore=1&STZ=0">VIETNAM<br>OPEN</a>')
        : grid,
    );
  } else if (/Create\.aspx/i.test(url)) res.end("<h1>Create page (fixture)</h1>");
  else res.end("");
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;
setFixtureOriginForTest(`http://127.0.0.1:${port}`);
const opts = new Options().addArguments("--window-size=1280,800");
const driver = await new Builder().forBrowser("chrome").setChromeOptions(opts as never).build();
try {
  await driver.get(`http://127.0.0.1:${port}/WorkingHoliday/`);
  await selectCountry(driver, "japan");
  const u1 = await driver.getCurrentUrl();
  if (!/Create\.aspx\?CountryId=/.test(u1)) throw new Error(`japan: ${u1}`);
  console.log("OUTCOME 1 OPEN japan ->", u1);
  await mkdir(".agents/tasks/country-selector", { recursive: true });
  await writeFile(".agents/tasks/country-selector/fixture-japan-create.png", Buffer.from(await driver.takeScreenshot(), "base64"));
  setTimeout(() => (vietnamOpen = true), 3000);
  await driver.get(`http://127.0.0.1:${port}/WorkingHoliday/`);
  await selectCountry(driver, "vietnam");
  const u2 = await driver.getCurrentUrl();
  if (!/CountryId=999/.test(u2)) throw new Error(`vietnam: ${u2}`);
  console.log("OUTCOME 2 CLOSED then re-polled and OPEN vietnam ->", u2);
  console.log("PASS");
} finally {
  await driver.quit();
  server.close();
}
