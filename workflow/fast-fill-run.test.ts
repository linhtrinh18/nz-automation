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

type Segment = SegmentResult | ((entries: FillEntry[], start: number, early: { defer: boolean; restore: boolean }) => SegmentResult) | Error;
type Settle = { timeOrigin?: number; navigating?: boolean; settled?: boolean } | (() => void);
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
  /** Phase 2 fakes: doc-complete answers, settle reads, wait-field answers, fill-segment call flags. */
  complete: boolean[];
  settles: Settle[];
  fieldWaits: (string | (() => string))[];
  calls: { start: number; defer: boolean; restore: boolean }[];
  domReady?: () => boolean;
}

function fake(): Fake {
  const values = new Map<string, string>();
  const state: Fake = {
    driver: undefined as unknown as WebDriver, values, log: [], scripts: [], segments: [], reads: [], present: [], available: [],
    posting: new Set(), origin: { value: 1 }, findById: [], complete: [], settles: [], fieldWaits: [], calls: [],
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
      const flags = { defer: args[2] === true, restore: args[3] === true };
      state.calls.push({ start: args[1] as number, ...flags });
      state.log.push(`fill:${args[1]}:${flags.defer ? "early" : flags.restore ? "auth" : "fast"}`);
      const next = state.segments.shift() ?? fillAll;
      if (next instanceof Error) throw next;
      return typeof next === "function" ? next(args[0] as FillEntry[], args[1] as number, flags) : next;
    }
    if (script.includes("nzwh:doc-complete")) return state.complete.shift() ?? false;
    if (script.includes("nzwh:dom-ready")) return state.domReady?.() ?? true;
    if (script.includes("nzwh:settle")) {
      state.log.push("settle");
      const next = state.settles.shift() ?? {};
      if (typeof next === "function") { next(); return { timeOrigin: state.origin.value, navigating: false, settled: true }; }
      return { timeOrigin: next.timeOrigin ?? state.origin.value, navigating: next.navigating ?? false, settled: next.settled ?? true };
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
  const executeAsyncScript = vi.fn(async (script: string) => {
    state.scripts.push(script);
    const next = state.fieldWaits.shift() ?? "ready";
    return typeof next === "function" ? next() : next;
  });
  state.driver = {
    executeScript,
    executeAsyncScript,
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

// --- Phase 2: early fill orchestration ---------------------------------------------------------
const EARLY = { fast: true, early: true };
const runEarly = (f: Fake, signal?: AbortSignal) =>
  withHooksForTest({ event: async (e) => { events.push(e); f.log.push(`event:${"state" in e ? e.state : e.type}`); }, checkpoint: async () => {} },
    () => saveStepForTest(f.driver, "identification", data(), EARLY), { signal });
const typeId = fields.identificationType.id;
const passIndex = (f: Fake, kind: "early" | "auth") => f.calls.filter((c) => (kind === "early" ? c.defer : c.restore));
test("early pass fills before load, then settle and an authoritative pass precede SAVE", async () => {
  const f = fake();
  const report = await runEarly(f);
  expect(report.filled).toEqual(keys);
  expect(passIndex(f, "early").map((c) => c.start)).toEqual([0]);
  expect(passIndex(f, "auth").map((c) => c.start)).toEqual([0]);
  const firstSettle = f.log.indexOf("settle");
  expect(f.log.indexOf("fill:0:early")).toBeLessThan(firstSettle);
  expect(f.log.indexOf("fill:0:auth")).toBeGreaterThan(firstSettle + 1); // SETTLE_STABLE_POLLS reads
  expect(f.log.indexOf("save")).toBeGreaterThan(f.log.indexOf("fill:0:auth"));
  expect(count(f, "nzwh:dom-ready")).toBe(1); // verification reload uses the DOM-ready entry
  noSentinel();
});
test("a page already complete at entry skips the early pass", async () => {
  const f = fake();
  f.complete.push(true);
  await runEarly(f);
  expect(passIndex(f, "early")).toEqual([]);
  expect(passIndex(f, "auth").map((c) => c.start)).toEqual([0]);
});
test("finding 4: repeated early misses defer instead of stopping; the authoritative pass fills", async () => {
  const f = fake();
  for (let n = 0; n < 4; n++) f.segments.push({ results: [], stop: { index: 2, reason: "missing" }, timeOrigin: 1 });
  const report = await runEarly(f);
  expect(report.filled).toEqual(keys);
  expect(passIndex(f, "early").map((c) => c.start)).toEqual([0, 2, 2, 2, 3]);
  expect(count(f, "nzwh:wait-field")).toBe(3);
});
test("finding 3 and 2: an early posting stop ends the early pass; legacy posts only after settle, then the pass restarts", async () => {
  const f = fake();
  f.posting.add(typeId);
  const typeIndex = keys.indexOf("identificationType");
  f.segments.push({ results: [], stop: { index: typeIndex, reason: "posting" }, timeOrigin: 1 });
  f.segments.push((entries) => ({ results: [], stop: { index: typeIndex, reason: "posting" }, timeOrigin: f.origin.value }));
  const report = await runEarly(f);
  expect(report.filled).toEqual(keys);
  const firstSettle = f.log.indexOf("settle");
  expect(f.log.indexOf("event:possible")).toBeGreaterThan(firstSettle);
  expect(f.log.indexOf(`select:${typeId}`)).toBeGreaterThan(firstSettle);
  expect(passIndex(f, "early")).toHaveLength(1);
  expect(passIndex(f, "auth").map((c) => c.start)).toEqual([0, 0]); // restart from 0 on the new document
  const restart = f.log.indexOf("fill:0:auth", f.log.indexOf(`select:${typeId}`));
  expect(f.log.slice(f.log.indexOf(`select:${typeId}`), restart)).toContain("settle");
  expect(logs.find((l) => l.includes("timing fill"))).toMatch(/restarts 1\)/);
});
test("finding 2: more postback restarts than entries stop the section", async () => {
  const f = fake();
  f.posting.add(typeId);
  const typeIndex = keys.indexOf("identificationType");
  f.complete.push(true);
  for (let n = 0; n < 20; n++)
    f.segments.push(() => { f.values.set(typeId, ""); return { results: [], stop: { index: typeIndex, reason: "posting" }, timeOrigin: f.origin.value }; });
  await expect(runEarly(f)).rejects.toThrow("Form reloaded repeatedly while filling; stopped.");
  expect(passIndex(f, "auth")).toHaveLength(keys.length + 1);
  expect(f.log).not.toContain("save");
});
test("an early fallback ends the early pass; standard entry runs only in the authoritative pass", async () => {
  const f = fake();
  f.segments.push({ results: [], stop: { index: 0, reason: "fallback", cause: "value-rejected" }, timeOrigin: 1 });
  f.segments.push({ results: [], stop: { index: 0, reason: "fallback", cause: "value-rejected" }, timeOrigin: 1 });
  await runEarly(f);
  expect(passIndex(f, "early")).toHaveLength(1);
  expect(f.log.indexOf(`sendKeys:${fields.passportNumber.id}`)).toBeGreaterThan(f.log.indexOf("settle"));
});
test("deferred-then-posting: the authoritative sweep pass (start 0) runs before the legacy postback", async () => {
  const f = fake();
  f.posting.add(typeId);
  const typeIndex = keys.indexOf("identificationType");
  f.segments.push({ results: [], stop: { index: typeIndex, reason: "unavailable-required" }, timeOrigin: 1 });
  f.fieldWaits.push("loaded");
  f.segments.push((entries, start) => { for (const e of entries.slice(start)) f.values.set(e.id, e.expected); return { results: entries.slice(start).map((e) => ({ key: e.key, status: "filled" as const })), stop: null, timeOrigin: 1 }; });
  f.segments.push({ results: [], stop: { index: typeIndex, reason: "posting" }, timeOrigin: 1 });
  f.values.set(typeId, "");
  await runEarly(f);
  expect(passIndex(f, "early").map((c) => c.start)).toEqual([0, typeIndex + 1]);
  expect(f.log.indexOf("fill:0:auth")).toBeLessThan(f.log.indexOf(`select:${typeId}`));
});
test.each([
  ["the settle barrier", (f: Fake) => { f.settles.push({ timeOrigin: 99 }); }],
  ["an early write (delegated postback handler)", (f: Fake) => { f.segments.push({ results: [{ key: keys[0], status: "filled" }], stop: null, timeOrigin: 99 }); }],
])("an unexpected new document seen by %s emits possible and stops before SAVE", async (_, arrange) => {
  const f = fake();
  arrange(f);
  await expect(runEarly(f)).rejects.toThrow("Form reloaded unexpectedly while filling; stopped before SAVE.");
  expect(events.map((e) => "state" in e && e.state)).toEqual(["possible"]);
  expect(f.log).not.toContain("save");
});
test("review NIT 2: an early write whose delegated change handler calls __doPostBack stops before SAVE", async () => {
  const f = fake();
  // $(document).on('change', '#type', () => __doPostBack(...)): invisible to isPosting on the element,
  // so the early write goes through and the page posts back, giving the fill script a new document.
  f.segments.push((entries, start, flags) => {
    expect(flags).toEqual({ defer: true, restore: false });
    f.values.set(typeId, entries.find((e) => e.id === typeId)!.expected);
    f.origin.value++;
    return { results: [{ key: "identificationType", status: "filled" }], stop: null, timeOrigin: f.origin.value };
  });
  await expect(runEarly(f)).rejects.toThrow("Form reloaded unexpectedly while filling; stopped before SAVE.");
  expect(events.map((e) => "state" in e && e.state)).toEqual(["possible"]);
  expect(passIndex(f, "auth")).toEqual([]);
  expect(f.log.some((l) => l.startsWith("sendKeys:") || l.startsWith("select:"))).toBe(false);
  expect(f.log).not.toContain("save");
  noSentinel();
});
test("the settle barrier needs consecutive settled reads and resets on navigating", async () => {
  const f = fake();
  f.settles.push({}, { navigating: true }, { settled: false }, {}, {});
  await runEarly(f);
  const firstAuth = f.log.indexOf("fill:0:auth");
  expect(f.log.slice(0, firstAuth).filter((l) => l === "settle")).toHaveLength(5);
});
test("the settle barrier times out with its message", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
  const f = fake();
  for (let n = 0; n < 2000; n++) f.settles.push({ settled: false });
  const result = runEarly(f);
  const assertion = expect(result).rejects.toThrow("Page did not settle before SAVE; stopped.");
  await vi.advanceTimersByTimeAsync(31000);
  await assertion;
  expect(f.log).not.toContain("save");
});
test("stop/cancel is honored during an early field wait and during the settle barrier", async () => {
  const f = fake();
  const controller = new AbortController();
  f.segments.push({ results: [], stop: { index: 0, reason: "missing" }, timeOrigin: 1 });
  f.fieldWaits.push("pending", () => { controller.abort(); return "pending"; }, "pending");
  const started = Date.now();
  await expect(runEarly(f, controller.signal)).rejects.toBeInstanceOf(StopRequested);
  expect(Date.now() - started).toBeLessThan(600);
  const g = fake();
  const second = new AbortController();
  g.settles.push(() => second.abort());
  await expect(runEarly(g, second.signal)).rejects.toBeInstanceOf(StopRequested);
  expect(g.log).not.toContain("save");
});
test("NZWH_EARLY_FILL=0 mode ({ fast: true, early: false }) runs no phase-2 scripts", async () => {
  const f = fake();
  await withHooksForTest({ event: async () => {}, checkpoint: async () => {} },
    () => saveStepForTest(f.driver, "identification", data(), { fast: true, early: false }));
  for (const tag of ["nzwh:dom-ready", "nzwh:settle", "nzwh:wait-field", "nzwh:doc-complete"]) expect(count(f, tag), tag).toBe(0);
  expect(f.calls.every((c) => !c.defer && !c.restore)).toBe(true);
  expect(logs.find((l) => l.includes("timing fill"))).not.toMatch(/early|settle/);
});
test("early section entry keeps the combined ready + first-field budget", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
  const f = fake();
  let navigatedAt = Infinity;
  const get = f.driver.get.bind(f.driver);
  (f.driver as unknown as { get: () => Promise<void> }).get = async () => { await get(""); navigatedAt = Date.now(); };
  f.domReady = () => Date.now() - navigatedAt > 25000;
  const ok = runEarly(f);
  await vi.advanceTimersByTimeAsync(26000);
  await expect(ok).resolves.toMatchObject({ filled: keys });
  const g = fake();
  g.domReady = () => false;
  const late = withHooksForTest({ event: async () => {}, checkpoint: async () => {} },
    () => saveStepForTest(g.driver, "identification", data(), EARLY));
  const assertion = expect(late).rejects.toBeInstanceOf(webdriverError.TimeoutError);
  await vi.advanceTimersByTimeAsync(49000);
  expect(g.log).not.toContain("never");
  await vi.advanceTimersByTimeAsync(2000);
  await assertion;
});
test("the early timing line adds early, restarts and settle, and still carries no values", async () => {
  const f = fake();
  await runEarly(f);
  const timing = logs.find((l) => l.includes("timing fill"))!;
  expect(timing).toMatch(/^\[NZWH\] identification: timing fill \d+ms \(fast \d+, unchanged \d+, standard 0 in \d+ms, skipped 0, segments \d+, early 6, restarts 0\), settle \d+ms, save \d+ms, verify \d+ms; load gap page n\/a\/save n\/a\/reload n\/ams\.$/);
  noSentinel();
});
test("E5: authoritative pass identical to the early pass runs one settle barrier; a differing write runs two", async () => {
  const same = fake();
  await runEarly(same);
  const settleReads = same.log.filter((l) => l === "settle").length;
  expect(settleReads).toBeGreaterThan(0);
  const differing = fake();
  // The early segment writes nothing, so the authoritative pass writes values the early pass did not.
  differing.segments.push({ results: [], stop: null, timeOrigin: 1 });
  await runEarly(differing);
  expect(differing.log.filter((l) => l === "settle").length).toBe(settleReads * 2);
});
test("off trace: SAVE, then reload, then batched readback; possible/accepted/verified in order", async () => {
  const f = fake();
  await run(f);
  expect(f.log.filter((l) => ["save", "navigate"].includes(l))).toEqual(["save", "navigate"]);
  const order = ["event:possible", "save", "event:accepted", "navigate", "event:verified"].map((l) => f.log.indexOf(l));
  expect(order.every((position) => position >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  expect(count(f, "nzwh:read-values")).toBe(2);
});
const preSave = (f: Fake, answer: unknown) => {
  const base = f.driver.executeScript.bind(f.driver) as (script: string, ...args: unknown[]) => Promise<unknown>;
  (f.driver as unknown as { executeScript: unknown }).executeScript = async (script: string, ...args: unknown[]) =>
    script.includes("nzwhPreSave") ? (f.scripts.push(script), answer) : base(script, ...args);
};
test("E6 combined pre-SAVE answer: unmapped fields stop before SAVE", async () => {
  const f = fake();
  preSave(f, { nzwhPreSave: 1, unmapped: ["ContentPlaceHolder1_extra"], href: URL_, saveId: SAVE_ID });
  await expect(run(f)).rejects.toThrow("Additional identification branch fields need mapping before SAVE: ContentPlaceHolder1_extra.");
  expect(f.log).not.toContain("save");
});
test("E6 combined pre-SAVE answer: a changed URL stops before SAVE", async () => {
  const f = fake();
  preSave(f, { nzwhPreSave: 1, unmapped: [], href: "https://onlineservices.immigration.govt.nz/other", saveId: SAVE_ID });
  await expect(run(f)).rejects.toThrow("Unexpected navigation before SAVE.");
  expect(f.log).not.toContain("save");
});
test("E6 combined pre-SAVE answer: the chosen SAVE id is used directly; no id falls back to the footer lookup", async () => {
  for (const saveId of [SAVE_ID, null]) {
    const f = fake();
    preSave(f, { nzwhPreSave: 1, unmapped: [], href: URL_, saveId });
    await run(f);
    expect(f.log.filter((l) => l === "save")).toHaveLength(1);
  }
});
