import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

// Node worker only. Never import this module into a Client Component.
const responseSchema = z.object({
  errorId: z.number().int(),
  taskId: z.number().int().positive().safe().optional(),
  errorCode: z.string().optional(),
  errorDescription: z.string().optional(),
  balance: z.number().optional(),
  status: z.enum(["idle", "processing", "ready", "failed"]).optional(),
  solution: z.object({
    gRecaptchaResponse: z.string().trim().min(1).max(32000).optional(),
    token: z.string().trim().min(1).max(32000).optional(),
    "recaptcha-ca-e": z.string().optional(),
    "recaptcha-ca-t": z.string().optional(),
  }).optional(),
});

export type TwoCaptchaCategory =
  | "timeout" | "service" | "response" | "session"
  | "balance" | "auth" | "ip" | "unsolvable" | "busy" | "proxy";

// Spec error codes (errorId) mapped to categories; anything else is "service".
function categoryFor(errorId: number): TwoCaptchaCategory {
  switch (errorId) {
    case 10: return "balance";
    case 1: case 55: return "auth";
    case 11: case 21: return "ip";
    case 12: case 13: return "unsolvable";
    case 2: return "busy";
    case 130: return "proxy";
    default: return "service";
  }
}

export class TwoCaptchaError extends Error {
  /** True for HTTP/network failures (no provider verdict), safe to retry on polling only. */
  transient = false;
  constructor(public readonly category: TwoCaptchaCategory) {
    // Never expose provider bodies, descriptions, URLs, tokens or request exceptions.
    super(`TwoCaptcha ${category}`);
  }
}

async function call(
  method: "createTask" | "getTaskResult" | "getBalance",
  apiKey: string,
  payload: object,
  signal: AbortSignal,
) {
  const response = await fetch(`https://api.2captcha.com/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey: apiKey, ...payload }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    redirect: "error",
  });
  if (!response.ok) throw Object.assign(new TwoCaptchaError("service"), { transient: true });
  const parsed = responseSchema.safeParse(await response.json());
  if (!parsed.success) throw new TwoCaptchaError("response");
  if (parsed.data.errorId !== 0) throw new TwoCaptchaError(categoryFor(parsed.data.errorId));
  if (parsed.data.status === "failed") throw new TwoCaptchaError("service");
  return parsed.data;
}

/** Returns the account balance in USD. */
export async function getTwoCaptchaBalance(apiKey: string, signal: AbortSignal): Promise<number> {
  signal.throwIfAborted();
  try {
    const result = await call("getBalance", apiKey, {}, signal);
    if (typeof result.balance !== "number") throw new TwoCaptchaError("response");
    return result.balance;
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof TwoCaptchaError) throw error;
    if (error instanceof Error && error.name === "TimeoutError") throw new TwoCaptchaError("timeout");
    throw new TwoCaptchaError("service");
  }
}

/** One task, no create retries (a failed connection may already have incurred a charge). */
export async function solveRecaptchaV2(
  challenge: { websiteURL: string; websiteKey: string },
  apiKey: string,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const deadline = AbortSignal.timeout(120000);
  const combined = AbortSignal.any([signal, deadline]);
  async function request(method: "createTask" | "getTaskResult", payload: object) {
    try {
      combined.throwIfAborted();
      return await call(method, apiKey, payload, combined);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (deadline.aborted || (error instanceof Error && error.name === "TimeoutError"))
        throw new TwoCaptchaError("timeout");
      if (error instanceof TwoCaptchaError) throw error;
      throw Object.assign(new TwoCaptchaError("service"), { transient: true });
    }
  }
  function token(result: z.infer<typeof responseSchema>): string {
    if (result.solution?.["recaptcha-ca-e"] || result.solution?.["recaptcha-ca-t"])
      throw new TwoCaptchaError("session");
    const value = result.solution?.gRecaptchaResponse ?? result.solution?.token;
    if (!value) throw new TwoCaptchaError("response");
    return value;
  }
  const created = await request("createTask", {
    task: { type: "RecaptchaV2TaskProxyless", ...challenge },
  });
  if (created.status === "ready") return token(created);
  if (!created.taskId) throw new TwoCaptchaError("response");
  // Official getTaskResult guidance requires at least 5 seconds between polls.
  for (let poll = 0; poll < 24; poll++) {
    try { await delay(5000, undefined, { signal: combined }); }
    catch { if (signal.aborted) throw signal.reason; throw new TwoCaptchaError("timeout"); }
    // Only polling is retried on transient HTTP/network failures (createTask never is).
    let result: Awaited<ReturnType<typeof request>> | undefined;
    for (let attempt = 0; !result; attempt++) {
      try { result = await request("getTaskResult", { taskId: created.taskId }); }
      catch (error) {
        if (!(error instanceof TwoCaptchaError) || !error.transient || attempt >= 2) throw error;
        try { await delay(5000, undefined, { signal: combined }); }
        catch { if (signal.aborted) throw signal.reason; throw new TwoCaptchaError("timeout"); }
      }
    }
    if (result.status === "ready") return token(result);
    if (result.status !== "idle" && result.status !== "processing")
      throw new TwoCaptchaError("response");
  }
  throw new TwoCaptchaError("timeout");
}
