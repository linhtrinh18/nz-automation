import { afterEach, expect, test, vi } from "vitest";
import { runInNewContext } from "node:vm";
import { error as webdriverError } from "selenium-webdriver";
import { readFileSync } from "node:fs";
import {
  REMOTE_TRIGGER_FN, addFilled, buildFillSegmentScript, fastFillEnabled, isDisplayedAtomSource, isNavigationError,
  normalizeLabel, planSection, type FillEntry, type SegmentResult,
} from "./fast-fill";
import { steps } from "./fields";
import { applicable } from "./conditions";
import { applicationDataSchema } from "./application-data";

afterEach(() => { vi.unstubAllEnvs(); });

const sample = () => applicationDataSchema.parse(JSON.parse(readFileSync(new URL("../fixtures/sample.json", import.meta.url), "utf8")));

// --- Minimal fake DOM for the in-page fill script -------------------------------------------
interface FakeOptions {
  id: string;
  value?: string;
  shown?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  maxLength?: number;
  reject?: boolean;
  onchange?: string;
  options?: { value: string; label: string }[];
}
function dom(...specs: (FakeOptions & { tag: "input" | "textarea" | "select" })[]) {
  class Event { type: string; bubbles: boolean; constructor(type: string, init?: { bubbles?: boolean }) { this.type = type; this.bubbles = !!init?.bubbles; } }
  class FocusEvent extends Event {}
  class El {
    id: string; events: string[] = []; listeners: Record<string, (() => void)[]> = {};
    __shown: boolean; disabled: boolean; readOnly: boolean; maxLength: number; reject: boolean; _v: string;
    attributes: { name: string; value: string }[];
    constructor(o: FakeOptions) {
      this.id = o.id; this._v = o.value ?? ""; this.__shown = o.shown !== false; this.disabled = !!o.disabled;
      this.readOnly = !!o.readOnly; this.maxLength = o.maxLength ?? -1; this.reject = !!o.reject;
      this.attributes = o.onchange ? [{ name: "onchange", value: o.onchange }] : [];
    }
    matches(selector: string) { return selector === ":disabled" && this.disabled; }
    dispatchEvent(event: Event) { this.events.push(event.type); for (const l of this.listeners[event.type] ?? []) l(); return true; }
    addEventListener(type: string, l: () => void) { (this.listeners[type] ??= []).push(l); }
  }
  const accessor = { get(this: El) { return this._v; }, set(this: El, v: string) { if (!this.reject) this._v = v; }, configurable: true };
  class HTMLInputElement extends El {}
  Object.defineProperty(HTMLInputElement.prototype, "value", accessor);
  class HTMLTextAreaElement extends El {}
  Object.defineProperty(HTMLTextAreaElement.prototype, "value", accessor);
  class HTMLSelectElement extends El {
    options: { value: string; textContent: string }[] = [];
    get selectedIndex() { return this.options.findIndex((o) => o.value === this._v); }
  }
  Object.defineProperty(HTMLSelectElement.prototype, "value", {
    get(this: HTMLSelectElement) { return this._v; },
    set(this: HTMLSelectElement, v: string) { if (!this.reject && this.options.some((o) => o.value === v)) this._v = v; },
  });
  const elements = new Map<string, El>();
  const extra = new Map<string, unknown[]>();
  for (const spec of specs) {
    const e = spec.tag === "input" ? new HTMLInputElement(spec) : spec.tag === "textarea" ? new HTMLTextAreaElement(spec) : new HTMLSelectElement(spec);
    if (e instanceof HTMLSelectElement) e.options = (spec.options ?? []).map((o) => ({ value: o.value, textContent: o.label }));
    elements.set(spec.id, e);
  }
  const document = {
    getElementById: (id: string) => elements.get(id) ?? null,
    querySelectorAll: (selector: string) => extra.get(selector) ?? [],
    querySelector: (selector: string) => (extra.get(selector) ?? [])[0] ?? null,
  };
  /** Adds a Select2 v3 stub; `follow` updates the chosen label on change. */
  const select2 = (id: string, follow: boolean, chosenElement = true) => {
    const chosen = { textContent: "" };
    extra.set(`#s2id_${id} a.select2-choice`, [{ __shown: true }]);
    if (chosenElement) extra.set(`#s2id_${id} .select2-chosen`, [chosen]);
    const e = elements.get(id) as HTMLSelectElement;
    if (follow) e.addEventListener("change", () => {
      chosen.textContent = `\n  ${(e.options[e.selectedIndex]?.textContent ?? "").replace(/ /g, "\u00a0")}  `;
    });
    return chosen;
  };
  const context = { document, performance: { timeOrigin: 42 }, Event, FocusEvent, HTMLInputElement, HTMLTextAreaElement, HTMLSelectElement, Array, Object, String };
  const run = (entries: FillEntry[], start = 0): SegmentResult =>
    runInNewContext(`(function () { ${buildFillSegmentScript("function (e) { return e.__shown !== false; }")} }).apply(null, args)`, { ...context, args: [entries, start] });
  return { run, element: (id: string) => elements.get(id)!, select2 };
}
const entry = (key: string, kind: FillEntry["kind"], expected: string, applicableField = true): FillEntry =>
  ({ key, id: key, kind, expected, applicable: applicableField, colonsPrepared: false });
const blurSequence = ["input", "change", "focusout", "blur"];

// --- REMOTE_TRIGGER (review NIT 5) ------------------------------------------------------------
test.each([
  ["__doPostBack('x','')", true],
  ["WebForm_DoPostBack(new WebForm_PostBackOptions('x'))", true],
  ["this.form.submit()", true],
  ["fetch('/x')", true],
  ["new XMLHttpRequest()", true],
  ["navigator.sendBeacon('/x')", true],
  ["return validate()", false],
])("REMOTE_TRIGGER flags %s as %s", (value, expected) => {
  const e = { attributes: [{ name: "onchange", value }] };
  expect(runInNewContext(`(${REMOTE_TRIGGER_FN})(e)`, { e, Array, Object, String })).toBe(expected);
});

test("REMOTE_TRIGGER inspects jQuery-bound handlers", () => {
  const e = { attributes: [] };
  const jQuery = { _data: () => ({ change: [{ handler: function () { return "__doPostBack('a','')"; } }] }) };
  // String(handler) is the function source, which mentions __doPostBack.
  expect(runInNewContext(`(${REMOTE_TRIGGER_FN})(e)`, { e, jQuery, Array, Object, String })).toBe(true);
});

// --- In-page fill script ----------------------------------------------------------------------
test("text, textarea and date get input, change, focusout, blur and keep the value", () => {
  const page = dom({ tag: "input", id: "a" }, { tag: "textarea", id: "b" }, { tag: "input", id: "c" });
  const out = page.run([entry("a", "text", "SENTINEL-A"), entry("b", "textarea", "line1\nline2"), entry("c", "date", "01/02/2000")]);
  expect(out.stop).toBeNull();
  expect(out.results).toEqual([{ key: "a", status: "filled" }, { key: "b", status: "filled" }, { key: "c", status: "filled" }]);
  for (const id of ["a", "b", "c"]) expect((page.element(id) as unknown as { events: string[] }).events).toEqual(blurSequence);
  expect((page.element("b") as unknown as { value: string }).value).toBe("line1\nline2");
  expect(out.timeOrigin).toBe(42);
});

test("unchanged text gets no events", () => {
  const page = dom({ tag: "input", id: "a", value: "same" });
  const out = page.run([entry("a", "text", "same")]);
  expect(out.results).toEqual([{ key: "a", status: "unchanged" }]);
  expect(page.element("a").events).toEqual([]);
});

test("a native select fires events then yields at the next index", () => {
  const page = dom({ tag: "select", id: "s", options: [{ value: "", label: "" }, { value: "Yes", label: "Yes" }] }, { tag: "input", id: "t" });
  const out = page.run([entry("s", "select", "Yes"), entry("t", "text", "x")]);
  expect(out.results).toEqual([{ key: "s", status: "filled" }]);
  expect(out.stop).toEqual({ index: 1, reason: "yield" });
  expect(page.element("s").events).toEqual(blurSequence);
  expect(page.element("t").events).toEqual([]);
});

test("Select2: label normalization verifies; ignored change and missing label fall back", () => {
  const options = [{ value: "", label: "" }, { value: "NZ", label: "New  Zealand" }];
  const ok = dom({ tag: "select", id: "s", options });
  ok.select2("s", true);
  expect(ok.run([entry("s", "select", "NZ")]).results).toEqual([{ key: "s", status: "filled" }]);
  expect(ok.element("s").events).toEqual(["input", "change"]);

  const ignored = dom({ tag: "select", id: "s", options });
  ignored.select2("s", false);
  expect(ignored.run([entry("s", "select", "NZ")]).stop).toEqual({ index: 0, reason: "fallback", cause: "widget-mismatch" });

  const unknown = dom({ tag: "select", id: "s", options });
  unknown.select2("s", true, false);
  expect(unknown.run([entry("s", "select", "NZ")]).stop).toEqual({ index: 0, reason: "fallback", cause: "widget-unknown" });
});

test.each([
  ["option-missing", { tag: "select" as const, id: "f", options: [{ value: "A", label: "A" }] }, "select" as const, "B"],
  ["readonly", { tag: "input" as const, id: "f", readOnly: true }, "text" as const, "x"],
  ["too-long", { tag: "input" as const, id: "f", maxLength: 2 }, "text" as const, "xyz"],
  ["value-rejected", { tag: "input" as const, id: "f", reject: true }, "text" as const, "x"],
])("fallback cause %s", (cause, spec, kind, expected) => {
  expect(dom(spec).run([entry("f", kind, expected)]).stop).toEqual({ index: 0, reason: "fallback", cause });
});

test("Select2 clear goes to the standard entry", () => {
  const page = dom({ tag: "select", id: "s", value: "A", options: [{ value: "", label: "" }, { value: "A", label: "A" }] });
  page.select2("s", true);
  expect(page.run([entry("s", "select", "")]).stop).toEqual({ index: 0, reason: "fallback", cause: "select2-clear" });
  expect(page.element("s").events).toEqual([]);
});

test("a posting control stops with no write and no events", () => {
  const page = dom({ tag: "select", id: "s", value: "No", onchange: "javascript:setTimeout('__doPostBack(\\'s\\',\\'\\')', 0)", options: [{ value: "No", label: "No" }, { value: "Yes", label: "Yes" }] });
  const out = page.run([entry("s", "select", "Yes")]);
  expect(out.stop).toEqual({ index: 0, reason: "posting" });
  expect((page.element("s") as unknown as { value: string }).value).toBe("No");
  expect(page.element("s").events).toEqual([]);
});

test("missing, unavailable and inapplicable fields", () => {
  const page = dom({ tag: "input", id: "hidden", shown: false }, { tag: "input", id: "hiddenEmpty", shown: false }, { tag: "input", id: "inapplicable" });
  expect(page.run([entry("nope", "text", "x")]).stop).toEqual({ index: 0, reason: "missing" });
  expect(page.run([entry("hidden", "text", "x")]).stop).toEqual({ index: 0, reason: "unavailable-required" });
  const out = page.run([entry("hiddenEmpty", "text", ""), entry("inapplicable", "text", "x", false)]);
  expect(out.results).toEqual([{ key: "hiddenEmpty", status: "skipped-unavailable" }, { key: "inapplicable", status: "skipped-inapplicable" }]);
  expect(page.element("inapplicable").events).toEqual([]);
});

test("results carry only key and status, never values", () => {
  const page = dom({ tag: "input", id: "a" }, { tag: "input", id: "b", value: "SENTINEL-B" });
  const out = page.run([entry("a", "text", "SENTINEL-A"), entry("b", "text", "SENTINEL-B")]);
  for (const result of out.results) expect(Object.keys(result).sort()).toEqual(["key", "status"]);
  expect(JSON.stringify(out)).not.toMatch(/SENTINEL/);
});

// --- Pure helpers -----------------------------------------------------------------------------
test("planSection keeps order, drops lookups and inapplicable exemptionReason, flags colons", () => {
  const data = sample();
  const personal = planSection("personal", data);
  expect(personal.map((e) => e.key)).toEqual(Object.keys(steps.personal.fields));
  expect(personal.find((e) => e.key === "otherTitle")?.applicable).toBe(applicable(data, "personal", "otherTitle"));
  expect(planSection("occupation", data)).toEqual([]);
  data.personal.representedByAdviser = "Yes";
  data.adviser.adviserType = "1";
  expect(planSection("adviser", data).some((e) => e.key === "exemptionReason")).toBe(false);
  data.adviser.adviserType = "2";
  expect(planSection("adviser", data).some((e) => e.key === "exemptionReason")).toBe(true);
  data.health.details = "a:b";
  const details = planSection("health", data).find((e) => e.key === "details")!;
  expect(details).toMatchObject({ expected: "ab", colonsPrepared: true });
});

test("addFilled de-duplicates and normalizeLabel collapses whitespace", () => {
  const report = { filled: [] as string[] };
  addFilled(report, "a"); addFilled(report, "a"); addFilled(report, "b");
  expect(report.filled).toEqual(["a", "b"]);
  expect(normalizeLabel("\n  New\u00a0 Zealand ")).toBe("New Zealand");
});

test.each([[undefined, true], ["1", true], ["yes", true], ["0", false], ["false", false], [" FALSE ", false]])(
  "NZWH_FAST_FILL=%s → %s", (value, expected) => {
    if (value !== undefined) vi.stubEnv("NZWH_FAST_FILL", value);
    else delete process.env.NZWH_FAST_FILL;
    expect(fastFillEnabled()).toBe(expected);
  });

test("selenium's isDisplayed atom loads", () => {
  expect(isDisplayedAtomSource()).toMatch(/^function/);
});

test("isNavigationError recognizes only document-gone script failures", () => {
  expect(isNavigationError(new webdriverError.JavascriptError("javascript error: document unloaded while waiting for result"))).toBe(true);
  expect(isNavigationError(new webdriverError.WebDriverError("target frame detached"))).toBe(true);
  expect(isNavigationError(new webdriverError.NoSuchSessionError("navigation"))).toBe(false);
  expect(isNavigationError(new webdriverError.ScriptTimeoutError("navigat"))).toBe(false);
});

test("conditional controllers precede their dependents (segment yield ordering)", () => {
  const controllers: [string, string[], string[]][] = [
    ["personal", ["title"], ["otherTitle"]],
    ["health", ["renalDialysis", "tuberculosis", "cancer", "heartDisease", "disability", "hospitalisation", "residentialCare"], ["details"]],
    ["character", ["deported"], ["deportedDate", "deportedCountry"]],
    ["character", ["charged", "convicted", "underInvestigation", "excluded", "removed"], ["details"]],
    ["workingHoliday", ["beenToNz"], ["previousVisitDate"]],
    ["adviser", ["adviserType"], ["exemptionReason"]],
  ];
  for (const [section, sources, dependents] of controllers) {
    const order = Object.keys(steps[section].fields);
    for (const source of sources) for (const dependent of dependents)
      expect(order.indexOf(source), `${section}.${source}`).toBeLessThan(order.indexOf(dependent));
  }
  const data = sample();
  data.personal.representedByAdviser = "No";
  for (const key of Object.keys(steps.adviser.fields)) expect(applicable(data, "adviser", key)).toBe(false);
});
