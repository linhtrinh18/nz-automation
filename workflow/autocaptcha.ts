import { z } from "zod";
// Node worker only. Never import this module into a Client Component.
// autocaptcha.pro solves in a single synchronous request (no create/poll endpoints).
const responseSchema = z.object({
  success: z.boolean(),
  message: z.string().optional(),
  captcha: z.unknown().optional(),
});
const tokenSchema = z.string().trim().min(1).max(32000);
// The solve duration is undocumented; the deadline matches the CapSolver precedent.
const DEADLINE_MS = 120000;
export class AutoCaptchaError extends Error {
  constructor(public readonly category: "timeout" | "service" | "response" | "auth") {
    // Never expose provider bodies, messages, URLs, tokens or request exceptions.
    super(`AutoCaptcha ${category}`);
  }
}
/** One billable request, no retries. The API key is sent only in the JSON body. */
export async function solveAutoCaptcha(
  challenge: { websiteURL: string; websiteKey: string },
  apiKey: string,
  signal: AbortSignal,
  log: (message: string) => void = () => undefined,
): Promise<string> {
  signal.throwIfAborted();
  const deadline = AbortSignal.timeout(DEADLINE_MS);
  try {
    log("AutoCaptcha request sending.");
    const response = await fetch("https://autocaptcha.pro/apiv3/process", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: apiKey, type: "recaptchav2", googlesitekey: challenge.websiteKey, pageurl: challenge.websiteURL }),
      signal: AbortSignal.any([signal, deadline]),
      redirect: "error",
    });
    if (response.status === 401 || response.status === 403) throw new AutoCaptchaError("auth");
    if (!response.ok) throw new AutoCaptchaError("service");
    const parsed = responseSchema.safeParse(await response.json());
    if (!parsed.success) throw new AutoCaptchaError("response");
    if (!parsed.data.success) throw new AutoCaptchaError("service");
    const token = tokenSchema.safeParse(parsed.data.captcha);
    if (!token.success) throw new AutoCaptchaError("response");
    return token.data;
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (deadline.aborted || (error instanceof Error && error.name === "TimeoutError"))
      throw new AutoCaptchaError("timeout");
    if (error instanceof AutoCaptchaError) throw error;
    throw new AutoCaptchaError("service");
  }
}
