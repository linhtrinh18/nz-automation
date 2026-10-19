import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Builder } from "selenium-webdriver";
import { Options, ServiceBuilder } from "selenium-webdriver/chrome";
import { WorkingHolidayStop } from "../workflow/errors";
import { markWindowSizedAtLaunch } from "./window-size";
import type { WebDriver } from "selenium-webdriver";

const MAC_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PROFILE_IN_USE = "Chrome profile is already in use. Close the Chrome window using that profile or choose a different profile name.";
const USER_AGENT = "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

function chromeBinary(): string | undefined {
  if (process.env.NZWH_CHROME_BINARY) return process.env.NZWH_CHROME_BINARY;
  return process.platform === "darwin" && existsSync(MAC_CHROME) ? MAC_CHROME : undefined;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error("No free port."))));
    });
  });
}

function abortError(): Error {
  const error = new Error("Browser start was aborted.");
  error.name = "AbortError";
  return error;
}

async function waitForDevTools(port: number, child: ChildProcess, timeoutMs = 20000, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw abortError();
    if (child.exitCode !== null || child.signalCode !== null) throw new WorkingHolidayStop(PROFILE_IN_USE);
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) return; } catch { /* not ready yet */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new WorkingHolidayStop(PROFILE_IN_USE);
}

function stopSpawned(child?: ChildProcess): void {
  try { child?.kill(); } catch { /* already gone */ }
}

export type BrowserType = "visible" | "headless" | "profile" | "profile-headless";
/** Node-only browser selection. Selenium Manager resolves a matching driver unless overridden. */
export async function chooseBrowser(type: BrowserType, useDefaultAgent = true, profileName = "working-holiday", attachPort?: number, signal?: AbortSignal, pageLoadStrategy: "normal" | "eager" = "normal"): Promise<WebDriver> {
  if (typeof window !== "undefined") throw new Error("Browser automation requires the local Node server.");
  if (signal?.aborted) throw abortError();
  let spawned: ChildProcess | undefined;
  // Only Chrome that we spawned is ever stopped on abort; an attach-mode Chrome belongs to the user.
  const onAbort = () => stopSpawned(spawned);
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const driver = await startBrowser();
    // Both non-attach paths (spawned Chrome and driver-launched Chrome) pass --window-size.
    if (!attachPort) markWindowSizedAtLaunch(driver);
    return driver;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }

  async function startBrowser(): Promise<WebDriver> {
  const options = new Options();
  if (process.env.NZWH_CHROME_BINARY) options.setChromeBinaryPath(process.env.NZWH_CHROME_BINARY);
  if (attachPort) {
    options.debuggerAddress(`127.0.0.1:${attachPort}`);
  } else {
    if (!/^[a-zA-Z0-9_-]{1,60}$/.test(profileName)) throw new Error("Invalid profile name.");
    const root = join(process.cwd(), "data", "profiles");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const profile = type.startsWith("profile") ? join(root, profileName) : await mkdtemp(join(tmpdir(), "nzwh-"));
    const bin = chromeBinary();
    if (!type.includes("headless") && bin) {
      // Spawn Chrome ourselves so ChromeDriver only attaches; this avoids the "controlled by automated test software" banner.
      const port = await freePort();
      spawned = spawn(bin, [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1", "--no-first-run", "--no-default-browser-check", "--window-size=1440,1000", "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", ...(useDefaultAgent ? [] : [USER_AGENT])], { detached: true, stdio: "ignore" });
      spawned.on("error", () => undefined);
      spawned.unref();
      try { await waitForDevTools(port, spawned, 20000, signal); }
      catch (error) { stopSpawned(spawned); throw error; }
      options.debuggerAddress(`127.0.0.1:${port}`);
    } else {
      options.addArguments(`--user-data-dir=${profile}`, "--window-size=1440,1000", "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding");
      options.detachDriver(true);
      if (type.includes("headless")) options.addArguments("--headless=new", "--window-size=1920,1080");
      if (!useDefaultAgent) options.addArguments(USER_AGENT);
    }
  }
  // "eager" returns from navigation at DOMContentLoaded; callers restore load waits where they matter.
  options.setPageLoadStrategy(pageLoadStrategy);
  const builder = new Builder().forBrowser("chrome").setChromeOptions(options);
  if (process.env.NZWH_CHROMEDRIVER) builder.setChromeService(new ServiceBuilder(process.env.NZWH_CHROMEDRIVER));
  try {
    const building = builder.build();
    if (!signal) return await building;
    let onBuildAbort: () => void = () => undefined;
    const aborted = new Promise<never>((_, reject) => {
      onBuildAbort = () => reject(abortError());
      signal.addEventListener("abort", onBuildAbort, { once: true });
      if (signal.aborted) onBuildAbort();
    });
    try { return await Promise.race([building, aborted]); }
    catch (error) {
      // A build that resolves after the abort must not leave a driver session behind.
      void building.then((late) => late.quit()).catch(() => undefined);
      throw error;
    }
    finally { signal.removeEventListener("abort", onBuildAbort); }
  }
  catch (error) {
    stopSpawned(spawned);
    if (error instanceof Error && error.name === "AbortError") throw error;
    const detail = error instanceof Error ? error.message : "";
    if (/user data directory.*in use|profile.*in use|singleton/i.test(detail)) throw new WorkingHolidayStop(PROFILE_IN_USE);
    if (attachPort) throw new WorkingHolidayStop("Could not attach to Chrome. Start Chrome with a dedicated --user-data-dir and the selected --remote-debugging-port, then check the local port and matching driver.");
    if (/version.*chrome|only supports chrome|session not created/i.test(detail)) throw new WorkingHolidayStop("Chrome session could not start. Close any conflicting profile and check that ChromeDriver matches Chrome; set NZWH_CHROMEDRIVER and NZWH_CHROME_BINARY if needed.");
    throw new WorkingHolidayStop("Chrome could not start. Install Chrome and allow Selenium Manager to obtain a matching driver, or configure NZWH_CHROME_BINARY and NZWH_CHROMEDRIVER. Check executable permissions and profile locks.");
  }
  }
}
