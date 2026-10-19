import type { WebDriver } from "selenium-webdriver";

/** Drivers whose Chrome window was sized by launch flags (--window-size), so maximize() is redundant. */
const sizedAtLaunch = new WeakSet<WebDriver>();
export const markWindowSizedAtLaunch = (driver: WebDriver): void => { sizedAtLaunch.add(driver); };
export const windowSizedAtLaunch = (driver: WebDriver): boolean => sizedAtLaunch.has(driver);
