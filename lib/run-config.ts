import { z } from "zod";
import { applicationDataSchema } from "../workflow/application-data";
import { sectionSchema } from "./execution-state";
import { requestedSections, buildPlan } from "./run-plan";
import { countryCodes } from "./countries";
import { scenarioData, validateData } from "../workflow/data-validation";
export const documentRunSourceSchema = z.object({ kind: z.literal("document"), documentId: z.string().uuid(), revision: z.string().uuid(), name: z.string().max(120).optional() }).strict();
export const runSchema = z
  .object({
    data: applicationDataSchema,
    // Keep the existing value for older fill/save snapshots.
    mode: z.enum(["loginOnly", "saveAll", "fillAndSubmit"]).default("saveAll"),
    source: z
      .preprocess(
        // Runs recorded before the two-file model used "editor" or "saved".
        (value) =>
          value &&
          typeof value === "object" &&
          ["editor", "saved"].includes((value as { kind?: string }).kind ?? "")
            ? { kind: "legacy" }
            : value,
        z.discriminatedUnion("kind", [
          documentRunSourceSchema,
          z.object({ kind: z.literal("login") }),
          z.object({ kind: z.literal("applicant") }),
          z.object({ kind: z.literal("sample") }),
          z.object({ kind: z.literal("run"), runId: z.string().uuid(), origin: documentRunSourceSchema.optional() }),
          z.object({ kind: z.literal("legacy") }),
        ]),
      )
      .default({ kind: "applicant" }),
    resumeKeys: z.array(z.string().max(160)).optional(),
    sections: z.array(sectionSchema).min(1).max(7).optional(),
    reviewedPlan: z.string().optional(),
    recoveryAcknowledged: z.boolean().default(false),
    scenario: z.string().default("baseline"),
    attachPort: z.number().int().min(1024).max(65535).optional(),
    browserType: z
      .enum(["visible", "profile"])
      .default("visible"),
    headless: z.boolean().default(false),
    profileName: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,60}$/)
      .default("working-holiday"),
    captchaMode: z.enum(["manual", "capsolver", "2captcha", "autocaptcha"]).default("manual"),
    useDefaultAgent: z.boolean().default(true),
    country: z.enum(countryCodes).optional(),
    liveSaveConsent: z.boolean().default(false),
    allowFictionalDraftSave: z.boolean().default(false),
  })
  .strict();
export type RunInput = z.infer<typeof runSchema>;
export function validateRun(input: RunInput, requireConsent = true): void {
  if (input.headless && input.attachPort)
    throw new Error("Chế độ ẩn không dùng được với Chrome đang mở.");
  if (input.mode === "loginOnly") return;
  if (input.source.kind === "login") throw new Error("Login source requires login-only mode.");
  if (requireConsent && !input.liveSaveConsent)
    throw new Error("Explicit live-save opt-in is required.");
  if (
    requireConsent &&
    input.data.dataKind === "fictional" &&
    !input.allowFictionalDraftSave
  )
    throw new Error("Fictional live-save opt-in is required.");
  if (input.resumeKeys && input.source.kind !== "run")
    throw new Error("Phạm vi khôi phục chỉ dùng với dữ liệu của lượt chạy cũ.");
  if (input.sections && new Set(input.sections).size !== input.sections.length)
    throw new Error("Không chọn trùng mục hồ sơ.");
  const names = [input.scenario];
  if (!buildPlan(input).outcomes.some((item) => item.status === "pending"))
    throw new Error(
      "Không có mục nào có thể chạy trong phạm vi này. Chọn mục phù hợp hoặc kiểm tra kịch bản.",
    );
  names.forEach((name) => {
    const data = scenarioData(input.data, name);
    validateData(data);
    if (
      requestedSections(input).includes("adviser") &&
      data.personal.representedByAdviser === "Yes" &&
      data.adviser.adviserType !== "2"
    )
      throw new Error(
        "Chưa hỗ trợ lưu nhánh người tư vấn này. Bỏ chọn mục Người tư vấn.",
      );
  });
}
