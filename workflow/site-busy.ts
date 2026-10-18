import type { WebDriver } from "selenium-webdriver";

export class SiteBusyError extends Error {
  constructor() {
    super("Immigration site returned Please try again later; this section's save state is unverified.");
    this.name = "SiteBusyError";
  }
}

export async function assertSiteAvailable(driver: WebDriver): Promise<void> {
  const busy = await driver.executeScript<boolean>(`
    return /site busy/i.test(document.title)
      || /(?:^|\\n)\\s*please try again later[.!]?\\s*(?:\\n|$)/i.test(document.body?.innerText || '');
  `);
  if (busy) throw new SiteBusyError();
}
