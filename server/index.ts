import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { pathToFileURL } from "node:url";
import { parseAppOrigin, cloudContext, executionStatus } from "./cloud";
import { userRunStore, assertRunBinding } from "../lib/user-runs";
import { getJob, latestJob, recentJobs, recoveryConfig, getReport, controlJob, controlPayload, resolveInput, reviewToken, startJob } from "../lib/jobs";
import { validateRun } from "../lib/run-config";
import { buildPlan } from "../lib/run-plan";
import { translateAutomationText } from "../lib/automation-vietnamese";

export function createApp() {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (!/^(localhost|127\.0\.0\.1):3210$/.test(c.req.header("host") ?? "")) return c.json({ error: "Only loopback requests are allowed." }, 403);
    const caller = c.req.header("origin");
    if (caller && c.req.header("Access-Control-Request-Private-Network") === "true") c.header("Access-Control-Allow-Private-Network", "true");
    return next();
  });
  app.use("*", cors({ origin: "*", allowMethods: ["GET", "POST", "OPTIONS"], allowHeaders: ["Authorization", "Content-Type", "X-Local-Request"], credentials: false, maxAge: 600 }));
  app.on(["GET", "POST"], "/api/*", async c => {
    const authorization = c.req.header("authorization") ?? "";
    if (!/^Bearer \S+$/i.test(authorization)) return c.json({ error: "Authentication required." }, 401);
    if (c.req.method === "POST" && c.req.header("x-local-request") !== "1") return c.json({ error: "Local request header required." }, 403);
    let appOrigin: string;
    try { appOrigin = parseAppOrigin(c.req.header("origin") ?? ""); }
    catch { return c.json({ error: "A valid frontend Origin header is required." }, 400); }
    return cloudContext.run({ authorization, appOrigin }, async () => {
      try {
        const status = await executionStatus();
        const context = cloudContext.getStore()!;
        context.binding = status.binding ?? undefined;
        context.applicationId = status.applicationId;
        const repository = userRunStore(status.userId, appOrigin);
        const path = c.req.path.slice("/api/".length).split("/");
        let result: unknown;
        if (c.req.method === "GET") {
          if (path.join("/") === "runtime") result = { ...status, binding: undefined, userId: undefined, applicationId: undefined, node: process.version, chromeBinary: process.env.NZWH_CHROME_BINARY ? "Configured" : "Auto-detected by Selenium", driver: process.env.NZWH_CHROMEDRIVER ? "Configured" : "Selenium Manager", profiles: "data/profiles", storage: "PostgreSQL application documents", reports: "data/runs" };
          else if (path[0] === "runs" && path.length <= 3) {
            if (path[2] === "recovery") {
              if (!status.binding) throw new Error("Configure credentials before recovery.");
              await assertRunBinding(repository, path[1], status.binding);
              result = await recoveryConfig(path[1], repository);
            } else result = path[1] ? path[2] ? await getReport(path[1], path[2], repository) : await getJob(path[1], repository) : { job: await latestJob(repository), history: await recentJobs(repository) };
          } else return c.json({ error: "Unknown endpoint." }, 404);
        } else {
          // Bound streamed bodies before JSON parsing.
          const reader = c.req.raw.body?.getReader();
          let raw = "", size = 0;
          const decoder = new TextDecoder();
          if (reader) while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > 1024 * 1024) { await reader.cancel(); throw new Error("JSON exceeds 1 MB."); }
            raw += decoder.decode(chunk.value, { stream: true });
          }
          raw += decoder.decode();
          const input: unknown = JSON.parse(raw);
          if (path[0] !== "runs") return c.json({ error: "Unknown endpoint." }, 404);
          if (path.length === 3 && path[2] === "control") result = await controlJob(path[1], controlPayload.parse(input).action, repository);
          else {
            if (!status.binding) throw new Error("Configure credentials before creating a run.");
            const config = await resolveInput(input, repository, status.binding);
            if (path.length === 2 && path[1] === "plan") { validateRun(config, false); result = { plan: buildPlan(config), token: reviewToken(config, status.binding) }; }
            else if (path.length === 1) result = await startJob(config, repository, status.binding);
            else return c.json({ error: "Unknown endpoint." }, 404);
          }
        }
        return c.json(result as object);
      } catch (error) {
        return c.json({ error: translateAutomationText(error instanceof Error ? error.message : "Automation request failed.") }, 400);
      }
    });
  });
  app.onError((_error, c) => c.json({ error: "Automation service unavailable." }, 500));
  return app;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.umask(0o077);
  serve({ fetch: createApp().fetch, hostname: "localhost", port: 3210 }, () => {
    console.log("NZWH local automation listening on http://localhost:3210");
  });
}
