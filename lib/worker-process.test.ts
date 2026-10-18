import { expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { signalWorker } from "./worker-process";

test("signalWorker refuses a process that is not this run's worker and ignores pid 0", async () => {
  expect(await signalWorker({ id: randomUUID(), pid: process.pid }, "SIGTERM")).toBe("not-owned");
  expect(await signalWorker({ id: randomUUID(), pid: 0 }, "SIGTERM")).toBe("gone");
});
