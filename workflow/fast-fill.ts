// Fast entry for wizard sections: one in-page script per segment instead of
// per-field find/clear/type/verify round trips. Results carry keys and status
// codes only; values travel to the page as script arguments and are never returned.
import { createRequire } from "node:module";
import type { WebDriver } from "selenium-webdriver";
import { steps, type FieldDefinition } from "./fields";
import { applicable } from "./conditions";
import { expectedFieldValue } from "./saved-values";
import type { ApplicationData, SectionName } from "./application-data";

/** Default poll interval for page waits outside the fill flow (today's value). */
export const PAGE_POLL_MS = 200;
/** Poll interval for fill-flow condition waits (section ready, postbacks, fields). */
export const FAST_POLL_MS = 50;
/** Limit for a section's first field or any expected field to appear. */
export const SECTION_WAIT_MS = 20000;
/** Limit for a SAVE or AutoPostBack round trip to land a new complete document. */
export const POSTBACK_WAIT_MS = 30000;
/** Limit for document.readyState to reach "complete". */
export const READY_WAIT_MS = 30000;
/** Limit for Select2 results to render after opening the widget. */
export const SELECT2_RESULTS_WAIT_MS = 5000;
/** Limit for a conditional dependent field to become available after its controller changes. */
export const DEPENDENT_FIELD_TIMEOUT_MS = 5000;
/** Times one field may stop a segment (missing/unavailable) before the run stops. */
export const MAX_FIELD_RESUMES = 3;
/** Limit for the final submission page to change after a click. */
export const SUBMISSION_CHANGE_WAIT_MS = 30000;

/** Kill switch: NZWH_FAST_FILL=0 (or false) restores the standard per-field entry. */
export function fastFillEnabled(): boolean {
  const raw = process.env.NZWH_FAST_FILL?.trim().toLowerCase();
  return raw !== "0" && raw !== "false";
}

let atomSource: string | null | undefined;
/** Selenium's own isDisplayed atom, so in-page availability matches WebElement.isDisplayed(). */
export function isDisplayedAtomSource(): string | null {
  if (atomSource !== undefined) return atomSource;
  try {
    const atom: unknown = createRequire(import.meta.url)("selenium-webdriver/lib/atoms/is-displayed.js");
    atomSource = typeof atom === "function" ? String(atom) : null;
  } catch {
    atomSource = null;
  }
  return atomSource;
}

/** In-page predicate: does this control post the form (AutoPostBack or network handlers)? */
export const REMOTE_TRIGGER_FN = String.raw`function (e) {
  const risk = /__doPostBack|WebForm_DoPostBack|\.submit\s*\(|ajax|fetch\s*\(|XMLHttpRequest|sendBeacon/i;
  const inline = Array.from(e.attributes).filter(a => a.name.startsWith('on')).map(a => a.value);
  const bound = typeof jQuery === 'undefined' ? [] : Object.values(jQuery._data(e, 'events') || {}).flatMap(list => list.map(h => String(h.handler)));
  return [...inline, ...bound].some(source => risk.test(source));
}`;

export const normalizeLabel = (s: string): string => s.replace(/\s+/g, " ").trim();

export interface FillEntry {
  key: string;
  id: string;
  kind: FieldDefinition["kind"];
  expected: string;
  applicable: boolean;
  colonsPrepared: boolean;
}

/** Fill plan in definition order with today's pre-skips (lookups, inapplicable exemptionReason). */
export function planSection(name: SectionName, data: ApplicationData): FillEntry[] {
  return Object.entries(steps[name].fields).flatMap(([key, field]) => {
    if (field.lookup) return [];
    const isApplicable = applicable(data, name, key);
    if (name === "adviser" && key === "exemptionReason" && !isApplicable) return [];
    const source = data[name][key];
    const expected = expectedFieldValue(name, key, source);
    return [{ key, id: field.id, kind: field.kind, expected, applicable: isApplicable, colonsPrepared: expected !== source }];
  });
}

export function addFilled(report: { filled: string[] }, key: string): void {
  if (!report.filled.includes(key)) report.filled.push(key);
}

export type FillStatus = "filled" | "unchanged" | "skipped-unavailable" | "skipped-inapplicable";
export type StopReason = "missing" | "unavailable-required" | "posting" | "fallback" | "yield";
export type FallbackCause = "too-long" | "readonly" | "markup-unknown" | "value-rejected" | "option-missing" | "select2-clear" | "widget-mismatch" | "widget-unknown";
export interface SegmentResult {
  results: { key: string; status: FillStatus }[];
  stop: { index: number; reason: StopReason; cause?: FallbackCause } | null;
  timeOrigin: number;
}

/**
 * Fills entries from `start` in order until a field needs Node (missing, unavailable,
 * posting, fallback) or a changed select yields so its handlers run before dependents.
 * Never clicks or submits anything.
 */
export function buildFillSegmentScript(atom: string): string {
  return String.raw`/* nzwh:fill-segment */
const isShown = (${atom});
const isPosting = (${REMOTE_TRIGGER_FN});
const entries = arguments[0], start = arguments[1];
const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
const results = [];
const fire = (e, type, focus) => e.dispatchEvent(focus ? new FocusEvent(type, { bubbles: type === 'focusout' }) : new Event(type, { bubbles: true }));
const done = (stop) => ({ results, stop, timeOrigin: performance.timeOrigin });
for (let i = start; i < entries.length; i++) {
  const entry = entries[i], expected = entry.expected;
  const e = document.getElementById(entry.id);
  if (!e) return done({ index: i, reason: 'missing' });
  const available = !e.matches(':disabled') && (entry.kind === 'select' || isShown(e));
  if (!available) {
    if (entry.applicable && expected) return done({ index: i, reason: 'unavailable-required' });
    results.push({ key: entry.key, status: 'skipped-unavailable' });
    continue;
  }
  if (!entry.applicable && expected) { results.push({ key: entry.key, status: 'skipped-inapplicable' }); continue; }
  const choices = document.querySelectorAll('#s2id_' + entry.id + ' a.select2-choice');
  const widget = choices.length === 1 && isShown(choices[0]);
  const chosen = () => document.querySelector('#s2id_' + entry.id + ' .select2-chosen');
  const selectedLabel = () => { const o = e.options && e.options[e.selectedIndex]; return o ? norm(o.textContent) : ''; };
  if (e.value === expected && (!widget || expected === '' || (chosen() && norm(chosen().textContent) === selectedLabel()))) {
    results.push({ key: entry.key, status: 'unchanged' });
    continue;
  }
  if (isPosting(e)) return done({ index: i, reason: 'posting' });
  let cause = null;
  if (entry.kind === 'select') {
    if (!(e instanceof HTMLSelectElement)) cause = 'markup-unknown';
    else if (widget && expected === '') cause = 'select2-clear';
    else if (!Array.from(e.options).some(o => o.value === expected)) cause = 'option-missing';
    else {
      e.value = expected;
      fire(e, 'input'); fire(e, 'change');
      if (!widget) { fire(e, 'focusout', true); fire(e, 'blur', true); }
      if (e.value !== expected) cause = 'value-rejected';
      else if (widget) {
        const label = chosen();
        if (!label) cause = 'widget-unknown';
        else if (norm(label.textContent) !== selectedLabel()) cause = 'widget-mismatch';
      }
    }
  } else {
    const proto = e instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : e instanceof HTMLInputElement ? HTMLInputElement.prototype : null;
    if (!proto) cause = 'markup-unknown';
    else if (e.readOnly) cause = 'readonly';
    else if (e.maxLength >= 0 && expected.length > e.maxLength) cause = 'too-long';
    else {
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, expected);
      fire(e, 'input'); fire(e, 'change'); fire(e, 'focusout', true); fire(e, 'blur', true);
      if (e.value !== expected) cause = 'value-rejected';
    }
  }
  if (cause) return done({ index: i, reason: 'fallback', cause });
  results.push({ key: entry.key, status: 'filled' });
  if (entry.kind === 'select') return done({ index: i + 1, reason: 'yield' });
}
return done(null);`;
}

export const READ_FIELD_VALUES_JS = `/* nzwh:read-values */
return { timeOrigin: performance.timeOrigin, values: arguments[0].map(id => { const e = document.getElementById(id); return e ? e.value : null; }) };`;

export const FIELD_PRESENT_JS = `/* nzwh:field-present */
return !!document.getElementById(arguments[0]);`;

export function buildFieldAvailableScript(atom: string): string {
  return `/* nzwh:field-available */
const isShown = (${atom});
const e = document.getElementById(arguments[0]), kind = arguments[1];
return !!e && !e.matches(':disabled') && (kind === 'select' || isShown(e));`;
}

export const LOAD_GAP_JS = `/* nzwh:load-gap */
const n = performance.getEntriesByType('navigation')[0];
return n && n.loadEventStart > 0 ? Math.round(n.loadEventStart - n.domContentLoadedEventEnd) : null;`;

const NAVIGATION_ERROR = /document unloaded|target frame detached|execution context was destroyed|no such execution context|navigat/i;
/** True when a script failed because the document went away (reload/navigation). */
export function isNavigationError(error: unknown): boolean {
  return error instanceof Error &&
    (error.name === "JavascriptError" || error.name === "WebDriverError") &&
    NAVIGATION_ERROR.test(error.message);
}

const scripts = new Map<string, { fill: string; available: string }>();
function scriptsFor(atom: string) {
  let built = scripts.get(atom);
  if (!built) scripts.set(atom, built = { fill: buildFillSegmentScript(atom), available: buildFieldAvailableScript(atom) });
  return built;
}

export function readTimeOrigin(driver: WebDriver): Promise<number> {
  return driver.executeScript<number>("return performance.timeOrigin");
}

export function fillSegment(driver: WebDriver, atom: string, entries: FillEntry[], start: number): Promise<SegmentResult> {
  return driver.executeScript<SegmentResult>(scriptsFor(atom).fill, entries, start);
}

export function readFieldValues(driver: WebDriver, ids: string[]): Promise<{ timeOrigin: number; values: (string | null)[] }> {
  return driver.executeScript(READ_FIELD_VALUES_JS, ids);
}

export function fieldPresent(driver: WebDriver, id: string): Promise<boolean> {
  return driver.executeScript<boolean>(FIELD_PRESENT_JS, id);
}

export function fieldAvailable(driver: WebDriver, atom: string, id: string, kind: FieldDefinition["kind"]): Promise<boolean> {
  return driver.executeScript<boolean>(scriptsFor(atom).available, id, kind);
}

/** DOMContentLoaded→load gap of the current document in ms (Navigation Timing), or null. */
export async function readLoadGap(driver: WebDriver): Promise<number | null> {
  try {
    const gap = await driver.executeScript<number | null>(LOAD_GAP_JS);
    return typeof gap === "number" ? gap : null;
  } catch {
    return null;
  }
}
