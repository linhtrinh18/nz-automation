import { targetFingerprint } from "./execution-target";
import { beforeEach, afterEach, expect, test } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RunStore, atomicJson } from "./run-store";
import {
  resolveInput,
  recoveryConfig,
  startJob,
  reviewToken,
  controlJob,
  getJob,
} from "./jobs";
import { runSchema } from "./run-config";
import { buildPlan } from "./run-plan";
import { saveApplicant } from "./storage";
import type { Job } from "./execution-state";
import sample from "../fixtures/sample.json";
let dataRoot: string, root: string, store: RunStore, job: Job;
const input = runSchema.parse({
  data: sample,
  source: { kind: "sample" },
  mode: "saveAll",
  sections: ["personal", "health"],
  liveSaveConsent: true,
  allowFictionalDraftSave: true,
});
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "nzwh-jobs-test-"));
  dataRoot = await mkdtemp(join(tmpdir(), "nzwh-data-test-"));
  await writeFile(join(dataRoot, "sample.json"), JSON.stringify(sample));
  process.env.NZWH_DATA_DIR = dataRoot;
  store = new RunStore(root);
  const now = new Date().toISOString(),
    id = randomUUID();
  await mkdir(join(root, id));
  const outcomes = buildPlan(input).outcomes;
  outcomes[0] = {
    ...outcomes[0],
    status: "completed",
    persistence: "verified",
  };
  const health = outcomes.find((item) => item.section === "health")!;
  health.status = "saved_unverified";
  health.persistence = "accepted";
  job = {
    id,
    token: randomUUID(),
    version: 2,
    pid: 0,
    status: "failed",
    started: now,
    updated: now,
    heartbeat: now,
    phase: "failed",
    message: "test",
    outcomes,
    browser: "unknown",
  };
  await store.write(job);
  await atomicJson(store.path(id, "input.json"), input);
  await atomicJson(store.path(id, "target.json"), {
    fingerprint: targetFingerprint(),
  });
  await atomicJson(store.path(id, "control.json"), {
    action: "continue",
    requested: now,
  });
});
afterEach(async () => {
  delete process.env.NZWH_DATA_DIR;
  await rm(dataRoot, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
});
test("recovery is original data and only unfinished outcomes; completed sections cannot replay", async () => {
  await atomicJson(store.path(job.id, "input.json"), { ...input, mode: "fillAndSubmit" });
  const { config, uncertain } = await recoveryConfig(job.id, store);
  expect(config.mode).toBe("saveAll");
  expect(config.sections).toEqual(["health"]);
  expect(config.resumeKeys).toEqual(["baseline:health"]);
  expect(uncertain).toEqual(["baseline:health"]);
  expect(config.liveSaveConsent).toBe(false);
  const canonical = await resolveInput(
    { ...config, data: { ...sample, metadata: "untrusted change" } },
    store,
  );
  expect(canonical.data.metadata).toBeUndefined();
  await expect(
    resolveInput(
      { ...config, sections: ["personal"], resumeKeys: undefined },
      store,
    ),
  ).rejects.toThrow("đã hoàn tất");
  await expect(
    resolveInput({ ...config, scenario: "medical-details" }, store),
  ).rejects.toThrow("giữ kịch bản");
});
test("uncertain live-save recovery needs fresh review, both save opt-ins and manual acknowledgement", async () => {
  const { config } = await recoveryConfig(job.id, store);
  let request = runSchema.parse(config);
  await expect(startJob(request, store)).rejects.toThrow("Explicit");
  request = { ...request, liveSaveConsent: true };
  await expect(startJob(request, store)).rejects.toThrow("Fictional");
  request = { ...request, allowFictionalDraftSave: true };
  await expect(startJob(request, store)).rejects.toThrow("Kiểm tra kế hoạch");
  request = { ...request, reviewedPlan: reviewToken(request) };
  await expect(startJob(request, store)).rejects.toThrow("kiểm tra thủ công");
});
test("stale review is rejected after a scope or data change before any worker spawns", async () => {
  const request = {
    ...input,
    reviewedPlan: reviewToken(input),
    sections: ["health"] as typeof input.sections,
  };
  await expect(startJob(request, store)).rejects.toThrow("Cấu hình đã đổi");
});
test("control lifecycle rejects terminal actions and stop wins over concurrent commands", async () => {
  await expect(controlJob(job.id, "continue", store)).rejects.toThrow(
    "trạng thái",
  );
  job.status = "running";
  job.pid = process.pid;
  await store.write(job);
  await controlJob(job.id, "stop", store);
  await expect(controlJob(job.id, "pause", store)).rejects.toThrow(
    "trạng thái",
  );
  expect((await getJob(job.id, store)).status).toBe("stop_requested");
});
test("lost worker with stale heartbeat is persisted interrupted and releases only its lock", async () => {
  job.status = "running";
  job.heartbeat = new Date(0).toISOString();
  job.pid = 0;
  job.outcomes.find((item) => item.section === "health")!.status = "running";
  await store.write(job);
  await store.claim(job.id, job.token);
  expect((await getJob(job.id, store)).status).toBe("interrupted");
  expect(
    (await store.read(job.id)).outcomes.find(
      (item) => item.section === "health",
    )?.status,
  ).toBe("saved_unverified");
  await expect(
    store.claim(randomUUID(), randomUUID()),
  ).resolves.toBeUndefined();
});
test("applicant and sample sources are read from disk, ignoring client data", async () => {
  {
    await saveApplicant({ ...input.data, dataKind: "applicant", metadata: "from disk" });
    const forged = { ...input.data, metadata: "not from disk" };
    const applicant = await resolveInput({ ...input, data: forged, source: { kind: "applicant" } }, store);
    expect(applicant.data.metadata).toBe("from disk");
    const fictional = await resolveInput({ ...input, data: forged, source: { kind: "sample" } }, store);
    expect(fictional.data.metadata).toBeUndefined();
    expect(fictional.data.dataKind).toBe("fictional");
  }
});
test("runs recorded with removed sources still parse and show a label", async () => {
  for (const source of [{ kind: "editor" }, { kind: "saved", name: "x.json", revision: "r" }]) {
    const old = runSchema.parse({ ...input, source });
    expect(old.source.kind).toBe("legacy");
    expect(buildPlan(old).source).toContain("đã gỡ");
    await expect(resolveInput({ ...input, source }, store)).rejects.toThrow("Nguồn dữ liệu cũ");
  }
});
test("live recovery refuses an account/application identity change", async () => {
  const { config } = await recoveryConfig(job.id, store);
  await atomicJson(store.path(job.id, "target.json"), {
    fingerprint: "different-target",
  });
  await expect(resolveInput(config, store)).rejects.toThrow(
    "Tài khoản hoặc mã hồ sơ",
  );
});

test("recovery proposes the observed local Chrome port and preserves the verified application identity", async () => {
  job.browser = "open";
  job.debugPort = 9222;
  job.applicationId = "observed-draft-id";
  await store.write(job);
  const recovery = await recoveryConfig(job.id, store);
  expect(recovery.config.attachPort).toBe(9222);
  expect((await store.read(job.id)).applicationId).toBe("observed-draft-id");
});

test("terminate is idempotent on a finished run", async () => {
  const view = await controlJob(job.id, "terminate", store);
  expect(view.status).toBe("failed");
  expect(view.stopRequest).toBeUndefined();
});

test("terminate on an active run reports stopRequest now, then stops after the grace period and stays recoverable", async () => {
  job.status = "running";
  job.pid = 0;
  const health = job.outcomes.find((item) => item.section === "health")!;
  health.status = "running";
  health.persistence = "none";
  await store.write(job);
  await store.claim(job.id, job.token);
  const first = await controlJob(job.id, "terminate", store);
  expect(first.status).toBe("stop_requested");
  expect(first.stopRequest?.mode).toBe("now");
  const requested = first.stopRequest!.requested;
  expect((await controlJob(job.id, "terminate", store)).stopRequest?.requested).toBe(requested);
  await atomicJson(store.path(job.id, "control.json"), {
    action: "terminate",
    requested: new Date(Date.now() - 10000).toISOString(),
  });
  const stopped = await getJob(job.id, store);
  expect(stopped.status).toBe("stopped");
  expect(stopped.outcomes.find((item) => item.section === "health")?.status).toBe("stopped");
  expect(stopped.outcomes.find((item) => item.section === "personal")?.status).toBe("completed");
  expect((await controlJob(job.id, "terminate", store)).status).toBe("stopped");
  const { config } = await recoveryConfig(job.id, store);
  expect(config.resumeKeys).toEqual(["baseline:health"]);
  await expect(store.claim(randomUUID(), randomUUID())).resolves.toBeUndefined();
});
