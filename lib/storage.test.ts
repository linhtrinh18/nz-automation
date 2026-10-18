import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { copyFile, lstat, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blankApplication } from "../workflow/application-data";
import { readApplicant, readSample, saveApplicant, saveSample, saveSource } from "./storage";
let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nzwh-data-"));
  await copyFile(join(process.cwd(), "fixtures", "sample.json"), join(dir, "sample.json"));
  process.env.NZWH_DATA_DIR = dir;
});
afterEach(async () => {
  delete process.env.NZWH_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});
describe("standalone/legacy file storage", () => {
  test("missing applicant.json reads as blank without writing", async () => {
    expect(await readApplicant()).toEqual(blankApplication());
    expect(await readdir(dir)).toEqual(["sample.json"]);
  });
  test("save and read keep metadata and incomplete answers, mode 0600", async () => {
    const data = { ...blankApplication(), metadata: { nested: [123, false, null] }, personal: { custom: "retained" } };
    await saveApplicant(data);
    expect((await lstat(join(dir, "applicant.json"))).mode & 0o777).toBe(0o600);
    expect(await readApplicant()).toEqual(data);
  });
  test("concurrent saves both succeed and leave valid JSON", async () => {
    const results = await Promise.allSettled([
      saveApplicant({ ...blankApplication(), metadata: 1 }),
      saveApplicant({ ...blankApplication(), metadata: 2 }),
    ]);
    expect(results.every((item) => item.status === "fulfilled")).toBe(true);
    expect([1, 2]).toContain((await readApplicant()).metadata);
  });
  test("sample.json is editable and independent of applicant.json", async () => {
    const edited = { ...(await readSample()), metadata: "edited" };
    await saveSample(edited);
    expect((await readSample()).metadata).toBe("edited");
    expect(await readdir(dir)).toEqual(["sample.json"]);
    await saveApplicant(blankApplication());
    expect((await readSample()).metadata).toBe("edited");
    expect((await readdir(dir)).sort()).toEqual(["applicant.json", "sample.json"]);
  });
  test("malformed data and unknown sources are rejected", async () => {
    await expect(saveApplicant({})).rejects.toThrow();
    await expect(saveSource("../evil" as "sample", blankApplication())).rejects.toThrow("Unknown legacy");
    expect((await readdir(dir)).sort()).toEqual(["sample.json"]);
  });
});
