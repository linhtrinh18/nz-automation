import { AsyncLocalStorage } from "node:async_hooks";
import { StopRequested } from "../lib/execution-controller";
import type { ExecutionHooks, ExecutionEvent } from "../lib/execution-state";
import type { RunInput } from "../lib/run-config";
import { automatedSection } from "./section-policy";
import { requestedSections } from "../lib/run-plan";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { By, Key, until, error as webdriverError } from "selenium-webdriver";
import { z } from "zod";

import { findCountry, matchTile, type CountryTile } from "../lib/countries";
import { WorkingHolidayStop, SavedValueVerificationError, SectionPostbackTimeoutError } from "./errors";
import { scenarioData, validateData } from "./data-validation";
export { scenarioData, validateData } from "./data-validation";
export { WorkingHolidayStop } from "./errors";
import { chooseBrowser } from "../browser/chooseBrowser";

import { readAuthState } from "./auth-state";
import { applicationDataSchema as dataSchema } from "./application-data";
import { assertSiteAvailable, SiteBusyError } from "./site-busy";
import { occupationLookups, steps } from "./fields";
import type { OccupationLookup } from "./fields";
import { lookupTimeoutMs, pickResult, queryPlan } from "./occupation-match";
import { applicable } from "./conditions";
import { expectedFieldValue, savedValueDiagnostic } from "./saved-values";
import { classifyPage, type PageState } from "./page-state";
import { loadCapSolverKey } from "../server/cloud";
import { solveRecaptchaV2 as solveTwoCaptcha, TwoCaptchaError, formatDuration } from "./two-captcha";
import { loadTwoCaptchaKey } from "../server/cloud";
import { solveRecaptchaV2, CapSolverError } from "./capsolver";
import { readCaptchaChallenge, applyCaptchaToken, clearCaptchaToken, type CaptchaChallenge } from "./capsolver-browser";
import { finishApplication, type ApplicationResult } from "./submission";
import {
  DEPENDENT_FIELD_TIMEOUT_MS, FAST_POLL_MS, MAX_FIELD_RESUMES, PAGE_POLL_MS, POSTBACK_WAIT_MS, READY_WAIT_MS,
  REMOTE_TRIGGER_FN, SECTION_WAIT_MS, SELECT2_RESULTS_WAIT_MS, SUBMISSION_CHANGE_WAIT_MS,
  addFilled, fastFillEnabled, fieldAvailable, fieldPresent, fillSegment, isDisplayedAtomSource, isNavigationError,
  planSection, readFieldValues, readLoadGap, readTimeOrigin, type FillEntry,
} from "./fast-fill";
interface AutomationActionResult extends ApplicationResult {
  driver: WebDriver;
}
import type { WebDriver, WebElement } from "selenium-webdriver";
import type { FieldDefinition } from "./fields";
import type { ApplicationData, SectionName } from "./application-data";
import type { Driver } from "selenium-webdriver/chrome";

let origin = "https://onlineservices.immigration.govt.nz";
let home = `${origin}/WorkingHoliday/`;
/** Test only: point the country step at a local fixture (127.0.0.1 only). */
export function setFixtureOriginForTest(url: string): void {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) throw new Error("fixture origin must be 127.0.0.1");
  origin = url;
  home = `${origin}/WorkingHoliday/`;
}
const login = `${origin}/secure/Login+Working+Holiday.htm`;
const directory = dirname(fileURLToPath(import.meta.url));
const reportDirectory = process.env.NZWH_REPORT_DIR ?? directory;

const execution = new AsyncLocalStorage<{
  hooks?: ExecutionHooks;
  risk: boolean;
  captchaMode?: "manual" | "capsolver" | "2captcha";
  loadCapSolverKey?: (signal?: AbortSignal) => Promise<string | null>;
  signal?: AbortSignal;
  credentials?: { username: string; password: string };
}>();
async function emit(event: ExecutionEvent): Promise<void> {
  const context = execution.getStore();
  if (context && event.type === "persistence" && event.state !== "verified")
    context.risk = true;
  await context?.hooks?.event(event);
}
/** Test only: run fn with execution hooks so emitted events can be observed. */
export function withHooksForTest<T>(hooks: ExecutionHooks, fn: () => Promise<T>, options: { captchaMode?: "manual" | "capsolver" | "2captcha"; signal?: AbortSignal; loadCapSolverKey?: (signal?: AbortSignal) => Promise<string | null> } = {}): Promise<T> {
  return execution.run({ hooks, risk: false, ...options }, fn);
}
async function checkpoint(): Promise<void> {
  await execution.getStore()?.hooks?.checkpoint();
}
class SessionExpiredError extends WorkingHolidayStop {}
const loginRejectedMessage =
  "Login rejected: incorrect credentials or account locked. No automatic retry. Check the assigned NZWH credentials and resolve account access manually before restarting.";

async function requireSession(driver: WebDriver): Promise<void> {
  const state = await readAuthState(driver);
  if (state.rejected) throw new WorkingHolidayStop(loginRejectedMessage);
  if (state.loginForm)
    throw new SessionExpiredError(
      "The form redirected to login; session is no longer authenticated.",
    );
}


export interface WorkingHolidayOptions {
  mode?: RunInput["mode"];
  payerName?: string;
  credentials?: { username: string; password: string };
  dataPath: string;
  expectedApplicationId?: string;
  sections?: SectionName[];
  taskKeys?: string[];
  hooks?: ExecutionHooks;
  signal?: AbortSignal;
  captchaMode?: "manual" | "capsolver" | "2captcha";
  attachPort?: number;
  scenario?: string;
  allowFictionalDraftSave?: boolean;
  browserType?: "visible" | "profile";
  profileName?: string;
  useDefaultAgent?: boolean;
  country?: string;
}

export async function captchaPending(driver: WebDriver): Promise<boolean> {
  return driver.executeScript<boolean>(`
    const challengePage = /captcha/i.test(location.pathname) || /please complete the captcha/i.test(document.body?.innerText || '');
    const widgets = Array.from(document.querySelectorAll('iframe[src*="recaptcha"],iframe[src*="hcaptcha"],input[id*="captcha"],img[src*="captcha"]'))
      .some(e => e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0);
    const completed = Array.from(document.querySelectorAll('textarea[name="g-recaptcha-response"],textarea[name="h-captcha-response"],input[name="h-captcha-response"]')).some(e => e.value.trim().length > 0);
    return challengePage || (widgets && !completed);
  `);
}

/** Only the dedicated CAPTCHA form may be submitted after a response is present. */
export async function captchaSubmitCandidate(driver: WebDriver): Promise<{
  button: WebElement;
  completionId: string;
} | null> {
  return driver.executeScript(`
    const captchaSubmit = true;
    const captchaPath = path => /\\/(?:[a-z0-9_-]*captcha[a-z0-9_-]*)(?:\\.(?:aspx|html?))?$/i.test(path);
    if (location.origin !== arguments[0] || !captchaPath(location.pathname)) return null;
    const visible = e => e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0;
    const responses = Array.from(document.querySelectorAll('textarea[name="g-recaptcha-response"],textarea[name="h-captcha-response"],input[name="h-captcha-response"]'))
      .filter(e => e.value.trim());
    if (!responses.length) return null;
    const buttons = Array.from(document.querySelectorAll('input[type="submit"],button[type="submit"],button:not([type])')).filter(e => {
      if (e.disabled || !visible(e) || !/^submit$/i.test((e.value || e.textContent || '').trim())) return false;
      const form = e.form;
      if (!form || !responses.some(response => response.form === form)) return false;
      const destination = new URL(e.getAttribute('formaction') || form.getAttribute('action') || location.href, location.href);
      return destination.origin === location.origin && captchaPath(destination.pathname);
    });
    if (buttons.length !== 1) return null;
    // One click per completed response; never log the response token.
    let hash = 2166136261;
    for (const character of responses.map(e => e.value).join('|')) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
    return { button: buttons[0], completionId: String(performance.timeOrigin) + ':' + hash };
  `, origin);
}

/** Human CAPTCHA wait limit: NZWH_CAPTCHA_TIMEOUT_MINUTES (1-240, default 30). */
export function captchaTimeoutMinutes(): number {
  const raw = Number(process.env.NZWH_CAPTCHA_TIMEOUT_MINUTES);
  return Number.isInteger(raw) && raw >= 1 && raw <= 240 ? raw : 30;
}
export async function captchaGuard(driver: WebDriver): Promise<boolean> {
  const context = execution.getStore();
  const checkCancelled = () => { if (context?.signal?.aborted) throw new StopRequested(); };
  checkCancelled();
  await assertSiteAvailable(driver);
  if (!(await captchaPending(driver))) return false;
  const notify = async (message: string) => {
    await emit({ type: "captcha", waiting: true, message });
    console.log(`[NZWH] ${message}`);
  };
  const captchaStartedAt = Date.now();
  const since = () => formatDuration(Date.now() - captchaStartedAt);
  const trace = (message: string) => console.log(`[NZWH] CAPTCHA +${since()}: ${message}`);
  const providerName = context?.captchaMode === "2captcha" ? "2Captcha" : "CapSolver";
  const manual = "Giải CAPTCHA trong Chrome; tác vụ tự tiếp tục. Chỉ nút Submit riêng của CAPTCHA được tự bấm khi có phản hồi.";
  if (typeof (driver as Driver).sendDevToolsCommand === "function")
    await activateChrome(driver).catch(() => undefined);
  const submitted = new Set<string>();
  const attempt = new AbortController();
  const signal = context?.signal ? AbortSignal.any([attempt.signal, context.signal]) : attempt.signal;
  let result: { token: string } | { error: unknown } | undefined;
  let pending: Promise<void> | undefined;
  let challenge: CaptchaChallenge | null = null;
  let applied: { token: string; at: number } | undefined;
  let completed = false;
  let solvedAt: number | undefined;
  try {
    if (context?.captchaMode === "capsolver" || context?.captchaMode === "2captcha") {
      challenge = await readCaptchaChallenge(driver, origin);
      checkCancelled();
      trace(`mode=${context.captchaMode}; page=${challenge ? new URL(challenge.websiteURL).pathname : "n/a"}; challenge ${challenge ? "supported (reCAPTCHA v2)" : "unsupported (no usable reCAPTCHA v2 sitekey found)"}.`);
      let key: string | null = null;
      let configurationUnavailable = false;
      if (challenge) {
        await notify(`Đang đọc cấu hình ${providerName}; bạn vẫn có thể giải CAPTCHA trong Chrome.`);
        try {
          key = await (context.captchaMode === "2captcha" ? loadTwoCaptchaKey : context.loadCapSolverKey ?? loadCapSolverKey)(signal);
        } catch {
          checkCancelled();
          configurationUnavailable = true;
        }
        checkCancelled();
        trace(configurationUnavailable ? "key load failed; manual fallback." : `key loaded from app: ${key ? `yes (length ${key.length})` : "no"}.`);
      }
      if (key && challenge) {
        await notify(`Đang thử ${providerName} (reCAPTCHA v2). Bạn vẫn có thể giải trong Chrome; lỗi sẽ chuyển sang thủ công.`);
        const request = { websiteURL: challenge.websiteURL, websiteKey: challenge.websiteKey };
        pending = (context.captchaMode === "2captcha" ? solveTwoCaptcha(request, key, signal, trace) : solveRecaptchaV2(request, key, signal))
          .then(token => { result = { token }; solvedAt = Date.now(); trace(`${providerName} ready; token length ${token.length}.`); }, error => { result = { error }; });
      } else {
        await notify(`${!challenge ? "Chưa hỗ trợ cấu hình CAPTCHA này." : configurationUnavailable ? `Không đọc được cấu hình ${providerName}; nhờ quản trị viên kiểm tra.` : context.captchaMode === "2captcha" ? "Chưa có khóa 2Captcha dùng chung; nhờ quản trị viên cấu hình trong /admin/2captcha." : "Chưa có khóa CapSolver dùng chung; nhờ quản trị viên cấu hình trong /admin."} ${manual}`);
      }
    } else await notify(manual);
    await driver.wait(
      async () => {
        checkCancelled();
        await assertSiteAvailable(driver);
        // A human completion always wins over a pending or late provider result.
        const candidate = await captchaSubmitCandidate(driver);
        if (candidate && !submitted.has(candidate.completionId)) {
          attempt.abort();
          result = undefined;
          submitted.add(candidate.completionId);
          try {
            checkCancelled();
            await candidate.button.click();
            console.log("[NZWH] CAPTCHA-only Submit clicked; waiting for acceptance.");
            trace("CAPTCHA-only Submit clicked; waiting for page acceptance.");
          } catch (error) {
            if (!(error instanceof webdriverError.StaleElementReferenceError) &&
                !(error instanceof webdriverError.NoSuchElementError)) throw error;
          }
          return false;
        }
        if (!(await captchaPending(driver))) {
          attempt.abort();
          return driver.executeScript<boolean>("return document.readyState === 'complete'");
        }
        if (result && !attempt.signal.aborted) {
          const resolved = result;
          result = undefined;
          checkCancelled();
          if ("token" in resolved && challenge) {
            const accepted = await applyCaptchaToken(driver, origin, challenge, resolved.token);
            if (accepted) {
              applied = { token: resolved.token, at: Date.now() };
              trace(`token injected (length ${resolved.token.length}); waiting for page acceptance.`);
              await notify(`Đã nhận phản hồi ${providerName}; đang chờ trang đích xác nhận CAPTCHA.`);
            } else {
              attempt.abort();
              trace("page or challenge changed; token discarded; manual fallback.");
              await notify(`Trang hoặc CAPTCHA đã thay đổi; bỏ phản hồi ${providerName}. ${manual}`);
            }
          } else {
            attempt.abort();
            const reason = "error" in resolved && (resolved.error instanceof CapSolverError || resolved.error instanceof TwoCaptchaError) ? resolved.error.category : "service";
            const hints: Record<string, string> = {
              balance: "Tài khoản hết số dư.",
              auth: "API key không hợp lệ hoặc bị khóa.",
              ip: "IP không được phép hoặc bị chặn.",
              unsolvable: "Không giải được CAPTCHA.",
              busy: "Dịch vụ đang quá tải; thử lại sau ít giây.",
              proxy: "Proxy không dùng được.",
            };
            const twoCaptchaError = "error" in resolved && resolved.error instanceof TwoCaptchaError ? resolved.error : undefined;
            const hint = twoCaptchaError && reason in hints ? ` ${hints[reason]}` : "";
            const code = twoCaptchaError?.providerCode ? `, ${twoCaptchaError.providerCode}` : "";
            trace(`${providerName} failed: category=${reason}${twoCaptchaError?.providerCode ? ` providerCode=${twoCaptchaError.providerCode}` : ""}; manual fallback.`);
            await notify(`${providerName} không hoàn tất (${reason}${code}).${hint} ${manual}`);
          }
        }
        if (applied && challenge && Date.now() - applied.at >= 10000) {
          await clearCaptchaToken(driver, origin, challenge, applied.token);
          applied = undefined;
          trace("page did not accept the token within 10s; token cleared; manual fallback.");
          await notify(`Trang chưa chấp nhận phản hồi ${providerName}; không tự thử lại. Tải lại trang CAPTCHA nếu ô vẫn được chọn. ${manual}`);
        }
        return false;
      },
      captchaTimeoutMinutes() * 60 * 1000,
      "CAPTCHA waiting expired",
      200,
    );
    completed = true;
  } catch (error) {
    if (!(error instanceof webdriverError.TimeoutError)) throw error;
    throw new WorkingHolidayStop(
      `CAPTCHA was not completed within ${captchaTimeoutMinutes()} minutes; stopped without bypassing it.`,
    );
  } finally {
    attempt.abort();
    await pending;
    await emit({ type: "captcha", waiting: false,
      ...(!completed ? { message: "Đã kết thúc chờ CAPTCHA; chưa xác nhận hoàn tất." } : {}),
    });
  }
  if (solvedAt && applied) {
    trace(`summary: solved by ${providerName} in ${formatDuration(solvedAt - captchaStartedAt)}, accepted ${formatDuration(Date.now() - applied.at)} after injection, total ${since()}.`);
  } else trace(`summary: completed manually/without provider token, total ${since()}.`);
  console.log(
    `[NZWH] CAPTCHA completion detected after ${Math.round((Date.now() - captchaStartedAt) / 1000)}s. Resuming automatically.`,
  );
  return true;
}

/** CAPTCHA time must not consume the surrounding page/postback timeout. */
export async function waitWithCaptcha<T>(
  driver: WebDriver,
  condition: () => Promise<T>,
  timeout: number,
  pollMs = PAGE_POLL_MS,
): Promise<NonNullable<T>> {
  let deadline = Date.now() + timeout;
  while (true) {
    const before = Date.now();
    if (await captchaGuard(driver)) deadline += Date.now() - before;
    const value = await condition();
    if (value) return value as NonNullable<T>;
    if (Date.now() >= deadline)
      throw new webdriverError.TimeoutError("Page condition did not become ready.");
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
}

async function ready(driver: WebDriver, pollMs = PAGE_POLL_MS): Promise<void> {
  await waitWithCaptcha(driver,
    async () =>
      (await driver.executeScript<string>("return document.readyState")) ===
      "complete",
    READY_WAIT_MS,
    pollMs,
  );
}

/** Stop/cancel check for the fast-fill loops (captchaGuard keeps its own). */
function checkCancelled(): void {
  if (execution.getStore()?.signal?.aborted) throw new StopRequested();
}

function assertHost(url: string): void {
  if (new URL(url).origin !== origin)
    throw new WorkingHolidayStop("Stopped at an unexpected destination.");
}

async function navigate(driver: WebDriver, url: string): Promise<void> {
  try {
    await driver.get(url);
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
    const actual = new URL(await driver.getCurrentUrl());
    const requested = new URL(url);
    const loaded = await driver.executeScript<boolean>(
      "return document.readyState === 'complete'",
    );
    // Chrome can time out on a background resource after the destination's DOM
    // has completed. Keep normal CAPTCHA/session/page identity checks in callers.
    if (actual.origin !== requested.origin || !loaded) throw error;
    const recognized = await driver.executeScript<boolean>(`
      return !!document.querySelector('input[name="username"],a[id*="editHyperLink"],input[id^="ContentPlaceHolder1_"]')
        || /captcha/i.test(location.pathname) || /site busy|please try again later/i.test(document.title + ' ' + document.body.innerText);
    `);
    if (!recognized) throw error;
    console.log(
      "[NZWH] Navigation timed out on a background resource, but the same-origin application page is fully loaded. Continuing with page verification.",
    );
  }
}

async function authenticate(
  driver: WebDriver,
  acceptCountryGrid = false,
  assigned?: { username: string; password: string },
  loginOnly = false,
): Promise<void> {
  assigned ??= execution.getStore()?.credentials;
  const credentials = z
    .object({
      NZWH_USERNAME: z.string().min(1),
      NZWH_PASSWORD: z.string().min(1),
    })
    .safeParse(assigned ? { NZWH_USERNAME: assigned.username, NZWH_PASSWORD: assigned.password } : process.env);
  if (!credentials.success)
    throw new WorkingHolidayStop(
      "Set NZWH_USERNAME and NZWH_PASSWORD in your environment.",
    );
  console.log(
    "[NZWH] Starting a fresh login before opening any applicant fields.",
  );
  await navigate(driver, home);
  await ready(driver);
  const logoutLinks = await driver.findElements(By.css('a[href*="Logout"]'));
  if (logoutLinks.length) {
    const logoutUrl = await logoutLinks[0].getAttribute("href");
    if (!logoutUrl)
      throw new WorkingHolidayStop("Logout link is missing its destination.");
    assertHost(logoutUrl);
    await navigate(driver, logoutUrl);
    await ready(driver);
    console.log("[NZWH] Previous session signed out.");
  }
  await navigate(driver, login);
  await ready(driver);
  await waitWithCaptcha(driver, async () => {
    return (
      (await driver.findElements(By.css('input[name="username"]'))).length === 1
    );
  }, 20000);
  assertHost(await driver.getCurrentUrl());
  // Never log credential values, Selenium exceptions, page source or login screenshots.
  await driver.wait(
    until.elementLocated(By.css('input[name="username"]')),
    15000,
  );
  await driver.findElement(By.css('input[name="username"]')).clear();
  await driver.findElement(By.css('input[name="password"]')).clear();
  await driver
    .findElement(By.css('input[name="username"]'))
    .sendKeys(credentials.data.NZWH_USERNAME);
  await driver
    .findElement(By.css('input[name="password"]'))
    .sendKeys(credentials.data.NZWH_PASSWORD);
  await captchaGuard(driver);
  await driver
    .findElement(By.css('input[type="submit"][value="LOGIN"]'))
    .click();
  console.log(
    `[NZWH] Login submitted; waiting for authenticated page. url=${await driver.getCurrentUrl().then((u) => new URL(u).pathname).catch(() => "?")}`,
  );
  await waitWithCaptcha(driver, async () => {
    const state = await readAuthState(driver);
    if (state.rejected) throw new WorkingHolidayStop(loginRejectedMessage);
    return state.authenticated;
  }, 30000);
  await ready(driver);
  if (loginOnly) return;
  await navigate(driver, home);
  await ready(driver);
  await waitWithCaptcha(driver,
    async () =>
      (await driver.findElements(By.css('a[id*="editHyperLink"]'))).length > 0 ||
      (acceptCountryGrid && (await countryTiles(driver)).length > 0),
    20000,
  );
  assertHost(await driver.getCurrentUrl());
}
/**
 * Reads the country tile grid. Open tiles are anchors to Create.aspx?CountryId=...;
 * closed tiles are grey and have no such link, so they are found by their text.
 * Selectors were not verified against the live DOM (the site denied the automated
 * browser), so detection is deliberately tolerant.
 */
async function countryTiles(driver: WebDriver): Promise<CountryTile[]> {
  return driver.executeScript<CountryTile[]>(`
    const tiles = [];
    const seen = new Set();
    for (const a of document.querySelectorAll('a[href*="CountryId="]')) {
      const text = (a.innerText || a.textContent || '').replace(/\\s+/g, ' ').replace(/\\s*\\b(OPEN|CLOSED)\\b\\s*$/i, '').trim();
      const cls = (a.className || '') + ' ' + (a.parentElement?.className || '');
      const open = !/disabled|closed/i.test(cls) && a.getAttribute('aria-disabled') !== 'true';
      tiles.push({ text, href: a.href, open });
      seen.add(text.toLowerCase());
    }
    for (const e of document.querySelectorAll('div,span,li,td,p,h2,h3,h4,button')) {
      if (Array.from(e.children).some((c) => !/^(BR|SPAN|SMALL|B|STRONG|I|EM)$/.test(c.tagName)) || e.closest('a[href*="CountryId="]')) continue;
      const text = (e.innerText || e.textContent || '').replace(/\\s+/g, ' ').replace(/\\s*\\b(OPEN|CLOSED)\\b\\s*$/i, '').trim();
      if (text && text.length < 40 && /^[A-Z][A-Z .'-]+$/i.test(text) && !/^(open|closed)$/i.test(text) && !seen.has(text.toLowerCase())) {
        tiles.push({ text, href: null, open: false });
        seen.add(text.toLowerCase());
      }
    }
    return tiles;
  `);
}
const countryPollMs = 15000;
const countryDeadlineMs = 30 * 60 * 1000;
/** Clicks the chosen country's tile and stops on Create.aspx. Never submits anything. */
export async function selectCountry(driver: WebDriver, code: string): Promise<void> {
  const country = findCountry(code);
  if (!country) throw new WorkingHolidayStop("Quốc gia không được hỗ trợ.");
  const deadline = Date.now() + countryDeadlineMs;
  let lastReport = 0;
  while (true) {
    await checkpoint();
    await requireSession(driver);
    if (!new URL(await driver.getCurrentUrl()).pathname.match(/^\/WorkingHoliday\/?$/i)) {
      await navigate(driver, home);
      await ready(driver);
    }
    await waitWithCaptcha(driver, async () => (await countryTiles(driver)).length > 0, 20000);
    const tile = matchTile(await countryTiles(driver), country);
    if (!tile)
      throw new WorkingHolidayStop(
        `Không tìm thấy ô quốc gia ${country.name} trên trang.`,
      );
    if (tile.open && tile.href) {
      assertHost(tile.href);
      console.log(`[NZWH] ${country.name} is OPEN. Clicking its tile.`);
      const links = await driver.findElements(By.css('a[href*="CountryId="]'));
      let target: WebElement | undefined;
      for (const link of links)
        if ((await link.getAttribute("href")) === tile.href) target = link;
      if (!target)
        throw new WorkingHolidayStop("Không tìm thấy liên kết của ô quốc gia.");
      await driver.executeScript(
        "arguments[0].scrollIntoView({block:'center'})",
        target,
      );
      await driver.sleep(300);
      const original = await driver.getWindowHandle();
      await clickWithFallback(driver, target);
      try {
        await waitWithCaptcha(driver, async () => {
          const handles = await driver.getAllWindowHandles();
          for (const h of handles) {
            if (h === original) continue;
            // Popup notice: close it and return to the original screen.
            await driver.switchTo().window(h);
            const popupUrl = await driver.getCurrentUrl();
            if (!/Create\.aspx/i.test(popupUrl)) {
              await driver.close();
              await driver.switchTo().window(original);
            }
          }
          const url = new URL(await driver.getCurrentUrl());
          return (
            /^\/WorkingHoliday\/Application\/Create\.aspx$/i.test(url.pathname) &&
            url.searchParams.has("CountryId")
          );
        }, 30000);
      } catch (error) {
        if (!(error instanceof webdriverError.TimeoutError)) throw error;
        throw new WorkingHolidayStop("Chọn quốc gia không chuyển trang.");
      }
      await ready(driver);
      await requireSession(driver);
      console.log(`[NZWH] Reached ${await driver.getCurrentUrl()}. Stopping before any submission.`);
      return;
    }
    if (Date.now() > deadline)
      throw new WorkingHolidayStop(
        `${country.name} vẫn đóng sau 30 phút; đã dừng.`,
      );
    if (Date.now() - lastReport >= 60000) {
      lastReport = Date.now();
      console.log(`[NZWH] ${country.name} is CLOSED. Re-checking every ${countryPollMs / 1000}s...`);
      await emit({
        type: "phase",
        phase: "login",
        message: `${country.label} đang đóng. Hệ thống sẽ thử lại mỗi ${countryPollMs / 1000} giây.`,
      });
    }
    for (let waited = 0; waited < countryPollMs; waited += 200) {
      await checkpoint();
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    await navigate(driver, home);
    await ready(driver);
  }
}

export function currentState(driver: WebDriver): Promise<PageState> {
  return classifyPage(driver, origin);
}
/** Clicks the single visible APPLY NOW control on Create.aspx. Touches nothing else. */
export async function clickApplyNow(driver: WebDriver): Promise<"clicked" | "unavailable"> {
  const found = await driver.executeScript<
    { unavailable: true } | { element: WebElement } | null
  >(`
    const text = e => (e.value || e.innerText || e.textContent || e.alt || e.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim();
    const visible = e => e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0;
    const matches = Array.from(document.querySelectorAll('input[type="submit"],input[type="button"],input[type="image"],button,a,[role="button"]'))
      .filter(e => /^apply\\s*now$/i.test(text(e)) && visible(e) && !e.disabled);
    if (matches.length) return { element: matches[0] };
    if (/scheme\\s+(is\\s+)?(not\\s+available|closed)/i.test(document.body?.innerText || '')) return { unavailable: true };
    return null;
  `);
  if (found && "unavailable" in found) return "unavailable";
  if (!found) throw new WorkingHolidayStop("Không tìm thấy nút APPLY NOW.");
  await emit({ type: "phase", phase: "login", message: "Đang bấm APPLY NOW." });
  await driver.executeScript("arguments[0].scrollIntoView({block:'center'})", found.element);
  console.log("[NZWH] Clicking APPLY NOW.");
  await clickWithFallback(driver, found.element);
  try {
    await waitWithCaptcha(driver, async () => (await currentState(driver)) !== "create", 30000);
  } catch (error) {
    if (!(error instanceof webdriverError.TimeoutError)) throw error;
    throw new WorkingHolidayStop("Bấm APPLY NOW nhưng trang không chuyển.");
  }
  return "clicked";
}
/**
 * Page state machine: home grid -> Create.aspx (APPLY NOW) -> rs-captcha (human) -> Wizard.
 * Works from any starting page. Never fills data and never submits an application.
 */
export async function advanceToWizard(driver: WebDriver, code: string): Promise<void> {
  const country = findCountry(code);
  if (!country) throw new WorkingHolidayStop("Quốc gia không được hỗ trợ.");
  const deadline = Date.now() + countryDeadlineMs;
  let lastReport = 0;
  let loggedIn = false;
  for (let pass = 0; pass < 200; pass++) {
    await checkpoint();
    const state = await currentState(driver);
    if (state === "wizard") {
      assertHost(await driver.getCurrentUrl());
      return;
    }
    if (state !== "login") await requireSession(driver);
    if (Date.now() > deadline)
      throw new WorkingHolidayStop(`${country.name} chưa sẵn sàng sau 30 phút; đã dừng.`);
    if (state === "home") await selectCountry(driver, code);
    else if (state === "captcha") await captchaGuard(driver);
    else if (state === "create") {
      if ((await clickApplyNow(driver)) === "unavailable") {
        if (Date.now() - lastReport >= 60000) {
          lastReport = Date.now();
          console.log(`[NZWH] ${country.name} scheme is NOT available. Re-checking every ${countryPollMs / 1000}s...`);
          await emit({
            type: "phase",
            phase: "login",
            message: `${country.label} chưa mở nhận hồ sơ. Hệ thống sẽ thử lại mỗi ${countryPollMs / 1000} giây.`,
          });
        }
        for (let waited = 0; waited < countryPollMs; waited += 200) {
          await checkpoint();
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        await navigate(driver, home);
        await ready(driver);
      }
    } else if (state === "login") {
      if (loggedIn) throw new WorkingHolidayStop("Đăng nhập không thành công; đã dừng.");
      loggedIn = true;
      await authenticate(driver, true);
    } else {
      await navigate(driver, home);
      await ready(driver);
    }
  }
  throw new WorkingHolidayStop("Không thể đến trang hồ sơ sau nhiều lần thử.");
}
async function setField(
  driver: WebDriver,
  field: FieldDefinition,
  value: string,
  element: WebElement,
): Promise<void> {
  if (field.kind === "select") {
    // Select2 hides the native select; interact with its visible generated control.
    const widgets = await driver.findElements(
      By.css(`#s2id_${field.id} a.select2-choice`),
    );
    const hasWidget = widgets.length === 1 && (await widgets[0].isDisplayed());
    if (value === "" && (await element.getAttribute("value")) === "") return;
    if (!hasWidget) {
      const options = await element.findElements(By.css("option"));
      for (const option of options) {
        if ((await option.getAttribute("value")) === value) {
          await option.click();
          await element.sendKeys(Key.TAB);
          return;
        }
      }
      throw new WorkingHolidayStop("Option no longer exists.");
    }
    if (value === "") {
      const clear = await driver.findElements(
        By.css(`#s2id_${field.id} .select2-search-choice-close`),
      );
      if (!clear.length || !(await clear[0].isDisplayed()))
        throw new WorkingHolidayStop(
          "This dropdown cannot be cleared through its visible widget.",
        );
      await clear[0].click();
      return;
    }
    const label = await driver.executeScript<string>(
      "const option = Array.from(arguments[0].options).find(o => o.value === arguments[1]); return option ? option.textContent : '';",
      element,
      value,
    );
    if (!label.trim())
      throw new WorkingHolidayStop("Requested dropdown option is unavailable.");
    await widgets[0].click();
    const search = await driver.findElements(
      By.css(".select2-drop-active .select2-input"),
    );
    if (search.length && (await search[0].isDisplayed()))
      await search[0].sendKeys(label.trim());
    await driver.wait(
      async () =>
        (
          await driver.findElements(
            By.css(".select2-drop-active .select2-result-label"),
          )
        ).length > 0,
      SELECT2_RESULTS_WAIT_MS,
    );
    const choices = await driver.findElements(
      By.css(".select2-drop-active .select2-result-label"),
    );
    for (const choice of choices) {
      if ((await choice.getText()).trim() === label.trim()) {
        await choice.click();
        return;
      }
    }
    throw new WorkingHolidayStop("Select2 choice requires manual review.");
  }
  await element.clear();
  if (value) await element.sendKeys(value);
  if (!field.lookup) await element.sendKeys(Key.TAB);
}

async function activateChrome(driver: WebDriver): Promise<void> {
  const chromium = driver as Driver;
  await chromium.sendDevToolsCommand("Page.setWebLifecycleState", {
    state: "active",
  });
  await chromium.sendDevToolsCommand("Page.bringToFront", {});
}

async function waitForSection(driver: WebDriver, name: string, fast = false): Promise<void> {
  const id = Object.values(steps[name].fields)[0].id;
  const pollMs = fast ? FAST_POLL_MS : PAGE_POLL_MS;
  await activateChrome(driver);
  await ready(driver, pollMs);
  await waitWithCaptcha(driver, async () => {
    await requireSession(driver);
    return (await driver.findElements(By.id(id))).length === 1;
  }, SECTION_WAIT_MS, pollMs);
}

async function remoteTrigger(
  driver: WebDriver,
  element: WebElement,
): Promise<boolean> {
  return driver.executeScript<boolean>(
    `return (${REMOTE_TRIGGER_FN})(arguments[0]);`,
    element,
  );
}

interface SavedSection {
  filled: string[];
  persisted: string[];
  lookups: string[];
}

const savedReportSchema = z.record(
  z
    .object({
      filled: z.array(z.string()),
      persisted: z.array(z.string()),
      lookups: z.array(z.string()),
    })
    .strict(),
);

async function previousSavedReport(
  resuming: boolean,
): Promise<Record<string, SavedSection>> {
  if (!resuming) return {};
  try {
    return savedReportSchema.parse(
      JSON.parse(
        await readFile(join(reportDirectory, "coverage-saved.json"), "utf8"),
      ),
    );
  } catch {
    return {};
  }
}

async function locateField(driver: WebDriver, id: string, pollMs = PAGE_POLL_MS): Promise<WebElement> {
  const element = await waitWithCaptcha(driver, async () => {
    await requireSession(driver);
    const elements = await driver.findElements(By.id(id));
    return elements.length === 1 ? elements[0] : undefined;
  }, SECTION_WAIT_MS, pollMs);
  if (!element)
    throw new WorkingHolidayStop(
      "Expected form control did not become available.",
    );
  return element;
}

function isTransientElementError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "StaleElementReferenceError" ||
      error.name === "NoSuchElementError")
  );
}

async function clickWithFallback(
  driver: WebDriver,
  element: WebElement,
): Promise<void> {
  await activateChrome(driver);
  try {
    await element.click();
  } catch {
    await driver.executeScript(
      "arguments[0].scrollIntoView({block:'center'}); arguments[0].click();",
      element,
    );
  }
}

/** Lookup (search/select) clicks wait for the real outcome. They save nothing, so no persistence event. */
async function lookupClickAndWait(
  driver: WebDriver,
  trigger: WebElement,
  condition: () => Promise<boolean>,
  timeoutMessage: string,
  tag: string,
  timeout = lookupTimeoutMs(),
): Promise<void> {
  await clickWithFallback(driver, trigger);
  const started = Date.now();
  let beat = started;
  try {
    await waitWithCaptcha(driver, async () => {
      await requireSession(driver);
      if (Date.now() - beat >= 10000) {
        beat = Date.now();
        console.log(`${tag} Đang chờ trang phản hồi… ${Math.round((beat - started) / 1000)}s/${Math.round(timeout / 1000)}s`);
      }
      try {
        return await condition();
      } catch (error) {
        if (isTransientElementError(error)) return false;
        throw error;
      }
    }, timeout);
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError")
      throw new WorkingHolidayStop(`${timeoutMessage} (${Math.round((Date.now() - started) / 1000)}s)`);
    throw error;
  }
}

async function postbackAndWait(
  driver: WebDriver,
  trigger: WebElement,
  name: string,
  fast = false,
): Promise<void> {
  const stamp = await driver.executeScript<number>(
    "return performance.timeOrigin",
  );
  // Keep the tab active before native SAVE/search/result button activation.
  await activateChrome(driver);
  await emit({ type: "persistence", state: "possible" });
  await trigger.sendKeys(Key.SPACE);
  try {
    await waitForPostback(driver, name, stamp, fast);
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError")
      throw new SectionPostbackTimeoutError(name);
    throw error;
  }
}

async function waitForPostback(
  driver: WebDriver,
  name: string,
  stamp: number,
  fast = false,
): Promise<void> {
  await waitWithCaptcha(driver, async () => {
    await requireSession(driver);
    return driver.executeScript<boolean>(
      `
      const manager = typeof Sys !== 'undefined' && Sys.WebForms && Sys.WebForms.PageRequestManager ? Sys.WebForms.PageRequestManager.getInstance() : null;
      return performance.timeOrigin !== arguments[1] && document.readyState === 'complete' && !(manager && manager.get_isInAsyncPostBack()) && (typeof jQuery === 'undefined' || jQuery.active === 0) && !!document.getElementById(arguments[0]);
    `,
      Object.values(steps[name].fields)[0].id,
      stamp,
    );
  }, POSTBACK_WAIT_MS, fast ? FAST_POLL_MS : PAGE_POLL_MS);
  // The predicate already proved a new complete document with the first field present.
  if (fast) await activateChrome(driver);
  else await waitForSection(driver, name);
}

const selectionMatches = (label: string, expected: string): boolean =>
  label.trim() !== "" && pickResult([label], expected) === 0;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Search result elements (any tag); label comes from `value`, else the text. */
async function readResults(driver: WebDriver, prefix: string): Promise<{ id: string; label: string }[]> {
  return driver.executeScript<{ id: string; label: string }[]>(
    `return Array.from(document.querySelectorAll('[id^="' + arguments[0] + '"]')).map(e => ({ id: e.id, label: String(e.value || e.textContent || '').trim() }));`,
    prefix,
  );
}

/** True once the page is not loading and no async postback is running. */
async function pageIdle(driver: WebDriver): Promise<boolean> {
  return driver.executeScript<boolean>(`
    const manager = typeof Sys !== 'undefined' && Sys.WebForms && Sys.WebForms.PageRequestManager ? Sys.WebForms.PageRequestManager.getInstance() : null;
    return document.readyState === 'complete' && !(manager && manager.get_isInAsyncPostBack());
  `);
}

/** Wait for results to appear, or for the page to settle (idle 3s) with none. Never throws on timeout. */
async function waitForResults(
  driver: WebDriver,
  tag: string,
  prefix: string,
  timeout: number,
): Promise<{ id: string; label: string }[]> {
  const started = Date.now();
  let beat = started;
  let idleSince = 0;
  try {
    return (await waitWithCaptcha<{ id: string; label: string }[] | false>(driver, async () => {
      await requireSession(driver);
      if (Date.now() - beat >= 10000) {
        beat = Date.now();
        console.log(`${tag} Đang chờ trang phản hồi… ${Math.round((beat - started) / 1000)}s/${Math.round(timeout / 1000)}s`);
      }
      try {
        const idle = await pageIdle(driver);
        const results = idle ? await readResults(driver, prefix) : [];
        if (results.length > 0) return results;
        if (!idle) { idleSince = 0; return false; }
        idleSince ||= Date.now();
        return Date.now() - idleSince >= 3000 ? results : false;
      } catch (error) {
        if (isTransientElementError(error)) { idleSince = 0; return false; }
        throw error;
      }
    }, timeout)) as { id: string; label: string }[];
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      console.log(`${tag} Hết ${Math.round(timeout / 1000)}s mà trang vẫn chưa phản hồi; xem như 0 kết quả.`);
      return [];
    }
    throw error;
  }
}

async function typeQuery(driver: WebDriver, lookup: OccupationLookup, text: string): Promise<void> {
  const field = steps.occupation.fields[lookup.queryKey];
  const query = await locateField(driver, field.id);
  await setField(driver, field, text, query);
  const typed = await driver.executeScript<string>("return arguments[0].value", query);
  if (typed !== text)
    throw new WorkingHolidayStop(`Search query readback failed: ${lookup.queryKey}.`);
}

/** Type + click search (retry with backoff) until results appear. Returns the results seen. */
async function searchWithRetry(
  driver: WebDriver,
  lookup: OccupationLookup,
  tag: string,
  text: string,
  timeout: number,
): Promise<{ id: string; label: string }[]> {
  const backoff = [2000, 5000];
  const started = Date.now();
  for (let attempt = 0; ; attempt++) {
    await typeQuery(driver, lookup, text);
    console.log(`${tag} Tìm "${text}" (lần ${attempt + 1}/${backoff.length + 1}), chờ tối đa ${Math.round(timeout / 1000)}s.`);
    await clickWithFallback(driver, await locateField(driver, lookup.searchButtonId));
    const results = await waitForResults(driver, tag, lookup.resultButtonPrefix, timeout);
    const seconds = Math.round((Date.now() - started) / 1000);
    if (results.length > 0) {
      console.log(`${tag} Đã tìm "${text}": ${results.length} kết quả sau ${seconds}s.`);
      return results;
    }
    console.log(`${tag} Đã tìm "${text}": 0 kết quả sau ${seconds}s.`);
    if (attempt >= backoff.length) return [];
    await sleep(backoff[attempt]);
  }
}

/** Click the control's "full list" link when present and return the list shown. */
async function openFullList(driver: WebDriver, lookup: OccupationLookup, tag: string, timeout: number) {
  const control = lookup.searchButtonId.includes("industryControl") ? "industryControl" : "occupationControl";
  const links = await driver.executeScript<WebElement[]>(
    `return Array.from(document.querySelectorAll('a')).filter(a => /full\\s*list/i.test(a.textContent || '') && (a.id.includes(arguments[0]) || !/Control/.test(a.id)));`,
    control,
  );
  if (links.length === 0) {
    console.log(`${tag} Không thấy liên kết "full list" trên trang.`);
    return [];
  }
  console.log(`${tag} Mở danh sách đầy đủ ("full list").`);
  await clickWithFallback(driver, links[0]);
  return waitForResults(driver, tag, lookup.resultButtonPrefix, timeout);
}

async function occupationSelection(
  driver: WebDriver,
  data: ApplicationData,
): Promise<string[]> {
  const selected: string[] = [];
  const timeout = lookupTimeoutMs();
  for (const lookup of occupationLookups) {
    const tag = `[NZWH] ${lookup.resultKey}:`;
    const expected = data.occupation[lookup.resultKey];
    const existing = await driver.findElements(By.id(lookup.selectedLabelId));
    if (existing.length === 1 && selectionMatches(await existing[0].getText(), expected)) {
      selected.push(lookup.resultKey);
      console.log(`${tag} Giá trị đã chọn khớp; bỏ qua bước tìm kiếm.`);
      continue;
    }
    const started = Date.now();
    const queries = queryPlan(data.occupation[lookup.queryKey], data.occupation[lookup.altQueryKey] ?? "");
    let results: { id: string; label: string }[] = [];
    let pick = -1;
    let total = 0;
    const seen = new Set<string>();
    for (const [index, text] of queries.entries()) {
      results = await searchWithRetry(driver, lookup, tag, text, timeout);
      results.forEach((r) => seen.add(r.label));
      total = Math.max(total, results.length);
      pick = pickResult(results.map((r) => r.label), expected);
      if (pick >= 0) break;
      if (index < queries.length - 1) console.log(`${tag} Không có kết quả khớp "${expected}" cho "${text}"; thử cụm từ khác.`);
    }
    if (pick < 0) {
      results = await openFullList(driver, lookup, tag, timeout);
      results.forEach((r) => seen.add(r.label));
      total = Math.max(total, results.length);
      pick = pickResult(results.map((r) => r.label), expected);
    }
    if (pick < 0) {
      const message = `Không tìm thấy "${expected}" sau khi tìm [${queries.join(", ")}] (${total} kết quả, ${Math.round((Date.now() - started) / 1000)}s). Kết quả quan sát: [${[...seen].slice(0, 20).map((l) => `"${l}"`).join(", ")}]. Hãy dùng đúng nhãn hiển thị trên trang.`;
      console.log(`${tag} ${message}`);
      throw new WorkingHolidayStop(message);
    }
    console.log(`${tag} Chọn kết quả "${results[pick].label}".`);
    await lookupClickAndWait(
      driver,
      await locateField(driver, results[pick].id),
      async () => {
        const found = await driver.findElements(By.id(lookup.selectedLabelId));
        return found.length === 1 && selectionMatches(await found[0].getText(), expected);
      },
      `${tag} Đã bấm "${expected}" nhưng "Selected Value" không cập nhật`,
      tag,
      timeout,
    );
    await ready(driver);
    selected.push(lookup.resultKey);
    console.log(`${tag} Đã chọn và xác minh "Selected Value" sau ${Math.round((Date.now() - started) / 1000)}s.`);
  }
  return selected;
}

/** Test only: run the occupation lookups against a fixture page. */
export const occupationSelectionForTest = occupationSelection;

async function sectionSaveControl(
  driver: WebDriver,
  name: string,
): Promise<WebElement> {
  const save = await driver.findElements(
    By.id(
      "ContentPlaceHolder1_wizardPageFooter_wizardPageNavigator_validateButton",
    ),
  );
  if (
    save.length === 1 &&
    (await save[0].isDisplayed()) &&
    (await save[0].isEnabled())
  )
    return save[0];
  // Once all sections are complete the footer exposes final SUBMIT instead of
  // SAVE. Re-post only this section's observed tab; never activate final SUBMIT.
  const tabs: Record<string, string> = {
    personal: "pageTabs_TabHeaders_tabButton_0",
    identification: "pageTabs_TabHeaders_tabButton_1",
    occupation: "pageTabs_TabHeaders_tabButton_2",
    health: "sectionTabs_TabHeaders_tabButton_1",
    character: "sectionTabs_TabHeaders_tabButton_2",
    adviser: "sectionTabs_TabHeaders_tabButton_3",
    workingHoliday: "sectionTabs_TabHeaders_tabButton_4",
  };
  const completeFooter = await driver.findElements(
    By.id(
      "ContentPlaceHolder1_wizardPageFooter_wizardPageNavigator_submitImageButton",
    ),
  );
  if (completeFooter.length !== 1)
    throw new WorkingHolidayStop(
      `SAVE unavailable in ${name}; no inspected completed-draft footer found. Final SUBMIT was not clicked.`,
    );
  const tab = await locateField(
    driver,
    `ContentPlaceHolder1_wizardPageHeader_nav_${tabs[name]}`,
  );
  if (!(await tab.isDisplayed()) || !(await tab.isEnabled()))
    throw new WorkingHolidayStop(
      `Current-section tab unavailable in ${name}; final SUBMIT was not clicked.`,
    );
  console.log(
    `[NZWH] ${name}: SAVE is absent on this completed draft. Re-posting the current section tab and verifying persistence; final SUBMIT is excluded.`,
  );
  return tab;
}

/** Today's per-field entry: locate, check availability, type/select, read back. */
async function legacyFillField(
  driver: WebDriver,
  name: string,
  key: string,
  field: FieldDefinition,
  data: ApplicationData,
  report: SavedSection,
  fast: boolean,
): Promise<void> {
  await requireSession(driver);
  if (
    name === "adviser" &&
    key === "exemptionReason" &&
    !applicable(data, name, key)
  )
    return;
  if (field.lookup) return; // Search/result workflow below owns these transient inputs.
  const sourceValue = data[name as SectionName][key];
  const expected = expectedFieldValue(name, key, sourceValue);
  if (expected !== sourceValue)
    console.log(`[NZWH] ${name}.${key}: prepared for website persistence (colons removed; source document unchanged).`);
  const pollMs = fast ? FAST_POLL_MS : PAGE_POLL_MS;
  let element = await locateField(driver, field.id, pollMs);
  if (
    !(await element.isEnabled()) ||
    (field.kind !== "select" && !(await element.isDisplayed()))
  ) {
    if (applicable(data, name, key) && expected)
      throw new WorkingHolidayStop(
        `Required conditional field unavailable: ${name}.${key}.`,
      );
    return;
  }
  if (!applicable(data, name, key) && expected) return;
  const posts = await remoteTrigger(driver, element);
  const current = await element.getAttribute("value");
  const stamp = posts
    ? await driver.executeScript<number>("return performance.timeOrigin")
    : 0;
  if (posts && current !== expected)
    await emit({ type: "persistence", state: "possible" });
  await setField(driver, field, expected, element);
  // Reselect matching values too. Same-value selections may not emit change,
  // so only require a postback when the underlying value actually changes.
  if (posts && current !== expected) {
    await waitForPostback(driver, name, stamp, fast);
    element = await locateField(driver, field.id, pollMs);
  }
  if (
    (await driver.executeScript<string>(
      "return arguments[0].value",
      element,
    )) !== expected
  )
    throw new WorkingHolidayStop(`Readback mismatch: ${name}.${key}.`);
  addFilled(report, key);
  console.log(`[NZWH] ${name}.${key}: entered and read back.`);
}

/** Counts and durations only; never values. */
interface FillStats {
  fast: number;
  unchanged: number;
  standard: number;
  skipped: number;
  segments: number;
  standardMs: number;
}

async function unexpectedReload(): Promise<never> {
  await emit({ type: "persistence", state: "possible" });
  throw new WorkingHolidayStop("Form reloaded unexpectedly while filling; stopped before SAVE.");
}

/** Batched entry: one script per segment; posting/unusual fields use the standard entry. */
async function fastFillSection(
  driver: WebDriver,
  name: SectionName,
  data: ApplicationData,
  report: SavedSection,
  atom: string,
): Promise<FillStats> {
  const stats: FillStats = { fast: 0, unchanged: 0, standard: 0, skipped: 0, segments: 0, standardMs: 0 };
  const entries = planSection(name, data);
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  let stamp = await readTimeOrigin(driver);
  const waitFor = async (condition: () => Promise<boolean>, timeout: number, message: string) => {
    try {
      await waitWithCaptcha(driver, async () => {
        checkCancelled();
        await requireSession(driver);
        return condition();
      }, timeout, FAST_POLL_MS);
    } catch (error) {
      if (error instanceof webdriverError.TimeoutError) throw new WorkingHolidayStop(message);
      throw error;
    }
    if ((await readTimeOrigin(driver)) !== stamp) await unexpectedReload();
  };
  const runFill = async () => {
    report.filled = [];
    const resumes = new Map<string, number>();
    const resume = (entry: FillEntry, message: string) => {
      const count = (resumes.get(entry.key) ?? 0) + 1;
      resumes.set(entry.key, count);
      if (count > MAX_FIELD_RESUMES) throw new WorkingHolidayStop(message);
    };
    let index = 0;
    while (index < entries.length) {
      checkCancelled();
      await captchaGuard(driver);
      await requireSession(driver);
      let out;
      try {
        out = await fillSegment(driver, atom, entries, index);
      } catch (error) {
        if (isNavigationError(error)) await unexpectedReload();
        throw error;
      }
      stats.segments++;
      if (out.timeOrigin !== stamp) await unexpectedReload();
      for (const result of out.results) {
        const entry = byKey.get(result.key)!;
        if (result.status === "filled" || result.status === "unchanged") {
          if (result.status === "filled") stats.fast++;
          else stats.unchanged++;
          addFilled(report, entry.key);
          if (entry.colonsPrepared)
            console.log(`[NZWH] ${name}.${entry.key}: prepared for website persistence (colons removed; source document unchanged).`);
          console.log(`[NZWH] ${name}.${entry.key}: entered and read back.`);
        } else stats.skipped++;
      }
      if (!out.stop) break;
      const i = out.stop.index;
      const entry = entries[i];
      switch (out.stop.reason) {
        case "yield":
          index = i;
          break;
        case "missing": {
          const message = "Expected form control did not become available.";
          resume(entry, message);
          await waitFor(() => fieldPresent(driver, entry.id), SECTION_WAIT_MS, message);
          index = i;
          break;
        }
        case "unavailable-required": {
          const message = `Required conditional field unavailable: ${name}.${entry.key}.`;
          resume(entry, message);
          await waitFor(() => fieldAvailable(driver, atom, entry.id, entry.kind), DEPENDENT_FIELD_TIMEOUT_MS, message);
          index = i;
          break;
        }
        case "posting":
        case "fallback": {
          if (out.stop.reason === "fallback")
            console.log(`[NZWH] ${name}.${entry.key}: fast entry not accepted (${out.stop.cause}); using standard entry.`);
          const started = Date.now();
          await legacyFillField(driver, name, entry.key, steps[name].fields[entry.key], data, report, true);
          stats.standardMs += Date.now() - started;
          stats.standard++;
          stamp = await readTimeOrigin(driver);
          index = i + 1;
          break;
        }
      }
    }
  };
  // Pre-SAVE re-check: a later handler or postback must not have altered an earlier field.
  const recheck = async (): Promise<string | null> => {
    const read = await readFieldValues(driver, report.filled.map((key) => byKey.get(key)!.id));
    if (read.timeOrigin !== stamp) await unexpectedReload();
    for (const [position, key] of report.filled.entries()) {
      const value = read.values[position];
      if (value === null) throw new WorkingHolidayStop("Expected form control did not become available.");
      if (value !== byKey.get(key)!.expected) return key;
    }
    return null;
  };
  await runFill();
  if (await recheck()) {
    await runFill();
    const mismatch = await recheck();
    if (mismatch) throw new WorkingHolidayStop(`Readback mismatch: ${name}.${mismatch}.`);
  }
  return stats;
}

/** Test only: run one section save with a fake or fixture driver. */
export const saveStepForTest = (driver: WebDriver, name: string, data: ApplicationData, fast = false) => saveStep(driver, name, data, fast);

/** Kill-switch snapshot, read once per run (NZWH_FAST_FILL=0 restores standard entry). */
function fastEntrySnapshot(): boolean {
  if (!fastFillEnabled()) {
    console.log("[NZWH] Fast entry disabled (NZWH_FAST_FILL).");
    return false;
  }
  if (isDisplayedAtomSource() === null) {
    console.log("[NZWH] Fast entry unavailable; using standard entry.");
    return false;
  }
  console.log("[NZWH] Fast entry enabled.");
  return true;
}

const gapText = (gap: number | null) => (gap === null ? "n/a" : String(gap));

async function saveStep(
  driver: WebDriver,
  name: string,
  data: ApplicationData,
  fast = false,
): Promise<SavedSection> {
  const report: SavedSection = { filled: [], persisted: [], lookups: [] };
  const url = await driver.getCurrentUrl();
  const pageGap = await readLoadGap(driver);
  const fillStarted = Date.now();
  let stats: FillStats = { fast: 0, unchanged: 0, standard: 0, skipped: 0, segments: 0, standardMs: 0 };
  const atom = fast ? isDisplayedAtomSource() : null;
  if (atom) stats = await fastFillSection(driver, name as SectionName, data, report, atom);
  else
    for (const [key, field] of Object.entries(steps[name].fields)) {
      const started = Date.now();
      await legacyFillField(driver, name, key, field, data, report, false);
      stats.standardMs += Date.now() - started;
      stats.standard++;
    }
  const fillMs = Date.now() - fillStarted;
  if (name === "occupation")
    report.lookups = await occupationSelection(driver, data);
  const unmapped = await driver.executeScript<string[]>(
    `
    const mapped = new Set(arguments[0]);
    return Array.from(document.querySelectorAll('input,select,textarea')).filter(e => {
      if (!e.id.startsWith('ContentPlaceHolder1_') || mapped.has(e.id) || ['hidden','submit','image','button'].includes(e.type)) return false;
      const visible = e.getBoundingClientRect().width > 0 || !!document.querySelector('#s2id_' + e.id);
      return visible && !e.disabled;
    }).map(e => e.id);
  `,
    Object.values(steps[name].fields).map((field) => field.id),
  );
  if (unmapped.length)
    throw new WorkingHolidayStop(
      `Additional ${name} branch fields need mapping before SAVE: ${unmapped.join(", ")}.`,
    );
  await captchaGuard(driver);
  if ((await driver.getCurrentUrl()) !== url)
    throw new WorkingHolidayStop("Unexpected navigation before SAVE.");
  const save = await sectionSaveControl(driver, name);
  const saveStarted = Date.now();
  await postbackAndWait(driver, save, name, fast);
  const saveGap = await readLoadGap(driver);
  if (new URL(await driver.getCurrentUrl()).pathname !== new URL(url).pathname)
    throw new WorkingHolidayStop(
      "SAVE navigated outside the inspected section; stopped.",
    );
  const invalid = await driver.executeScript<number>(`
    return Array.from(document.querySelectorAll('[errorlabel]')).filter(e => /mandatory|invalid|error/i.test(e.getAttribute('errorlabel') || '') && e.getBoundingClientRect().width > 0).length;
  `);
  if (invalid)
    throw new WorkingHolidayStop(
      `Server validation flagged ${invalid} fields in ${name}; stopped before next section.`,
    );
  const saveMs = Date.now() - saveStarted;
  await emit({ type: "persistence", state: "accepted" });
  const verifyStarted = Date.now();
  await navigate(driver, url);
  await waitForSection(driver, name, fast);
  const reloadGap = await readLoadGap(driver);
  const reloaded = new URL(await driver.getCurrentUrl());
  const original = new URL(url);
  if (reloaded.origin !== original.origin || reloaded.pathname !== original.pathname ||
      reloaded.searchParams.get("ApplicationId") !== original.searchParams.get("ApplicationId"))
    throw new WorkingHolidayStop("Unexpected application after SAVE reload.");
  const mismatches: string[] = [];
  const verifyKeys = report.filled.filter(
    (key) => !steps[name].fields[key].lookup,
  );
  // Fast mode reads every saved value in one script instead of two round trips per field.
  const batched = atom
    ? (await readFieldValues(driver, verifyKeys.map((key) => steps[name].fields[key].id))).values
    : null;
  for (const [position, key] of verifyKeys.entries()) {
    const expected = expectedFieldValue(name, key, data[name as SectionName][key]);
    let actual: string | null;
    if (batched) {
      actual = batched[position];
      if (actual === null) throw new webdriverError.NoSuchElementError("Saved field missing after reload.");
    } else {
      const element = await driver.findElement(By.id(steps[name].fields[key].id));
      actual = await element.getAttribute("value");
    }
    if (actual !== expected) {
      mismatches.push(`${name}.${key}`);
      console.log(`[NZWH] Saved-value mismatch ${name}.${key}: ${savedValueDiagnostic(expected, actual)}; section=${steps[name].page}. No applicant values logged.`);
    } else report.persisted.push(key);
  }
  for (const lookup of name === "occupation" ? occupationLookups : []) {
    const stored = await (
      await locateField(driver, lookup.selectedLabelId)
    ).getText();
    if (!selectionMatches(stored, data.occupation[lookup.resultKey]))
      mismatches.push(`${name}.${lookup.resultKey}`);
    else report.persisted.push(lookup.resultKey);
  }
  if (mismatches.length)
    throw new SavedValueVerificationError(mismatches, report.persisted.length);
  await emit({ type: "persistence", state: "verified" });
  const verifyMs = Date.now() - verifyStarted;
  console.log(
    `[NZWH] ${name}: timing fill ${fillMs}ms (fast ${stats.fast}, unchanged ${stats.unchanged}, standard ${stats.standard} in ${stats.standardMs}ms, skipped ${stats.skipped}, segments ${stats.segments}), save ${saveMs}ms, verify ${verifyMs}ms; load gap page ${gapText(pageGap)}/save ${gapText(saveGap)}/reload ${gapText(reloadGap)}ms.`,
  );
  console.log(
    `[NZWH] ${name}: SAVE completed; ${report.persisted.length} values persisted and verified. Continuing in the same tab.`,
  );
  return report;
}

export interface SavedSectionOptions {
  dataPath: string;
  section: SectionName;
  scenario?: string;
  allowFictionalDraftSave: boolean;
}

// For verification with an already authenticated, caller-provided Selenium driver.
// Browser startup and login remain the responsibility of runWorkingHoliday.
export async function fillAndSaveWorkingHolidaySection(
  driver: WebDriver,
  options: SavedSectionOptions,
): Promise<void> {
  if (!automatedSection(options.section)) {
    console.log("[NZWH] Occupation is excluded: no filling, lookup, SAVE or verification.");
    return;
  }
  const base = dataSchema.parse(
    JSON.parse(await readFile(options.dataPath, "utf8")),
  );
  const data = scenarioData(base, options.scenario ?? "baseline");
  validateData(data);
  if (data.dataKind === "fictional" && !options.allowFictionalDraftSave)
    throw new WorkingHolidayStop(
      "Explicit fictional draft saving opt-in is required.",
    );
  if (!Object.hasOwn(steps, options.section))
    throw new WorkingHolidayStop("Unsupported section.");
  await activateChrome(driver);
  await ready(driver);
  const current = new URL(await driver.getCurrentUrl());
  assertHost(current.href);
  if (
    current.pathname !==
      `/WorkingHoliday/Wizard/${steps[options.section].page}` ||
    !current.searchParams.get("ApplicationId")
  )
    throw new WorkingHolidayStop(
      "Driver must be on the selected existing draft section.",
    );
  await driver.manage().window().maximize();
  await requireSession(driver);
  const fast = fastEntrySnapshot();
  await waitForSection(driver, options.section, fast);
  const report = await saveStep(driver, options.section, data, fast);
  const saved = await previousSavedReport(true);
  saved[options.section] = report;
  await writeFile(
    join(reportDirectory, "coverage-saved.json"),
    `${JSON.stringify(saved, null, 2)}\n`,
  );
}

export async function runWorkingHoliday(
  options: WorkingHolidayOptions,
): Promise<AutomationActionResult> {
  return execution.run({ hooks: options.hooks, risk: false, credentials: options.credentials, captchaMode: options.captchaMode ?? "manual", signal: options.signal }, () =>
    executeWorkingHoliday(options),
  );
}
async function executeWorkingHoliday(
  options: WorkingHolidayOptions,
): Promise<AutomationActionResult> {
  const base = dataSchema.parse(
    JSON.parse(await readFile(options.dataPath, "utf8")),
  );
  const scenario = options.scenario ?? "baseline";
  const mode = z.enum(["loginOnly", "saveAll", "fillAndSubmit"]).parse(options.mode ?? "saveAll");
  const data = mode === "loginOnly" ? base : scenarioData(base, scenario);
  if (mode !== "loginOnly") validateData(data);
  const fast = mode !== "loginOnly" && fastEntrySnapshot();
  if (mode !== "loginOnly" && base.dataKind === "fictional" && !options.allowFictionalDraftSave)
    throw new WorkingHolidayStop(
      "Saving fictional values in the existing live draft requires explicit --allow-fictional-draft-save opt-in.",
    );
  console.log(
    mode === "loginOnly" ? "[NZWH] Chế độ: Chỉ đăng nhập. Giữ Chrome mở sau khi đăng nhập."
    : mode === "fillAndSubmit"
      ? "[NZWH] Chế độ: Điền và nộp. Chỉ báo đã nộp khi website xác nhận."
      : "[NZWH] Chế độ: Chỉ điền. Dừng trước khi nộp hồ sơ để bạn kiểm tra.",
  );
  if (
    options.sections &&
    (options.sections.length === 0 ||
      options.sections.some((name) => !Object.hasOwn(steps, name)) ||
      new Set(options.sections).size !== options.sections.length)
  )
    throw new WorkingHolidayStop("Phạm vi mục hồ sơ không hợp lệ.");
  await checkpoint();
  await emit({
    type: "phase",
    phase: "browser-starting",
    message: options.attachPort
      ? `Đang kết nối Chrome ở cổng ${options.attachPort}. Bạn có thể bấm Dừng tác vụ bất cứ lúc nào.`
      : "Đang mở Chrome. Bạn có thể bấm Dừng tác vụ bất cứ lúc nào.",
  });
  const driver = await chooseBrowser(
    options.browserType ?? "visible",
    options.useDefaultAgent ?? true,
    options.profileName,
    options.attachPort,
    options.signal,
  );
  const capabilities = await driver.getCapabilities().catch(() => null);
  const chromeCapabilities = z
    .object({ debuggerAddress: z.string() })
    .safeParse(capabilities?.get("goog:chromeOptions"));
  const debuggerMatch = chromeCapabilities.success
    ? /^(?:localhost|127\.0\.0\.1):(\d+)$/.exec(
        chromeCapabilities.data.debuggerAddress,
      )
    : null;
  await emit({
    type: "phase",
    phase: "browser-open",
    message: "Chrome đã mở.",
    debugPort: debuggerMatch ? Number(debuggerMatch[1]) : undefined,
  });
  await checkpoint();
  await driver.manage().setTimeouts({ pageLoad: 30000, script: 15000 });
  await driver.manage().window().maximize();
  await activateChrome(driver);
  // Use one existing tab for the sequential save flow.
  if (options.attachPort) {
    const handles = await driver.getAllWindowHandles();
    await driver.switchTo().window(handles[0]);
  }
  if (mode === "loginOnly") {
    await emit({ type: "phase", phase: "login", message: "Đang đăng nhập trang đích. Chrome sẽ giữ mở sau khi đăng nhập." });
    await authenticate(driver, true, options.credentials, true);
    await checkpoint();
    return { success: true, outcome: "loggedIn", message: "Đã đăng nhập thành công. Chrome giữ mở để bạn thao tác; chưa mở hoặc điền hồ sơ.", driver };
  }
  let applicationPage: URL | undefined;
  {
    await emit({
      type: "phase",
      phase: "login",
      message: "Đang đăng nhập trang đích. Chưa mở các trường hồ sơ.",
    });
    // Resume without logging out when already inside an in-progress application.
    const startState = await currentState(driver);
    let startedInside = false;
    if (!options.credentials && (startState === "create" || startState === "captcha" || startState === "wizard")) {
      startedInside = (await driver.findElements(By.css('input[name="username"]'))).length === 0;
    }
    if (startedInside && options.country) {
      await advanceToWizard(driver, options.country);
    } else {
      await authenticate(driver, true, options.credentials);
    }
    const links = startedInside
      ? []
      : await driver.findElements(By.css('a[id*="editHyperLink"]'));
    if (!links.length && options.country) {
      await advanceToWizard(driver, options.country);
      applicationPage = new URL(await driver.getCurrentUrl());
      if (
        !applicationPage.pathname.startsWith("/WorkingHoliday/Wizard/") ||
        !applicationPage.searchParams.get("ApplicationId")
      )
        throw new WorkingHolidayStop("Unexpected application page.");
    }
    if (!applicationPage) {
    if (!links.length && (await countryTiles(driver)).length > 0)
      throw new WorkingHolidayStop("Chưa chọn quốc gia trong cấu hình.");
    if (!links.length)
      throw new WorkingHolidayStop(
        "No editable applications found, or login failed.",
      );
    const requested =
      options.expectedApplicationId ?? process.env.NZWH_APPLICATION_ID;
    if (links.length > 1 && !requested)
      throw new WorkingHolidayStop(
        "Multiple applications found; choose NZWH_APPLICATION_ID manually.",
      );
    for (const link of links) {
      const candidate = new URL((await link.getAttribute("href")) ?? "");
      assertHost(candidate.href);
      if (
        !requested ||
        candidate.searchParams.get("ApplicationId") === requested
      ) {
        applicationPage = candidate;
        break;
      }
    }
    if (
      !applicationPage ||
      applicationPage.pathname !== "/WorkingHoliday/Application/Edit.aspx"
    )
      throw new WorkingHolidayStop("Selected application not found.");
    const id = applicationPage.searchParams.get("ApplicationId");
    await navigate(driver, applicationPage.href);
    await ready(driver);
    applicationPage = new URL(await driver.getCurrentUrl());
    if (
      !applicationPage.pathname.startsWith("/WorkingHoliday/Wizard/") ||
      applicationPage.searchParams.get("ApplicationId") !== id
    )
      throw new WorkingHolidayStop("Unexpected application page.");
    }
  }
  const selectedApplicationId =
    applicationPage?.searchParams.get("ApplicationId");
  if (selectedApplicationId)
    await emit({ type: "application", id: selectedApplicationId });
  const saved: Record<string, SavedSection> = {};
  const skippedBusy: string[] = [];
  const unverifiedSections: string[] = [];
  const completedSections: string[] = [];
  await writeFile(
    join(reportDirectory, "coverage-busy.json"),
    `${JSON.stringify({ skippedUnverified: skippedBusy }, null, 2)}\n`,
  );
  {
    const selected = requestedSections({ sections: options.sections });
    console.log("[NZWH] Occupation is excluded: no filling, lookup, SAVE or verification.");
    console.log(`[NZWH] Planned form pages: ${selected.join(" → ")}.`);
    for (const [sectionIndex, name] of selected.entries()) {
      if (
        options.taskKeys &&
        !options.taskKeys.includes(`${scenario}:${name}`)
      )
        continue;
      await checkpoint();
      console.log(
        `[NZWH] Opening section ${sectionIndex + 1}/${selected.length}: ${name}. url=${await driver.getCurrentUrl().then((u) => new URL(u).pathname).catch(() => "?")}`,
      );
      if (name === "adviser" && data.personal.representedByAdviser !== "Yes") {
        console.log(
          "[NZWH] Adviser skipped: personal.representedByAdviser is No. Use an adviser scenario to fill this section.",
        );
        continue;
      }
      const context = execution.getStore();
      if (context) context.risk = false;
      await emit({
        type: "section-start",
        section: name,
        scenario: scenario,
      });
      let recoveredSession = false;
      while (true) {
        try {
          const url = `${origin}/WorkingHoliday/Wizard/${steps[name].page}?${applicationPage?.searchParams.toString()}`;
          if ((await driver.getCurrentUrl()) !== url)
            await navigate(driver, url);
          await waitForSection(driver, name, fast);
          const actual = new URL(await driver.getCurrentUrl());
          assertHost(actual.href);
          if (
            actual.pathname !== `/WorkingHoliday/Wizard/${steps[name].page}` ||
            actual.searchParams.get("ApplicationId") !==
              applicationPage?.searchParams.get("ApplicationId")
          )
            throw new WorkingHolidayStop(
              "Conditional page unavailable or application changed.",
            );
          saved[name] = await saveStep(driver, name, data, fast);
          completedSections.push(name);
          await writeFile(
            join(reportDirectory, "coverage-saved.json"),
            `${JSON.stringify(saved, null, 2)}\n`,
          );
          await emit({
            type: "section-result",
            status: "completed",
            detail: "Đã lưu và xác minh sau khi tải lại.",
            checked:
              saved[name]?.persisted.length ??
              Object.keys(steps[name].fields).length,
            blocked: 0,
          });
          break;
        } catch (error) {
          if (error instanceof StopRequested) throw error;
          {
            const state = await readAuthState(driver);
            if (state.rejected)
              throw new WorkingHolidayStop(loginRejectedMessage);
            if (error instanceof SessionExpiredError || state.loginForm) {
              if (execution.getStore()?.risk)
                throw new WorkingHolidayStop(
                  "Phiên đăng nhập hết hạn sau thao tác có thể lưu dữ liệu. Không tự điền lại. Kiểm tra dữ liệu trên Chrome rồi khôi phục có xác nhận.",
                );
              if (recoveredSession)
                throw new WorkingHolidayStop(
                  `Session expired again in ${name}; stopped after one recovery attempt.`,
                );
              recoveredSession = true;
              console.log(
                `[NZWH] ${name}: login redirect detected. Re-authenticating once before retrying this section.`,
              );
              await authenticate(driver, false, options.credentials);
              const links = await driver.findElements(
                By.css('a[id*="editHyperLink"]'),
              );
              let sameDraft = false;
              for (const link of links) {
                const candidate = new URL(
                  (await link.getAttribute("href")) ?? "",
                );
                assertHost(candidate.href);
                if (
                  candidate.searchParams.get("ApplicationId") ===
                  applicationPage?.searchParams.get("ApplicationId")
                )
                  sameDraft = true;
              }
              if (!sameDraft)
                throw new WorkingHolidayStop(
                  "Original draft not found after login; stopped without choosing a different application.",
                );
              continue;
            }
          }
          if (error instanceof SectionPostbackTimeoutError) {
            const actual = new URL(await driver.getCurrentUrl());
            assertHost(actual.href);
            if (actual.pathname !== `/WorkingHoliday/Wizard/${steps[name].page}` ||
                actual.searchParams.get("ApplicationId") !== selectedApplicationId)
              throw error;
            unverifiedSections.push(name);
            console.log(`[NZWH] ${error.message} No repeat POST; continuing to the next selected section.`);
            await emit({
              type: "section-result", status: "failed",
              detail: "Hết thời gian chờ phản hồi trên cùng mục hồ sơ. Chưa xác minh việc lưu; không tự gửi lại. Tiếp tục mục kế tiếp.",
            });
            break;
          }
          if (error instanceof SavedValueVerificationError) {
            // saveStep only raises this after a successful reload of the same
            // authenticated section. Do not replay its POST; process the rest.
            assertHost(await driver.getCurrentUrl());
            unverifiedSections.push(name);
            console.log(`[NZWH] ${error.message} No repeat SAVE; continuing to the next selected section.`);
            await emit({
              type: "section-result",
              status: "failed",
              detail: `Đã nhận phản hồi lưu nhưng các trường chưa khớp: ${error.fields.join(", ")}. Không tự lưu lại; tiếp tục mục kế tiếp.`,
              checked: error.checked,
              blocked: error.fields.length,
            });
            break;
          }
          if (error instanceof SiteBusyError) {
            assertHost(await driver.getCurrentUrl());
            skippedBusy.push(name);
            // A busy response cannot establish whether the last POST persisted.
            delete saved[name];
            await writeFile(
              join(reportDirectory, "coverage-saved.json"),
              `${JSON.stringify(saved, null, 2)}\n`,
            );
            await writeFile(
              join(reportDirectory, "coverage-busy.json"),
              `${JSON.stringify({ skippedUnverified: skippedBusy }, null, 2)}\n`,
            );
            await emit({
              type: "section-result",
              status: "failed",
              detail:
                "Trang đích bận. Chưa xác minh việc lưu; không tự thử lại. Các mục tiếp theo vẫn được xử lý.",
            });
            console.log(
              `[NZWH] ${name}: site returned Please try again later. Save state is unverified; moving to the next form section in this same tab.`,
            );
            break;
          }
          await emit({
            type: "section-result",
            status: "failed",
            detail:
              "Không hoàn tất mục này. Kiểm tra Chrome và trạng thái lưu trước khi thử lại.",
          });
          const reason =
            error instanceof WorkingHolidayStop
              ? error.message
              : "Form interaction or page load did not complete. Check the current Chrome page.";
          throw new WorkingHolidayStop(
            `Stopped in ${name}. ${reason} Later sections have not run.`,
          );
        }
      }
    }
  }
  await checkpoint();
  console.log(
    `[NZWH] Sections saved and verified this run: ${completedSections.join(", ") || "none"}.`,
  );
  if (skippedBusy.length)
    console.log(
      `[NZWH] Incomplete sections skipped because the site was busy: ${skippedBusy.join(", ")}. Re-run these sections later; no successful SAVE is claimed for them.`,
    );
  const result = await finishApplication(driver, {
    mode,
    payerName: options.payerName,
    filled: skippedBusy.length === 0 && unverifiedSections.length === 0,
    origin,
    applicationId: selectedApplicationId ?? undefined,
    checkpoint,
    ready: async () => {
      // Submit.aspx has an inline CAPTCHA below the declarations. Load its DOM
      // without waiting for that CAPTCHA, so the Yes labels are selected first.
      const url = new URL(await driver.getCurrentUrl());
      if (url.origin === origin && /^\/WorkingHoliday\/Application\/(?:Submit|Declarations?)\.aspx$/i.test(url.pathname)) {
        await driver.wait(async () => {
          await checkpoint();
          return await driver.executeScript("return document.readyState") === "complete";
        }, 30000);
        await assertSiteAvailable(driver);
      } else await ready(driver);
    },
    waitForCaptcha: async () => { await captchaGuard(driver); },
    // Check the transition before entering the next page's CAPTCHA wait.
    waitForChange: condition => driver.wait(condition, SUBMISSION_CHANGE_WAIT_MS),
    submitting: () => emit({ type: "submission", state: "unconfirmed" }),
    confirmed: () => emit({ type: "submission", state: "confirmed" }),
  });
  console.log(`[NZWH] ${result.message}`);
  return {
    ...result,
    driver,
  };
}

