import { expect, test } from "vitest";
import { ExecutionController } from "../lib/execution-controller";
import type { ExecutionEvent, Job } from "../lib/execution-state";
import { loadTimeRescan, mayPostNext, pipelineSnapshot, type SectionTab } from "./tab-pipeline";

const ctx = { fast: true, early: true, loginOnly: false };
const snap = (env: Record<string, string>, over = {}) => pipelineSnapshot(env, { ...ctx, ...over });

test("default is off; valid values, case and spaces", () => {
  expect(snap({}).mode).toBe("off");
  expect(snap({ NZWH_TAB_PIPELINE: " SAVE " }).mode).toBe("save");
  expect(snap({ NZWH_TAB_PIPELINE: "verify" })).toMatchObject({ mode: "verify", barrier: "verified" });
});
test("invalid mode falls back to off without echoing the value", () => {
  const result = snap({ NZWH_TAB_PIPELINE: "secret-x" });
  expect(result.mode).toBe("off");
  expect(result.log.join("\n")).toContain("Unknown NZWH_TAB_PIPELINE value; using off.");
  expect(result.log.join("\n")).not.toContain("secret-x");
});
test.each([
  ["attach", { attachPort: 9222 }], ["fast fill off", { fast: false }],
  ["early fill off", { early: false }], ["login only", { loginOnly: true }],
])("forced off: %s", (_, over) => {
  const result = snap({ NZWH_TAB_PIPELINE: "save" }, over);
  expect(result.mode).toBe("off");
  expect(result.log.join("\n")).toContain("forced off");
});
test("barrier default, valid and invalid", () => {
  expect(snap({ NZWH_TAB_PIPELINE: "save", NZWH_PIPELINE_BARRIER: "accepted" }).barrier).toBe("accepted");
  expect(snap({ NZWH_TAB_PIPELINE: "save", NZWH_PIPELINE_BARRIER: "zzz" }).barrier).toBe("verified");
  expect(snap({ NZWH_PIPELINE_BARRIER: "accepted" }).barrier).toBe("verified");
});

const tab = (phase: SectionTab["phase"]): SectionTab => ({ name: "personal", handle: "h1", phase });
function recorder() {
  const events: ExecutionEvent[] = [];
  return { events, emit: async (event: ExecutionEvent) => { events.push(event); } };
}

test("clean load-time re-scan emits persistence accepted and moves to accepted", async () => {
  const { events, emit } = recorder();
  const t = tab("domready");
  expect(await loadTimeRescan(t, async () => 0, emit)).toBe(true);
  expect(t.phase).toBe("accepted");
  expect(events).toEqual([{ type: "persistence", state: "accepted", section: "personal", background: true }]);
});

test("DOM-ready alone never accepts: barrier accepted still blocks N+1 SAVE", () => {
  const n = tab("domready");
  expect(mayPostNext([n], n, "accepted")).toBe(false);
  expect(mayPostNext([n], n, "verified")).toBe(false);
  n.phase = "accepted";
  expect(mayPostNext([n], n, "accepted")).toBe(true);
  expect(mayPostNext([n], n, "verified")).toBe(false);
  n.phase = "done"; n.outcome = { kind: "verified" };
  expect(mayPostNext([n], n, "verified")).toBe(true);
  expect(mayPostNext([{ ...tab("posted") }, n], n, "verified")).toBe(false);
});

test.each(["verified", "accepted"] as const)("load-time [errorlabel]: failed, not accepted, N+1 gets no SAVE (barrier %s)", async barrier => {
  const { events, emit } = recorder();
  const n = tab("domready");
  expect(await loadTimeRescan(n, async () => 2, emit)).toBe(false);
  expect(events.some(e => e.type === "persistence")).toBe(false);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ type: "section-result", status: "failed", section: "personal" });
  expect(n.outcome?.kind).toBe("stop");
  expect(mayPostNext([n], n, barrier)).toBe(false);
});

test("controller maps load-time failure (persistence still possible) to failed, not saved_unverified", async () => {
  const job = { outcomes: [{ key: "baseline:personal", status: "pending" }, { key: "baseline:adviser", status: "pending" }], status: "running" } as unknown as Job;
  const store = { write: async () => {}, command: async () => ({ action: "none" }), release: async () => {} };
  const controller = new ExecutionController(store as never, job);
  await controller.event({ type: "section-start", section: "personal", scenario: "baseline" });
  await controller.event({ type: "persistence", state: "possible", section: "personal" });
  await controller.event({ type: "section-result", status: "failed", detail: "x", section: "personal", background: true });
  expect(job.outcomes[0].status).toBe("failed");
  expect(job.outcomes[1].status).toBe("pending");
});

test("controller: accepted then failed becomes saved_unverified; complete finalizes every running item", async () => {
  const job = { outcomes: [{ key: "baseline:personal", status: "pending" }, { key: "baseline:adviser", status: "pending" }], status: "running" } as unknown as Job;
  const store = { write: async () => {}, command: async () => ({ action: "none" }), release: async () => {} };
  const controller = new ExecutionController(store as never, job);
  await controller.event({ type: "section-start", section: "personal", scenario: "baseline" });
  await controller.event({ type: "section-start", section: "adviser", scenario: "baseline" });
  await controller.event({ type: "persistence", state: "accepted", section: "personal", background: true });
  await controller.event({ type: "section-result", status: "failed", detail: "x", section: "personal", background: true });
  expect(controller.job.outcomes[0].status).toBe("saved_unverified");
  expect(controller.job.outcomes[1].status).toBe("running");
  await controller.finish("failed", "m");
  expect(controller.job.outcomes[1].status).toBe("failed");
});

// ---- scheduler / section runner with a fake tab driver ----
import { StopRequested } from "../lib/execution-controller";
import {
  PipelineAbort, PipelineDowngrade, TabScheduler, runPipelinedSections, type Barrier, type Readback, type ReloadPoll, type TabOps,
} from "./tab-pipeline";
import type { SectionName } from "./application-data";

interface Script { flagged?: number; pending?: number; poll?: ReloadPoll; readback?: Readback }
function harness(names: SectionName[], options: { mode?: "verify" | "save"; barrier?: Barrier; script?: Partial<Record<SectionName, Script>>; prefetchCommand?: "pause" | "stop"; failBoundaryAt?: SectionName } = {}) {
  const log: string[] = [];
  const events: ExecutionEvent[] = [];
  let time = 0;
  let current = "main";
  let handles = 0;
  const left: Record<string, number> = {};
  const script = (name: string) => options.script?.[name as SectionName] ?? {};
  const ops: TabOps = {
    newTab: async () => { handles++; current = "extra"; log.push("newTab"); return "extra"; },
    closeTab: async () => { log.push("closeTab"); },
    focus: async (handle) => { current = handle; log.push(`focus:${handle}`); },
    rescan: async (tab) => script(tab.name).flagged ?? 0,
    startReload: async (tab) => { log.push(`reload:${tab.name}`); left[tab.name] = script(tab.name).pending ?? 0; },
    pollReload: async (tab) => {
      if (left[tab.name]-- > 0) return "pending";
      return script(tab.name).poll ?? "ready";
    },
    readback: async (tab) => script(tab.name).readback ?? { kind: "ok" },
    emit: async (event) => { events.push(event); log.push(`event:${event.type}:${"state" in event ? event.state : "status" in event ? event.status : ""}:${"section" in event ? event.section : ""}`); },
    sleep: async (ms) => { time += ms; },
    now: () => time,
  };
  const outcomes: string[] = [];
  const scheduler = new TabScheduler(ops, "main", {
    onOutcome: async (tab) => { outcomes.push(`${tab.name}:${tab.outcome?.kind}`); log.push(`outcome:${tab.name}:${tab.outcome?.kind}`); },
  }, { verifyTimeoutMs: 10_000, pollMs: 10 });
  const foregroundViolations: string[] = [];
  const run = () => runPipelinedSections(names, {
    scheduler, mode: options.mode ?? "save", barrier: options.barrier ?? "verified",
    boundary: async (name, prefetch) => {
      log.push(`boundary:${name}:${prefetch ? "prefetch" : "real"}`);
      if (prefetch && options.prefetchCommand) return options.prefetchCommand;
      if (!prefetch && options.failBoundaryAt === name) throw new StopRequested();
      return "continue";
    },
    begin: async (name) => { log.push(`begin:${name}`); },
    load: async (name, handle) => { log.push(`load:${name}:${handle}`); },
    fill: async (name, tab, ctl) => {
      if (scheduler.focused !== tab.handle) foregroundViolations.push(`${name}: focused ${scheduler.focused} != ${tab.handle}`);
      await ctl.drain();
      await ctl.beforePost();
      log.push(`SAVE:${name}`);
      if (scheduler.focused !== tab.handle) foregroundViolations.push(`${name}@save: focused ${scheduler.focused} != ${tab.handle}`);
      return {};
    },
    skip: async (name) => { log.push(`skip:${name}`); },
    log: () => {},
  });
  return { log, events, outcomes, scheduler, run, foregroundViolations, current: () => current, handles: () => handles };
}
const saves = (log: string[]) => log.filter(entry => entry.startsWith("SAVE:"));

test("save mode: one SAVE per section, in order, tabs alternate, foreground is always the section's tab", async () => {
  const h = harness(["identification", "health", "character"]);
  const result = await h.run();
  expect(result.remaining).toEqual([]);
  expect(saves(h.log)).toEqual(["SAVE:identification", "SAVE:health", "SAVE:character"]);
  expect(h.outcomes).toEqual(["identification:verified", "health:verified", "character:verified"]);
  expect(h.foregroundViolations).toEqual([]);
  expect(h.handles()).toBe(1); // one reused extra tab
  expect(h.log).toContain("load:character:main"); // N+2 reuses slot A
});

test("barrier verified: N+1 SAVE only after N reached an outcome; the last SAVE waits for every earlier tab", async () => {
  const h = harness(["identification", "health"], { script: { identification: { pending: 3 } } });
  await h.run();
  expect(h.log.indexOf("outcome:identification:verified")).toBeLessThan(h.log.indexOf("SAVE:health"));
});

test("barrier accepted: N+1 SAVE after N's persistence accepted event, not before; DOM-ready alone is not enough", async () => {
  const h = harness(["identification", "health", "character"], { barrier: "accepted", script: { identification: { pending: 5 }, health: { pending: 2 } } });
  await h.run();
  const accepted = h.log.indexOf("event:persistence:accepted:identification");
  expect(accepted).toBeGreaterThan(-1);
  expect(accepted).toBeLessThan(h.log.indexOf("SAVE:health"));
  // the final section still waits for every earlier tab
  expect(h.log.indexOf("outcome:health:verified")).toBeLessThan(h.log.indexOf("SAVE:character"));
  expect(h.log.indexOf("outcome:identification:verified")).toBeLessThan(h.log.indexOf("SAVE:character"));
});

test.each(["verified", "accepted"] as const)("load-time [errorlabel] on N (barrier %s): failed not unverified, no accepted event, N+1 never posted", async barrier => {
  const h = harness(["identification", "health", "character"], { barrier, script: { identification: { flagged: 2 } } });
  await expect(h.run()).rejects.toBeInstanceOf(PipelineAbort);
  expect(saves(h.log)).toEqual(["SAVE:identification"]);
  expect(h.log.some(entry => entry.startsWith("event:persistence:accepted:identification"))).toBe(false);
  expect(h.events.filter(e => e.type === "section-result")).toMatchObject([{ status: "failed", section: "identification" }]);
  if (h.log.includes("begin:health")) expect(h.log).toContain("skip:health"); // prefetched but never posted: abandoned as skipped
  expect(h.log).not.toContain("SAVE:health");
});

test("a mismatch in N is reported read-only and the run continues (like the sequential path)", async () => {
  const h = harness(["identification", "health"], { script: { identification: { readback: { kind: "mismatch", fields: ["identification.x"], checked: 1 } } } });
  await h.run();
  expect(h.outcomes).toEqual(["identification:unverified", "health:verified"]);
  expect(saves(h.log)).toHaveLength(2);
});

test("busy reload in N after N+1 was prefetched downgrades: N+1 restarts sequentially with zero SAVEs", async () => {
  const h = harness(["identification", "health", "character"], { script: { identification: { poll: "busy" } } });
  const result = await h.run();
  expect(result.downgraded).toBe("busy");
  expect(saves(h.log)).toEqual(["SAVE:identification"]);
  expect(result.remaining.map(item => item.name)).toEqual(["health", "character"]);
  expect(result.remaining[0].started).toBe(true); // prefetched: section-start already emitted
});

test("denied/login/captcha on a background reload raise a downgrade for the owning tab to finish read-only", async () => {
  const h = harness(["identification", "health"], { script: { identification: { poll: "denied" } } });
  const result = await h.run();
  expect(result.downgraded).toBe("denied");
  expect(h.scheduler.tabs[0].phase).not.toBe("done");
});

test("pause during a prefetch cancels it before anything is emitted for N+1; N verifies, then the real boundary decides", async () => {
  const h = harness(["identification", "health"], { prefetchCommand: "pause" });
  await h.run();
  expect(h.log.indexOf("boundary:health:prefetch")).toBeLessThan(h.log.indexOf("SAVE:identification"));
  expect(h.log.indexOf("begin:health")).toBeGreaterThan(h.log.indexOf("SAVE:identification"));
  expect(h.log.indexOf("boundary:health:real")).toBeGreaterThan(h.log.indexOf("SAVE:identification"));
});

test("verify mode starts N+1 only after N's load-time re-scan passed", async () => {
  const h = harness(["identification", "health"], { mode: "verify" });
  await h.run();
  expect(h.log.indexOf("event:persistence:accepted:identification")).toBeLessThan(h.log.indexOf("begin:health"));
});

test("a real-boundary stop finalizes in-flight tabs (reports, never throws) and rethrows the original error", async () => {
  const h = harness(["identification", "health", "character"], { mode: "verify", failBoundaryAt: "character" });
  await expect(h.run()).rejects.toBeInstanceOf(StopRequested);
  expect(h.outcomes).toEqual(["identification:verified", "health:verified"]); // in-flight health was finalized (reported)
  expect(saves(h.log)).not.toContain("SAVE:character");
});

test("awaitDone for slot reuse runs before the N+2 boundary and advances both background tabs", async () => {
  const h = harness(["identification", "health", "character"], { barrier: "accepted", script: { identification: { pending: 4 }, health: { pending: 1 } } });
  await h.run();
  expect(h.log.indexOf("outcome:identification:verified")).toBeLessThan(h.log.indexOf("boundary:character:real") === -1 ? h.log.indexOf("boundary:character:prefetch") : h.log.indexOf("boundary:character:real"));
});

test("drain restores the foreground tab even when a background step throws", async () => {
  const log: string[] = [];
  let focused = "main";
  const ops = {
    focus: async (h: string) => { focused = h; log.push(h); }, newTab: async () => "extra", closeTab: async () => {},
    rescan: async () => { throw new Error("boom"); }, startReload: async () => {}, pollReload: async () => "pending", readback: async () => ({ kind: "pending" }),
    emit: async () => {}, sleep: async () => {}, now: () => 0,
  } as unknown as TabOps;
  const scheduler = new TabScheduler(ops, "main", { onOutcome: async () => {} }, { verifyTimeoutMs: 1, pollMs: 1 });
  scheduler.add({ name: "health", handle: "extra", phase: "domready" });
  await expect(scheduler.drain()).rejects.toThrow("boom");
  expect(focused).toBe("main");
  expect(scheduler.focused).toBe("main");
});

test("the second CAPTCHA solved while the pipeline is active downgrades; the first does not", async () => {
  const h = harness(["identification", "health"]);
  h.scheduler.noteChallenge();
  await h.scheduler.drain();
  h.scheduler.noteChallenge();
  await expect(h.scheduler.drain()).rejects.toBeInstanceOf(PipelineDowngrade);
});

test("window closed by the user maps to the Vietnamese stop message", async () => {
  const ops = {
    focus: async () => { const e = new Error("gone"); e.name = "NoSuchWindowError"; throw e; },
  } as unknown as TabOps;
  const scheduler = new TabScheduler(ops, "main", { onOutcome: async () => {} }, { verifyTimeoutMs: 1, pollMs: 1 });
  await expect(scheduler.focus("extra")).rejects.toThrow("Cửa sổ Chrome của mục đang xử lý đã bị đóng");
});
