import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

// Node worker only. Never import this module into a Client Component.
const responseSchema = z.object({
  errorId: z.number().int(),
  taskId: z.string().min(1).max(200).optional(),
  status: z.enum(["idle", "processing", "ready", "failed"]).optional(),
  solution: z.object({
    gRecaptchaResponse: z.string().trim().min(1).max(32000).optional(),
    "recaptcha-ca-e": z.string().optional(),
    "recaptcha-ca-t": z.string().optional(),
  }).optional(),
});

export class CapSolverError extends Error {
  constructor(public readonly category: "timeout" | "service" | "response" | "session") {
    // Never expose provider bodies, descriptions, URLs, tokens or request exceptions.
    super(`CapSolver ${category}`);
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
      const response = await fetch(`https://api.capsolver.com/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientKey: apiKey, ...payload }),
        signal: AbortSignal.any([combined, AbortSignal.timeout(15000)]),
        redirect: "error",
      });
      if (!response.ok) throw new CapSolverError("service");
      const parsed = responseSchema.safeParse(await response.json());
      if (!parsed.success) throw new CapSolverError("response");
      if (parsed.data.errorId !== 0 || parsed.data.status === "failed")
        throw new CapSolverError("service");
      return parsed.data;
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (deadline.aborted || (error instanceof Error && error.name === "TimeoutError"))
        throw new CapSolverError("timeout");
      if (error instanceof CapSolverError) throw error;
      throw new CapSolverError("service");
    }
  }
  function token(result: z.infer<typeof responseSchema>): string {
    if (result.solution?.["recaptcha-ca-e"] || result.solution?.["recaptcha-ca-t"])
      throw new CapSolverError("session");
    if (!result.solution?.gRecaptchaResponse) throw new CapSolverError("response");
    return result.solution.gRecaptchaResponse;
  }
  const created = await request("createTask", {
    task: { type: "ReCaptchaV2TaskProxyLess", ...challenge },
  });
  if (created.status === "ready") return token(created);
  if (!created.taskId) throw new CapSolverError("response");
  // 3s polling, under the documented 120-query/5-minute result limits.
  for (let poll = 0; poll < 40; poll++) {
    try { await delay(3000, undefined, { signal: combined }); }
    catch { if (signal.aborted) throw signal.reason; throw new CapSolverError("timeout"); }
    const result = await request("getTaskResult", { taskId: created.taskId });
    if (result.status === "ready") return token(result);
    if (result.status !== "idle" && result.status !== "processing")
      throw new CapSolverError("response");
  }
  throw new CapSolverError("timeout");
}
