import { z } from "zod";
import { sectionNames } from "../workflow/application-data";
export const sectionSchema = z.enum(
  sectionNames as [
    (typeof sectionNames)[number],
    ...(typeof sectionNames)[number][],
  ],
);
export const runStatusSchema = z.enum([
  "queued",
  "running",
  "pause_requested",
  "paused",
  "stop_requested",
  "succeeded",
  "incomplete",
  "failed",
  "stopped",
  "interrupted",
]);
export type RunStatus = z.infer<typeof runStatusSchema>;
export const outcomeSchema = z.object({
  key: z.string(),
  scenario: z.string(),
  section: sectionSchema,
  status: z.enum([
    "pending",
    "running",
    "completed",
    "skipped",
    "failed",
    "interrupted",
    "waiting_captcha",
    "saved_unverified",
    "stopped",
  ]),
  persistence: z
    .enum(["none", "possible", "accepted", "verified"])
    .default("none"),
  detail: z.string().default(""),
  checked: z.number().default(0),
  blocked: z.number().default(0),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  durationMs: z.number().nonnegative().optional(),
});
export type Outcome = z.infer<typeof outcomeSchema>;
export const jobSchema = z.object({
  id: z.string().uuid(),
  version: z.literal(2),
  token: z.string().uuid(),
  pid: z.number().int().nonnegative(),
  status: runStatusSchema,
  started: z.string(),
  updated: z.string(),
  heartbeat: z.string(),
  finished: z.string().optional(),
  phase: z.string(),
  message: z.string(),
  outcomes: z.array(outcomeSchema),
  error: z.string().optional(),
  applicationId: z.string().optional(),
  submission: z.enum(["unconfirmed", "confirmed"]).optional(),
  debugPort: z.number().int().min(1024).max(65535).optional(),
  browser: z
    .enum(["not-opened", "open", "closed", "unknown"])
    .default("not-opened"),
});
export type Job = z.infer<typeof jobSchema>;
export interface JobView extends Job {
  configuration?: { mode: string; source: string; browser: string };
  log: string;
  reports: string[];
  waitingForCaptcha: boolean;
  unresponsive: boolean;
  stopRequest?: { mode: "after-section" | "now"; requested: string };
}
export const controlSchema = z
  .object({
    action: z.enum(["pause", "continue", "stop", "terminate"]),
    requested: z.string(),
  })
  .strict();
export type ControlAction = z.infer<typeof controlSchema>["action"];
export function activeStatus(status: RunStatus): boolean {
  return [
    "queued",
    "running",
    "pause_requested",
    "paused",
    "stop_requested",
  ].includes(status);
}
export function allowedControl(
  status: RunStatus,
  action: ControlAction,
): boolean {
  return action === "pause"
    ? ["queued", "running"].includes(status)
    : action === "continue"
      ? status === "paused"
      : action === "terminate"
        ? activeStatus(status)
        : activeStatus(status) && status !== "stop_requested";
}
function withTiming<T extends { startedAt?: string }>(item: T) {
  if (!item.startedAt) return {};
  const finishedAt = new Date().toISOString();
  return {
    finishedAt,
    durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(item.startedAt)),
  };
}
export function interruptJob(job: Job, message: string): Job {
  return {
    ...job,
    browser: job.browser === "not-opened" ? "not-opened" : "unknown",
    status: "interrupted",
    phase: "interrupted",
    message,
    finished: new Date().toISOString(),
    outcomes: job.outcomes.map((item) =>
      ["running", "waiting_captcha"].includes(item.status)
        ? {
            ...item,
            ...withTiming(item),
            status:
              item.persistence === "accepted"
                ? "saved_unverified"
                : "interrupted",
            detail:
              "Tác vụ bị gián đoạn. Kiểm tra Chrome và dữ liệu trên trang đích trước khi thử lại.",
          }
        : item,
    ),
  };
}
export function stopJob(job: Job, message: string): Job {
  return {
    ...job,
    browser: job.browser === "not-opened" ? "not-opened" : "unknown",
    status: "stopped",
    phase: "stopped",
    message,
    finished: new Date().toISOString(),
    outcomes: job.outcomes.map((item) =>
      ["running", "waiting_captcha"].includes(item.status)
        ? {
            ...item,
            ...withTiming(item),
            status: "stopped" as const,
            detail:
              "Đã dừng theo yêu cầu. Chưa xác minh việc lưu; không tự gửi lại.",
          }
        : item,
    ),
  };
}
export function recoverableOutcomes(job: Job): Outcome[] {
  return job.outcomes.filter(
    (item) =>
      item.persistence !== "verified" &&
      [
        "pending",
        "failed",
        "interrupted",
        "saved_unverified",
        "stopped",
      ].includes(item.status),
  );
}
export type ExecutionEvent =
  | { type: "application"; id: string }
  | { type: "submission"; state: "unconfirmed" | "confirmed" }
  | {
      type: "section-start";
      section: (typeof sectionNames)[number];
      scenario: string;
    }
  | { type: "persistence"; state: "possible" | "accepted" | "verified" }
  | { type: "captcha"; waiting: boolean; message?: string }
  | { type: "phase"; phase: string; message: string; debugPort?: number }
  | {
      type: "section-result";
      status: "completed" | "skipped" | "failed";
      detail: string;
      checked?: number;
      blocked?: number;
    };
export interface ExecutionHooks {
  event(event: ExecutionEvent): Promise<void>;
  checkpoint(): Promise<void>;
}
