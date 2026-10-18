import { format } from "node:util";
import { formatDuration } from "./format-duration";
import { redactSecrets } from "./redact";

// Process-memory only; covers keys loaded/replaced during worker/CLI execution.
const registeredSecrets = new Set<string>();
export function registerLogSecret(secret: string): void {
  if (secret) registeredSecrets.add(secret);
}

/** Prefixes every console line with ISO time, elapsed since boot and level; secrets are masked. */
export function installLogStamping(
  bootMs: number,
  secrets: () => (string | undefined)[],
): void {
  const wrap = (level: "INFO" | "WARN" | "ERROR", write: (text: string) => void) =>
    (...args: unknown[]) => {
      const text = redactSecrets(format(...args), [...secrets(), ...registeredSecrets], true);
      const stamp = `${new Date().toISOString()} +${formatDuration(Date.now() - bootMs)} ${level}`;
      for (const line of text.split("\n")) write(`${stamp} ${line}`);
    };
  const log = console.log.bind(console);
  const warn = console.warn.bind(console);
  const error = console.error.bind(console);
  console.log = wrap("INFO", log);
  console.warn = wrap("WARN", warn);
  console.error = wrap("ERROR", error);
}
