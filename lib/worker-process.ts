import { execFile } from "node:child_process";
import type { Job } from "./execution-state";

export type SignalResult = "signalled" | "gone" | "not-owned";

function commandLine(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("ps", ["-o", "command=", "-p", String(pid)], (error, stdout) => {
      const text = stdout.trim();
      resolve(error || !text ? null : text);
    });
  });
}

export function workerAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Signals the worker only after its command line proves it is this run's worker. */
export async function signalWorker(
  job: Pick<Job, "id" | "pid">,
  signal: "SIGTERM" | "SIGKILL",
): Promise<SignalResult> {
  if (!Number.isInteger(job.pid) || job.pid <= 0) return "gone";
  const command = await commandLine(job.pid);
  if (command === null) return "gone";
  if (!command.includes("workflow/worker.ts") || !command.includes(job.id))
    return "not-owned";
  // The worker is spawned detached, so its process group id is its pid and also covers ChromeDriver.
  try {
    process.kill(-job.pid, signal);
    return "signalled";
  } catch {
    /* No such group; fall back to the process itself. */
  }
  try {
    process.kill(job.pid, signal);
    return "signalled";
  } catch {
    return "gone";
  }
}
