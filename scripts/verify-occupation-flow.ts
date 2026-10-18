// Chrome end-to-end check of occupationSelection against a local slow-postback fixture. Never touches the real site.
import { mkdir, writeFile } from "node:fs/promises";
import { Builder } from "selenium-webdriver";
import { Options } from "selenium-webdriver/chrome";
import type { WebDriver } from "selenium-webdriver";
import { runScenario } from "./fixtures/occupation-scenarios";

const shots = ".agents/tasks/occupation-fix/";
const check = (ok: boolean, msg: string) => { if (!ok) throw new Error(`FAIL: ${msg}`); console.log(`ok: ${msg}`); };
const driver: WebDriver = await new Builder().forBrowser("chrome").setChromeOptions(new Options().addArguments("--window-size=1280,900") as never).build();
try {
  await mkdir(shots, { recursive: true });
  const save = async (file: string, o: Awaited<ReturnType<typeof runScenario>>) =>
    writeFile(`${shots}${file}`, Buffer.from(await o.shot!(), "base64"));

  let o = await runScenario(driver, "slow", { industry: 8000, occupation: 20000 });
  check(!o.error && o.selected.length === 2, `slow postback (8s/20s): both selected in ${Math.round(o.elapsedMs / 1000)}s`);
  check(o.logs.some((l) => /Đang chờ trang phản hồi/.test(l)), "heartbeat log with elapsed time shown");
  await save("slow-postback.png", o);

  o = await runScenario(driver, "fallback", { industry: 1000, occupation: 1000 });
  check(!o.error && o.logs.some((l) => /thử cụm từ khác/.test(l)), "alt query fallback used");
  await save("fallback-query.png", o);

  o = await runScenario(driver, "fullList", { industry: 1000, occupation: 1000 });
  check(!o.error && o.logs.some((l) => /full list/.test(l)), `full list fallback used ${o.error ?? ""}`);
  await o.shot!();

  o = await runScenario(driver, "alreadySelected", { industry: 1000, occupation: 1000 });
  check(!o.error && o.searchPosts === 0, "already-selected: no search POST");
  await save("already-selected.png", o);

  o = await runScenario(driver, "noResults", { industry: 1000, occupation: 1000 });
  check(!!o.error && /Không tìm thấy .* \(0 kết quả/.test(o.error) && o.logs.some((l) => /Không tìm thấy/.test(l)), "no results: Vietnamese failure logged and thrown");
  await save("no-results.png", o);
  console.log("verify:occupation OK");
} finally {
  await driver.quit();
}
