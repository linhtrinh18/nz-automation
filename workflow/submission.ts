import type { WebDriver, WebElement } from "selenium-webdriver";
import type { RunInput } from "../lib/run-config";
import { completePayerForm } from "./payer-form";
import { StopRequested } from "../lib/execution-controller";

export interface ApplicationResult {
  success: boolean;
  outcome: "loggedIn" | "filled" | "submitted" | "incomplete";
  message: string;
}

interface SubmissionPage {
  url: string;
  stamp: number;
  confirmed: boolean;
  blocked: boolean;
  payment: boolean;
  stage: "wizard" | "declaration" | "receipt" | "other";
  button: WebElement | null;
  payNow: WebElement | null;
  declarations: WebElement[];
  declarationCount: number;
  unknownDeclarations: number;
}

/** Read website evidence, excluding hidden text, field values and CAPTCHA forms. */
export async function readSubmissionPage(
  driver: WebDriver,
  origin: string,
  applicationId: string,
  allowTokenReceipt = false,
): Promise<SubmissionPage> {
  return driver.executeScript<SubmissionPage>(String.raw`
    const origin = arguments[0], applicationId = arguments[1];
    const url = new URL(location.href);
    const visible = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const text = e => (e.innerText ?? '').replace(/\s+/g, ' ').trim();
    const receipt = arguments[2] && url.origin === origin && !url.searchParams.has('ApplicationId')
      && !!url.searchParams.get('Token') && url.pathname === '/WorkingHoliday/Application/Submit.aspx'
      && Array.from(document.querySelectorAll('h1,h2')).some(e => visible(e) && /^Submit Received$/i.test(text(e)));
    const scoped = !document.querySelector('input[name="username"],input[name="password"]')
      && url.origin === origin && (url.searchParams.get('ApplicationId') === applicationId || receipt)
      && /^\/WorkingHoliday\/(?:Wizard|Application)\/[^/]+\.aspx$/i.test(url.pathname);
    const stage = !scoped ? 'other' : receipt ? 'receipt'
      : /\/(?:Submit|Declarations?)\.aspx$/i.test(url.pathname) ? 'declaration'
      : /\/Wizard\//i.test(url.pathname) ? 'wizard' : 'other';
    const body = document.body?.innerText || '';
    const blocked = Array.from(document.querySelectorAll('.validation-summary-errors,.field-validation-error,[role="alert"],[id*="ValidationSummary"]'))
      .some(e => visible(e) && text(e))
      || /please try again later|site (?:is )?busy|application (?:could not|cannot) be submitted|application (?:has |was |is )?(?:not |never )(?:been )?(?:submitted|received|accepted)|submission failed|unable to submit|scheme is not available/i.test(body);
    // A completed SAVE, CAPTCHA, a redirect or a Submit button is never evidence.
    const confirmed = scoped && !blocked && Array.from(document.querySelectorAll('h1,h2,h3,p,[role="status"],[id*="confirmation" i],[id*="status" i]'))
      .filter(visible).some(e => text(e).split(/[.!]\s+/).some(sentence =>
        /^(?:(?:your|the|this) )?(?:working holiday )?(?:visa )?application (?:(?:has been|was|is) )?(?:successfully )?(?:submitted|received)(?: successfully)?(?: to Immigration New Zealand| to INZ| for processing)?[.!]?$/i.test(sentence)));
    const payment = scoped && (receipt || /\/payment/i.test(url.pathname)
      || /(?:payment|application fee) (?:is )?(?:required|due)|(?:please |you (?:must|need to) )pay|pay (?:now|the (?:application )?fee)/i.test(body));
    const safeForm = e => {
      const form = e.form;
      if (!form) return false;
      const action = new URL(e.getAttribute('formaction') || form.getAttribute('action') || url.href, url.href);
      return action.origin === origin && /^\/WorkingHoliday\/(?:Wizard|Application)\//i.test(action.pathname)
        && (!action.searchParams.has('ApplicationId') || action.searchParams.get('ApplicationId') === applicationId);
    };
    const buttons = scoped ? Array.from(document.querySelectorAll('input[type="submit"],input[type="image"],button[type="submit"],button:not([type])'))
      .filter(e => visible(e) && !e.disabled && safeForm(e)
        && (stage === 'wizard'
          ? e.id === 'ContentPlaceHolder1_wizardPageFooter_wizardPageNavigator_submitImageButton'
          : stage === 'declaration' && /^(?:submit(?: application)?|confirm(?: and submit)?)$/i.test((e.value || e.alt || text(e)).trim()))) : [];
    const payLinks = scoped && receipt ? Array.from(document.querySelectorAll('a[id="ContentPlaceHolder1_payAnchor"]'))
      .filter(e => {
        if (!visible(e) || !/^PAY NOW$/i.test(text(e))) return false;
        const target = new URL(e.getAttribute('href'), url.href);
        const token = value => (value || '').replace(/ /g, '+');
        return target.origin === origin && target.pathname === '/WorkingHoliday/Application/Pay.aspx'
          && token(target.searchParams.get('Token')) === token(url.searchParams.get('Token'));
      }) : [];
    const auditedIds = new Set([
      'falseStatementCheckBox', 'notesCheckBox', 'circumstancesCheckBox', 'warrantsCheckBox',
      'informationCheckBox', 'healthCheckBox', 'adviceCheckBox', 'registrationCheckBox',
      'entitlementCheckbox', 'permitExpiryCheckBox', 'medicalInsuranceCheckBox', 'adviserCheckBox',
    ].map(id => 'ContentPlaceHolder1_' + id));
    const declarationText = value => /^I (?:agree|accept|declare|confirm|understand|authori[sz]e|have read|certify|am fully aware)\b/i.test(value);
    const checks = stage === 'declaration' ? Array.from(document.querySelectorAll('input[type="checkbox"]'))
      .filter(e => !e.disabled && safeForm(e)).map(e => {
        const labels = Array.from(e.labels || []);
        const label = labels.find(visible);
        // INZ hides native checkboxes. The visible Yes label toggles the input;
        // the actual legal statement lives in the first cell of the same row.
        const row = e.closest?.('tr');
        const knownRow = auditedIds.has(e.id) && label && /^Yes$/i.test(text(label))
          && row && row.querySelectorAll('input[type="checkbox"]').length === 1
          && declarationText(text(row.querySelector('td')));
        const knownLabel = labels.some(label => declarationText(text(label)));
        return { e, target: visible(e) ? e : label, recognized: knownRow || knownLabel };
      }).filter(item => item.target) : [];
    const recognized = checks.filter(item => item.recognized);
    const declarations = recognized.filter(item => !item.e.checked).map(item => item.target);
    const unknownDeclarations = checks.filter(item => !item.recognized &&
      Array.from(item.e.labels || []).some(label => /^Yes$/i.test(text(label)))).length;
    return { url: url.href, stamp: performance.timeOrigin, stage, confirmed, blocked, payment,
      button: buttons.length === 1 ? buttons[0] : null, payNow: payLinks.length === 1 ? payLinks[0] : null, declarations,
      declarationCount: recognized.length, unknownDeclarations };
  `, origin, applicationId, allowTokenReceipt);
}

/** Only the audited payment introduction can open the payer-name gateway. */
export async function readSecurePaymentLink(
  driver: WebDriver, origin: string, applicationId: string, receiptToken: string,
): Promise<WebElement | null> {
  return driver.executeScript<WebElement | null>(String.raw`
    const [origin, applicationId, receiptToken] = arguments;
    const url = new URL(location.href);
    const token = value => (value || '').replace(/ /g, '+');
    if (url.origin !== origin || url.pathname !== '/WorkingHoliday/Application/Pay.aspx'
        || !receiptToken || token(url.searchParams.get('Token')) !== token(receiptToken)) return null;
    const links = Array.from(document.querySelectorAll('a[id="ContentPlaceHolder1_onlinePaymentAnchor"]')).filter(e => {
      const r = e.getBoundingClientRect();
      if (!r.width || !r.height || !/^secure payment site$/i.test(e.innerText.trim())) return false;
      const target = new URL(e.getAttribute('href'), url.href);
      const source = new URL(target.searchParams.get('SourceUrl') || '/', origin);
      return target.origin === origin && target.pathname === '/PaymentGateway/OnLinePayment.aspx'
        && target.searchParams.get('ProductId') === '2'
        && token(target.searchParams.get('Token')) === token(receiptToken)
        && source.origin === origin && source.pathname === '/WorkingHoliday/Application/SubmitConfirmation.aspx'
        && source.searchParams.get('ApplicationId') === applicationId;
    });
    return links.length === 1 ? links[0] : null;
  `, origin, applicationId, receiptToken);
}

interface SubmissionOptions {
  mode: RunInput["mode"];
  payerName?: string;
  filled: boolean;
  origin: string;
  applicationId?: string;
  checkpoint(): Promise<void>;
  /** Wait for page DOM only; an inline declaration CAPTCHA must not block this. */
  ready(): Promise<void>;
  waitForCaptcha?(): Promise<void>;
  waitForChange(condition: () => Promise<boolean>): Promise<unknown>;
  submitting(): Promise<void>;
  confirmed(): Promise<void>;
}

/** Never retries a submission POST, including after timeouts or uncertain responses. */
export async function finishApplication(
  driver: WebDriver,
  options: SubmissionOptions,
): Promise<ApplicationResult> {
  const incomplete = (message: string): ApplicationResult => ({ success: false, outcome: "incomplete", message });
  if (options.mode === "loginOnly")
    return incomplete("Chế độ chỉ đăng nhập không thực hiện nộp hồ sơ.");
  if (!options.filled)
    return incomplete("Chưa điền và xác minh xong các mục đã chọn. Không thực hiện nộp hồ sơ cuối cùng.");
  if (options.mode === "saveAll")
    return { success: true, outcome: "filled", message: "Đã điền, lưu và xác minh các mục đã chọn. Chưa nộp hồ sơ; Chrome giữ mở để bạn kiểm tra." };
  if (!options.applicationId)
    return incomplete("Đã điền các mục đã chọn nhưng không xác định được mã hồ sơ để nộp.");
  // Token-only receipts are trusted only after this run clicks the pinned
  // application's final declaration Submit, never from an arbitrary starting URL.
  let declarationSubmitted = false;
  const read = () => readSubmissionPage(driver, options.origin, options.applicationId!, declarationSubmitted);
  const visited = new Set<string>();
  try {
    // At most one wizard transition and one final declaration submission.
    for (let action = 0; action < 3; action++) {
      await options.checkpoint();
      await options.ready();
      let page = await read();
      console.log(`[NZWH] Submission audit: stage=${page.stage} declarations=${page.declarationCount} unchecked=${page.declarations.length} unknown=${page.unknownDeclarations} submit=${!!page.button} blocked=${page.blocked} payment=${page.payment} confirmed=${page.confirmed}.`);
      if (page.unknownDeclarations)
        return incomplete("Trang cam kết có mục chưa được nhận diện. Kiểm tra Chrome trước khi nộp.");
      if (page.stage === "receipt") {
        if (!page.payNow) return incomplete("Website đã nhận thao tác nộp nhưng không nhận diện được liên kết Pay Now an toàn. Kiểm tra Chrome.");
        await options.checkpoint();
        console.log("[NZWH] Submit Received: opening Pay Now once. Payment has not been made.");
        await page.payNow.click();
        await options.waitForChange(async () => (await read()).url !== page.url);
        const paymentUrl = new URL((await read()).url);
        if (paymentUrl.origin === options.origin && paymentUrl.pathname === "/WorkingHoliday/Application/Pay.aspx") {
          await options.ready();
          const nextStep = await readSecurePaymentLink(driver, options.origin, options.applicationId!, new URL(page.url).searchParams.get("Token") ?? "");
          if (!nextStep) return incomplete("Đã mở trang thanh toán nhưng không nhận diện được liên kết Secure Payment Site an toàn. Kiểm tra Chrome.");
          await options.checkpoint();
          console.log("[NZWH] Payment introduction: opening Secure Payment Site once. No card details entered or payment made.");
          await nextStep.click();
          await options.waitForChange(async () => (await read()).url !== paymentUrl.href);
          const gateway = new URL((await read()).url);
          if (gateway.origin === options.origin && gateway.pathname === "/PaymentGateway/OnLinePayment.aspx") {
            await completePayerForm(driver, {
              origin: options.origin, applicationId: options.applicationId!,
              receiptToken: new URL(page.url).searchParams.get("Token") ?? "",
              payerName: options.payerName, checkpoint: options.checkpoint, waitForChange: options.waitForChange,
            });
            const cardPage = new URL((await read()).url);
            if (cardPage.origin === "https://payments.paystation.co.nz" && cardPage.pathname === "/hosted/")
              return incomplete("Đã nhập tên người trả phí và bấm OK, mở trang nhập thẻ Paystation. Chưa thanh toán; hoàn tất trên Chrome.");
            return incomplete("Đã nhập tên người trả phí và bấm OK một lần. Kiểm tra Chrome để hoàn tất thanh toán; chưa xác nhận đã trả phí.");
          }
          return incomplete("Đã bấm Next Step một lần. Kiểm tra trang thanh toán trên Chrome; chưa xác nhận đã trả phí.");
        }
        return incomplete("Đã bấm Pay Now một lần. Kiểm tra Chrome để hoàn tất thanh toán; chưa xác nhận đã trả phí.");
      }
      if (page.confirmed) {
        await options.confirmed();
        return { success: true, outcome: "submitted", message: "Website đã xác nhận hồ sơ Working Holiday này được nộp thành công." };
      }
      if (page.blocked)
        return incomplete("Đã điền các mục đã chọn nhưng website chặn hoặc báo lỗi khi nộp. Chưa xác nhận nộp hồ sơ; kiểm tra Chrome trước khi thử lại.");
      if (page.payment)
        return incomplete("Đã điền các mục đã chọn; website yêu cầu thanh toán và chưa xác nhận nộp hồ sơ. Hoàn tất trên Chrome.");
      if (page.stage === "other" || visited.has(page.stage)) break;
      // Declaration consent can enable an initially disabled Submit control.
      if (!page.button && !(page.stage === "declaration" && page.declarations.length)) break;
      visited.add(page.stage);
      for (const declaration of page.declarations) {
        await options.checkpoint();
        // Re-check application identity before every declaration mutation.
        const current = await read();
        if (current.url !== page.url || current.stage !== "declaration" || current.blocked)
          return incomplete("Trang cam kết đã thay đổi. Chưa xác nhận nộp hồ sơ; kiểm tra Chrome.");
        if (!(await declaration.isSelected())) await declaration.click();
      }
      if (page.stage === "declaration") {
        const verified = await read();
        if (verified.url !== page.url || verified.stage !== "declaration" || verified.blocked ||
            verified.unknownDeclarations || verified.declarations.length || verified.declarationCount !== page.declarationCount)
          return incomplete("Chưa xác minh được tất cả cam kết đã chọn. Chưa nộp hồ sơ; kiểm tra Chrome.");
        await driver.executeScript(`window.scrollTo({
          top: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
          left: 0,
          behavior: "instant"
        });`);
        console.log(`[NZWH] Declarations verified: ${verified.declarationCount}/${page.declarationCount} checked.`);
      }
      // Prepare declarations before spending the CAPTCHA token's limited lifetime.
      await options.checkpoint();
      await options.waitForCaptcha?.();
      // CAPTCHA completion may change the page or reset checked declarations.
      const before = page;
      page = await read();
      if (page.url !== before.url || page.stage !== before.stage || !page.button || page.blocked || page.payment ||
          page.unknownDeclarations || (page.stage === "declaration" &&
          (page.declarations.length || page.declarationCount !== before.declarationCount))) break;
      await options.checkpoint();
      // Persist uncertainty BEFORE the first potentially submitting click.
      await options.submitting();
      console.log(`[NZWH] Submission action: ${page.stage === "wizard" ? "open declaration page" : "final declaration submit"}; sending once.`);
      if (page.stage === "declaration") declarationSubmitted = true;
      await page.button.click();
      await options.waitForChange(async () => {
        const next = await read();
        return next.confirmed || next.blocked || next.payment || next.url !== page.url || next.stamp !== page.stamp;
      });
    }
  } catch (error) {
    if (error instanceof StopRequested) throw error;
    return incomplete("Đã điền các mục đã chọn nhưng không xác nhận được kết quả nộp hồ sơ. Không tự nộp lại; kiểm tra trạng thái trên website.");
  }
  return incomplete("Đã điền các mục đã chọn nhưng website chưa xác nhận nộp hồ sơ hoặc bước nộp chưa được hỗ trợ. Kiểm tra Chrome; không tự nộp lại.");
}
