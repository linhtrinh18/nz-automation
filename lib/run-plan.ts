import { automatedSection } from "../workflow/section-policy";
import { sectionNames } from "../workflow/application-data";
import { scenarioData } from "../workflow/data-validation";
import type { RunInput } from "./run-config";
import type { Outcome } from "./execution-state";
export interface RunPlan {
  outcomes: Outcome[];
  selected: string[];
  dataKind: "applicant" | "fictional";
  source: string;
  scenarioNames: string[];
  warnings: string[];
}
export function requestedSections(input: Pick<RunInput, "sections">) {
  const requested = input.sections ?? sectionNames;
  return sectionNames.filter((section) => automatedSection(section) && requested.includes(section));
}
export function buildPlan(input: RunInput): RunPlan {
  if (input.mode === "loginOnly") return {
    outcomes: [], selected: [], dataKind: "applicant", source: "Chỉ đăng nhập",
    scenarioNames: [], warnings: ["Chỉ đăng nhập trang Working Holiday và giữ Chrome mở. Không chọn quốc gia, mở hoặc điền hồ sơ, nộp hồ sơ hay thanh toán."],
  };
  const selected = requestedSections(input);
  const scenarioNames = [input.scenario];
  const outcomes: Outcome[] = scenarioNames.flatMap((scenario) => {
    const data = scenarioData(input.data, scenario);
    return sectionNames.map((section) => {
      const reason =
        !automatedSection(section) ? "Bỏ qua Nghề nghiệp theo yêu cầu: không điền hoặc xác minh."
        : input.resumeKeys && !input.resumeKeys.includes(`${scenario}:${section}`)
          ? "Không chạy lại mục đã hoàn tất / ngoài phạm vi khôi phục."
          : !selected.includes(section)
            ? "Ngoài phạm vi đã chọn."
            : section === "adviser" &&
                data.personal.representedByAdviser !== "Yes"
              ? "Không áp dụng: hồ sơ không chọn người tư vấn."
              : "";
      return {
        key: `${scenario}:${section}`,
        scenario,
        section,
        status: reason ? "skipped" : "pending",
        persistence: "none",
        detail: reason,
        checked: 0,
        blocked: 0,
      };
    });
  });
  return {
    outcomes,
    selected,
    dataKind: input.data.dataKind,
    source:
      input.source.kind === "login" ? "Chỉ đăng nhập" : input.source.kind === "document"
        ? `Tài liệu: ${input.source.name ?? input.source.documentId} · phiên bản ${input.source.revision.slice(0, 8)}`
        : input.source.kind === "applicant"
        ? "Bản dữ liệu hồ sơ cũ (tệp CLI)"
        : input.source.kind === "sample"
          ? "Bản dữ liệu mẫu cũ (tệp CLI)"
          : input.source.kind === "legacy"
            ? "Nguồn dữ liệu cũ (đã gỡ)"
            : `Bản dữ liệu của lượt chạy ${input.source.runId}${input.source.origin?.name ? ` · ${input.source.origin.name}` : ""}`,
    scenarioNames,
    warnings: [
      "Ghi đè các trường có thể sửa trong các mục đã chọn. Chọn người tư vấn và tra cứu nghề nghiệp cũng có thể gửi dữ liệu lên trang đích.",
      "Đăng xuất phiên cũ, đăng nhập và chọn hồ sơ. Trang đích có thể mở trang mặc định của hồ sơ; chỉ các mục trong phạm vi mới được xử lý. CAPTCHA theo chế độ đã chọn; luôn có thể giải thủ công trong Chrome.",
      ...(input.captchaMode === "capsolver" ? ["CapSolver thử nghiệm: tối đa một lần cho mỗi lần chờ CAPTCHA phù hợp, có tính phí. Chỉ gửi site key và địa chỉ trang CAPTCHA không có tham số; lỗi chuyển sang thủ công. Chưa xác minh trên trang đích thật."] : []),
      ...(input.captchaMode === "autocaptcha" ? ["AutoCaptcha thử nghiệm: tối đa một lần cho mỗi lần chờ CAPTCHA phù hợp, có tính phí. Chỉ gửi site key và địa chỉ trang CAPTCHA không có tham số; lỗi chuyển sang thủ công. Chưa xác minh trên trang đích thật."] : []),
      ...(input.captchaMode === "2captcha" ? ["2Captcha thử nghiệm: tối đa một lần cho mỗi lần chờ CAPTCHA phù hợp, có tính phí. Chỉ gửi site key và địa chỉ trang CAPTCHA không có tham số; lỗi chuyển sang thủ công. Chưa xác minh trên trang đích thật."] : []),
      input.mode === "fillAndSubmit"
        ? "Điền và nộp: sau khi xác minh các mục đã chọn, thực hiện cam kết và nộp hồ sơ Working Holiday. Lưu bản nháp hoặc gửi CAPTCHA không phải là nộp hồ sơ. Khi chưa có xác nhận đã nộp (kể cả khi chuyển sang thanh toán), lượt chạy chưa hoàn tất."
        : "Chỉ điền: dừng trước phần cam kết, nộp hồ sơ cuối cùng và thanh toán; Chrome giữ mở để bạn kiểm tra.",
    ],
  };
}
