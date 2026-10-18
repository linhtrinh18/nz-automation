import type { SectionName } from "../workflow/application-data";

export const automationSectionTitles: Record<SectionName, string> = {
  personal: "Thông tin cá nhân",
  identification: "Giấy tờ định danh",
  occupation: "Nghề nghiệp",
  health: "Sức khỏe",
  character: "Lý lịch tư pháp",
  adviser: "Người tư vấn",
  workingHoliday: "Thông tin Working Holiday",
};
export function automationStatus(status: string): string {
  return (
    (
      {
        running: "Đang chạy",
        succeeded: "Hoàn tất",
        incomplete: "Chưa hoàn tất",
        interrupted: "Bị gián đoạn",
      } as Record<string, string>
    )[status] ?? status
  );
}
export function automationScenario(name: string): string {
  return (
    (
      {
        "other-title-and-identity-expiry": "Danh xưng khác và hạn giấy tờ",
        "medical-details": "Chi tiết sức khỏe",
        "character-details-and-previous-visit":
          "Lý lịch tư pháp và lần đến trước",
        "adviser-exempt": "Người tư vấn được miễn giấy phép",
        "adviser-licensed": "Người tư vấn có giấy phép",
        "adviser-unlicensed": "Người tư vấn không có giấy phép",
        "all-editable-controls": "Tất cả trường có thể chỉnh sửa",
      } as Record<string, string>
    )[name] ?? name
  );
}
const messages: Record<string, string> = {
  "NZWH credentials are missing. Set your NZWH username and password in My NZWH credentials at /credentials before creating a run.":
    "Chưa có thông tin đăng nhập NZWH. Mở My NZWH credentials tại /credentials để cấu hình rồi tạo kế hoạch mới.",
  "NZWH credentials changed, were removed, or the account was disabled. Check My NZWH credentials at /credentials and create a new run.":
    "Thông tin đăng nhập NZWH đã đổi, bị xóa hoặc tài khoản bị vô hiệu hóa. Kiểm tra My NZWH credentials tại /credentials rồi tạo lượt chạy mới.",
  "NZWH credentials changed. Create a new run; recovery with a different account is blocked.":
    "Thông tin đăng nhập NZWH đã đổi. Kiểm tra /credentials rồi tạo lượt chạy mới; không thể khôi phục bằng tài khoản khác.",
  "Login rejected: incorrect credentials or account locked. No automatic retry. Check the assigned NZWH credentials and resolve account access manually before restarting.":
    "Đăng nhập bị từ chối: sai thông tin hoặc tài khoản bị khóa. Kiểm tra My NZWH credentials tại /credentials và quyền truy cập trang đích trước khi tạo lượt chạy mới. Không tự thử lại.",
  "Invalid data file.": "Tệp dữ liệu không hợp lệ (JSON, tối đa 1 MB).",
  "Chrome profile is already in use. Close the Chrome window using that profile or choose a different profile name.":
    "Hồ sơ Chrome đang được dùng. Đóng Chrome hoặc đổi tên hồ sơ.",
  "Could not attach to Chrome. Start Chrome with a dedicated --user-data-dir and the selected --remote-debugging-port, then check the local port and matching driver.":
    "Không kết nối được Chrome. Kiểm tra cổng và --user-data-dir.",
  "Chrome session could not start. Close any conflicting profile and check that ChromeDriver matches Chrome; set NZWH_CHROMEDRIVER and NZWH_CHROME_BINARY if needed.":
    "Không mở được Chrome. Kiểm tra ChromeDriver khớp phiên bản Chrome.",
  "Chrome could not start. Install Chrome and allow Selenium Manager to obtain a matching driver, or configure NZWH_CHROME_BINARY and NZWH_CHROMEDRIVER. Check executable permissions and profile locks.":
    "Không khởi động được Chrome. Cài Chrome hoặc đặt NZWH_CHROME_BINARY/NZWH_CHROMEDRIVER.",
  "No editable applications found, or login failed.":
    "Không tìm thấy hồ sơ có thể chỉnh sửa hoặc đăng nhập thất bại.",
  "Multiple applications found; choose NZWH_APPLICATION_ID manually.":
    "Tìm thấy nhiều hồ sơ; hãy chỉ định NZWH_APPLICATION_ID.",
  "Selected application not found.": "Không tìm thấy hồ sơ đã chọn.",
  "CAPTCHA was not completed within 30 minutes; stopped without bypassing it.":
    "CAPTCHA chưa xong sau 30 phút; tác vụ đã dừng.",
  "Login rejected: incorrect credentials or account locked. No automatic retry. Check the environment credentials and resolve account access manually before restarting.":
    "Đăng nhập bị từ chối: sai thông tin hoặc tài khoản bị khóa. Không tự thử lại.",
  "Automation stopped. Check Chrome, target-site credentials, Chrome/driver versions, profile locks and validation. No final submission attempted.":
    "Tự động hóa đã dừng. Kiểm tra Chrome và đăng nhập. Chưa nộp hồ sơ.",
  "Adviser skipped: personal.representedByAdviser is No. Use an adviser scenario to fill this section.":
    "Bỏ qua mục người tư vấn (hồ sơ chọn Không).",
  Configured: "Đã cấu hình",
  "Auto-detected by Selenium": "Selenium tự phát hiện",
  "Selenium Manager": "Selenium Manager",
  "Explicit live-save opt-in is required.":
    "Cần đồng ý trước khi lưu lên trang đích.",
  "Fictional live-save opt-in is required.":
    "Cần đồng ý riêng để lưu dữ liệu giả lập.",
  "An automation run is already active. Finish it before starting another.":
    "Đã có tác vụ đang chạy.",
  "Another run is starting.": "Một tác vụ khác đang khởi động.",
  "Set NZWH_USERNAME and NZWH_PASSWORD in .env.local, then restart Next.js. These are target-site credentials, not app authentication.":
    "Thêm NZWH_USERNAME và NZWH_PASSWORD vào .env.local rồi khởi động lại.",
  "Operation failed. Check JSON structure, filename, file permissions or whether the filename already exists. Your current edits are preserved.":
    "Thao tác thất bại. Thay đổi hiện tại được giữ nguyên.",
  "Unknown scenario.": "Không tìm thấy kịch bản đã chọn.",
  "Passport confirmation differs.": "Hai lần nhập số hộ chiếu không khớp.",
  "Other title requires details.": "Danh xưng khác cần được ghi rõ.",
  "Medical conditions require details.":
    "Cần bổ sung chi tiết về tình trạng sức khỏe.",
  "Character answers require details.":
    "Cần bổ sung chi tiết về lý lịch tư pháp.",
  "Deportation requires date and country.":
    "Cần nhập ngày và quốc gia liên quan đến việc trục xuất.",
  "Previous visit requires a date.": "Cần nhập ngày từng đến New Zealand.",
  "Exempt adviser requires an exemption reason.":
    "Người tư vấn được miễn giấy phép cần có lý do miễn.",
  "NZBN must have 13 digits and begin with 94.":
    "NZBN phải gồm 13 chữ số và bắt đầu bằng 94.",
  "Inconsistent birth, travel or passport expiry dates.":
    "Ngày sinh, ngày dự định đi hoặc hạn hộ chiếu không hợp lệ hoặc không nhất quán.",
  "Previous visit must precede intended travel.":
    "Lần đến trước phải sớm hơn ngày dự định đi.",
  "Identification expiry must follow issue date.":
    "Ngày hết hạn giấy tờ phải sau ngày cấp.",
};
/** Translate presentation only; raw field keys, scenario IDs and stored reports remain compatible. */
export function translateAutomationText(text: string): string {
  let output = text;
  for (const [english, vietnamese] of Object.entries(messages))
    output = output.replaceAll(english, vietnamese);
  return output
    .replace(
      /Missing mapped fields in (\w+)\./g,
      "Thiếu các trường bắt buộc cho tự động hóa trong mục $1.",
    )
    .replace(/Invalid option: ([\w.]+)\./g, "Lựa chọn không hợp lệ: $1.")
    .replace(
      /Invalid date format: ([\w.]+)\./g,
      "Định dạng ngày không hợp lệ: $1.",
    )
    .replace(
      /Opening section (\d+)\/(\d+): (\w+)\./g,
      (_, current: string, total: string, section: string) =>
        `Đang mở mục ${current}/${total}: ${automationSectionTitles[section as SectionName] ?? section}.`,
    )
    .replaceAll("filled/read back", "trường đã điền và đọc lại")
    .replaceAll("modeled lookups", "kết quả tra cứu mô phỏng")
    .replaceAll("blocked", "bị chặn")
    .replaceAll("failures", "lỗi")
    .replaceAll("entered and read back.", "đã nhập và đọc lại.")
    .replaceAll("Run completed successfully.", "Lượt chạy đã hoàn tất.")
    .replaceAll(
      "Run incomplete. Review skipped/unverified sections and coverage reports.",
      "Lượt chạy chưa hoàn tất. Xem các mục bỏ qua hoặc chưa xác minh.",
    )
    .replaceAll(
      "Stopped before declarations, final submission and payment. Chrome remains open for review.",
      "Đã dừng trước phần cam kết và nộp hồ sơ. Chrome giữ mở.",
    )
    .replaceAll(
      "CAPTCHA pending. Solve it manually in Chrome. The dedicated CAPTCHA Submit button is clicked automatically after completion; no terminal input needed.",
      "Đang chờ CAPTCHA. Giải trong Chrome; tác vụ tự tiếp tục.",
    )
    .replaceAll(
      "Manually solved CAPTCHA detected. CAPTCHA-only Submit clicked; waiting for acceptance.",
      "Đã giải CAPTCHA; đang chờ xác nhận.",
    )
    .replaceAll(
      "CAPTCHA completion detected. Resuming automatically.",
      "Đã phát hiện CAPTCHA hoàn tất. Tác vụ tự tiếp tục.",
    )
    .replaceAll(
      "Starting a fresh login before opening any applicant fields.",
      "Đang đăng nhập lại trước khi mở các trường hồ sơ.",
    )
    .replaceAll("Previous session signed out.", "Đã đăng xuất phiên cũ.")
    .replaceAll(
      "Login submitted; waiting for authenticated page.",
      "Đã gửi thông tin đăng nhập; đang chờ trang xác thực.",
    )
    .replaceAll(
      "Mode: autofill verification; no live SAVE.",
      "Chế độ: thử điền, không lưu.",
    )
    .replaceAll(
      "Mode: FILL AND SAVE. Each applicable field is entered and read back before SAVE.",
      "Chế độ: điền và lưu.",
    )
    .replace(
      /SAVE completed; (\d+) values persisted and verified. Continuing in the same tab./g,
      "Đã lưu; $1 giá trị được xác minh.",
    )
    .replaceAll(
      "site returned Please try again later. Save state is unverified; moving to the next form section in this same tab.",
      "Trang đích bận; chưa xác minh lưu. Chuyển sang mục kế tiếp.",
    )
    .replaceAll(
      "Sections saved and verified this run:",
      "Các mục đã lưu và xác minh trong lượt này:",
    )
    .replaceAll("Planned form pages:", "Thứ tự các mục dự kiến:");
}

/** Stable Vietnamese recovery advice; technical identifiers stay in the diagnostic log. */
export function executionErrorText(message: string): string {
  if (/Saved-value|Readback mismatch|Saved occupation/.test(message))
    return "Không xác minh được dữ liệu đã lưu. Kiểm tra Chrome trước khi chạy lại.";
  if (/Server validation/.test(message))
    return "Trang đích báo dữ liệu không hợp lệ. Xem Chrome.";
  if (/Additional .*branch|conditional field|Conditional page/.test(message))
    return "Trang có nhánh chưa hỗ trợ. Kiểm tra biểu mẫu thật.";
  if (/site.*busy|try again later/i.test(message))
    return "Trang nhập cư đang bận. Chạy lại sau.";
  const translated = translateAutomationText(message);
  if (
    !/Stopped in|Form interaction|Unexpected navigation|Unexpected application|Original draft|Session expired again/.test(
      translated,
    )
  )
    return translated;
  return "Tác vụ dừng ở một mục. Kiểm tra Chrome và kết quả từng mục.";
}
