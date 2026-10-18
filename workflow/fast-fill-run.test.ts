// Orchestration tests for fast entry in saveStep, with a mocked WebDriver (no browser).
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { Key, error as webdriverError } from "selenium-webdriver";
import type { WebDriver } from "selenium-webdriver";
import { saveStepForTest, withHooksForTest } from "./run";
import { steps } from "./fields";
import { applicationDataSchema } from "./application-data";
import { SavedValueVerificationError } from "./errors";
import { StopRequested } from "../lib/execution-controller";
import type { ExecutionEvent } from "../lib/execution-state";
import type { FillEntry, SegmentResult } from "./fast-fill";

const SAVE_ID = "ContentPlaceHolder1_wizardPageFooter_wizardPageNavigator_validateButton";
const URL_ = "https://onlineservices.immigration.govt.nz/WorkingHoliday/Wizard/Personal2.aspx?ApplicationId=fx";
const fields = steps.identification.fields;
const keys = Object.keys(fields);

function data() {
  const d = applicationDataSchema.parse(JSON.parse(readFileSync(new URL("../fixtures/sample.json", import.meta.url), "utf8")));
  d.identification.passportNumber = "SENTINEL-PASSPORT-7Q";
  d.identification.confirmPassportNumber = "SENTINEL-PASSPORT-7Q";
  return d;
}

type Segment = SegmentResult | ((entries: FillEntry[], start: number) => SegmentResult) | Error;
interface Fake {
  driver: WebDriver;
  values: Map<string, string>;
  log: string[];
  scripts: string[];
  segments: Segment[];
  reads: ({ timeOrigin?: number; values: (string | null)[] } | "page")[];
  present: boolean[];
  available: boolean[];
  posting: Set<string>;
  origin: { value: number };
  findById: string[];
  onPresent?: () => void;
}

function fake(): Fake {
  const values = new Map<string, string>();
  const state: Fake = {
    driver: undefined as unknown as WebDriver, values, log: [], scripts: [], segments: [], reads: [], present: [], available: [],
    posting: new Set(), origin: { value: 1 }, findById: [],
  };
  const fillAll = (entries: FillEntry[], start: number): SegmentResult => {
    const results = entries.slice(start).map((e) => {
      const unchanged = values.get(e.id) === e.expected;
      values.set(e.id, e.expected);
      return { key: e.key, status: unchanged ? "unchanged" as const : "filled" as const };
    });
    return { results, stop: null, timeOrigin: state.origin.value };
  };
  const element = (id: string) => {
    const kind = Object.values(fields).find((f) => f.id === id)?.kind;
    return {
      __id: id,
      isEnabled: async () => true,
      isDisplayed: async () => true,
      getAttribute: async () => values.get(id) ?? "",
      clear: async () => { values.set(id, ""); },
      sendKeys: async (...text: string[]) => {
        if (id === SAVE_ID && text[0] === Key.SPACE) { state.log.push("save"); state.origin.value++; return; }
        state.log.push(`sendKeys:${id}`);
        if (text[0] !== Key.TAB) values.set(id, (values.get(id) ?? "") + text.join(""));
      },
      findElements: async () => (kind === "select" ? ["", "1", "2", "3"] : []).map((value) => ({
        getAttribute: async () => value,
        click: async () => {
          state.log.push(`select:${id}`);
          const changed = values.get(id) !== value;
          values.set(id, value);
          if (state.posting.has(id) && changed) state.origin.value++;
        },
      })),
    };
  };
  const executeScript = vi.fn(async (script: string, ...args: unknown[]) => {
    state.scripts.push(script);
    if (script.includes("nzwh:fill-segment")) {
      const next = state.segments.shift() ?? fillAll;
      if (next instanceof Error) throw next;
      return typeof next === "function" ? next(args[0] as FillEntry[], args[1] as number) : next;
    }
    if (script.includes("nzwh:read-values")) {
      const next = state.reads.shift() ?? "page";
      const ids = args[0] as string[];
      if (next === "page") return { timeOrigin: state.origin.value, values: ids.map((id) => values.get(id) ?? null) };
      return { timeOrigin: next.timeOrigin ?? state.origin.value, values: next.values };
    }
    if (script.includes("nzwh:field-present")) { state.onPresent?.(); return state.present.shift() ?? true; }
    if (script.includes("nzwh:field-available")) return state.available.shift() ?? false;
    if (script.includes("nzwh:load-gap")) return null;
    if (script.includes("get_isInAsyncPostBack")) return true;
    if (script.includes("return performance.timeOrigin")) return state.origin.value;
    if (script.includes("loginForm:")) return { loginForm: false, rejected: false, authenticated: true };
    if (script.includes("site busy")) return false;
    if (script.includes("const challengePage")) return false;
    if (script.includes("document.readyState")) return "complete";
    if (script.includes("const mapped")) return [];
    if (script.includes("[errorlabel]")) return 0;
    if (script.includes("const risk")) return state.posting.has((args[0] as { __id: string }).__id);
    if (script.includes("return arguments[0].value")) return values.get((args[0] as { __id: string }).__id) ?? "";
    throw new Error(`unexpected script: ${script.slice(0, 60)}`);
  });
  const idOf = (locator: { value: string }) => /\[id="(.+)"\]/.exec(locator.value)?.[1]?.replace(/\\/g, "") ?? "";
  state.driver = {
    executeScript,
    getCurrentUrl: async () => URL_,
    get: async () => { state.log.push("navigate"); state.origin.value++; },
    findElements: async (locator: { value: string }) => {
      const id = idOf(locator);
      if (!id) return [];
      if (id !== SAVE_ID && id !== fields.passportNumber.id) state.findById.push(id);
      return [element(id)];
    },
    findElement: async (locator: { value: string }) => element(idOf(locator)),
    sendDevToolsCommand: async () => undefined,
  } as unknown as WebDriver;
  return state;
}

let events: ExecutionEvent[];
let logs: string[];
beforeEach(() => {
  events = [];
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...line: unknown[]) => { logs.push(line.join(" ")); });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const run = (f: Fake, fast = true, signal?: AbortSignal) =>
  withHooksForTest({ event: async (e) => { events.push(e); f.log.push(`event:${"state" in e ? e.state : e.type}`); }, checkpoint: async () => {} },
    () => saveStepForTest(f.driver, "identification", data(), fast), { signal });
const count = (f: Fake, marker: string) => f.scripts.filter((s) => s.includes(marker)).length;
const noSentinel = () => {
  expect(logs.join("\n")).not.toMatch(/SENTINEL|AA0000001|June/);
  expect(JSON.stringify(events)).not.toMatch(/SENTINEL/);
};

test("one batched segment fills the section, one SAVE and one batched reload read", async () => {
  const f = fake();
  f.values.set(fields.identificationType.id, "1"); // unchanged
  const report = await run(f);
  expect(report.filled).toEqual(keys);
  expect(report.persisted).toEqual(keys);
  expect(count(f, "nzwh:fill-segment")).toBe(1);
  expect(count(f, "nzwh:read-values")).toBe(2); // pre-SAVE re-check + post-reload verify
  expect(f.findById).toEqual([]);
  expect(f.log.filter((l) => l === "save")).toHaveLength(1);
  expect(events.map((e) => "state" in e && e.state)).toEqual(["possible", "accepted", "verified"]);
  const timing = logs.filter((l) => l.includes("timing fill"));
  expect(timing).toHaveLength(1);
  expect(timing[0]).toMatch(/^\[NZWH\] identification: timing fill \d+ms \(fast 5, unchanged 1, standard 0 in \d+ms, skipped 0, segments 1\), save \d+ms, verify \d+ms; load gap page n\/a\/save n\/a\/reload n\/ams\.$/);
  noSentinel();
});

test("a posting field uses the standard entry with possible emitted before the change", async () => {
  const f = fake();
  const typeId = fields.identificationType.id;
  f.posting.add(typeId);
  f.segments.push((entries) => {
    for (const e of entries.slice(0, 3)) f.values.set(e.id, e.expected);
    return { results: entries.slice(0, 3).map((e) => ({ key: e.key, status: "filled" })), stop: { index: 3, reason: "posting" }, timeOrigin: f.origin.value };
  });
  const starts: number[] = [];
  f.segments.push((entries, start) => { starts.push(start); for (const e of entries.slice(start)) f.values.set(e.id, e.expected); return { results: entries.slice(start).map((e) => ({ key: e.key, status: "filled" })), stop: null, timeOrigin: f.origin.value }; });
  const report = await run(f);
  expect(report.filled).toEqual(keys);
  expect(starts).toEqual([4]);
  const possible = f.log.indexOf("event:possible");
  expect(possible).toBeGreaterThanOrEqual(0);
  expect(possible).toBeLessThan(f.log.indexOf(`select:${typeId}`));
  noSentinel();
});

test("fallback runs the standard entry and logs only the cause", async () => {
  const f = fake();
  f.segments.push((entries) => ({ results: [], stop: { index: 0, reason: "fallback", cause: "value-rejected" }, timeOrigin: f.origin.value }));
  const report = await run(f);
  expect(report.filled).toEqual(keys);
  expect(f.log).toContain(`sendKeys:${fields.passportNumber.id}`);
  expect(logs).toContain("[NZWH] identification.passportNumber: fast entry not accepted (value-rejected); using standard entry.");
  noSentinel();
});

test("fallback on a missing option stops with today's message", async () => {
  const f = fake();
  f.segments.push({ results: [], stop: { index: 3, reason: "fallback", cause: "option-missing" }, timeOrigin: 1 });
  const d = data();
  d.identification.identificationType = "9";
  await expect(withHooksForTest({ event: async (e) => { events.push(e); }, checkpoint: async () => {} },
    () => saveStepForTest(f.driver, "identification", d, true))).rejects.toThrow("Option no longer exists.");
  expect(f.log).not.toContain("save");
});

test("yield resumes at the stop index without waiting", async () => {
  const f = fake();
  const starts: number[] = [];
  f.segments.push((entries) => { f.values.set(entries[0].id, entries[0].expected); return { results: [{ key: entries[0].key, status: "filled" }], stop: { index: 1, reason: "yield" }, timeOrigin: f.origin.value }; });
  f.segments.push((entries, start) => {
    starts.push(start);
    for (const e of entries.slice(start)) f.values.set(e.id, e.expected);
    return { results: entries.slice(start).map((e) => ({ key: e.key, status: "filled" })), stop: null, timeOrigin: f.origin.value };
  });
  await expect(run(f)).resolves.toMatchObject({ filled: keys });
  expect(starts).toEqual([1]);
  expect(count(f, "nzwh:field-present") + count(f, "nzwh:field-available")).toBe(0);
});

test("a missing field is awaited then filled; repeated misses stop", async () => {
  const f = fake();
  f.segments.push({ results: [], stop: { index: 0, reason: "missing" }, timeOrigin: 1 });
  f.present.push(false, false, true);
  await expect(run(f)).resolves.toMatchObject({ filled: keys });
  expect(count(f, "nzwh:field-present")).toBe(3);

  const g = fake();
  for (let i = 0; i < 5; i++) g.segments.push({ results: [], stop: { index: 2, reason: "missing" }, timeOrigin: 1 });
  await expect(run(g)).rejects.toThrow("Expected form control did not become available.");
  expect(g.log).not.toContain("save");
});

test("an unavailable required dependent times out with today's message and no SAVE", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
  const f = fake();
  f.segments.push({ results: [], stop: { index: 4, reason: "unavailable-required" }, timeOrigin: 1 });
  const result = run(f);
  const assertion = expect(result).rejects.toThrow("Required conditional field unavailable: identification.identificationIssued.");
  await vi.advanceTimersByTimeAsync(6000);
  await assertion;
  expect(f.log).not.toContain("save");
});

test("stop/cancel is honored inside the field wait", async () => {
  const f = fake();
  const controller = new AbortController();
  f.segments.push({ results: [], stop: { index: 0, reason: "missing" }, timeOrigin: 1 });
  f.present.push(false, false, false, false);
  f.onPresent = () => controller.abort();
  await expect(run(f, true, controller.signal)).rejects.toBeInstanceOf(StopRequested);
  expect(f.log).not.toContain("save");
});

test.each([
  ["a changed timeOrigin", { results: [], stop: null, timeOrigin: 99 } as Segment],
  ["a document-unloaded error", new webdriverError.JavascriptError("javascript error: document unloaded while waiting for result")],
])("unexpected reload (%s) emits possible and stops before SAVE", async (_, segment) => {
  const f = fake();
  f.segments.push(segment);
  await expect(run(f)).rejects.toThrow("Form reloaded unexpectedly while filling; stopped before SAVE.");
  expect(events.map((e) => "state" in e && e.state)).toEqual(["possible"]);
  expect(f.log).not.toContain("save");
});

test("pre-SAVE re-check refills once on mismatch, then stops if it persists", async () => {
  const f = fake();
  f.reads.push({ values: ["x", ...keys.slice(1).map(() => "")] });
  // First re-check mismatches; the second fill pass (default) restores everything.
  f.reads.push("page");
  await expect(run(f)).resolves.toMatchObject({ filled: keys });
  expect(count(f, "nzwh:fill-segment")).toBe(2);

  const g = fake();
  g.reads.push({ values: keys.map(() => "x") }, { values: keys.map(() => "x") });
  await expect(run(g)).rejects.toThrow("Readback mismatch: identification.passportNumber.");
  expect(g.log).not.toContain("save");
});

test("batched reload verification reports mismatches and missing fields", async () => {
  const f = fake();
  f.reads.push("page", { values: keys.map((_, i) => (i === 0 ? "changed" : "")) });
  const error = await run(f).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(SavedValueVerificationError);
  expect(logs.some((l) => l.startsWith("[NZWH] Saved-value mismatch identification.passportNumber: expectedLength="))).toBe(true);
  noSentinel();

  const g = fake();
  g.reads.push("page", { values: keys.map(() => null) });
  await expect(run(g)).rejects.toBeInstanceOf(webdriverError.NoSuchElementError);
});

test("kill switch (fast=false) uses the standard per-field entry only", async () => {
  const f = fake();
  const report = await run(f, false);
  expect(report.filled).toEqual(keys);
  expect(count(f, "nzwh:fill-segment")).toBe(0);
  expect(count(f, "nzwh:read-values")).toBe(0);
  expect(f.findById.filter((id) => id !== SAVE_ID)).toEqual(expect.arrayContaining(keys.slice(1).map((k) => fields[k].id)));
  expect(logs.find((l) => l.includes("timing fill"))).toMatch(/fast 0, unchanged 0, standard 6 in \d+ms, skipped 0, segments 0/);
  noSentinel();
});

test("fast postback wait skips the extra section re-wait", async () => {
  const f = fake();
  await run(f);
  // Legacy path waits for readyState again after SAVE's postback; fast path only once (after the reload).
  const fastReady = f.scripts.filter((s) => s === "return document.readyState").length;
  const g = fake();
  await run(g, false);
  const legacyReady = g.scripts.filter((s) => s === "return document.readyState").length;
  expect(fastReady).toBe(1);
  expect(legacyReady).toBe(2);
});
