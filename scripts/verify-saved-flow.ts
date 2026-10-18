/** Recheck enabled sections of an existing authenticated draft in real Chrome.
 * Usage: npx tsx scripts/verify-saved-flow.ts <debug-port> <data.json>
 * Explicitly saves fictional draft data. Never clicks final Submit.
 */
import { chooseBrowser } from "../browser/chooseBrowser";
import { fillAndSaveWorkingHolidaySection } from "../workflow/run";
import { automatedSection } from "../workflow/section-policy";
import { steps } from "../workflow/fields";
import type { SectionName } from "../workflow/application-data";
import { resolve } from "node:path";
const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port < 1024 || port > 65535 || !process.argv[3])
  throw new Error("Supply Chrome debug port and application data path.");
const driver = await chooseBrowser("visible", true, "working-holiday", port);
try {
  const original = new URL(await driver.getCurrentUrl());
  if (original.origin !== "https://onlineservices.immigration.govt.nz" ||
      !original.pathname.startsWith("/WorkingHoliday/Wizard/") ||
      !original.searchParams.get("ApplicationId"))
    throw new Error("Chrome must already be on the intended authenticated draft.");
  let completed = 0;
  const selected = Object.entries(steps).filter(([section]) => automatedSection(section));
  for (const [section, step] of selected) {
    const url = new URL(original.href);
    url.pathname = `/WorkingHoliday/Wizard/${step.page}`;
    await driver.get(url.href);
    await fillAndSaveWorkingHolidaySection(driver, {
      dataPath: resolve(process.argv[3]), section: section as SectionName,
      allowFictionalDraftSave: true,
    });
    console.log(`[VERIFY] ${++completed}/${selected.length} ${section} saved and verified.`);
  }
  console.log("[VERIFY] All enabled sections persisted after reload. Occupation was excluded. Final submission was not attempted.");
} finally {
  // Attached Chrome remains open for inspection.
  await driver.quit();
}
