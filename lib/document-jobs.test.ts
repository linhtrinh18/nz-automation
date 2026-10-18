import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import sample from "../fixtures/sample.json";
const mocked = vi.hoisted(() => ({ load: vi.fn(), spawn: vi.fn() }));
vi.mock("../server/cloud", async original => ({ ...await original<typeof import("../server/cloud")>(), loadDocumentForRun: mocked.load }));
vi.mock("node:child_process", () => ({ spawn: mocked.spawn }));
import { DocumentError } from "../server/cloud";
import { runSchema } from "./run-config";
import { resolveInput, startJob, recoveryConfig, reviewToken, getJob } from "./jobs";
import { RunStore } from "./run-store";
let store: RunStore;
const binding = { userId: "owner", revision: randomUUID() };
const source = { kind: "document", documentId: randomUUID(), revision: randomUUID(), name: "Server name" } as const;
const input = runSchema.parse({ data: sample, source, sections: ["health"], liveSaveConsent: true, allowFictionalDraftSave: true });
beforeEach(async () => {
  vi.resetAllMocks();
  store = new RunStore(await mkdtemp(join(tmpdir(), "nzwh-document-run-")));
  mocked.load.mockResolvedValue({ id: source.documentId, revision: source.revision, name: "Server name", data: { ...sample, metadata: { snapshot: true } } });
  mocked.spawn.mockImplementation(() => Object.assign(new EventEmitter(), { unref() {}, stdio: [null, null, null, { on() {}, end() {} }] }));
});
afterEach(async () => { await rm(store.root, { recursive: true, force: true }); });
it("resolves the selected document with the session owner, ignores forged data/name, and persists provenance", async () => {
  const resolved = await resolveInput({ ...input, source: { ...source, name: "forged" }, data: { ...sample, metadata: "forged" } }, store, binding);
  expect(mocked.load).toHaveBeenCalledWith(binding.userId, source.documentId, source.revision);
  expect(resolved.source).toEqual(source); expect(resolved.data.metadata).toEqual({ snapshot: true });
  const job = await startJob({ ...resolved, reviewedPlan: reviewToken(resolved, binding) }, store, binding);
  const saved = JSON.parse(await readFile(store.path(job.id, "input.json"), "utf8"));
  expect(saved.source).toEqual(source); expect(saved.data.metadata).toEqual({ snapshot: true });
  expect((await getJob(job.id, store)).configuration?.source).toContain("Server name");
});
it("blocks stale and deleted sources before launch and keeps review checks when the client changes revision", async () => {
  const resolved = await resolveInput(input, store, binding);
  const token = reviewToken(resolved, binding);
  mocked.load.mockRejectedValue(new DocumentError("Selected document changed", 409));
  await expect(startJob({ ...resolved, reviewedPlan: token }, store, binding)).rejects.toMatchObject({ status: 409 });
  mocked.load.mockRejectedValue(new DocumentError("Selected document is unavailable", 404));
  await expect(resolveInput(input, store, binding)).rejects.toMatchObject({ status: 404 });
  mocked.load.mockResolvedValue({ id: source.documentId, revision: randomUUID(), name: "renamed", data: sample });
  await expect(startJob({ ...resolved, reviewedPlan: token }, store, binding)).rejects.toThrow("Cấu hình đã đổi");
  expect(mocked.spawn).not.toHaveBeenCalled();
});
it("recovers an immutable owner snapshot after its original document is deleted, with credential isolation intact", async () => {
  const resolved = await resolveInput(input, store, binding);
  const job = await startJob({ ...resolved, reviewedPlan: reviewToken(resolved, binding) }, store, binding);
  await store.write({ ...job, status: "failed" });
  mocked.load.mockRejectedValue(new DocumentError("deleted", 404));
  const { config } = await recoveryConfig(job.id, store);
  const recovered = await resolveInput(config, store, binding);
  expect(recovered.data).toEqual(resolved.data);
  expect(recovered.source).toMatchObject({ kind: "run", origin: source });
  const forged = await resolveInput({ ...config, source: { ...config.source, origin: { ...source, name: "forged recovery name" } } }, store, binding);
  expect(forged.source).toMatchObject({ kind: "run", origin: source });
  await expect(resolveInput(config, store, { ...binding, revision: randomUUID() })).rejects.toThrow("credentials changed");
  await expect(resolveInput(config, store, { ...binding, userId: "other" })).rejects.toThrow("credentials changed");
});
it("rejects legacy file sources for app runs without reading shared files", async () => {
  for (const kind of ["applicant", "sample", "legacy"]) await expect(resolveInput({ ...input, source: { kind } }, store, binding)).rejects.toMatchObject({ status: 410 });
  await expect(resolveInput(input, store)).rejects.toMatchObject({ status: 401 });
});

it("login-only launches without loading a selected document or persisting applicant values", async () => {
  mocked.load.mockRejectedValue(new DocumentError("deleted", 404));
  const resolved = await resolveInput({ ...input, mode: "loginOnly", liveSaveConsent: false, allowFictionalDraftSave: false }, store, binding);
  expect(resolved.source).toEqual({ kind: "login" });
  expect(mocked.load).not.toHaveBeenCalled();
  expect(Object.values(resolved.data.personal).every(value => value === "")).toBe(true);
  const job = await startJob({ ...resolved, reviewedPlan: reviewToken(resolved, binding) }, store, binding);
  expect(job.outcomes).toEqual([]);
  expect(job.configuration?.mode).toBe("loginOnly");
  expect(job.configuration?.source).toBe("Chỉ đăng nhập");
  expect(mocked.spawn).toHaveBeenCalledOnce();
});
