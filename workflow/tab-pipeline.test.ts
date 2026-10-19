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
