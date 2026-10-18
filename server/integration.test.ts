import { afterEach, expect, test, vi } from "vitest";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { rm, readFile } from "node:fs/promises";
import { createApp } from "./index";
import { userRunStore } from "../lib/user-runs";
import { blankApplication } from "../workflow/application-data";
const owners: { id: string; origin: string }[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const owner of owners.splice(0)) await rm(userRunStore(owner.id, owner.origin).root, { recursive: true, force: true });
});
test("local API reviews, launches a real worker, fails closed on revocation and isolates history", async () => {
  const owner = `fixture-${randomUUID()}`, other = `fixture-${randomUUID()}`;
  const revision = randomUUID();
  const operations: string[] = [];
  const upstream = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const input = JSON.parse(raw); operations.push(input.operation);
    res.setHeader("Content-Type", "application/json");
    if (input.operation === "status") {
      const userId = req.headers.authorization === "Bearer other" ? other : owner;
      res.end(JSON.stringify({ userId, binding: { userId, revision }, credentialsConfigured: true, capsolverConfigured: false, capsolverAvailable: true, twoCaptchaConfigured: false, twoCaptchaAvailable: true, applicationId: "fixture-target" }));
    } else { res.statusCode = 403; res.end(JSON.stringify({ error: "revoked-before-browser" })); }
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address(); if (!address || typeof address === "string") throw new Error("Missing fixture port");
  const origin = `http://127.0.0.1:${address.port}`;
  owners.push({ id: owner, origin }, { id: other, origin });
  const secondUpstream = createServer((req, res) => { upstream.emit("request", req, res); });
  await new Promise<void>(resolve => secondUpstream.listen(0, "127.0.0.1", resolve));
  const secondAddress = secondUpstream.address();
  if (!secondAddress || typeof secondAddress === "string") throw new Error("Missing second fixture port");
  const secondOrigin = `http://127.0.0.1:${secondAddress.port}`;
  owners.push({ id: owner, origin: secondOrigin });
  const app = createApp();
  const request = (path: string, input?: object, token = "owner", caller = origin) => app.request(`http://localhost:3210/api/${path}`, { method: input ? "POST" : "GET", headers: { host: "localhost:3210", origin: caller, authorization: `Bearer ${token}`, "x-local-request": "1", "content-type": "application/json" }, ...(input ? { body: JSON.stringify(input) } : {}) });
  try {
    const foreign = await app.request("http://localhost:3210/api/runtime", { headers: { host: "localhost:3210", origin: "https://another-domain.example" } });
    expect(foreign.status).toBe(401);
    expect(foreign.headers.get("access-control-allow-origin")).toBe("*");
    const noOrigin = await app.request("http://localhost:3210/api/runtime", { headers: { host: "localhost:3210", authorization: "Bearer owner" } });
    expect(noOrigin.status).toBe(400);
    const preflight = await app.request("http://localhost:3210/api/runs", { method: "OPTIONS", headers: { host: "localhost:3210", origin, "access-control-request-method": "POST", "access-control-request-private-network": "true" } });
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    expect(preflight.headers.get("access-control-allow-private-network")).toBe("true");
    const input = { data: blankApplication(), mode: "loginOnly", source: { kind: "login" } };
    const planResponse = await request("runs/plan", input);
    expect(planResponse.status).toBe(200);
    const plan = await planResponse.json();
    const stale = await request("runs", { ...input, profileName: "changed", reviewedPlan: plan.token });
    expect(stale.status).toBe(400);
    const started = await request("runs", { ...input, reviewedPlan: plan.token });
    expect(started.status).toBe(200);
    const job = await started.json();
    let final = job;
    for (let attempt = 0; attempt < 100; attempt++) {
      final = await (await request(`runs/${job.id}`)).json();
      if (final.status === "failed") break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    expect(final.status).toBe("failed");
    expect(final.browser).toBe("not-opened");
    expect(operations).toContain("credentials");
    expect(operations).not.toContain("provider");
    expect(await (await request("runs", undefined, "owner", secondOrigin)).json()).toEqual({ job: null, history: [] });
    expect((await request(`runs/${job.id}`, undefined, "owner", secondOrigin)).status).toBe(400);
    const history = await (await request("runs", undefined, "other")).json();
    expect(history).toEqual({ job: null, history: [] });
    expect((await request(`runs/${job.id}`, undefined, "other")).status).toBe(400);
    expect((await request(`runs/${job.id}/control`, { action: "continue" }, "other")).status).toBe(400);
    await expect(readFile(userRunStore(owner, origin).path(job.id, "session.json"))).rejects.toMatchObject({ code: "ENOENT" });
    const serialized = JSON.stringify(final);
    expect(serialized).not.toContain("Bearer owner");
  } finally { await new Promise<void>(resolve => secondUpstream.close(() => resolve())); await new Promise<void>(resolve => upstream.close(() => resolve())); }
}, 15000);


test.each(["https://first.example", "https://second.example:8443", "http://third.example", "null"])("CORS accepts %s without configuration or cookies", async origin => {
  const app = createApp();
  const response = await app.request("http://localhost:3210/api/runs", { method: "OPTIONS", headers: { host: "localhost:3210", origin, "access-control-request-method": "POST", "access-control-request-headers": "Authorization,X-Local-Request,Content-Type", "access-control-request-private-network": "true" } });
  expect(response.status).toBe(204);
  expect(response.headers.get("access-control-allow-origin")).toBe("*");
  expect(response.headers.get("access-control-allow-credentials")).toBeNull();
  expect(response.headers.get("access-control-allow-private-network")).toBe("true");
});
