import { describe, expect, test } from "vitest";
import { applicationDataSchema } from "../workflow/application-data";
import { scenarioData } from "../workflow/data-validation";
import sample from "../fixtures/sample.json";
import { runSchema, validateRun } from "./run-config";
const data = applicationDataSchema.parse(sample);
describe("automation safeguards",() => {
 test("live save requires separate explicit and fictional opt-ins",() => {
  const config = runSchema.parse({data,mode:"saveAll"});
  expect(() => validateRun(config)).toThrow("Explicit");
  config.liveSaveConsent = true;expect(() => validateRun(config)).toThrow("Fictional");
  config.allowFictionalDraftSave = true;expect(() => validateRun(config)).not.toThrow();
 });
 test("fill only is the default; submission requires the explicit supported mode",() => {
  expect(runSchema.parse({data}).mode).toBe("saveAll");
  expect(runSchema.parse({data,mode:"saveAll"}).mode).toBe("saveAll");
  expect(runSchema.parse({data,mode:"fillAndSubmit"}).mode).toBe("fillAndSubmit");
  expect(runSchema.safeParse({data,mode:"other"}).success).toBe(false);
  expect(runSchema.safeParse({data,mode:"saveAll",step:"health"}).success).toBe(false);
  expect(runSchema.safeParse({data,mode:"saveAll",firstSection:"health"}).success).toBe(false);
  expect(runSchema.safeParse({data,mode:"saveAll",browserType:"headless"}).success).toBe(false);
 });
 test("scenario overlays preserve metadata, do not mutate source and reject unknown sections",() => {
  const source = {...data,metadata:{keep:[true,"value"]}};
  const output = scenarioData(source,"all-editable-controls");
  expect(output.metadata).toEqual(source.metadata);expect(source.personal.title).toBe(data.personal.title);
  expect(output.personal.title).toBe("6");
  expect(() => scenarioData(source,"unknown")).toThrow("Unknown scenario");
  expect(() => scenarioData({...source,scenarios:[{name:"bad",notes:"",changes:{declarations:{save:"yes"}}}]},"bad")).toThrow("Unsupported scenario section");
 });
 test("general sample scenarios preserve non-adverse Character answers", () => {
  for (const scenario of ["baseline", "all-editable-controls"]) {
   const character = scenarioData(data, scenario).character;
   for (const key of ["imprisonment5Years", "imprisonment12Months", "deported", "charged", "convicted", "underInvestigation", "excluded", "removed"])
    expect(character[key]).toBe("No");
   for (const key of ["deportedDate", "deportedCountry", "details"])
    expect(character[key]).toBe("");
  }
  expect(scenarioData(data, "character-details-and-previous-visit").character).toMatchObject({deported: "Yes", charged: "Yes"});
 });
 test("invalid browser ports and excluded sections never enter the runner",() => {
  expect(runSchema.safeParse({data,mode:"saveAll",sections:["declarations"]}).success).toBe(false);
  expect(runSchema.safeParse({data,mode:"saveAll",attachPort:80}).success).toBe(false);
 });
 test("country is optional and limited to the known list",() => {
  expect(runSchema.parse({data,mode:"saveAll"}).country).toBeUndefined();
  expect(runSchema.parse({data,mode:"saveAll",country:"japan"}).country).toBe("japan");
  expect(runSchema.safeParse({data,mode:"saveAll",country:"xx"}).success).toBe(false);
 });
});

test("CAPTCHA defaults to manual; only explicit supported modes enter snapshots", () => {
  expect(runSchema.parse({ data, mode: "saveAll" }).captchaMode).toBe("manual");
  expect(runSchema.parse({ data, mode: "saveAll", captchaMode: "capsolver" }).captchaMode).toBe("capsolver");
  expect(runSchema.safeParse({ data, mode: "saveAll", captchaMode: "unknown" }).success).toBe(false);
  expect(runSchema.safeParse({ data, mode: "saveAll", apiKey: "secret" }).success).toBe(false);
});

test("login-only does not require valid application values or live-save consent", () => {
  const config = runSchema.parse({ data: { dataKind: "applicant", personal: {}, identification: {}, occupation: {}, health: {}, character: {}, adviser: {}, workingHoliday: {} }, mode: "loginOnly", source: { kind: "login" } });
  expect(() => validateRun(config)).not.toThrow();
});

test("CAPTCHA provider selection preserves manual default and rejects keys in run input", () => {
  expect(runSchema.parse({ data }).captchaMode).toBe("manual");
  for (const captchaMode of ["manual", "capsolver", "2captcha"])
    expect(runSchema.parse({ data, captchaMode }).captchaMode).toBe(captchaMode);
  expect(runSchema.safeParse({ data, captchaMode: "both" }).success).toBe(false);
  expect(runSchema.safeParse({ data, captchaMode: "2captcha", apiKey: "private" }).success).toBe(false);
});
