import type { WebDriver } from "selenium-webdriver";
import { StopRequested } from "../lib/execution-controller";
import { WorkingHolidayStop } from "./errors";
import { ACCESS_DENIED_BACKOFF_SLICE_MS, isNavigationError } from "./fast-fill";

export class SiteBusyError extends Error {
  constructor() {
    super("Immigration site returned Please try again later; this section's save state is unverified.");
    this.name = "SiteBusyError";
  }
}

export const ACCESS_DENIED_MESSAGE = "Immigration site redirected to its access-denied page.";
/** The static INZ page the site redirects to on session, permission or cookie problems. Not a busy response. */
export class AccessDeniedError extends WorkingHolidayStop {
  constructor() {
    super(ACCESS_DENIED_MESSAGE);
    this.name = "AccessDeniedError";
  }
}
export const ACCESS_DENIED_GIVE_UP_MESSAGE =
  "Access denied by the immigration site; recovery limit reached. Save state may be unverified. Check Chrome and the saved data before restarting.";
export const ACCESS_DENIED_DISABLED_MESSAGE =
  "Access denied by the immigration site; automatic recovery is disabled. Save state may be unverified. Check Chrome and the saved data before restarting.";
/** Pathname only, any host, any case, optional trailing slash. Never matches body text. */
export const ACCESS_DENIED_PATH = /(?:^|\/)formshelp\/access-denied\/?$/i;
export const isAccessDeniedPath = (pathname: string): boolean => ACCESS_DENIED_PATH.test(pathname);
/** Only this path (never the query string) may appear in logs and events. */
export const ACCESS_DENIED_LOG_PATH = "/formshelp/access-denied";

const DENIED_TEST = `new RegExp(${JSON.stringify(ACCESS_DENIED_PATH.source)}, 'i').test(location.pathname)`;
/** One round trip: 'denied' (pathname), 'busy' (title/body) or false. */
export const SITE_STATE_JS = `
    if (${DENIED_TEST}) return 'denied';
    const busy = /site busy/i.test(document.title)
      || /(?:^|\\n)\\s*please try again later[.!]?\\s*(?:\\n|$)/i.test(document.body?.innerText || '');
    return busy ? 'busy' : false;
  `;

export async function assertSiteAvailable(driver: WebDriver): Promise<void> {
  const state = await driver.executeScript<boolean | "busy" | "denied">(SITE_STATE_JS);
  if (state === "denied") throw new AccessDeniedError();
  // `true` (legacy boolean) still means busy.
  if (state) throw new SiteBusyError();
}

/** Denied-page check (same script, denied decided by pathname only) for paths that must tolerate a navigation in flight. */
export async function isAccessDenied(driver: WebDriver): Promise<boolean> {
  try {
    return (await driver.executeScript<unknown>(SITE_STATE_JS)) === "denied";
  } catch (error) {
    if (isNavigationError(error)) return false;
    throw error;
  }
}

/** Sleeps in short slices; throws StopRequested as soon as the run is aborted. */
export async function abortableBackoff(ms: number, signal?: AbortSignal, slice = ACCESS_DENIED_BACKOFF_SLICE_MS): Promise<void> {
  const until = Date.now() + ms;
  while (true) {
    if (signal?.aborted) throw new StopRequested();
    const left = until - Date.now();
    if (left <= 0) return;
    await new Promise<void>(resolve => setTimeout(resolve, Math.min(slice, left)));
  }
}
