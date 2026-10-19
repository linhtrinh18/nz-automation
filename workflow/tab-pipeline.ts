// Tab pipeline configuration and the SAVE-acceptance gate (design rev 3, sections 2, 4, 6.1, 6.3).
// Pure bookkeeping: no driver calls, so it is unit-testable offline. The default mode is "off".
import type { ExecutionEvent } from "../lib/execution-state";
import type { SectionName } from "./application-data";

export type PipelineMode = "off" | "verify" | "save";
export type Barrier = "verified" | "accepted";
export interface PipelineSnapshot { mode: PipelineMode; barrier: Barrier; log: string[] }
export interface PipelineContext { attachPort?: number; fast: boolean; early: boolean; loginOnly: boolean }

const modes: readonly PipelineMode[] = ["off", "verify", "save"];
const barriers: readonly Barrier[] = ["verified", "accepted"];
const oneOf = <T extends string>(allowed: readonly T[], raw: string | undefined): T | undefined =>
  allowed.find(value => value === raw?.trim().toLowerCase());

/** Reads NZWH_TAB_PIPELINE / NZWH_PIPELINE_BARRIER once per run. Values are never echoed to the log. */
export function pipelineSnapshot(env: Record<string, string | undefined>, context: PipelineContext): PipelineSnapshot {
  const log: string[] = [];
  const raw = env.NZWH_TAB_PIPELINE;
  let mode: PipelineMode = "off";
  if (raw !== undefined && raw.trim() !== "") {
    const parsed = oneOf(modes, raw);
    if (parsed) mode = parsed;
    else log.push("[NZWH] Unknown NZWH_TAB_PIPELINE value; using off.");
  }
  if (mode !== "off") {
    const reason = context.attachPort ? "attach mode"
      : !context.fast ? "NZWH_FAST_FILL=0"
      : !context.early ? "NZWH_EARLY_FILL=0 or no eager session"
      : context.loginOnly ? "login-only mode" : undefined;
    if (reason) { log.push(`[NZWH] Tab pipeline forced off: ${reason}.`); mode = "off"; }
  }
  const barrier = mode === "off" ? "verified" : oneOf(barriers, env.NZWH_PIPELINE_BARRIER) ?? "verified";
  log.push(`[NZWH] Tab pipeline: ${mode} (barrier ${barrier}).`);
  return { mode, barrier, log };
}

export type TabPhase = "loading" | "filling" | "posted" | "domready" | "accepted" | "verifying" | "done";
export type TabOutcome =
  | { kind: "verified" }
  | { kind: "unverified"; reason: "timeout" | "mismatch" | "denied" }
  | { kind: "busy" }
  | { kind: "stop"; error: Error };
export interface SectionTab { name: SectionName; phase: TabPhase; outcome?: TabOutcome }

/** Existing run.ts detail for a failed section (reused; no new Vietnamese string). */
const SECTION_FAILED_DETAIL = "Không hoàn tất mục này. Kiểm tra Chrome và trạng thái lưu trước khi thử lại.";

/**
 * Load-time re-scan of a tab whose SAVE reached DOM-ready (phase "domready").
 * Clean: emit `persistence accepted` and move to "accepted". Errors: emit keyed `section-result failed`
 * while persistence is still "possible" (the controller maps that to `failed`, never `saved_unverified`),
 * set outcome "stop". Returns whether the tab is accepted.
 */
export async function loadTimeRescan(
  tab: SectionTab,
  scan: () => Promise<number>,
  emit: (event: ExecutionEvent) => Promise<void>,
): Promise<boolean> {
  if (tab.phase !== "domready") throw new Error("Load-time re-scan requires a DOM-ready tab.");
  const invalid = await scan();
  if (invalid > 0) {
    tab.outcome = { kind: "stop", error: new Error(`Server validation flagged ${invalid} fields in ${tab.name} after load; stopped before next section.`) };
    tab.phase = "done";
    await emit({ type: "section-result", status: "failed", detail: SECTION_FAILED_DETAIL, section: tab.name, background: true });
    return false;
  }
  await emit({ type: "persistence", state: "accepted", section: tab.name, background: true });
  tab.phase = "accepted";
  return true;
}

/**
 * May the next section SAVE? Never while any tab is mid-POST or after a non-verified outcome.
 * Barrier "verified": previous tab has a verified outcome. Barrier "accepted": previous tab emitted
 * `persistence accepted` (phase "accepted"/"verifying") or is verified; "domready" is not enough.
 */
export function mayPostNext(tabs: readonly SectionTab[], previous: SectionTab | undefined, barrier: Barrier): boolean {
  if (tabs.some(tab => tab.phase === "posted")) return false;
  if (!previous) return true;
  if (previous.outcome) return previous.outcome.kind === "verified";
  return barrier === "accepted" && (previous.phase === "accepted" || previous.phase === "verifying");
}
