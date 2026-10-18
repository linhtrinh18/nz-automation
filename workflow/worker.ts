import { readFileSync } from "node:fs";
import { setWorkerAuthorization, currentAppOrigin } from "../server/cloud";
import { CredentialError, loadRunCredentials, loadRunPayerName, assertCurrentCredentials } from "../server/cloud";
import { assertRunBinding, userRunStore } from "../lib/user-runs";
import { z } from "zod";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import { runWorkingHoliday, WorkingHolidayStop } from "./run";
import { SiteBusyError } from "./site-busy";
import { runSchema, validateRun } from "../lib/run-config";
import { RunStore } from "../lib/run-store";
import {
  ExecutionController,
  StopRequested,
} from "../lib/execution-controller";
import { executionErrorText } from "../lib/automation-vietnamese";
import { formatDuration } from "../lib/format-duration";
import { installLogStamping } from "../lib/log-stamp";
import { redactSecrets } from "../lib/redact";
const directory = process.argv[2];
if (!directory) process.exit(1);
const bootMs = Date.now();
let credentials: { username: string; password: string } | undefined;
installLogStamping(bootMs, () => [credentials?.username, credentials?.password]);
const totalTime = () => `Tổng thời gian: ${formatDuration(Date.now() - bootMs)}`;
const store = new RunStore(dirname(directory));
let controller: ExecutionController | undefined;
const abort = new AbortController();
const terminatedMessage =
  "Đã dừng theo yêu cầu của bạn. Mục đang chạy chưa được xác minh lưu; dữ liệu đã lưu không bị hoàn tác và hệ thống không tự gửi lại.";
let stopping: Promise<void> | undefined;
// Terminate: abort Chrome start-up, record the stopped state, then leave without waiting for the flow.
process.on("SIGTERM", () => {
  if (stopping) return;
  abort.abort();
  setTimeout(() => process.exit(1), 4000).unref();
  console.error(
    `[NZWH] Đã dừng theo yêu cầu của bạn. Mục đang chạy chưa được xác minh lưu; không tự gửi lại. ${totalTime()}`,
  );
  stopping = (async () => {
    await controller?.finish("stopped", terminatedMessage).catch(() => {});
    process.exit(1);
  })();
});
try {
  const session = z.object({ authorization: z.string(), appOrigin: z.string() }).strict().parse(JSON.parse(readFileSync(3, "utf8")));
  setWorkerAuthorization(session.authorization, session.appOrigin);
  const binding = z.object({ userId: z.string().min(1), revision: z.string().uuid() }).strict().parse(JSON.parse(await readFile(join(directory, "owner.json"), "utf8")));
  if (userRunStore(binding.userId).root !== dirname(directory)) throw new Error("Invalid run owner.");
  await assertRunBinding(store, basename(directory), binding);
  const job = await store.read(basename(directory));
  controller = new ExecutionController(store, job, () => assertCurrentCredentials(binding));
  await controller.start();
  credentials = await loadRunCredentials(binding);
  const input = runSchema.parse(
    JSON.parse(await readFile(join(directory, "input.json"), "utf8")),
  );
  validateRun(input);
  const version = await readFile(join(process.cwd(), "package.json"), "utf8")
    .then((text) => (JSON.parse(text) as { version?: string }).version)
    .catch(() => undefined);
  // Configuration only: no applicant data, credentials or environment values.
  console.log(
    `[NZWH] run-info id=${basename(directory)} pid=${process.pid} node=${process.version} ${process.platform}/${process.arch} app=${version ?? "?"} mode=${input.mode} source=${input.source.kind} browser=${input.browserType} attachPort=${input.attachPort ?? "-"} country=${input.country ?? "-"} scenario=${input.scenario} sections=${input.sections?.join(",") ?? "all"} resumeKeys=${input.resumeKeys?.length ?? 0}`,
  );
  await writeFile(
    join(directory, "application.json"),
    JSON.stringify(input.data),
    { mode: 0o600 },
  );
  const result = await runWorkingHoliday({
    ...input,
    credentials,
    payerName: input.mode === "fillAndSubmit" ? await loadRunPayerName(binding) : undefined,
    profileName: input.browserType === "profile" ? `user-${(await import("node:crypto")).createHash("sha256").update(JSON.stringify([currentAppOrigin(), binding.userId, binding.revision, input.profileName])).digest("hex").slice(0, 48)}` : input.profileName,
    dataPath: join(directory, "application.json"),
    expectedApplicationId:
      input.source.kind === "run"
        ? (await assertRunBinding(store, input.source.runId, binding), (await store.read(input.source.runId)).applicationId)
        : undefined,
    taskKeys: input.resumeKeys,
    hooks: controller,
    signal: abort.signal,
  });
  await controller.finish(
    result.success ? "succeeded" : "incomplete",
    result.message,
  );
} catch (error) {
  // A terminate request owns the final state; never record its AbortError as a failure.
  if (stopping) await stopping;
  const message =
    error instanceof StopRequested
      ? "Đã dừng tại ranh giới an toàn. Những dữ liệu đã lưu được giữ nguyên; không hoàn tác."
      : error instanceof CredentialError
        ? executionErrorText(error.message)
      : error instanceof WorkingHolidayStop || error instanceof SiteBusyError
        ? executionErrorText(error.message)
        : "Tác vụ gặp lỗi. Kiểm tra Chrome, cấu hình trình duyệt và quyền truy cập tệp. Không tự thử lại thao tác có thể đã lưu.";
  if (
    controller &&
    !(error instanceof StopRequested) &&
    controller.job.browser !== "not-opened"
  )
    controller.job.browser = "unknown";
  console.error(`[NZWH] ${message}`);
  // Stack frames only: Selenium messages can embed typed values, so the message text is never printed.
  const frames =
    error instanceof Error
      ? (error.stack ?? "")
          .split("\n")
          .filter((line) => /^\s+at /.test(line))
          .join("\n")
      : "";
  console.error(
    `[NZWH] error name=${error instanceof Error ? error.name : typeof error} class=${(error as object)?.constructor?.name ?? "?"} phase=${controller?.job.phase ?? "-"}`,
  );
  if (frames) console.error(redactSecrets(frames, []));
  if (controller)
    await controller
      .finish(error instanceof StopRequested ? "stopped" : "failed", message)
      .catch(() => {});
}
console.log(`[NZWH] ${totalTime()} (status=${controller?.job.status ?? "-"})`);
process.exit(controller?.job.status === "succeeded" ? 0 : 1);
