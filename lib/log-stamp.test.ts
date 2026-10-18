import { afterEach, expect, test, vi } from "vitest";
import { installLogStamping } from "./log-stamp";

const original = { ...console };
afterEach(() => Object.assign(console, original));

test("stamps lines with time, level and masks secrets", () => {
  const lines: string[] = [];
  console.log = (text: string) => void lines.push(text);
  console.warn = console.error = console.log;
  installLogStamping(Date.now(), () => ["s3cretpw"]);
  console.log("a s3cretpw\nb");
  console.error("boom");
  expect(lines[0]).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z \+00:00 INFO a \*\*\*$/);
  expect(lines[1]).toMatch(/ INFO b$/);
  expect(lines[2]).toMatch(/ ERROR boom$/);
  vi.restoreAllMocks();
});

test("masks even a one-character external password", () => {
  const lines: string[] = [];
  console.log = (text: string) => void lines.push(text);
  installLogStamping(Date.now(), () => ["Q"]);
  console.log("typed Q");
  expect(lines[0]).toContain("typed ***");
});

test("database-loaded and replaced keys are masked without environment secrets", async () => {
  const { registerLogSecret } = await import("./log-stamp");
  const lines: string[] = [];
  console.log = (text: string) => void lines.push(text);
  installLogStamping(Date.now(), () => []);
  registerLogSecret("database-key-one");
  registerLogSecret("database-key-two");
  console.log("database-key-one database-key-two");
  expect(lines[0]).toMatch(/INFO \*\*\* \*\*\*$/);
});
