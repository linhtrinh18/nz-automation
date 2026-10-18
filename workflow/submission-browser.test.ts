import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { Builder, type WebDriver } from "selenium-webdriver";
import { Options } from "selenium-webdriver/chrome";
import { finishApplication } from "./submission";

let server: Server;
let driver: WebDriver;
let origin: string;
let submissions = 0;
let reject = false;
let liveLayout = false;
let unknownDeclaration = false;
let preventDeclarationToggle = false;
let checkedCount = 0;
let tokenReceipt = false;
let wrongPaymentToken = false;
let paymentOpens = 0;
let gatewayOpens = 0;
let payerPosts = 0;
let postedPayer = "";
let wrongGatewayApplication = false;
const declarationIds = ["falseStatementCheckBox", "notesCheckBox", "circumstancesCheckBox", "warrantsCheckBox", "informationCheckBox", "healthCheckBox", "adviceCheckBox", "registrationCheckBox", "entitlementCheckbox", "permitExpiryCheckBox", "medicalInsuranceCheckBox", "adviserCheckBox"];
const applicationId = "local-submission-fixture";

beforeAll(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url!, "http://localhost");
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    const hiddenId = `<input type="hidden" name="ApplicationId" value="${applicationId}">`;
    if (url.pathname === "/PaymentGateway/OnLinePayment.aspx") {
      if (request.method === "POST") {
        payerPosts++;
        let body = "";
        request.on("data", chunk => { body += chunk; });
        request.on("end", () => {
          postedPayer = new URLSearchParams(body).get("payerName") || "";
          response.writeHead(302, { Location: "/Card.aspx" }); response.end();
        });
      } else {
        gatewayOpens++;
        response.end('<h1>Online Payment</h1><form method="post"><label>Payer Name<input id="_ctl0_ContentPlaceHolder1_payerNameTextBox" name="payerName" maxlength="100"></label><input id="_ctl0_ContentPlaceHolder1_okButton" type="submit" value="OK"></form>');
      }
    } else if (url.pathname === "/Card.aspx") {
      response.end('<h1>Card payment</h1><input placeholder="Card number"><button>Pay</button>');
    } else if (url.pathname.endsWith("Pay.aspx")) {
      paymentOpens++;
      response.end(`<h1>Paying for Your Application</h1><a id="ContentPlaceHolder1_onlinePaymentAnchor"
        href="/PaymentGateway/OnLinePayment.aspx?SourceUrl=//127.0.0.1:${(server.address() as { port: number }).port}/WorkingHoliday/Application/SubmitConfirmation.aspx?ApplicationId=${wrongGatewayApplication ? "other" : applicationId}&ProductId=2&Token=fixture+receipt==">secure payment site</a>`);
    } else if (url.pathname.endsWith("Submit.aspx") && url.searchParams.has("Token")) {
      response.end(`<h2>Submit Received</h2><p>Please note that you must pay the application fee before your place is secured.</p>
        <a id="ContentPlaceHolder1_payAnchor" href="Pay.aspx?Token=${wrongPaymentToken ? "wrong" : "fixture+receipt=="}"><span>PAY NOW</span></a><a href="Later.aspx">PAY LATER</a>`);
    } else if (url.pathname.endsWith("WorkingHoliday.aspx")) {
      response.end(`<form action="/WorkingHoliday/Application/Submit.aspx">
        ${hiddenId}<input type="submit" value="SUBMIT"
        id="ContentPlaceHolder1_wizardPageFooter_wizardPageNavigator_submitImageButton"></form>`);
    } else if (url.pathname.endsWith("Submit.aspx")) {
      if (liveLayout) {
        response.end(`<style>input[type=checkbox]{display:none}label{display:inline-block;width:70px;height:24px}</style>
          <form method="post" action="/WorkingHoliday/Application/Confirmation.aspx?ApplicationId=${applicationId}">
          <table>${declarationIds.map((knownId, index) => { const id = unknownDeclaration && index === 0 ? "unknownCheckBox" : knownId; return `<tr><td><ul><li>${index === 10 ? "I am fully aware of the policy requirements." : "I understand and accept this declaration."}</li></ul></td><td>
          <input type="checkbox" name="${id}" id="ContentPlaceHolder1_${id}" required><label ${preventDeclarationToggle ? 'onclick="event.preventDefault()"' : ""} for="ContentPlaceHolder1_${id}">Yes</label></td></tr>`; }).join("")}</table>
          <div style="height:2400px" aria-hidden="true"></div>
          <input type="submit" id="ContentPlaceHolder1_submitImageButton" value="SUBMIT">
          <input type="submit" value="CANCEL"></form>`);
        return;
      }
      response.end(`<form method="post" action="/WorkingHoliday/Application/Confirmation.aspx?ApplicationId=${applicationId}">
        <label><input type="checkbox" required onchange="document.getElementById('submit').disabled=!this.checked">I agree to the declaration</label>
        <button id="submit" type="submit" disabled>Submit application</button></form>`);
    } else if (url.pathname.endsWith("Confirmation.aspx") && request.method === "POST") {
      submissions++;
      let body = "";
      request.on("data", chunk => { body += chunk; });
      request.on("end", () => { checkedCount = Array.from(new URLSearchParams(body).keys()).filter(key => declarationIds.includes(key)).length; });
      if (tokenReceipt && !reject) {
        response.writeHead(302, { Location: "/WorkingHoliday/Application/Submit.aspx?Token=fixture%2Breceipt%3D%3D" });
        response.end();
        return;
      }
      response.end(reject
        ? '<div role="alert">Your application could not be submitted.</div>'
        : '<h1>Your application has been successfully submitted.</h1>');
    } else {
      response.statusCode = 404;
      response.end("Not found");
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const chromeOptions = new Options();
  chromeOptions.addArguments("--headless=new", "--window-size=1280,900");
  driver = await new Builder().forBrowser("chrome")
    .setChromeOptions(chromeOptions)
    .build();
}, 60000);

beforeEach(async () => {
  submissions = 0;
  reject = false;
  liveLayout = false;
  unknownDeclaration = false;
  preventDeclarationToggle = false;
  checkedCount = 0;
  tokenReceipt = false;
  wrongPaymentToken = false;
  paymentOpens = 0;
  gatewayOpens = 0;
  payerPosts = 0;
  postedPayer = "";
  wrongGatewayApplication = false;
  await driver.get(`${origin}/WorkingHoliday/Wizard/WorkingHoliday.aspx?ApplicationId=${applicationId}`);
});

afterAll(async () => {
  await driver?.quit();
  server?.closeAllConnections();
  if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve()));
});

async function run(mode: "saveAll" | "fillAndSubmit", waitForCaptcha?: () => Promise<void>, payerName?: string) {
  return finishApplication(driver, {
    mode, origin, applicationId, filled: true, waitForCaptcha, payerName,
    checkpoint: async () => {},
    ready: async () => { await driver.wait(async () => await driver.executeScript("return document.readyState") === "complete", 10000); },
    waitForChange: condition => driver.wait(condition, 10000),
    submitting: async () => {},
    confirmed: async () => {},
  });
}

test("Fill only leaves the real browser on the draft without a final POST", async () => {
  expect(await run("saveAll")).toMatchObject({ outcome: "filled", success: true });
  expect(await driver.getCurrentUrl()).toContain("/Wizard/WorkingHoliday.aspx");
  expect(submissions).toBe(0);
});

test("Fill and submit follows real forms, consents, submits once and reads confirmation", async () => {
  expect(await run("fillAndSubmit")).toMatchObject({ outcome: "submitted", success: true });
  expect(submissions).toBe(1);
}, 20000);

test("a rejected final POST stays incomplete and is never repeated", async () => {
  reject = true;
  expect(await run("fillAndSubmit")).toMatchObject({ outcome: "incomplete", success: false });
  expect(submissions).toBe(1);
}, 20000);


test("audited INZ layout: twelve hidden inputs with Yes labels in separate table cells", async () => {
  liveLayout = true;
  expect(await run("fillAndSubmit")).toMatchObject({ outcome: "submitted", success: true });
  expect(submissions).toBe(1);
  expect(checkedCount).toBe(12);
}, 20000);

test("an unrecognized Yes declaration blocks the final POST", async () => {
  liveLayout = true;
  unknownDeclaration = true;
  expect(await run("fillAndSubmit")).toMatchObject({ outcome: "incomplete", success: false });
  expect(submissions).toBe(0);
}, 20000);

test("a label click that fails to check the input blocks the final POST", async () => {
  liveLayout = true;
  preventDeclarationToggle = true;
  expect(await run("fillAndSubmit")).toMatchObject({ outcome: "incomplete", success: false });
  expect(submissions).toBe(0);
}, 20000);


test("real browser checks all Yes labels and scrolls to the bottom before waiting for declaration CAPTCHA", async () => {
  liveLayout = true;
  let captchaWaited = false;
  const waitForCaptcha = async () => {
    if (!(await driver.getCurrentUrl()).includes("/Application/Submit.aspx")) return;
    expect(await driver.executeScript('return document.querySelectorAll("input[type=checkbox]:checked").length')).toBe(12);
    expect(await driver.executeScript(`return window.scrollY > 0 &&
      window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2;`)).toBe(true);
    expect(submissions).toBe(0);
    captchaWaited = true;
  };
  expect(await run("fillAndSubmit", waitForCaptcha)).toMatchObject({ outcome: "submitted" });
  expect(captchaWaited).toBe(true);
  expect(submissions).toBe(1);
}, 20000);

test("follows token-only Submit Received to Pay Now once and stops before paying", async () => {
  liveLayout = true;
  tokenReceipt = true;
  const result = await run("fillAndSubmit");
  expect(result).toMatchObject({ outcome: "incomplete", success: false });
  expect(result.message).toContain("Đã nhập tên người trả phí");
  expect(await driver.getCurrentUrl()).toContain("/Card.aspx");
  expect(submissions).toBe(1);
  expect(paymentOpens).toBe(1);
  expect(gatewayOpens).toBe(1);
  expect(payerPosts).toBe(1);
  expect(postedPayer).toBe("Tuan");
  expect(await driver.findElement({css: 'input[placeholder="Card number"]'}).getAttribute("value")).toBe("");
}, 20000);

test("refuses a Pay Now link with a different receipt token", async () => {
  tokenReceipt = true;
  wrongPaymentToken = true;
  expect(await run("fillAndSubmit")).toMatchObject({ outcome: "incomplete" });
  expect(paymentOpens).toBe(0);
}, 20000);

test("does not trust a token receipt opened outside the pinned submission flow", async () => {
  await driver.get(`${origin}/WorkingHoliday/Application/Submit.aspx?Token=fixture%2Breceipt%3D%3D`);
  expect(await run("fillAndSubmit")).toMatchObject({ outcome: "incomplete" });
  expect(paymentOpens).toBe(0);
}, 20000);


test("does not open a payment gateway for a different application", async () => {
  tokenReceipt = true;
  wrongGatewayApplication = true;
  expect(await run("fillAndSubmit")).toMatchObject({ outcome: "incomplete" });
  expect(paymentOpens).toBe(1);
  expect(gatewayOpens).toBe(0);
}, 20000);


test("uses the run owner's display name and clicks payer OK exactly once", async () => {
  tokenReceipt = true;
  expect(await run("fillAndSubmit", undefined, "  Account Display Name  ")).toMatchObject({ outcome: "incomplete" });
  expect(postedPayer).toBe("Account Display Name");
  expect(payerPosts).toBe(1);
  expect(await driver.getCurrentUrl()).toContain("/Card.aspx");
}, 20000);
