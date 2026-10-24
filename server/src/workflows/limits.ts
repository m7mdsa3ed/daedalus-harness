/**
 * Flow control for the workflow engine: a timer that stands still while a run
 * is paused, a priority scheduler over three nested pools (global, per run,
 * per key), and the per-run budget meter.
 *
 * Pure on purpose — no db, config or session imports — so the engine can be
 * tested against it and it can be tested without the engine.
 */
import type { Budgets } from "./types.js";

// ── PausableTimer ───────────────────────────────────────────────────────────

/** The longest delay Node's setTimeout honours (2^31-1 ms); longer is clamped to 1 ms. */
export const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/** A one-shot timer whose clock stops while paused. */
export class PausableTimer {
  private handle: ReturnType<typeof setTimeout> | null = null;
  private left: number;
  private armedAt = 0;
  private fired = false;
  private cleared = false;
  private fn: () => void;

  constructor(ms: number, fn: () => void) {
    this.left = Math.max(0, ms);
    this.fn = fn;
    this.arm();
  }

  /** Node clamps a setTimeout delay above 2^31-1 ms to 1 ms (a 30-day sleep would fire at once),
      so a long wait is armed in slices: each slice re-arms until `left` is spent. `left` is the
      time remaining as of `armedAt`. */
  private arm(): void {
    this.armedAt = Date.now();
    const slice = Math.min(this.left, MAX_TIMEOUT_MS);
    this.handle = setTimeout(() => {
      this.handle = null;
      this.left = Math.max(0, this.left - slice);
      if (this.left > 0) {
        this.arm();
        return;
      }
      this.fired = true;
      this.fn();
    }, slice);
    this.handle.unref?.();
  }

  pause(): void {
    if (!this.handle) return;
    clearTimeout(this.handle);
    this.handle = null;
    this.left = Math.max(0, this.left - (Date.now() - this.armedAt));
  }

  resume(): void {
    if (this.handle || this.fired || this.cleared) return;
    this.arm();
  }

  clear(): void {
    if (this.handle) clearTimeout(this.handle);
    this.handle = null;
    this.cleared = true;
    this.fired = false;
    this.left = -1;
  }

  /** ms of running time left, 0 when fired, -1 when cleared */
  remaining(): number {
    if (this.cleared) return -1;
    if (this.fired) return 0;
    if (this.handle) return Math.max(0, this.left - (Date.now() - this.armedAt));
    return this.left;
  }
}

// ── FlowScheduler ───────────────────────────────────────────────────────────

export interface SlotRequest {
  runId: string;
  priority: number;
  /** this run's own width */
  runConcurrency: number;
  /** optional shared pool */
  key?: string;
  keyLimit?: number;
  signal: AbortSignal;
}

interface Waiter {
  req: SlotRequest;
  seq: number;
  resolve: (release: () => void) => void;
  reject: (e: Error) => void;
  onAbort: () => void;
}

function abortError(): Error {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}

export class FlowScheduler {
  private globalMax: number;
  private held = 0;
  private runHeld = new Map<string, number>();
  private keyHeld = new Map<string, number>();
  /** Kept ordered: higher priority first, FIFO within a priority. */
  private queue: Waiter[] = [];
  private seq = 0;
  private pumping = false;

  constructor(globalMax: number) {
    this.globalMax = Math.max(1, Math.floor(globalMax));
  }

  acquire(req: SlotRequest): Promise<() => void> {
    if (req.signal.aborted) return Promise.reject(abortError());
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        req,
        seq: this.seq++,
        resolve,
        reject,
        onAbort: () => {
          const i = this.queue.indexOf(waiter);
          if (i < 0) return;
          this.queue.splice(i, 1);
          reject(abortError());
          // A departing waiter may have been what held others back.
          this.pump();
        },
      };
      req.signal.addEventListener("abort", waiter.onAbort, { once: true });
      // Insert after the last waiter whose priority is >= ours (stable).
      let at = this.queue.length;
      while (at > 0 && this.queue[at - 1].req.priority < req.priority) at -= 1;
      this.queue.splice(at, 0, waiter);
      this.pump();
    });
  }

  stats(): { global: number; waiting: number; byRun: Record<string, number>; byKey: Record<string, number> } {
    return {
      global: this.held,
      waiting: this.queue.length,
      byRun: Object.fromEntries(this.runHeld),
      byKey: Object.fromEntries(this.keyHeld),
    };
  }

  dropRun(runId: string): void {
    this.runHeld.delete(runId);
    this.pump();
  }

  private admissible(req: SlotRequest): boolean {
    if (this.held >= this.globalMax) return false;
    if ((this.runHeld.get(req.runId) ?? 0) >= Math.max(1, req.runConcurrency)) return false;
    if (req.key !== undefined && (this.keyHeld.get(req.key) ?? 0) >= Math.max(1, req.keyLimit ?? 1)) return false;
    return true;
  }

  /** Admit, in queue order, every waiter whose three pools all have room. A
      waiter blocked by its own pools is skipped, not waited behind. Taking a
      slot only ever tightens the pools, so one pass is enough. */
  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (let i = 0; i < this.queue.length; ) {
        if (this.held >= this.globalMax) break;
        const w = this.queue[i];
        if (!this.admissible(w.req)) {
          i += 1;
          continue;
        }
        this.queue.splice(i, 1);
        w.req.signal.removeEventListener("abort", w.onAbort);
        w.resolve(this.take(w.req));
      }
    } finally {
      this.pumping = false;
    }
  }

  private take(req: SlotRequest): () => void {
    const { runId, key } = req;
    this.held += 1;
    this.runHeld.set(runId, (this.runHeld.get(runId) ?? 0) + 1);
    if (key !== undefined) this.keyHeld.set(key, (this.keyHeld.get(key) ?? 0) + 1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.held -= 1;
      dec(this.runHeld, runId);
      if (key !== undefined) dec(this.keyHeld, key);
      this.pump();
    };
  }
}

function dec(m: Map<string, number>, k: string): void {
  const n = m.get(k);
  if (n === undefined) return; // forgotten by dropRun
  if (n <= 1) m.delete(k);
  else m.set(k, n - 1);
}

// ── BudgetTracker ───────────────────────────────────────────────────────────

export type BudgetKind = "tokens" | "costUsd" | "agents" | "wallSec";

export class BudgetTracker {
  private cfg: Budgets;
  private now: () => number;
  private tokens = 0;
  private costUsd = 0;
  private agents = 0;
  /** Running time banked before the current stretch. */
  private bankedMs = 0;
  /** Start of the current running stretch; null while the clock is paused. */
  private since: number | null;

  constructor(budgets: Budgets, now: () => number = Date.now) {
    this.cfg = budgets;
    this.now = now;
    this.since = now();
  }

  addUsage(u: { tokens?: number; costUsd?: number }): void {
    if (u.tokens && u.tokens > 0) this.tokens += u.tokens;
    if (u.costUsd && u.costUsd > 0) this.costUsd += u.costUsd;
  }

  /** Count an agent as started; returns false (and counts nothing) if that would exceed budgets.agents. */
  tryStartAgent(): boolean {
    const cap = this.cfg.agents;
    if (cap !== undefined && this.agents + 1 > cap) return false;
    this.agents += 1;
    return true;
  }

  usage(): { tokens: number; costUsd: number; agents: number; wallSec: number } {
    return { tokens: this.tokens, costUsd: this.costUsd, agents: this.agents, wallSec: this.wallMs() / 1000 };
  }

  /** The first exceeded budget, or null. A budget is exceeded once usage is
      past it (agents: never, via tryStartAgent, unless seeded past it).
      wallSec excludes paused time. */
  exceeded(): BudgetKind | null {
    const u = this.usage();
    const b = this.cfg;
    if (b.tokens !== undefined && u.tokens > b.tokens) return "tokens";
    if (b.costUsd !== undefined && u.costUsd > b.costUsd) return "costUsd";
    if (b.agents !== undefined && u.agents > b.agents) return "agents";
    if (b.wallSec !== undefined && u.wallSec > b.wallSec) return "wallSec";
    return null;
  }

  pauseClock(): void {
    if (this.since === null) return;
    this.bankedMs += Math.max(0, this.now() - this.since);
    this.since = null;
  }

  resumeClock(): void {
    if (this.since !== null) return;
    this.since = this.now();
  }

  /** Seed from journal totals on a resumed run (wallSec spent so far included). */
  seed(u: { tokens: number; costUsd: number; agents: number; wallSec?: number }): void {
    this.tokens = u.tokens;
    this.costUsd = u.costUsd;
    this.agents = u.agents;
    if (u.wallSec !== undefined) {
      this.bankedMs = Math.max(0, u.wallSec) * 1000;
      if (this.since !== null) this.since = this.now();
    }
  }

  budgets(): Budgets {
    return this.cfg;
  }

  private wallMs(): number {
    return this.bankedMs + (this.since === null ? 0 : Math.max(0, this.now() - this.since));
  }
}

/** Rough USD estimate for a usage figure. `perMTokOut` defaults to 15. Pure helper. */
export function estimateCostUsd(outputTokens: number, perMTokOut = 15): number {
  return (Math.max(0, outputTokens) / 1_000_000) * perMTokOut;
}
