import { expect, test, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import sample from "../fixtures/sample.json";
vi.mock("../server/cloud", async (original) => {
  const queries = await original<typeof import("../server/cloud")>();
  return { ...queries, loadDocumentForRun: async (_userId: string, id: string, revision: string) => ({ id, revision, name: "Fixture", data: (await import("../fixtures/sample.json")).default }) };
});
const mocked = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocked.spawn }));
import { RunStore } from "./run-store";
import { startJob, reviewToken, resolveInput } from "./jobs";
import { runSchema } from "./run-config";
test("concurrent worker launches persist only owner/revision and strip shared credentials", async () => {
  const root=await mkdtemp(join(tmpdir(),"nzwh-worker-pairs-"));
  vi.stubEnv("NZWH_USERNAME","shared-username"); vi.stubEnv("NZWH_PASSWORD","shared-secret");
  vi.stubEnv("CAPSOLVER_API_KEY","obsolete-provider-secret");
  vi.stubEnv("TWOCAPTCHA_API_KEY","obsolete-two-secret");
  mocked.spawn.mockImplementation(() => Object.assign(new EventEmitter(), { unref() {}, stdio: [null, null, null, { on() {}, end() {} }] }));
  try {
    const input=runSchema.parse({ data:sample, source:{kind:"document",documentId:randomUUID(),revision:randomUUID(),name:"Fixture"}, mode:"saveAll", sections:["health"], liveSaveConsent:true, allowFictionalDraftSave:true });
    const a={userId:"a",revision:randomUUID()},b={userId:"b",revision:randomUUID()};
    const stores=[new RunStore(join(root,"a")),new RunStore(join(root,"b"))];
    const jobs=await Promise.all([a,b].map((binding,index)=>startJob({...input,reviewedPlan:reviewToken(input,binding)},stores[index],binding)));
    expect(mocked.spawn).toHaveBeenCalledTimes(2);
    for(const call of mocked.spawn.mock.calls) {
      const options=call[2];
      expect(options.env.NZWH_USERNAME).toBeUndefined();expect(options.env.NZWH_PASSWORD).toBeUndefined();
      expect(options.env.CAPSOLVER_API_KEY).toBeUndefined();
      expect(options.env.TWOCAPTCHA_API_KEY).toBeUndefined();
      expect(JSON.stringify(call)).not.toMatch(/shared-secret|obsolete-provider-secret|obsolete-two-secret/);
    }
    for(const [index,binding] of [a,b].entries()) {
      expect(JSON.parse(await readFile(stores[index].path(jobs[index].id,"owner.json"),"utf8"))).toEqual(binding);
      const persisted=await readFile(stores[index].path(jobs[index].id,"input.json"),"utf8");
      expect(persisted).not.toMatch(/shared-secret|shared-username|password|credentials|obsolete-provider-secret|apiKey/);
    }
    expect(reviewToken(input,a)).not.toBe(reviewToken(input,b));
    await expect(resolveInput({...input,source:{kind:"run",runId:jobs[0].id}},stores[0],b)).rejects.toThrow("credentials changed");
  } finally {vi.unstubAllEnvs();await rm(root,{recursive:true,force:true});}
});
