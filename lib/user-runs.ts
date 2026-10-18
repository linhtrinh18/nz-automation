import { createHash } from "node:crypto";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { RunStore } from "./run-store";
import { currentAppOrigin } from "../server/cloud";
import type { CredentialBinding } from "../server/cloud";
export function userRunStore(userId: string, appOrigin = currentAppOrigin()): RunStore {
  return new RunStore(join(process.cwd(), "data", "runs", "users", createHash("sha256").update(JSON.stringify([appOrigin, userId])).digest("hex")));
}
export async function assertRunBinding(store: RunStore, id: string, binding: CredentialBinding): Promise<void> {
  const owner = JSON.parse(await readFile(store.path(id, "owner.json"), "utf8")) as CredentialBinding;
  if (owner.userId !== binding.userId || owner.revision !== binding.revision) throw new Error("NZWH credentials changed. Create a new run; recovery with a different account is blocked.");
}
