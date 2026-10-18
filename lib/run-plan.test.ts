import { blankApplication } from "../workflow/application-data";
import { expect, test } from "vitest";
import { runSchema, validateRun } from "./run-config";
import { buildPlan } from "./run-plan";
import { reviewToken } from "./jobs";
import sample from "../fixtures/sample.json";
test("selected sections run in canonical order from the first one and excluded sections stay skipped", () => {
  const input = runSchema.parse({
    data: sample,
    mode: "saveAll",
    sections: ["workingHoliday", "personal", "health"],
    liveSaveConsent: true,
    allowFictionalDraftSave: true,
  });
  const plan = buildPlan(input);
  expect(plan.selected).toEqual(["personal", "health", "workingHoliday"]);
  expect(
    plan.outcomes
      .filter((item) => item.status === "pending")
      .map((item) => item.section),
  ).toEqual(["personal", "health", "workingHoliday"]);
});
test("non-adverse Character answers can be planned alongside every section", () => {
  const input = runSchema.parse({ data: sample, mode: "saveAll" });
  expect(() => validateRun(input, false)).not.toThrow();
  const outcomes = buildPlan(input).outcomes;
  expect(outcomes).toHaveLength(7);
  expect(outcomes.filter(item => item.status === "pending")).toHaveLength(6);
  expect(outcomes.find(item => item.section === "occupation")?.status).toBe("skipped");
  for (const value of [
    input.data.personal.otherTitle,
    input.data.identification.identificationExpiry,
    input.data.health.details,
    input.data.workingHoliday.previousVisitDate,
    input.data.adviser.familyName,
    input.data.adviser.exemptionReason,
  ]) expect(value).not.toBe("");
  for (const key of ["imprisonment5Years", "imprisonment12Months", "deported", "charged", "convicted", "underInvestigation", "excluded", "removed"])
    expect(input.data.character[key]).toBe("No");
  for (const key of ["details", "deportedDate", "deportedCountry"])
    expect(input.data.character[key]).toBe("");
  const adverse = sample.scenarios.find(item => item.name === "character-details-and-previous-visit")!;
  expect(adverse.changes.character).toMatchObject({ deported: "Yes", charged: "Yes" });
});
test("conditional adviser is explicitly skipped; unsupported live-save branch blocks preflight", () => {
  const input = runSchema.parse({
    data: { ...sample, personal: { ...sample.personal, representedByAdviser: "No" } },
    mode: "saveAll",
  });
  expect(
    buildPlan(input).outcomes.find((item) => item.section === "adviser")
      ?.status,
  ).toBe("skipped");
  expect(() =>
    validateRun(
      { ...input, mode: "saveAll", scenario: "adviser-licensed" },
      false,
    ),
  ).toThrow("Chưa hỗ trợ");
});
test("review fingerprint changes with data, source, scope and browser but not consent", () => {
  const input = runSchema.parse({ data: sample, mode: "saveAll" });
  const token = reviewToken(input);
  expect(reviewToken({ ...input, liveSaveConsent: true })).toBe(token);
  for (const change of [
    { mode: "fillAndSubmit" as const },
    { sections: ["health"] as const },
    { scenario: "medical-details" },
    { browserType: "profile" as const },
    { captchaMode: "capsolver" as const },
    { data: { ...input.data, metadata: "changed" } },
  ])
    expect(
      reviewToken({
        ...input,
        ...change,
        sections: change.sections ? [...change.sections] : input.sections,
      }),
    ).not.toBe(token);
});

test("both modes plan identical fields and disclose the final application action", () => {
  const input = runSchema.parse({ data: sample, sections: ["personal", "health"] });
  const fill = buildPlan(input);
  const submit = buildPlan({ ...input, mode: "fillAndSubmit" });
  expect(submit.outcomes).toEqual(fill.outcomes);
  expect(fill.warnings.join(" ")).toContain("Chỉ điền: dừng trước");
  expect(submit.warnings.join(" ")).toContain("Điền và nộp:");
  expect(submit.warnings.join(" ")).toContain("không phải là nộp hồ sơ");
});
test("recovery skips completed section pairs", () => {
  const input = runSchema.parse({
    data: sample,
    mode: "saveAll",
    scenario: "medical-details",
    source: { kind: "run", runId: "00000000-0000-4000-8000-000000000000" },
    sections: ["health"],
    resumeKeys: ["medical-details:health"],
  });
  expect(
    buildPlan(input)
      .outcomes.filter((item) => item.status === "pending")
      .map((item) => item.key),
  ).toEqual(["medical-details:health"]);
});

test("saving rejects an incomplete blank draft", () => {
  const input = runSchema.parse({
    data: blankApplication(),
    mode: "saveAll",
    sections: ["health"],
  });
  expect(() => validateRun(input, false)).toThrow();
});
