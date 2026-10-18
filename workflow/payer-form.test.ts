import { expect, test, vi } from "vitest";
import { payerDisplayName, completePayerForm } from "./payer-form";
import type { WebDriver } from "selenium-webdriver";
test("payer display name uses the account name or Tuan when absent", () => {
  expect(payerDisplayName("  Account Name  ")).toBe("Account Name");
  expect(payerDisplayName(" ")).toBe("Tuan");
  expect(payerDisplayName()).toBe("Tuan");
});
test("readback failure never clicks OK or proceeds to card payment", async () => {
  const ok = { click: vi.fn() };
  const form = { input: { clear: vi.fn(), sendKeys: vi.fn(), getAttribute: async () => "changed" }, ok, max: 100, url: "https://fixture", stamp: 1 };
  const driver = { wait: async () => form } as unknown as WebDriver;
  await expect(completePayerForm(driver, { origin: "https://fixture", applicationId: "app", receiptToken: "token", checkpoint: async () => {}, waitForChange: async () => {} })).rejects.toThrow("readback");
  expect(ok.click).not.toHaveBeenCalled();
});
