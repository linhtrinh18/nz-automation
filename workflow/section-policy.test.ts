import { expect, test } from "vitest";
import sample from "../fixtures/sample.json";
import { runSchema, validateRun } from "../lib/run-config";
import { buildPlan, requestedSections } from "../lib/run-plan";
import { fillAndSaveWorkingHolidaySection } from "./run";
import type { WebDriver } from "selenium-webdriver";

test("Occupation is excluded even when explicitly selected or restored from an older run", () => {
  const input = runSchema.parse({ data: sample, sections: ["occupation", "health"], mode: "fillAndSubmit" });
  expect(requestedSections(input)).toEqual(["health"]);
  expect(buildPlan(input).outcomes.find(item => item.section === "occupation")).toMatchObject({ status: "skipped", persistence: "none" });
  expect(buildPlan(input).outcomes.filter(item => item.status === "pending").map(item => item.section)).toEqual(["health"]);
});
test("missing occupation values do not fail application preflight", () => {
  const input = runSchema.parse({ data: { ...sample, occupation: {} } });
  expect(() => validateRun(input, false)).not.toThrow();
});
test("direct section entry skips occupation without reading data or touching Chrome", async () => {
  const driver = new Proxy({}, { get() { throw new Error("Chrome must not be touched"); } }) as WebDriver;
  await expect(fillAndSaveWorkingHolidaySection(driver, { dataPath: "/nonexistent", section: "occupation", allowFictionalDraftSave: false })).resolves.toBeUndefined();
});
