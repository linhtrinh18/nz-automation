import { error as webdriverError } from "selenium-webdriver";
import type { WebDriver } from "selenium-webdriver";
import { StopRequested } from "../lib/execution-controller";
import { SavedValueVerificationError } from "./errors";

/**
 * Second-tab read-only verification (NZWH_PARALLEL_VERIFY=1). One driver, two window handles:
 * WebDriver commands stay serialized; only the two page loads overlap inside Chrome.
 * The tab never clicks SAVE or posts a form: it only navigates (GET) and reads values.
 */
export interface VerifyItem {
  name: string;
  url: string;
}
export type VerifyOutcome<T> =
  | { name: string; outcome: "verified"; result: T; overlapMs: number; verifyMs: number }
  | { name: string; outcome: "unverified"; error: SavedValueVerificationError; overlapMs: number; verifyMs: number }
  /** Tab 2 is unusable (busy, denied, session, closed window, load timeout): verify in the main tab instead. */
  | { name: string; outcome: "fallback"; reason: string; overlapMs: number; verifyMs: number }
  | { name: string; outcome: "error"; error: unknown; overlapMs: number; verifyMs: number };

export interface VerifyTabDeps<T> {
  /** Read-only verification of the already navigated tab (same checks as the sequential reload). */
  verify(item: VerifyItem & { startedAt: number }): Promise<T>;
  /** Errors in tab 2 that switch the rest of the run to the sequential flow. */
  fallbackReason(error: unknown): string | null;
  log(message: string): void;
}

/** Windows that must never be closed by the country-popup closer, per driver. */
const protectedWindows = new WeakMap<WebDriver, Set<string>>();
export const isProtectedWindow = (driver: WebDriver, handle: string): boolean =>
  protectedWindows.get(driver)?.has(handle) ?? false;
/** True while a verify tab is open for this driver (CAPTCHA guard pins its window). */
export const hasVerifyTab = (driver: WebDriver): boolean => (protectedWindows.get(driver)?.size ?? 0) > 0;

export function createVerifyTab<T>(driver: WebDriver, deps: VerifyTabDeps<T>) {
  let main: string | undefined;
  let handle: string | undefined;
  let pending: (VerifyItem & { startedAt: number }) | undefined;
  let disabled: string | null = null;

  /** Runs fn on the verify window and always restores the main window. */
  async function withWindow<R>(fn: () => Promise<R>): Promise<R> {
    await driver.switchTo().window(handle!);
    try {
      return await fn();
    } finally {
      await driver.switchTo().window(main!);
    }
  }

  async function open(): Promise<void> {
    main = await driver.getWindowHandle();
    await driver.switchTo().newWindow("tab");
    handle = await driver.getWindowHandle();
    let set = protectedWindows.get(driver);
    if (!set) protectedWindows.set(driver, (set = new Set()));
    set.add(handle);
    await driver.switchTo().window(main);
  }

  async function close(): Promise<void> {
    if (!handle) return;
    const closing = handle;
    handle = undefined;
    protectedWindows.get(driver)?.delete(closing);
    try {
      await driver.switchTo().window(closing);
      await driver.close();
    } catch (error) {
      if (!(error instanceof webdriverError.NoSuchWindowError)) throw error;
    } finally {
      if (main) await driver.switchTo().window(main);
    }
  }

  async function disable(reason: string): Promise<void> {
    if (disabled) return;
    disabled = reason;
    deps.log(`[NZWH] Parallel verify off for the rest of this run (${reason}); continuing sequentially.`);
    await close();
  }

  return {
    get enabled() { return disabled === null; },
    get reason() { return disabled; },
    get pending() { return pending?.name; },
    get handle() { return handle; },
    /** Starts the non-blocking reload of a saved section in tab 2; returns false when unavailable. */
    async start(item: VerifyItem): Promise<boolean> {
      if (disabled || pending) return false;
      try {
        if (!handle) await open();
        await withWindow(() => driver.executeScript("location.href = arguments[0];", item.url));
      } catch (error) {
        if (error instanceof StopRequested) throw error;
        await disable(error instanceof webdriverError.NoSuchWindowError ? "verify tab closed" : "verify tab unavailable").catch(() => undefined);
        return false;
      }
      pending = { ...item, startedAt: Date.now() };
      return true;
    },
    /** Resolves the pending item in tab 2. Never throws except StopRequested. */
    async settle(): Promise<VerifyOutcome<T> | null> {
      if (!pending) return null;
      const item = pending;
      pending = undefined;
      const begun = Date.now();
      const overlapMs = begun - item.startedAt;
      const timed = () => ({ name: item.name, overlapMs, verifyMs: Date.now() - begun });
      try {
        const result = await withWindow(() => deps.verify(item));
        return { ...timed(), outcome: "verified", result };
      } catch (error) {
        if (error instanceof StopRequested) throw error;
        if (error instanceof SavedValueVerificationError) return { ...timed(), outcome: "unverified", error };
        const reason = error instanceof webdriverError.NoSuchWindowError ? "verify tab closed" : deps.fallbackReason(error);
        if (reason) {
          await disable(reason).catch(() => undefined);
          return { ...timed(), outcome: "fallback", reason };
        }
        return { ...timed(), outcome: "error", error };
      }
    },
    disable,
    close,
  };
}
export type VerifyTab<T> = ReturnType<typeof createVerifyTab<T>>;
