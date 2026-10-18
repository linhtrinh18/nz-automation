import { afterEach, expect, test, vi } from "vitest";
import { solveRecaptchaV2, CapSolverError } from "./capsolver";

// Vitest's fake clock does not replace node:timers/promises. Keep its abort
// semantics while routing this module's waits through the controlled test clock.
vi.mock("node:timers/promises", () => ({
  setTimeout: (ms: number, _value: unknown, options: { signal: AbortSignal }) => new Promise<void>((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(options.signal.reason); };
    const timer = setTimeout(() => { options.signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener("abort", onAbort, { once: true });
  }),
}));

const challenge = { websiteURL: "https://onlineservices.immigration.govt.nz/rs-captcha", websiteKey: "public-site-key" };
const key = "test-secret-do-not-log";
const signal = () => new AbortController().signal;
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

test("creates exactly one minimal task and polls after 3 seconds", async () => {
  vi.useFakeTimers();
  const fetch = vi.fn().mockResolvedValueOnce(response({ errorId: 0, taskId: "task" }))
    .mockResolvedValueOnce(response({ errorId: 0, status: "processing" }))
    .mockResolvedValueOnce(response({ errorId: 0, status: "ready", solution: { gRecaptchaResponse: "test-token" } }));
  vi.stubGlobal("fetch", fetch);
  const promise = solveRecaptchaV2(challenge, key, signal());
  await vi.advanceTimersByTimeAsync(2999);
  expect(fetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(3001);
  await expect(promise).resolves.toBe("test-token");
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ clientKey: key, task: { type: "ReCaptchaV2TaskProxyLess", ...challenge } });
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ clientKey: key, taskId: "task" });
  expect(fetch.mock.calls[0][1].redirect).toBe("error");
});

test.each([
  { errorId: 1, errorCode: "ERROR_ZERO_BALANCE", errorDescription: key },
  { errorId: 0, status: "failed" },
  { errorId: 0 },
  { errorId: 0, status: "ready", solution: {} },
  { errorId: 0, status: "ready", solution: { gRecaptchaResponse: "token", "recaptcha-ca-e": "cookie" } },
  { errorId: 0, status: "ready", solution: { gRecaptchaResponse: "token", "recaptcha-ca-t": "cookie" } },
  { unexpected: key },
])("rejects provider errors/unsupported responses without exposing the response: %j", async body => {
  const fetch = vi.fn().mockResolvedValue(response(body));
  vi.stubGlobal("fetch", fetch);
  await expect(solveRecaptchaV2(challenge, key, signal())).rejects.toBeInstanceOf(CapSolverError);
  await expect(solveRecaptchaV2(challenge, key, signal())).rejects.not.toThrow(key);
  expect(fetch).toHaveBeenCalledTimes(2); // one create per invocation, no retries
});

test.each([new Response("secret", { status: 429 }), new Response("not-json")])("handles HTTP/JSON failure with a safe error", async res => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res));
  await expect(solveRecaptchaV2(challenge, key, signal())).rejects.toThrow(/^CapSolver (service|response)$/);
});

test("network errors are sanitized and createTask is never retried", async () => {
  const fetch = vi.fn().mockRejectedValue(new Error(key));
  vi.stubGlobal("fetch", fetch);
  await expect(solveRecaptchaV2(challenge, key, signal())).rejects.toThrow("CapSolver service");
  expect(fetch).toHaveBeenCalledOnce();
});

test("cancellation interrupts an in-flight request", async () => {
  const abort = new AbortController();
  const fetch = vi.fn((_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
  }));
  vi.stubGlobal("fetch", fetch);
  const promise = solveRecaptchaV2(challenge, key, abort.signal);
  const assertion = expect(promise).rejects.toBe("cancelled");
  abort.abort("cancelled");
  await assertion;
  expect(fetch).toHaveBeenCalledOnce();
});

test("cancellation interrupts polling without making another request", async () => {
  vi.useFakeTimers();
  const abort = new AbortController();
  const fetch = vi.fn().mockResolvedValue(response({ errorId: 0, taskId: "task" }));
  vi.stubGlobal("fetch", fetch);
  const promise = solveRecaptchaV2(challenge, key, abort.signal);
  const assertion = expect(promise).rejects.toBe("cancelled");
  await vi.advanceTimersByTimeAsync(1000);
  abort.abort("cancelled");
  await assertion;
  expect(fetch).toHaveBeenCalledOnce();
});

test("processing ends within the 120-second attempt budget", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response({ errorId: 0, taskId: "task" }))
    .mockImplementation(async () => response({ errorId: 0, status: "processing" })));
  const promise = solveRecaptchaV2(challenge, key, signal());
  const assertion = expect(promise).rejects.toThrow("CapSolver timeout");
  await vi.advanceTimersByTimeAsync(120000);
  await assertion;
});
