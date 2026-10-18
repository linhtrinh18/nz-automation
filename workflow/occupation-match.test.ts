import { afterEach, expect, test } from "vitest";
import { lookupTimeoutMs, pickResult, queryPlan } from "./occupation-match";

afterEach(() => delete process.env.NZWH_LOOKUP_TIMEOUT_SECONDS);

test("exact beats contains, case-insensitive and trimmed", () => {
  expect(pickResult(["Software Engineering Manager", "software engineer "], "Software Engineer")).toBe(1);
});
test("code prefix is stripped", () => {
  expect(pickResult(["L783400 Computer Consultancy Services"], "Computer Consultancy Services")).toBe(0);
  expect(pickResult(["Other", "L783400 Computer Consultancy Services"], "L783400 Computer Consultancy Services")).toBe(1);
});
test("contains fallback, no match and ambiguity", () => {
  expect(pickResult(["Senior Software Engineer"], "software engineer")).toBe(0);
  expect(pickResult(["Baker"], "Software Engineer")).toBe(-1);
  expect(pickResult(["A Software", "B Software"], "software")).toBe(-1);
  expect(pickResult([], "x")).toBe(-1);
});
test("queryPlan dedupes and appends first word", () => {
  expect(queryPlan("Computer Services", " IT | computer services |IT")).toEqual(["Computer Services", "IT", "Computer"]);
  expect(queryPlan("Computer")).toEqual(["Computer"]);
});
test("lookup timeout env is clamped", () => {
  expect(lookupTimeoutMs()).toBe(45000);
  process.env.NZWH_LOOKUP_TIMEOUT_SECONDS = "90";
  expect(lookupTimeoutMs()).toBe(90000);
  process.env.NZWH_LOOKUP_TIMEOUT_SECONDS = "1000";
  expect(lookupTimeoutMs()).toBe(45000);
});
