import { currentAuthorization, currentAppOrigin, applicationId } from "../server/cloud";
import { blankApplication } from "../workflow/application-data";
import { assertRunBinding } from "./user-runs";
import type { CredentialBinding } from "../server/cloud";
import { targetFingerprint } from "./execution-target";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { openSync, closeSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { RunStore, atomicJson } from "./run-store";
import {
  activeStatus,
  allowedControl,
  interruptJob,
  recoverableOutcomes,
  stopJob,
} from "./execution-state";
import { signalWorker, workerAlive } from "./worker-process";
import { buildPlan } from "./run-plan";
import { runSchema, validateRun } from "./run-config";
import { loadDocumentForRun, DocumentError } from "../server/cloud";
import { readApplicant, readSample } from "./storage";
import type { RunInput } from "./run-config";
import type { Job, JobView, ControlAction } from "./execution-state";
export const store = new RunStore(join(process.cwd(), "data", "runs"));
export function reviewToken(input: RunInput, binding?: CredentialBinding): string {
  const {
    reviewedPlan: _reviewed,
    liveSaveConsent: _live,
    allowFictionalDraftSave: _fictional,
    recoveryAcknowledged: _recovery,
    ...configuration
  } = input;
  void _reviewed;
  void _live;
  void _fictional;
  void _recovery;
  return createHash("sha256")
    .update(
      JSON.stringify({
        configuration,
        target: targetFingerprint(binding),
      }),
    )
    .digest("hex");
}
export async function resolveInput(
  raw: unknown,
  repository: RunStore = store,
  binding?: CredentialBinding,
): Promise<RunInput> {
  const input = runSchema.parse(raw);
  if (input.mode === "loginOnly") return {
    ...input, data: blankApplication(), source: { kind: "login" },
    sections: undefined, resumeKeys: undefined, scenario: "baseline",
  };
  if (input.source.kind === "document") {
    if (!binding) throw new DocumentError("A signed-in owner is required to select database documents.", 401);
    const document = await loadDocumentForRun(binding.userId, input.source.documentId, input.source.revision);
    input.data = document.data;
    input.source = { kind: "document", documentId: document.id, revision: document.revision, name: document.name };
  } else if (binding && (input.source.kind === "applicant" || input.source.kind === "sample" || input.source.kind === "legacy")) {
    throw new DocumentError("File-based sources are retired in the workspace. Select a private document or shared template. Legacy owner-scoped runs can still recover their immutable snapshot.", 410);
  } else if (input.source.kind === "legacy")
    throw new Error(
      "Nguồn dữ liệu cũ đã bị gỡ. Chọn tài liệu riêng hoặc mẫu dùng chung.",
    );
  else if (input.source.kind === "applicant")
    input.data = await readApplicant();
  else if (input.source.kind === "sample") input.data = await readSample();
  else if (input.source.kind === "run") {
    if (binding) await assertRunBinding(repository, input.source.runId, binding);
    const previous = await repository.read(input.source.runId);
    if (activeStatus(previous.status))
      throw new Error(
        "Lượt cũ vẫn đang hoạt động; hãy tiếp tục hoặc dừng lượt đó trước.",
      );
    const original = runSchema.parse(
      JSON.parse(
        await readFile(repository.path(previous.id, "input.json"), "utf8"),
      ),
    );
    if (input.scenario !== original.scenario)
      throw new Error(
        "Khôi phục phải giữ kịch bản của lượt cũ. Tạo lượt mới để đổi thiết lập này.",
      );
    const context = z
      .object({ fingerprint: z.string() })
      .parse(
        JSON.parse(
          await readFile(repository.path(previous.id, "target.json"), "utf8"),
        ),
      );
    if (context.fingerprint !== targetFingerprint(binding))
      throw new Error(
        "Tài khoản hoặc mã hồ sơ đích đã thay đổi. Không tự khôi phục sang hồ sơ khác; kiểm tra cấu hình đăng nhập và tạo kế hoạch mới.",
      );
    const origin = original.source.kind === "document" ? original.source : original.source.kind === "run" ? original.source.origin : undefined;
    input.source = { kind: "run", runId: input.source.runId, ...(origin ? { origin } : {}) };
    input.data = original.data;
    const remaining = recoverableOutcomes(previous);
    const plan = buildPlan(input);
    if (
      plan.outcomes.some(
        (item) =>
          item.status === "pending" &&
          !remaining.some((old) => old.key === item.key),
      )
    )
      throw new Error(
        "Phạm vi khôi phục chứa mục đã hoàn tất hoặc đã bỏ qua. Chỉ chọn các mục chưa hoàn tất.",
      );
  }
  return input;
}
const terminateGraceMs = 5000;
const terminateMessage =
  "Đã dừng theo yêu cầu của bạn. Mục đang chạy chưa được xác minh lưu; dữ liệu đã lưu không bị hoàn tác và hệ thống không tự gửi lại.";
// Writes the stopped state once. Re-reads first so concurrent polls and the exit handler stay idempotent.
async function finalizeStopped(id: string, repository: RunStore): Promise<Job> {
  const fresh = await repository.read(id);
  if (!activeStatus(fresh.status)) return fresh;
  const stopped = stopJob(fresh, terminateMessage);
  await repository.write(stopped);
  await repository.release(stopped.id, stopped.token);
  await appendFile(
    repository.path(id, "events.log"),
    `[NZWH] ${new Date().toLocaleString("vi-VN")} Đã dừng tác vụ theo yêu cầu của bạn.\n`,
  ).catch(() => {});
  return stopped;
}
async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (workerAlive(pid) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 50));
  return !workerAlive(pid);
}
export async function getJob(
  id: string,
  repository: RunStore = store,
): Promise<JobView> {
  let job = await repository.read(id);
  const command = await repository.command(id).catch(() => null);
  if (
    activeStatus(job.status) &&
    command?.action === "terminate" &&
    Date.now() - Date.parse(command.requested) > terminateGraceMs
  ) {
    // The worker ignored SIGTERM for the whole grace period; force it, then record the stop ourselves.
    const result = await signalWorker(job, "SIGKILL");
    if (result !== "signalled" || (await waitForExit(job.pid, 1000)))
      job = await finalizeStopped(id, repository);
  }
  const stale = Date.now() - Date.parse(job.heartbeat) > 15000;
  if (activeStatus(job.status) && stale) {
    let alive = true;
    try {
      if (job.pid > 0) process.kill(job.pid, 0);
      else alive = false;
    } catch {
      alive = false;
    }
    if (!alive && command?.action === "terminate") {
      job = await finalizeStopped(id, repository);
    } else if (!alive) {
      job = interruptJob(
        job,
        "Tiến trình đã kết thúc ngoài dự kiến. Không tự chạy lại; kiểm tra các mục có thể đã lưu.",
      );
      await repository.write(job);
      await repository.release(job.id, job.token);
    }
  }
  let stopRequest: JobView["stopRequest"];
  if (
    activeStatus(job.status) &&
    (command?.action === "stop" || command?.action === "terminate")
  ) {
    job = { ...job, status: "stop_requested" };
    stopRequest = {
      mode: command.action === "terminate" ? "now" : "after-section",
      requested: command.requested,
    };
  } else if (job.status === "running" && command?.action === "pause")
    job = { ...job, status: "pause_requested" };
  const log = await readFile(repository.path(id, "events.log"), "utf8").catch(
    () => "",
  );
  const { readdir } = await import("node:fs/promises");
  const input = runSchema.parse(
    JSON.parse(await readFile(repository.path(id, "input.json"), "utf8")),
  );
  const configuration = {
    mode: input.mode,
    source: buildPlan(input).source,
    browser: input.attachPort
      ? `Chrome đang mở · cổng ${input.attachPort}`
      : `${input.headless ? "Chrome ẩn (headless)" : "Chrome có cửa sổ"} · ${input.browserType.startsWith("profile") ? input.profileName : "hồ sơ tạm"}`,
  };
  return {
    ...job,
    configuration,
    log: log.slice(-100000),
    reports: (await readdir(join(repository.root, id))).filter((name) =>
      /^coverage-.*\.json$/.test(name),
    ),
    waitingForCaptcha: job.phase === "captcha",
    unresponsive: activeStatus(job.status) && stale,
    ...(stopRequest ? { stopRequest } : {}),
  };
}
export async function latestJob(repository: RunStore = store): Promise<JobView | null> {
  const jobs = (
    await Promise.all(
      (await repository.ids()).map((id) => getJob(id, repository).catch(() => null)),
    )
  ).filter((job): job is JobView => job !== null);
  return jobs.sort((a, b) => b.started.localeCompare(a.started))[0] ?? null;
}
export async function startJob(
  input: RunInput,
  repository: RunStore = store,
  binding?: CredentialBinding,
): Promise<JobView> {
  input = await resolveInput(input, repository, binding);
  validateRun(input);
  if (input.reviewedPlan !== reviewToken(input, binding))
    throw new Error(
      "Cấu hình đã đổi hoặc chưa được xem lại. Bấm Kiểm tra kế hoạch trước khi chạy.",
    );
  if (input.source.kind === "run") {
    if (binding) await assertRunBinding(repository, input.source.runId, binding);
    const previous = await repository.read(input.source.runId);
    if (
      recoverableOutcomes(previous).some(
        (item) =>
          item.persistence !== "none" &&
          buildPlan(input).outcomes.some(
            (next) => next.key === item.key && next.status === "pending",
          ),
      ) &&
      !input.recoveryAcknowledged
    )
      throw new Error(
        "Cần xác nhận đã kiểm tra thủ công các mục có thể đã lưu trước khi chạy lại.",
      );
  }
  if (binding && input.attachPort) {
    if (input.source.kind !== "run" || (await repository.read(input.source.runId)).debugPort !== input.attachPort)
      throw new Error("Attaching Chrome requires recovery of your own run. Use a fresh browser for a new run.");
  }
  for (const id of await repository.ids()) {
    const existing = await getJob(id, repository).catch(() => null);
    if (existing && !activeStatus(existing.status))
      await repository.release(existing.id, existing.token);
    if (existing && activeStatus(existing.status))
      throw new Error(
        "An automation run is already active. Finish it before starting another.",
      );
    // Legacy running jobs predate control support. Never start beside a live legacy worker.
    if (!existing) {
      try {
        const old = JSON.parse(
          await readFile(repository.path(id, "status.json"), "utf8"),
        ) as { status: string; pid: number };
        if (old.status === "running" && old.pid > 0) {
          process.kill(old.pid, 0);
          throw new Error(
            "Lượt cũ vẫn đang chạy; hãy kiểm tra Chrome và đợi kết thúc.",
          );
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("Lượt cũ"))
          throw error;
      }
    }
  }
  const id = randomUUID(),
    token = randomUUID();
  await repository.claim(id, token);
  const now = new Date().toISOString();
  const job: Job = {
    id,
    token,
    version: 2,
    pid: 0,
    status: "queued",
    started: now,
    updated: now,
    heartbeat: now,
    phase: "queued",
    message: "Đang khởi động tác vụ.",
    outcomes: buildPlan(input).outcomes,
    browser: "not-opened",
  };
  try {
    await mkdir(join(repository.root, id), { mode: 0o700 });
    if (binding) await atomicJson(repository.path(id, "owner.json"), binding);
    await atomicJson(repository.path(id, "input.json"), input);
    await atomicJson(repository.path(id, "target.json"), {
      fingerprint: targetFingerprint(binding),
    });
    await atomicJson(repository.path(id, "control.json"), {
      action: "continue",
      requested: now,
    });
    await repository.write(job);
    const output = openSync(repository.path(id, "events.log"), "a", 0o600);
    const workerEnv: NodeJS.ProcessEnv = { ...process.env, NZWH_REPORT_DIR: join(repository.root, id), NZWH_APPLICATION_ID: applicationId() };
    // App workers must never inherit shared site credentials.
    delete workerEnv.NZWH_USERNAME;
    delete workerEnv.NZWH_PASSWORD;
    // Obsolete provider configuration must not be propagated to workers.
    delete workerEnv.CAPSOLVER_API_KEY;
    delete workerEnv.TWOCAPTCHA_API_KEY;
    delete workerEnv.AUTOCAPTCHA_API_KEY;
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        join(process.cwd(), "workflow/worker.ts"),
        join(repository.root, id),
      ],
      {
        cwd: process.cwd(),
        env: workerEnv,
        stdio: ["ignore", output, output, "pipe"],
        detached: true,
      },
    );
    closeSync(output);
    const sessionChannel = child.stdio[3];
    if (!sessionChannel || !("end" in sessionChannel)) throw new Error("Worker authorization channel unavailable.");
    sessionChannel.on("error", () => {});
    sessionChannel.end(JSON.stringify({ authorization: currentAuthorization(), appOrigin: currentAppOrigin() }));
    const unexpectedExit = async () => {
      const current = await repository.read(id);
      if (activeStatus(current.status)) {
        const requested = await repository.command(id).catch(() => null);
        if (requested?.action === "terminate")
          await finalizeStopped(id, repository);
        else
          await repository.write(
            interruptJob(
              current,
              "Tiến trình dừng ngoài dự kiến. Kiểm tra trạng thái lưu trên Chrome trước khi thử lại.",
            ),
          );
      }
      await repository.release(id, token);
    };
    child.once("exit", () => {
      void unexpectedExit().catch(() => {});
    });
    child.once("error", () => {
      void unexpectedExit().catch(() => {});
    });
    child.unref();
    return await getJob(id, repository);
  } catch (error) {
    await repository.release(id, token);
    throw error;
  }
}
async function terminateJob(
  id: string,
  repository: RunStore,
): Promise<JobView> {
  const job = await getJob(id, repository);
  if (!activeStatus(job.status)) return job;
  const existing = await repository.command(id).catch(() => null);
  await atomicJson(repository.path(id, "control.json"), {
    action: "terminate",
    // Keep the first request time so repeated clicks never restart the grace period.
    requested:
      existing?.action === "terminate"
        ? existing.requested
        : new Date().toISOString(),
  });
  await signalWorker(job, "SIGTERM");
  return getJob(id, repository);
}
export async function controlJob(
  id: string,
  action: ControlAction,
  repository: RunStore = store,
): Promise<JobView> {
  if (action === "terminate") return terminateJob(id, repository);
  const job = await getJob(id, repository);
  if (!allowedControl(job.status, action))
    throw new Error(
      "Lệnh không phù hợp với trạng thái hiện tại. Hãy cập nhật trạng thái rồi thử lại.",
    );
  // Atomic command replacement; stop has precedence over any concurrent pause/continue.
  const lock = repository.path(id, "command.lock");
  const { open, unlink } = await import("node:fs/promises");
  let handle;
  try {
    handle = await open(lock, "wx", 0o600);
  } catch {
    throw new Error(
      "Một lệnh khác đang được xử lý. Đợi cập nhật trạng thái rồi thử lại.",
    );
  }
  try {
    const current = await getJob(id, repository);
    if (!allowedControl(current.status, action))
      throw new Error("Trạng thái vừa thay đổi; hãy đợi cập nhật.");
    await atomicJson(repository.path(id, "control.json"), {
      action,
      requested: new Date().toISOString(),
    });
  } finally {
    await handle.close();
    await unlink(lock);
  }
  return getJob(id, repository);
}
export async function recoveryConfig(id: string, repository: RunStore = store) {
  const job = await getJob(id, repository);
  if (activeStatus(job.status))
    throw new Error("Dừng hoặc tiếp tục lượt đang chạy trước khi khôi phục.");
  const config = runSchema.parse(
    JSON.parse(await readFile(repository.path(id, "input.json"), "utf8")),
  );
  const remaining = recoverableOutcomes(job);
  if (!remaining.length) throw new Error("Không còn mục nào cần khôi phục.");
  return {
    config: {
      ...config,
      mode: "saveAll",
      source: { kind: "run" as const, runId: id, ...((config.source.kind === "document" || config.source.kind === "run" && config.source.origin) ? { origin: config.source.kind === "document" ? config.source : config.source.origin } : {}) },
      sections: [...new Set(remaining.map((item) => item.section))],
      resumeKeys: remaining.map((item) => item.key),
      attachPort:
        job.browser === "open" && job.debugPort
          ? job.debugPort
          : config.attachPort,
      reviewedPlan: undefined,
      liveSaveConsent: false,
      allowFictionalDraftSave: false,
      recoveryAcknowledged: false,
    },
    uncertain: remaining
      .filter((item) => item.persistence !== "none")
      .map((item) => item.key),
  };
}
export async function getReport(id: string, name: string, repository: RunStore = store) {
  await repository.read(id);
  if (!/^coverage-[a-z-]+\.json$/.test(name))
    throw new Error("Tên báo cáo không hợp lệ.");
  return JSON.parse(await readFile(repository.path(id, name), "utf8")) as object;
}
export const controlPayload = z
  .object({ action: z.enum(["pause", "continue", "stop", "terminate"]) })
  .strict();

export async function recentJobs(repository: RunStore = store) {
  const jobs = (
    await Promise.all(
      (await repository.ids()).map((id) => repository.read(id).catch(() => null)),
    )
  )
    .filter((job): job is Job => job !== null)
    .sort((a, b) => b.started.localeCompare(a.started))
    .slice(0, 20);
  return Promise.all(jobs.map(async (job) => {
    const input = await readFile(repository.path(job.id, "input.json"), "utf8").then(text => runSchema.parse(JSON.parse(text))).catch(() => null);
    return { id: job.id, status: job.status, started: job.started, source: input ? buildPlan(input).source : "Bản dữ liệu của lượt cũ" };
  }));
}
