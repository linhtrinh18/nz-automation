import { activeStatus, interruptJob, stopJob } from "./execution-state";
import { RunStore } from "./run-store";
import type { ExecutionEvent, ExecutionHooks, Job } from "./execution-state";
export class StopRequested extends Error {}
export class ExecutionController implements ExecutionHooks {
  private writes = Promise.resolve();
  private closed = false;
  private finishing: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  constructor(
    private store: RunStore,
    public job: Job,
    private validateCredentials?: () => Promise<void>,
  ) {}
  async persist(): Promise<void> {
    if (this.closed) return;
    await this.write();
  }
  private async write(): Promise<void> {
    this.job.updated = new Date().toISOString();
    const snapshot = structuredClone(this.job);
    this.writes = this.writes.then(() => this.store.write(snapshot));
    await this.writes;
  }
  async start(): Promise<void> {
    const command = await this.store.command(this.job.id);
    if (command.action === "stop" || command.action === "terminate")
      throw new StopRequested();
    this.job.pid = process.pid;
    this.job.status = "running";
    this.job.phase = "starting";
    this.job.message = "Đang chuẩn bị trình duyệt.";
    await this.persist();
    this.timer = setInterval(() => {
      this.job.heartbeat = new Date().toISOString();
      void this.persist().catch(() => {
        process.exitCode = 1;
      });
    }, 1000);
  }
  private current() {
    return this.job.outcomes.find((item) =>
      ["running", "waiting_captcha"].includes(item.status),
    );
  }
  /** Section name to outcome key, filled from section-start so keyed events reach the right item. */
  private keys = new Map<string, string>();
  private resolve(event: ExecutionEvent) {
    const section = "section" in event ? event.section : undefined;
    const key = section ? this.keys.get(section) : undefined;
    return key ? this.job.outcomes.find((item) => item.key === key) : this.current();
  }
  async event(event: ExecutionEvent): Promise<void> {
    if (this.closed) return;
    const current = this.resolve(event);
    // Background (other tab) events never overwrite the foreground phase/message.
    const background = "background" in event && event.background === true;
    if (event.type === "application") {
      this.job.applicationId = event.id;
    } else if (event.type === "submission") {
      this.job.submission = event.state;
      this.job.phase = "submission";
      this.job.message = event.state === "confirmed"
        ? "Website đã xác nhận hồ sơ được nộp thành công."
        : "Đang thực hiện bước nộp hồ sơ. Chưa có xác nhận nộp thành công từ website; không tự gửi lại.";
    } else if (event.type === "section-start") {
      const item = this.job.outcomes.find(
        (item) => item.key === `${event.scenario}:${event.section}`,
      );
      if (!item || item.status !== "pending")
        throw new Error("Phạm vi thực thi không khớp kế hoạch đã xác nhận.");
      this.keys.set(event.section, item.key);
      item.status = "running";
      item.startedAt = new Date().toISOString();
      this.job.phase = "section";
      this.job.message = "Đang xử lý mục hồ sơ đã chọn.";
    } else if (event.type === "persistence" && current) {
      current.persistence = event.state;
      if (!background) this.job.phase = event.state === "verified" ? "verified" : "saving";
      current.detail =
        event.state === "possible"
          ? "Đã bắt đầu thao tác có thể gửi dữ liệu; chưa biết đã lưu hay chưa."
          : event.state === "accepted"
            ? "Trang đã phản hồi thao tác lưu; đang tải lại để xác minh."
            : "Đã xác minh dữ liệu sau khi tải lại.";
    } else if (event.type === "captcha") {
      if (!background || event.waiting) this.job.phase = event.waiting ? "captcha" : "section";
      if (!background || event.waiting) this.job.message = event.waiting
        ? event.message ?? "Hãy tự giải CAPTCHA trong Chrome. Tác vụ kiểm tra mỗi 0,2 giây và tự bấm nút Submit riêng của CAPTCHA khi giải xong. Lệnh tạm dừng/dừng áp dụng tại ranh giới an toàn."
        : event.message ?? "CAPTCHA đã hoàn tất; tiếp tục xử lý.";
      if (current)
        current.status = event.waiting ? "waiting_captcha" : "running";
    } else if (event.type === "phase") {
      this.job.phase = event.phase;
      this.job.message = event.message;
      if (event.phase === "browser-open") {
        this.job.browser = "open";
        this.job.debugPort = event.debugPort;
      }
    } else if (event.type === "section-result" && current) {
      current.status =
        event.status === "failed" && current.persistence === "accepted"
          ? "saved_unverified"
          : event.status;
      current.detail = event.detail;
      current.checked = event.checked ?? 0;
      current.blocked = event.blocked ?? 0;
      if (current.startedAt) {
        current.finishedAt = new Date().toISOString();
        current.durationMs = Math.max(
          0,
          Date.parse(current.finishedAt) - Date.parse(current.startedAt),
        );
      }
    }
    await this.persist();
  }
  async checkpoint(): Promise<void> {
    if (this.current()) return; // Never pause or stop within a section/postback/restore operation.
    let command = await this.store.command(this.job.id);
    if (command.action === "stop" || command.action === "terminate")
      throw new StopRequested();
    await this.validateCredentials?.();
    if (command.action !== "pause") return;
    this.job.status = "paused";
    this.job.phase = "paused";
    this.job.message =
      "Đã tạm dừng ở ranh giới an toàn. Không gửi thao tác mới; Chrome giữ nguyên.";
    await this.persist();
    while (command.action === "pause") {
      await new Promise((resolve) => setTimeout(resolve, 200));
      command = await this.store.command(this.job.id);
    }
    if (command.action === "stop" || command.action === "terminate")
      throw new StopRequested();
    await this.validateCredentials?.();
    this.job.status = "running";
    this.job.phase = "section";
    this.job.message =
      "Tiếp tục từ ranh giới đã tạm dừng; không chạy lại các mục hoàn tất.";
    await this.persist();
  }
  async finish(
    status: "succeeded" | "incomplete" | "failed" | "stopped" | "interrupted",
    message: string,
  ): Promise<void> {
    this.finishing ??= this.complete(status, message);
    return this.finishing;
  }
  private async complete(
    status: "succeeded" | "incomplete" | "failed" | "stopped" | "interrupted",
    message: string,
  ): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    if (status === "interrupted") this.job = interruptJob(this.job, message);
    else if (status === "stopped") this.job = stopJob(this.job, message);
    else {
      for (const item of this.job.outcomes) {
        if (!["running", "waiting_captcha"].includes(item.status)) continue;
        item.status = item.persistence === "accepted" ? "saved_unverified" : "failed";
        item.detail = message;
      }
      this.job.status = status;
      this.job.message = message;
      this.job.phase = status;
      this.job.finished = new Date().toISOString();
    }
    await this.write();
    await this.store.release(this.job.id, this.job.token);
  }
}
export function controllerIsActive(controller: ExecutionController): boolean {
  return activeStatus(controller.job.status);
}
