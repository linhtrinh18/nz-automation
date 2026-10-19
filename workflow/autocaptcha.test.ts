import { afterEach, expect, test, vi } from "vitest";
import { solveAutoCaptcha, AutoCaptchaError } from "./autocaptcha";
const challenge = { websiteURL: "https://onlineservices.immigration.govt.nz/rs-captcha", websiteKey: "public-site-key" };
const key = "test-secret-do-not-log";
const signal = () => new AbortController().signal;
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
test("sends exactly one minimal request with the key only in the body", async () => {
  const fetch = vi.fn().mockResolvedValue(response({ success: true, message: "ok", captcha: "test-token" }));
  vi.stubGlobal("fetch", fetch);
  await expect(solveAutoCaptcha(challenge, key, signal())).resolves.toBe("test-token");
  expect(fetch).toHaveBeenCalledTimes(1);
  const [url, init] = fetch.mock.calls[0];
  expect(url).toBe("https://autocaptcha.pro/apiv3/process");
  expect(String(url)).not.toContain(key);
  expect(JSON.parse(init.body)).toEqual({ key, type: "recaptchav2", googlesitekey: challenge.websiteKey, pageurl: challenge.websiteURL });
  expect(init.redirect).toBe("error");
});
test.each([
  { success: false, message: key, captcha: "ERROR" },
  { success: true },
  { success: true, captcha: "" },
  { success: true, captcha: { token: "x" } },
  { unexpected: key },
])("rejects failures/unsupported responses without exposing them: %j", async body => {
  const fetch = vi.fn().mockResolvedValue(response(body));
  vi.stubGlobal("fetch", fetch);
  const error = await solveAutoCaptcha(challenge, key, signal()).catch(e => e);
  expect(error).toBeInstanceOf(AutoCaptchaError);
  expect(error.message).not.toContain(key);
  expect(fetch).toHaveBeenCalledTimes(1);
});
test.each([[new Response(key, { status: 429 }), "service"], [new Response(key, { status: 401 }), "auth"], [new Response("not-json"), "response|service"]])("handles HTTP/JSON failure with a safe error", async (res, category) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res));
  await expect(solveAutoCaptcha(challenge, key, signal())).rejects.toThrow(new RegExp(`^AutoCaptcha (${category})$`));
});
test("network errors are sanitized and never retried", async () => {
  const fetch = vi.fn().mockRejectedValue(new Error(key));
  vi.stubGlobal("fetch", fetch);
  await expect(solveAutoCaptcha(challenge, key, signal())).rejects.toThrow(/^AutoCaptcha service$/);
  expect(fetch).toHaveBeenCalledTimes(1);
});
test("cancellation of an in-flight request rethrows the cancellation reason", async () => {
  vi.stubGlobal("fetch", vi.fn((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)))));
  const controller = new AbortController();
  const promise = solveAutoCaptcha(challenge, key, controller.signal);
  controller.abort("cancelled");
  await expect(promise).rejects.toBe("cancelled");
  await expect(solveAutoCaptcha(challenge, key, AbortSignal.abort("early"))).rejects.toBe("early");
});
test("the 120 second deadline reports a timeout", async () => {
  // AbortSignal.timeout is not driven by the fake clock; capture and fire it directly.
  const real = AbortSignal.timeout.bind(AbortSignal);
  const controller = new AbortController();
  const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => ms === 120000 ? controller.signal : real(ms));
  vi.stubGlobal("fetch", vi.fn((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)))));
  const promise = solveAutoCaptcha(challenge, key, signal());
  controller.abort(new DOMException("timed out", "TimeoutError"));
  await expect(promise).rejects.toThrow(/^AutoCaptcha timeout$/);
  expect(timeout).toHaveBeenCalledWith(120000);
  timeout.mockRestore();
});
