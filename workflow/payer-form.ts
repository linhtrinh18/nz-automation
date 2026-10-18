import type { WebDriver, WebElement } from "selenium-webdriver";
import { WorkingHolidayStop } from "./errors";

export function payerDisplayName(name?: string | null): string {
  return name?.trim() || "Tuan";
}

/** Complete only INZ's payer-name form. Never interact with card fields or Pay. */
export async function completePayerForm(driver: WebDriver, options: {
  origin: string; applicationId: string; receiptToken: string; payerName?: string;
  checkpoint(): Promise<void>;
  waitForChange(condition: () => Promise<boolean>): Promise<unknown>;
}): Promise<void> {
  const read = () => driver.executeScript<{ input: WebElement; ok: WebElement; stamp: number; url: string; max: number } | null>(String.raw`
    const [origin, applicationId, receiptToken] = arguments;
    const url = new URL(location.href);
    const token = value => (value || '').replace(/ /g, '+');
    const source = new URL(url.searchParams.get('SourceUrl') || '/', origin);
    if (url.origin !== origin || url.pathname !== '/PaymentGateway/OnLinePayment.aspx'
      || !receiptToken || token(url.searchParams.get('Token')) !== token(receiptToken)
      || url.searchParams.get('ProductId') !== '2' || source.origin !== origin
      || source.pathname !== '/WorkingHoliday/Application/SubmitConfirmation.aspx'
      || source.searchParams.get('ApplicationId') !== applicationId) return null;
    const input = document.getElementById('_ctl0_ContentPlaceHolder1_payerNameTextBox');
    const ok = document.getElementById('_ctl0_ContentPlaceHolder1_okButton');
    const visible = e => e && !e.disabled && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0;
    if (!visible(input) || !visible(ok) || input.type !== 'text' || ok.type !== 'submit'
      || !/^OK$/i.test(ok.value) || !input.form || input.form !== ok.form) return null;
    const action = new URL(ok.getAttribute('formaction') || input.form.getAttribute('action') || url.href, url.href);
    if (action.origin !== origin || action.pathname !== url.pathname) return null;
    return { input, ok, url: url.href, stamp: performance.timeOrigin, max: input.maxLength };
  `, options.origin, options.applicationId, options.receiptToken);
  const form = await driver.wait(read, 20000);
  if (!form) throw new WorkingHolidayStop("Payer-name form unavailable for this application.");
  const name = payerDisplayName(options.payerName);
  if (form.max >= 0 && name.length > form.max)
    throw new WorkingHolidayStop("Payer name exceeds the website length limit. Review the account display name.");
  await options.checkpoint();
  await form.input.clear();
  await form.input.sendKeys(name);
  if (await form.input.getAttribute("value") !== name)
    throw new WorkingHolidayStop("Payer name readback failed.");
  const current = await read();
  if (!current || current.url !== form.url || current.stamp !== form.stamp)
    throw new WorkingHolidayStop("Payer-name page changed before OK.");
  await options.checkpoint();
  console.log("[NZWH] Payer name entered and verified; clicking OK once. No card details entered or payment made.");
  await current.ok.click();
  await options.waitForChange(async () => {
    const next = await read();
    return !next || next.stamp !== form.stamp || next.url !== form.url;
  });
}
