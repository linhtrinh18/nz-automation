// Tab pipeline configuration and the SAVE-acceptance gate (design rev 3, sections 2, 4, 6.1, 6.3).
// Pure bookkeeping: no driver calls, so it is unit-testable offline. The default mode is "off".
import { StopRequested } from "../lib/execution-controller";
import type { ExecutionEvent } from "../lib/execution-state";
import { WorkingHolidayStop } from "./errors";
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
  | { kind: "unverified"; reason: "timeout" | "mismatch" | "denied"; fields?: string[]; checked?: number }
  | { kind: "busy" }
  | { kind: "stop"; error: Error };
export interface SectionTab<T = unknown> {
  name: SectionName;
  /** Window handle that owns this section. */
  handle: string;
  phase: TabPhase;
  outcome?: TabOutcome;
  /** Set when the reload we wait on starts; the run supplies it. */
  stamp?: number;
  verifyStartedAt?: number;
  /** The section-result for this outcome was already emitted (load-time failure). */
  reported?: boolean;
  ticket?: T;
}

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
    tab.reported = true;
    await emit({ type: "section-result", status: "failed", detail: SECTION_FAILED_DETAIL, section: tab.name, background: true });
    return false;
  }
  await emit({ type: "persistence", state: "accepted", section: tab.name, background: true });
  tab.phase = "accepted";
  return true;
}

/**
 * May the next section SAVE? Never while any tab is mid-POST, and never after a busy/stop outcome.
 * A read-only "unverified" outcome does not block (today's sequential run also continues after it).
 * Barrier "verified": previous tab has an outcome. Barrier "accepted": previous tab emitted
 * `persistence accepted` (phase "accepted"/"verifying") or has an outcome; "domready" is not enough.
 */
export function mayPostNext(tabs: readonly SectionTab[], previous: SectionTab | undefined, barrier: Barrier): boolean {
  if (tabs.some(tab => tab.phase === "posted")) return false;
  if (!previous) return true;
  if (previous.outcome) return previous.outcome.kind === "verified" || previous.outcome.kind === "unverified";
  return barrier === "accepted" && (previous.phase === "accepted" || previous.phase === "verifying");
}

export { SECTION_FAILED_DETAIL };
export const WINDOW_CLOSED_MESSAGE = "Cửa sổ Chrome của mục đang xử lý đã bị đóng. Không tự lưu lại; kiểm tra dữ liệu trên Chrome.";
export const DOWNGRADE_PHASE_MESSAGE = "Chuyển về xử lý tuần tự trong một tab để giữ an toàn; không gửi lại mục nào.";
export const SKIPPED_DETAIL = "Chưa lưu: dừng vì mục trước gặp lỗi sau khi lưu. Không có dữ liệu nào được gửi cho mục này.";

/** An earlier tab failed after its SAVE: stop before any later section is posted. */
export class PipelineAbort extends Error {
  constructor(readonly section: string, readonly reason: Error) {
    super(`Pipeline aborted in ${section}.`);
    this.name = "PipelineAbort";
  }
}
/** Something unsafe for overlap happened (busy, denied, login, CAPTCHA): finish read-only, continue sequentially. */
export class PipelineDowngrade extends Error {
  constructor(readonly reason: string) {
    super(`Pipeline downgraded: ${reason}.`);
    this.name = "PipelineDowngrade";
  }
}

export type ReloadPoll = "pending" | "busy" | "denied" | "login" | "captcha" | "ready";
export type Readback = { kind: "pending" } | { kind: "ok" } | { kind: "mismatch"; fields: string[]; checked: number } | { kind: "unexpected" };
/** Driver-facing primitives. The scheduler focuses the tab before every background call. */
export interface TabOps {
  newTab(): Promise<string>;
  closeTab(handle: string): Promise<void>;
  focus(handle: string): Promise<void>;
  /** Count of flagged fields once the document is fully loaded, else "pending". */
  rescan(tab: SectionTab): Promise<number | "pending">;
  /** Non-blocking navigation to the section URL (never driver.get); records tab.stamp. */
  startReload(tab: SectionTab): Promise<void>;
  pollReload(tab: SectionTab): Promise<ReloadPoll>;
  readback(tab: SectionTab): Promise<Readback>;
  emit(event: ExecutionEvent): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
  aborted?(): boolean;
}
export interface SchedulerHooks {
  /** Report a terminal outcome (events, coverage files). `finalizing` outcomes are reported, never thrown on. */
  onOutcome(tab: SectionTab, finalizing: boolean): Promise<void>;
}
export interface SchedulerOptions { verifyTimeoutMs: number; pollMs: number }

/** Cooperative two-slot scheduler: one foreground tab, background tabs advance one cheap step per drain(). */
export class TabScheduler {
  readonly tabs: SectionTab[] = [];
  focused: string;
  /** Wall time spent in drain() (reported as `drain Xms`). */
  drainMs = 0;
  private extra: string | undefined;
  private challenges = 0;
  constructor(private ops: TabOps, readonly main: string, private hooks: SchedulerHooks, private options: SchedulerOptions) {
    this.focused = main;
  }
  /** Sections alternate between the main tab and one reused extra tab. */
  async handleFor(index: number): Promise<string> {
    if (index % 2 === 0) return this.main;
    if (!this.extra) {
      const previous = this.focused;
      this.extra = await this.guard(() => this.ops.newTab());
      this.focused = this.extra;
      await this.focus(previous);
    }
    return this.extra;
  }
  isPipelineHandle(handle: string): boolean { return handle === this.main || handle === this.extra; }
  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try { return await fn(); }
    catch (error) {
      if (error instanceof Error && error.name === "NoSuchWindowError") throw new WorkingHolidayStop(WINDOW_CLOSED_MESSAGE);
      throw error;
    }
  }
  /** Foreground switch; the only way run code changes tabs. */
  async focus(handle: string): Promise<void> {
    if (handle === this.focused) return;
    await this.guard(() => this.ops.focus(handle));
    this.focused = handle;
  }
  /** A CAPTCHA solved after the pipeline became active; the second one downgrades (throttling signal). */
  noteChallenge(): void { this.challenges++; }
  add(tab: SectionTab): void { this.tabs.push(tab); }
  find(name: string): SectionTab | undefined { return this.tabs.find(tab => tab.name === name); }
  private background(): SectionTab[] {
    return this.tabs.filter(tab => tab.phase === "domready" || tab.phase === "accepted" || tab.phase === "verifying");
  }
  open(): SectionTab[] { return this.background(); }
  /** One cheap step for every background tab. Restores the foreground tab even when a step throws. */
  async drain(finalizing = false): Promise<void> {
    if (this.ops.aborted?.() && !finalizing) throw new StopRequested();
    if (!finalizing && this.challenges >= 2) throw new PipelineDowngrade("captcha-repeat");
    const open = this.background();
    if (!open.length) return;
    const started = this.ops.now();
    const foreground = this.focused;
    try {
      for (const tab of open) {
        if (finalizing && this.ops.aborted?.()) break;
        await this.focus(tab.handle);
        await this.step(tab, finalizing);
      }
    } finally {
      try { await this.focus(foreground); }
      finally { this.drainMs += this.ops.now() - started; }
    }
  }
  private async step(tab: SectionTab, finalizing: boolean): Promise<void> {
    switch (tab.phase) {
      case "domready": {
        const flagged = await this.ops.rescan(tab);
        if (flagged === "pending") return;
        // Emits `persistence accepted` only when clean; a flagged field fails the section while persistence is "possible".
        if (!(await loadTimeRescan(tab, async () => flagged, this.ops.emit))) await this.settle(tab, finalizing);
        return;
      }
      case "accepted":
        await this.ops.startReload(tab);
        tab.phase = "verifying";
        tab.verifyStartedAt = this.ops.now();
        return;
      case "verifying": {
        if (this.ops.now() - (tab.verifyStartedAt ?? 0) > this.options.verifyTimeoutMs) return this.finish(tab, { kind: "unverified", reason: "timeout" }, finalizing);
        const poll = await this.ops.pollReload(tab);
        if (poll === "pending") return;
        if (poll === "busy") return this.finish(tab, { kind: "busy" }, finalizing);
        if (poll !== "ready") {
          // Recovery (denied/login/CAPTCHA) needs the owning tab in the foreground: not a background step.
          if (finalizing) return this.finish(tab, { kind: "unverified", reason: "denied" }, finalizing);
          throw new PipelineDowngrade(poll);
        }
        const read = await this.ops.readback(tab);
        if (read.kind === "pending") return;
        if (read.kind === "ok") return this.finish(tab, { kind: "verified" }, finalizing);
        if (read.kind === "mismatch") return this.finish(tab, { kind: "unverified", reason: "mismatch", fields: read.fields, checked: read.checked }, finalizing);
        return this.finish(tab, { kind: "stop", error: new WorkingHolidayStop("Unexpected application after SAVE reload.") }, finalizing);
      }
    }
  }
  private async finish(tab: SectionTab, outcome: TabOutcome, finalizing: boolean): Promise<void> {
    tab.outcome = outcome;
    tab.phase = "done";
    await this.settle(tab, finalizing);
  }
  private async settle(tab: SectionTab, finalizing: boolean): Promise<void> {
    await this.hooks.onOutcome(tab, finalizing);
    if (finalizing || !tab.outcome) return;
    if (tab.outcome.kind === "stop") throw new PipelineAbort(tab.name, tab.outcome.error);
    if (tab.outcome.kind === "busy") throw new PipelineDowngrade("busy");
  }
  /** Drain until `ready()`; background outcomes may throw PipelineAbort / PipelineDowngrade. */
  async until(ready: () => boolean): Promise<void> {
    while (!ready()) {
      await this.drain();
      if (ready()) return;
      await this.ops.sleep(this.options.pollMs);
    }
  }
  awaitDone(tab: SectionTab | undefined): Promise<void> { return this.until(() => !tab || tab.phase === "done"); }
  awaitAllDone(): Promise<void> { return this.until(() => this.tabs.every(tab => tab.phase === "done")); }
  awaitAccepted(tab: SectionTab | undefined): Promise<void> {
    return this.until(() => !tab || tab.phase === "accepted" || tab.phase === "verifying" || tab.phase === "done");
  }
  /** Gate for the next section's SAVE (design 6.3 step 6). */
  async awaitSaveGate(previous: SectionTab | undefined, barrier: Barrier): Promise<void> {
    await this.until(() => mayPostNext(this.tabs, previous, barrier) || (previous?.outcome !== undefined));
    if (!mayPostNext(this.tabs, previous, barrier)) throw new Error("SAVE gate violated.");
  }
  /** Stop/error path: report whatever the background tabs can still prove, never throw, never post. */
  async finalizeInFlight(log: (message: string) => void): Promise<void> {
    const deadline = this.ops.now() + this.options.verifyTimeoutMs;
    try {
      while (this.background().length && !this.ops.aborted?.() && this.ops.now() < deadline) {
        await this.drain(true);
        if (this.background().length) await this.ops.sleep(this.options.pollMs);
      }
    } catch (error) {
      log(`[NZWH] Tab pipeline: finalizing in-flight sections stopped early (${error instanceof Error ? error.name : "error"}).`);
    }
  }
  /** Closes the reused extra tab and returns focus to the main tab. */
  async closeExtra(): Promise<void> {
    const extra = this.extra;
    this.extra = undefined;
    if (!extra) return;
    try {
      await this.ops.focus(extra); this.focused = extra;
      await this.ops.closeTab(extra);
    } catch { /* already closed */ }
    try { await this.ops.focus(this.main); this.focused = this.main; } catch { /* nothing left to focus */ }
  }
}

export interface PipelineRunDeps<T = unknown> {
  scheduler: TabScheduler;
  mode: "verify" | "save";
  barrier: Barrier;
  /** Section boundary (credential validation, pause/stop). prefetch=true never throws or pauses. */
  boundary(name: SectionName, prefetch: boolean): Promise<"continue" | "pause" | "stop">;
  /** Emits section-start and resets the section's risk. */
  begin(name: SectionName): Promise<void>;
  /** Non-blocking navigation of `handle` to the section URL (never driver.get). */
  load(name: SectionName, handle: string): Promise<void>;
  /**
   * Foreground work in the section's tab: wait for the section, fill, pre-SAVE check, SAVE (DOM-ready response).
   * Calls ctl.beforePost right before the SAVE click and ctl.drain between waits. Returns the ticket.
   */
  fill(name: SectionName, tab: SectionTab<T>, ctl: { drain(): Promise<void>; beforePost(): Promise<void> }): Promise<T>;
  /** A started section that never posted is abandoned: report it skipped. */
  skip(name: SectionName): Promise<void>;
  log(message: string): void;
}
export interface PipelineRunResult {
  /** Sections not completed by the pipeline, in order, to run sequentially. `started` ones already emitted section-start. */
  remaining: { name: SectionName; started: boolean }[];
  /** Why the pipeline stopped early (downgrade reason code), if it did. */
  downgraded?: string;
  /** Foreground error (not a downgrade) raised while filling/saving `errorSection`. */
  error?: unknown;
  errorSection?: SectionName;
  /** The failing section had already clicked SAVE: map the error read-only, never restart it. */
  errorPosted?: boolean;
}

/**
 * Runs the sections after the first (sequential) one with two tabs. Invariants (design section 8): one SAVE call
 * site (deps.fill), at most one POST in flight, no re-POST on any late failure, the last SAVE waits for every earlier
 * tab, and a load-time failure of N leaves N+1 unposted.
 */
export async function runPipelinedSections<T>(names: SectionName[], deps: PipelineRunDeps<T>): Promise<PipelineRunResult> {
  const { scheduler, barrier, mode } = deps;
  const started = new Set<SectionName>();
  const posted = new Set<SectionName>();
  const startSection = async (index: number, prefetch: boolean): Promise<boolean> => {
    const name = names[index];
    if (index >= 2) await scheduler.awaitDone(scheduler.find(names[index - 2]));
    const command = await deps.boundary(name, prefetch);
    if (command !== "continue") return false;
    await deps.begin(name);
    started.add(name);
    await deps.load(name, await scheduler.handleFor(index));
    return true;
  };
  const remainingFrom = (index: number) => names.slice(index).filter(name => !posted.has(name)).map(name => ({ name, started: started.has(name) }));
  let index = 0;
  try {
    for (index = 0; index < names.length; index++) {
      const name = names[index];
      const previous = index > 0 ? scheduler.find(names[index - 1]) : undefined;
      if (!started.has(name)) {
        // verify: N+1 starts only once N's load-time re-scan passed; save: it was prefetched during N's SAVE.
        if (mode === "verify") await scheduler.awaitAccepted(previous);
        await startSection(index, false);
      }
      const handle = await scheduler.handleFor(index);
      await scheduler.focus(handle);
      const tab: SectionTab<T> = { name, handle, phase: "filling" };
      tab.ticket = await deps.fill(name, tab, {
        drain: () => scheduler.drain(),
        beforePost: async () => {
          if (scheduler.tabs.some(other => other.phase === "posted")) throw new Error("A SAVE is already in flight.");
          await scheduler.awaitSaveGate(previous, barrier);
          // The final section's SAVE (SAVE vs SUBMIT footer) waits for every earlier tab.
          if (index === names.length - 1) await scheduler.awaitAllDone();
          const next = names[index + 1];
          if (mode === "save" && next && !started.has(next) && (index < 1 || scheduler.find(names[index - 1])?.phase === "done")) {
            await startSection(index + 1, true);
          }
          tab.phase = "posted";
          scheduler.add(tab);
          posted.add(name);
        },
      });
      tab.phase = "domready";
    }
    await scheduler.awaitAllDone();
    return { remaining: [] };
  } catch (error) {
    if (error instanceof PipelineAbort) {
      for (const name of names) if (started.has(name) && !posted.has(name)) await deps.skip(name);
      throw error;
    }
    if (error instanceof StopRequested) {
      await scheduler.finalizeInFlight(deps.log);
      for (const name of names) if (started.has(name) && !posted.has(name)) await deps.skip(name);
      throw error;
    }
    // Downgrade or any foreground error: read-only tabs are finished by the caller; unposted sections restart sequentially.
    const isDowngrade = error instanceof PipelineDowngrade;
    const failing = names[index];
    return {
      remaining: remainingFrom(index),
      downgraded: isDowngrade ? error.reason : "error",
      ...(isDowngrade ? {} : { error, errorSection: failing, errorPosted: posted.has(failing) }),
    };
  }
}
