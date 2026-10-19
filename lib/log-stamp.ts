import { format } from "node:util";
import { formatClock } from "./format-duration";
import { redactSecrets } from "./redact";

// Process-memory only; covers keys loaded/replaced during worker/CLI execution.
const registeredSecrets = new Set<string>();
export function registerLogSecret(secret: string): void {
  if (secret) registeredSecrets.add(secret);
}

export const QUIET_TOKEN = "[NZWH:q]";
/** Marks a routine INFO line to print without a timestamp stamp (milestones stay stamped). */
export function quiet(message: string): string {
  return `${QUIET_TOKEN} ${message}`;
}
/** Prefixes every console line with ISO time, elapsed since boot and level; secrets are masked. */
export function installLogStamping(
  bootMs: number,
  secrets: () => (string | undefined)[],
): void {
  const wrap = (level: "INFO" | "WARN" | "ERROR", write: (text: string) => void) =>
    (...args: unknown[]) => {
      const text = redactSecrets(format(...args), [...secrets(), ...registeredSecrets], true);
      if (level === "INFO" && text.includes(QUIET_TOKEN)) {
        return; // routine per-field chatter is dropped; milestones stay stamped
      }
      const stamp = `${new Date().toISOString()} +${formatClock(Date.now() - bootMs)} ${level}`;
      for (const line of text.split("\n")) write(`${stamp} ${line}`);
    };
  const log = console.log.bind(console);
  const warn = console.warn.bind(console);
  const error = console.error.bind(console);
  console.log = wrap("INFO", log);
  console.warn = wrap("WARN", warn);
  console.error = wrap("ERROR", error);
}
