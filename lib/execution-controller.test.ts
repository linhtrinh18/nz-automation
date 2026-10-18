import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RunStore, atomicJson } from "./run-store";
import { ExecutionController, StopRequested } from "./execution-controller";
import {
  interruptJob,
  recoverableOutcomes,
  allowedControl,
} from "./execution-state";
import { buildPlan } from "./run-plan";
import { runSchema } from "./run-config";
import sample from "../fixtures/sample.json";
let root: string, store: RunStore, controller: ExecutionController;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "nzwh-control-test-"));
  store = new RunStore(root);
  const id = randomUUID(),
    token = randomUUID(),
    now = new Date().toISOString();
  await mkdir(join(root, id));
  await atomicJson(store.path(id, "control.json"), {
    action: "continue",
    requested: now,
  });
  controller = new ExecutionController(store, {
    id,
    token,
    version: 2,
    pid: process.pid,
    status: "running",
    started: now,
    updated: now,
    heartbeat: now,
    phase: "section",
    message: "",
    browser: "open",
    outcomes: buildPlan(
      runSchema.parse({
        data: sample,
        mode: "saveAll",
        sections: ["personal", "health"],
      }),
    ).outcomes,
  });
  await controller.persist();
});
afterEach(async () => {
  await controller.finish("stopped", "test complete");
  await rm(root, { recursive: true, force: true });
});
async function command(action: "pause" | "continue" | "stop" | "terminate") {
  await atomicJson(store.path(controller.job.id, "control.json"), {
    action,
    requested: new Date().toISOString(),
  });
}
test("pause is deferred during a section; resume never resets completed outcomes", async () => {
  await controller.event({
    type: "section-start",
    section: "personal",
    scenario: "baseline",
  });
  await command("pause");
  await controller.checkpoint();
  expect(controller.job.status).toBe("running");
  await controller.event({
    type: "section-result",
    status: "completed",
    detail: "done",
    checked: 25,
  });
  const waiting = controller.checkpoint();
  await expect.poll(() => controller.job.status).toBe("paused");
  expect(
    controller.job.outcomes.find((item) => item.section === "health")?.status,
  ).toBe("pending");
  await command("continue");
  await waiting;
  expect(controller.job.status).toBe("running");
  expect(controller.job.outcomes[0].status).toBe("completed");
});
test("stop waits for in-flight persistence and never erases verified saves", async () => {
  await controller.event({
    type: "section-start",
    section: "personal",
    scenario: "baseline",
  });
  await controller.event({ type: "persistence", state: "possible" });
  await command("stop");
  await controller.checkpoint();
  expect(controller.job.outcomes[0].persistence).toBe("possible");
  await controller.event({ type: "persistence", state: "accepted" });
  await controller.event({ type: "persistence", state: "verified" });
  await controller.event({
    type: "section-result",
    status: "completed",
    detail: "persisted",
  });
  await expect(controller.checkpoint()).rejects.toBeInstanceOf(StopRequested);
  expect(controller.job.outcomes[0].persistence).toBe("verified");
});
test("stop while paused finishes without starting the next section", async () => {
  await command("pause");
  const waiting = controller.checkpoint();
  await expect.poll(() => controller.job.status).toBe("paused");
  await command("stop");
  await expect(waiting).rejects.toBeInstanceOf(StopRequested);
  expect(
    controller.job.outcomes.filter((item) => item.status === "pending"),
  ).toHaveLength(2);
});
test("crashes preserve unknown POST outcomes and accepted-but-unverified saves", async () => {
  await controller.event({
    type: "section-start",
    section: "personal",
    scenario: "baseline",
  });
  await controller.event({ type: "persistence", state: "possible" });
  let interrupted = interruptJob(controller.job, "crash");
  expect(interrupted.outcomes[0]).toMatchObject({
    status: "interrupted",
    persistence: "possible",
  });
  await controller.event({ type: "persistence", state: "accepted" });
  interrupted = interruptJob(controller.job, "crash");
  expect(interrupted.outcomes[0]).toMatchObject({
    status: "saved_unverified",
    persistence: "accepted",
  });
  expect(recoverableOutcomes(interrupted).map((item) => item.section)).toEqual([
    "personal",
    "health",
  ]);
});
test("CAPTCHA is an explicit waiting state and controls do not bypass it", async () => {
  await controller.event({
    type: "section-start",
    section: "personal",
    scenario: "baseline",
  });
  await controller.event({ type: "captcha", waiting: true });
  await command("pause");
  await controller.checkpoint();
  expect(controller.job.phase).toBe("captcha");
  expect(controller.job.outcomes[0].status).toBe("waiting_captcha");
  await controller.event({ type: "captcha", waiting: false });
  expect(controller.job.outcomes[0].status).toBe("running");
});
test("out-of-scope and repeated completed sections are rejected", async () => {
  await expect(
    controller.event({
      type: "section-start",
      section: "occupation",
      scenario: "baseline",
    }),
  ).rejects.toThrow("Phạm vi");
  await controller.event({
    type: "section-start",
    section: "personal",
    scenario: "baseline",
  });
  await controller.event({
    type: "section-result",
    status: "completed",
    detail: "done",
  });
  await expect(
    controller.event({
      type: "section-start",
      section: "personal",
      scenario: "baseline",
    }),
  ).rejects.toThrow("Phạm vi");
  expect(allowedControl("stopped", "continue")).toBe(false);
  expect(allowedControl("paused", "continue")).toBe(true);
});
test("exclusive run lock cannot be released by another job identity", async () => {
  await store.claim(controller.job.id, controller.job.token);
  await expect(store.claim(randomUUID(), randomUUID())).rejects.toThrow("khóa");
  await store.release(controller.job.id, randomUUID());
  await expect(store.claim(randomUUID(), randomUUID())).rejects.toThrow();
  await store.release(controller.job.id, controller.job.token);
});

test.each(["possible", "accepted"] as const)("an unverified %s save preserves evidence and allows the next selected section", async (persistence) => {
  await controller.event({ type: "section-start", section: "personal", scenario: "baseline" });
  await controller.event({ type: "persistence", state: persistence });
  await controller.event({ type: "section-result", status: "failed", detail: "Saved-value verification failed: personal.title.", checked: 24, blocked: 1 });
  await controller.checkpoint();
  await controller.event({ type: "section-start", section: "health", scenario: "baseline" });
  expect(controller.job.outcomes[0]).toMatchObject({ status: persistence === "accepted" ? "saved_unverified" : "failed", persistence, checked: 24, blocked: 1 });
  expect(controller.job.outcomes.find(item => item.section === "health")?.status).toBe("running");
  await controller.event({ type: "persistence", state: "verified" });
  await controller.event({ type: "section-result", status: "completed", detail: "done" });
  await controller.finish("incomplete", "one section needs review");
  expect(controller.job.status).toBe("incomplete");
  expect(recoverableOutcomes(controller.job).map(item => item.section)).toEqual(["personal"]);
});

test("terminate stops at the next checkpoint like stop", async () => {
  await command("terminate");
  await expect(controller.checkpoint()).rejects.toBeInstanceOf(StopRequested);
});

test("application submission evidence persists independently of completed draft sections", async () => {
  await controller.event({ type: "submission", state: "unconfirmed" });
  expect((await store.read(controller.job.id)).submission).toBe("unconfirmed");
  await controller.event({ type: "submission", state: "confirmed" });
  await controller.finish("succeeded", "website confirmed");
  expect((await store.read(controller.job.id)).submission).toBe("confirmed");
});

test("finishing as stopped marks the running section stopped, not failed", async () => {
  await controller.event({ type: "section-start", section: "personal", scenario: "baseline" });
  await controller.finish("stopped", "stopped by user");
  expect(controller.job.status).toBe("stopped");
  expect(controller.job.outcomes[0].status).toBe("stopped");
  expect(controller.job.outcomes.find(item => item.section === "health")?.status).toBe("pending");
});

test("credential changes stop at safe boundaries, preserving in-flight section verification", async () => {
  const validate = vi.fn().mockResolvedValue(undefined);
  controller = new ExecutionController(store, controller.job, validate);
  await controller.checkpoint();
  expect(validate).toHaveBeenCalledTimes(1);
  await controller.event({ type: "section-start", section: "personal", scenario: "baseline" });
  validate.mockRejectedValue(new Error("NZWH credentials changed"));
  await controller.checkpoint();
  expect(validate).toHaveBeenCalledTimes(1);
  await controller.event({ type: "section-result", status: "completed", detail: "verified" });
  await expect(controller.checkpoint()).rejects.toThrow("credentials changed");
  expect(controller.job.outcomes[0].status).toBe("completed");
});
test("resuming a paused worker rechecks credentials before continuing", async () => {
  const validate = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValue(new Error("NZWH credentials changed"));
  controller = new ExecutionController(store, controller.job, validate);
  await command("pause");
  const waiting = controller.checkpoint();
  const rejected = expect(waiting).rejects.toThrow("credentials changed");
  await expect.poll(() => controller.job.status).toBe("paused");
  await command("continue");
  await rejected;
  expect(validate).toHaveBeenCalledTimes(2);
});
