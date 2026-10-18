import { expect, test } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { assertRunBinding, userRunStore } from "./user-runs";
import { RunStore, atomicJson } from "./run-store";
test("run and recovery ownership cannot cross users or credential revisions", async () => {
  expect(userRunStore("a", "https://one.example").root).not.toBe(userRunStore("a", "https://two.example").root);
  expect(userRunStore("a").root).not.toBe(userRunStore("b").root);
  const root = await mkdtemp(join(tmpdir(), "nzwh-owner-"));
  try {
    const store = new RunStore(root), id = randomUUID();
    await mkdir(join(root,id));
    await atomicJson(store.path(id,"owner.json"), { userId: "a", revision: "v1" });
    await expect(assertRunBinding(store,id,{ userId: "a", revision: "v1" })).resolves.toBeUndefined();
    await expect(assertRunBinding(store,id,{ userId: "b", revision: "v1" })).rejects.toThrow();
    await expect(assertRunBinding(store,id,{ userId: "a", revision: "v2" })).rejects.toThrow();
  } finally { await rm(root,{recursive:true,force:true}); }
});
