/*
 * Workflow engine v2: durable, replayable gates — approve, sleep/until, waitFor/signal,
 * sh, artifact and state. Imports `./types.js` and node builtins only.
 *
 * THE REPLAY RULE. The sandbox re-executes the script from the top after a restart, and
 * every gate call takes a deterministic key from a per-kind counter in call order
 * (`gate:<n>`, `timer:<n>`, `signal:<name>#<occurrence>`, `sh:<n>`,
 * `artifact:<name>#<occurrence>`, `state:<n>`). Before doing anything a gate looks in the
 * journal for that key:
 *   - resolved (answered / fired / received / shell / artifact): the journaled value comes
 *     back at once, with no side effect — no question parked, no timer armed, no command run;
 *   - unresolved (asked / set / waiting with no outcome): the gate is RESUMED — the same
 *     `*_asked` / `_set` / `_waiting` event stays the only one, and the remaining condition
 *     (answer, time left, signal) is waited for again;
 *   - absent: a fresh call — journal the opening event, then wait.
 * Keys are taken synchronously, at the top of each hook, before the first `await`, so a
 * script that calls two gates inside `parallel` numbers them in the order it called them.
 *
 * Every journal append goes through ONE promise chain, so the journal's order is the order
 * the calls were made in.
 *
 * Choices the contract left open:
 *   - a cancel (host.signal aborting) rejects with Error("the run was cancelled") and
 *     journals NO outcome, so the gate is still unresolved and resumes next time;
 *   - an approval that times out journals `approval_answered {choice:null, by:"timeout"}`
 *     and resolves null; a `waitFor` that times out journals `signal_received {value:null}`
 *     under the wait's own key (fold resolves the gate by key, so a different "timeout" key
 *     would leave the gate drawn as waiting forever) and resolves null;
 *   - a signal that arrives while nobody is waiting is BUFFERED: journaled as
 *     `signal_received` under `signal:<name>#buffered<k>`; the next `waitFor` of that name
 *     takes the oldest one. Taking it journals the wait's own `signal_received`, then a
 *     second `signal_received` under the same buffered key (the consumption marker — so a
 *     restart can tell which are still unread; a crash between the two redelivers);
 *   - TIMEKEEPING: `fireAt`, `askedAt`, `waitedAt` and the approval / waitFor timeouts are WALL-CLOCK
 *     instants (`host.now()`), so across a restart the downtime counts against them: a `sleep(60)`
 *     interrupted for an hour fires at once on resume, and an approval whose `timeoutSec` passed
 *     while the server was down times out on resume. Paused run time is excluded only in-process
 *     (`host.timer` / `whenRunning` stand still while paused); the journal does not record how
 *     long a run sat paused, so a restart forgets it. This is deliberate, not an oversight.
 *   - `sh` is at-most-once by default: `shell_started` is journaled BEFORE the command runs, so a
 *     crash mid-command leaves a started-but-unresolved record, and a replay REFUSES to run it
 *     again (it may already have had its effect) unless the script says `sh(cmd, {idempotent: true})`.
 *   - `state` replays too: the nth `setState` call of a run is the nth journaled `state:<n>`
 *     event, applied to the cache in order and not appended again. Seeding the cache with the
 *     FINAL journaled state would let a replaying script read the future (`n = get("n")+1`
 *     would diverge), so only state_set events no gate wrote (key not `state:<n>`) are seeded.
 */
import { mkdir, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ENGINE_LIMITS,
  canon,
  type GateHost,
  type GatesApi,
  type JournalEvent,
  type JournalPayload,
  type SandboxHooks,
} from "./types.js";

type P<K extends JournalPayload["kind"]> = Extract<JournalPayload, { kind: K }>;

/** Bytes of stdout / stderr a `sh` result keeps each. */
export const SH_OUTPUT_CAP = 64 * 1024;
/** Default `sh` timeout when the script names none. */
const SH_DEFAULT_TIMEOUT_SEC = 120;
/** Unread signals kept per name; past this `signal()` answers false instead of journaling more. */
const SIGNAL_BUFFER_CAP = 256;

const cancelled = () => new Error("the run was cancelled");
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const BUFFERED_KEY = /^signal:(.+)#buffered(\d+)$/;
const STATE_KEY = /^state:(\d+)$/;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface ApprovalWaiter {
  key: string;
  options: string[];
  /** Set the moment a route answer is accepted. */
  result: { choice: string | null; by: string; reason?: string } | null;
  /** Set SYNCHRONOUSLY the moment the outcome is decided (route or host); a later route answer is refused. */
  closed: boolean;
  /** The decided outcome reached the journal. */
  persisted: boolean;
  direct: Deferred<void>;
  /** Resolves (never rejects) once the gate's outcome is journaled or the call gave up. */
  done: Deferred<void>;
}

interface SignalWaiter {
  key: string;
  settled: boolean;
  value: Deferred<unknown>;
}

interface Buffered {
  key: string;
  value: unknown;
}

const clone = <T>(value: T): T => (value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T));

/**
 * What a gate hands the script: a private copy with object keys in canonical order. Postgres
 * `jsonb` stores keys by (length, alphabetical), so a value read back from the journal on replay
 * has a different key order than the one the script saw live. Canonicalising BOTH paths makes
 * the two identical, and anything the script then hashes (an `agent` prompt built from it) keys
 * the same step.
 */
const handOut = <T>(value: T): T => canon(clone(value));

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Same rule as `fold.ts`'s setPath, so the cache and the folded view agree. */
function setPath(state: Record<string, unknown>, dotted: string, value: unknown): void {
  const parts = dotted.split(".").filter((part) => part !== "");
  if (parts.length === 0 || parts.some((part) => UNSAFE_KEYS.has(part))) return;
  let cursor = state;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i]!;
    const next = cursor[part];
    if (isObject(next)) {
      cursor = next;
    } else {
      const created: Record<string, unknown> = {};
      cursor[part] = created;
      cursor = created;
    }
  }
  cursor[parts[parts.length - 1]!] = value;
}

function getPath(state: Record<string, unknown>, dotted: string): unknown {
  const parts = dotted.split(".").filter((part) => part !== "");
  let cursor: unknown = state;
  for (const part of parts) {
    if (!isObject(cursor) || !Object.hasOwn(cursor, part)) return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

function inside(base: string, target: string): boolean {
  const rel = path.relative(base, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function truncate(text: string, label: string): string {
  const bytes = Buffer.byteLength(text);
  if (bytes <= SH_OUTPUT_CAP) return text;
  return `${Buffer.from(text).subarray(0, SH_OUTPUT_CAP).toString("utf8")}\n…[${label} truncated: ${bytes - SH_OUTPUT_CAP} more bytes]`;
}

export class Gates implements GatesApi {
  private readonly host: GateHost;

  /** The one append chain: journal order == call order. */
  private chain: Promise<unknown> = Promise.resolve();
  /** Events this instance appended, for a host whose `events()` lags its `append()`. */
  private readonly local: JournalEvent[] = [];
  private fault: unknown = null;
  /** State writes are fire-and-forget for the script; `flush()` is where their failure is heard. */
  private readonly stateWrites = new Set<Promise<void>>();

  private approvalN = 0;
  private timerN = 0;
  private shN = 0;
  private stateN = 0;
  private readonly signalOcc = new Map<string, number>();
  private readonly artifactOcc = new Map<string, number>();

  private readonly approvals = new Map<string, ApprovalWaiter>();
  /** Answers accepted but not yet visible in the journal (a second answer must lose). */
  private readonly accepted = new Set<string>();
  private readonly waiters = new Map<string, SignalWaiter[]>();
  private readonly buffers = new Map<string, Buffered[]>();
  private readonly bufferN = new Map<string, number>();

  private readonly state: Record<string, unknown> = {};
  private readonly stateReplay = new Map<number, P<"state_set">>();

  constructor(host: GateHost) {
    this.host = host;
    const seeded = [...host.events()].sort((a, b) => a.seq - b.seq);
    // Signals: which buffered arrivals were never taken (one event under the key = unread).
    const arrivals = new Map<string, { name: string; value: unknown; count: number; k: number }>();
    for (const event of seeded) {
      const { payload, key } = event;
      if (payload.kind === "state_set") {
        const match = key === null ? null : STATE_KEY.exec(key);
        if (match) this.stateReplay.set(Number(match[1]), payload);
        else setPath(this.state, payload.path, clone(payload.value));
      } else if (payload.kind === "signal_received" && key !== null) {
        const match = BUFFERED_KEY.exec(key);
        if (!match) continue;
        const seen = arrivals.get(key);
        if (seen) seen.count += 1;
        else arrivals.set(key, { name: payload.name, value: payload.value, count: 1, k: Number(match[2]) });
      }
    }
    for (const [key, arrival] of arrivals) {
      this.bufferN.set(arrival.name, Math.max(this.bufferN.get(arrival.name) ?? 0, arrival.k + 1));
      if (arrival.count === 1) {
        const list = this.buffers.get(arrival.name) ?? [];
        list.push({ key, value: arrival.value });
        this.buffers.set(arrival.name, list);
      }
    }
  }

  hooks(): Pick<SandboxHooks, "approve" | "sleep" | "until" | "waitFor" | "sh" | "artifact" | "setState" | "getState"> {
    return {
      approve: (text, opts) => this.approve(text, opts),
      sleep: (seconds) => this.sleep(seconds),
      until: (iso) => this.until(iso),
      waitFor: (name, opts) => this.waitFor(name, opts),
      sh: (cmd, opts) => this.sh(cmd, opts),
      artifact: (name, data) => this.artifact(name, data),
      setState: (statePath, value) => this.setState(statePath, value),
      getState: (statePath) => this.getState(statePath),
    };
  }

  /** Resolves when every append queued so far is durable; throws the first append failure seen. */
  async flush(): Promise<void> {
    await Promise.all([...this.stateWrites]);
    await this.chain;
    if (this.fault !== null) {
      const fault = this.fault;
      this.fault = null;
      throw fault;
    }
  }

  // ---- journal plumbing ----------------------------------------------------

  private enqueue(key: string | null, payload: JournalPayload): Promise<JournalEvent> {
    const run = this.chain.then(() => this.host.append(key, payload));
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run.then((event) => {
      this.local.push(event);
      return event;
    });
  }

  /** Journaled events under `key`, host's and ours, in seq order. */
  private eventsFor(key: string): JournalEvent[] {
    const out = this.host.events().filter((event) => event.key === key);
    const seqs = new Set(out.map((event) => event.seq));
    for (const event of this.local) if (event.key === key && !seqs.has(event.seq)) out.push(event);
    return out.sort((a, b) => a.seq - b.seq);
  }

  private allEvents(): JournalEvent[] {
    const out = [...this.host.events()];
    const seqs = new Set(out.map((event) => event.seq));
    for (const event of this.local) if (!seqs.has(event.seq)) out.push(event);
    return out.sort((a, b) => a.seq - b.seq);
  }

  /** Reject with "the run was cancelled" if the run is aborted before `p` settles. */
  private cancellable<T>(p: Promise<T>): Promise<T> {
    const signal = this.host.signal;
    if (signal.aborted) {
      p.catch(() => {});
      return Promise.reject(cancelled());
    }
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(cancelled());
      signal.addEventListener("abort", onAbort, { once: true });
      p.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  }

  // ---- approvals -------------------------------------------------------------

  async approve(text: string, opts: { options: string[]; timeoutSec?: number }): Promise<string | null> {
    const key = `gate:${this.approvalN++}`;
    const prior = this.eventsFor(key);
    const answered = prior.find((event) => event.payload.kind === "approval_answered")?.payload as P<"approval_answered"> | undefined;
    if (answered) return answered.choice;
    const asked = prior.find((event) => event.payload.kind === "approval_asked")?.payload as P<"approval_asked"> | undefined;

    const question = asked ?? {
      kind: "approval_asked" as const,
      text,
      options: opts.options.length > 0 ? [...opts.options] : ["approve", "reject"],
      ...(opts.timeoutSec !== undefined ? { timeoutSec: opts.timeoutSec } : {}),
      askedAt: this.host.now(),
    };
    const waiter: ApprovalWaiter = {
      key,
      options: question.options,
      result: null,
      closed: false,
      persisted: false,
      direct: deferred<void>(),
      done: deferred<void>(),
    };
    this.approvals.set(key, waiter);
    const opening = asked ? Promise.resolve() : this.enqueue(key, question).then(() => undefined);
    let hostAsk: { id: string } | null = null;
    let handedOver = false; // the outcome was journaled (or is being)
    try {
      await opening;
      await this.cancellable(this.host.whenRunning());
      if (this.host.signal.aborted) throw cancelled();

      let outcome: { choice: string | null; by: string; reason?: string } | null = waiter.result;
      if (!outcome) {
        const remaining = question.timeoutSec === undefined ? undefined : question.timeoutSec - (this.host.now() - question.askedAt) / 1000;
        if (remaining !== undefined && remaining <= 0) {
          waiter.closed = true;
          outcome = { choice: null, by: "timeout", reason: "timed out" };
        } else {
          const asking = this.host.ask({
            text: question.text,
            options: question.options,
            ...(remaining !== undefined ? { timeoutSec: remaining } : {}),
          });
          hostAsk = asking;
          asking.answer.catch(() => {});
          /* The outcome is DECIDED in the callback below, synchronously with the host's answer: a
             route answer arriving a microtask later sees `closed` and is refused, so exactly one
             choice counts and the caller that lost is told so (not "true" for an answer that was
             then dropped). The same goes the other way: a route answer already accepted wins over
             a host answer that lands after it. */
          const hostDecided = asking.answer.then(
            (choice) => {
              if (waiter.closed) return;
              if (choice !== null) {
                waiter.result = { choice, by: "user" };
                waiter.closed = true;
              } else if (!this.host.signal.aborted) {
                waiter.result = { choice: null, by: "timeout", reason: "timed out" };
                waiter.closed = true;
              }
            },
            () => undefined,
          );
          await this.cancellable(Promise.race([hostDecided, waiter.direct.promise]));
          if (this.host.signal.aborted && !waiter.result) throw cancelled();
          if (!waiter.result) throw new Error("approval ended with no outcome");
          outcome = waiter.result;
        }
      }
      handedOver = true;
      waiter.closed = true;
      await this.enqueue(key, { kind: "approval_answered", ...outcome });
      waiter.persisted = true;
      return outcome.choice;
    } catch (error) {
      // A route answer that beat the cancel was promised to a person: keep it.
      if (!handedOver && waiter.result && waiter.result.choice !== null) {
        await this.enqueue(key, { kind: "approval_answered", choice: waiter.result.choice, by: waiter.result.by })
          .then(() => {
            waiter.persisted = true;
          })
          .catch(() => undefined);
      }
      throw error;
    } finally {
      // Always: an answered, timed-out or cancelled question must leave no card behind.
      if (hostAsk) this.host.withdraw(hostAsk.id);
      this.approvals.delete(key);
      waiter.done.resolve();
    }
  }

  /**
   * The route's door. True when this call decided the gate. False when the gate is unknown,
   * already answered, or `choice` is not one of its options. A gate that is journaled as
   * asked but has no waiter yet (the script has not replayed up to it after a restart) is
   * answered in the journal directly, and the replay will find the answer.
   */
  async answerApproval(gateKey: string, choice: string, by: string): Promise<boolean> {
    if (this.accepted.has(gateKey)) return false;
    const waiter = this.approvals.get(gateKey);
    if (waiter) {
      if (waiter.closed || waiter.result !== null || !waiter.options.includes(choice)) return false;
      waiter.result = { choice, by };
      waiter.closed = true;
      this.accepted.add(gateKey);
      waiter.direct.resolve();
      await waiter.done.promise;
      return waiter.persisted;
    }
    const prior = this.eventsFor(gateKey);
    const asked = prior.find((event) => event.payload.kind === "approval_asked")?.payload as P<"approval_asked"> | undefined;
    if (!asked || prior.some((event) => event.payload.kind === "approval_answered")) return false;
    if (!asked.options.includes(choice)) return false;
    this.accepted.add(gateKey);
    await this.enqueue(gateKey, { kind: "approval_answered", choice, by });
    return true;
  }

  // ---- timers ------------------------------------------------------------------

  async sleep(seconds: number): Promise<void> {
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
      throw new Error("sleep(seconds): seconds must be a finite number >= 0");
    }
    const key = `timer:${this.timerN++}`;
    return this.runTimer(key, () => this.host.now() + seconds * 1000, `sleep ${seconds}s`);
  }

  async until(iso: string): Promise<void> {
    const at = typeof iso === "string" ? Date.parse(iso) : Number.NaN;
    if (Number.isNaN(at)) throw new Error("until(isoTimestamp): not a valid ISO 8601 timestamp");
    const key = `timer:${this.timerN++}`;
    return this.runTimer(key, () => at, `until ${iso}`);
  }

  private async runTimer(key: string, fireAtNow: () => number, reason: string): Promise<void> {
    const prior = this.eventsFor(key);
    if (prior.some((event) => event.payload.kind === "timer_fired")) return;
    const set = prior.find((event) => event.payload.kind === "timer_set")?.payload as P<"timer_set"> | undefined;
    let fireAt: number;
    if (set) {
      fireAt = set.fireAt;
    } else {
      fireAt = fireAtNow();
      await this.enqueue(key, { kind: "timer_set", fireAt, reason });
    }
    const ms = Math.max(0, fireAt - this.host.now());
    if (ms > 0) {
      const fired = await this.cancellable(this.host.timer(ms));
      if (!fired) throw cancelled();
    } else if (this.host.signal.aborted) {
      throw cancelled();
    }
    await this.enqueue(key, { kind: "timer_fired" });
  }

  /** `timer_set` events with no `timer_fired`: what the engine re-arms after a restart. */
  pendingTimers(): { key: string; fireAt: number }[] {
    const fired = new Set<string>();
    const out: { key: string; fireAt: number }[] = [];
    const events = this.allEvents();
    for (const event of events) if (event.payload.kind === "timer_fired" && event.key !== null) fired.add(event.key);
    for (const event of events) {
      if (event.payload.kind === "timer_set" && event.key !== null && !fired.has(event.key)) {
        out.push({ key: event.key, fireAt: event.payload.fireAt });
      }
    }
    return out;
  }

  // ---- signals -------------------------------------------------------------------

  /** Null on timeout. */
  async waitFor(name: string, opts: { timeoutSec?: number }): Promise<unknown> {
    const occurrence = this.signalOcc.get(name) ?? 0;
    this.signalOcc.set(name, occurrence + 1);
    const key = `signal:${name}#${occurrence}`;

    const prior = this.eventsFor(key);
    const received = prior.find((event) => event.payload.kind === "signal_received")?.payload as P<"signal_received"> | undefined;
    if (received) return handOut(received.value);
    const waiting = prior.find((event) => event.payload.kind === "signal_waiting")?.payload as P<"signal_waiting"> | undefined;

    const timeoutSec = waiting ? waiting.timeoutSec : opts.timeoutSec;
    const waitedAt = waiting ? waiting.waitedAt : this.host.now();
    const opening = waiting
      ? Promise.resolve()
      : this.enqueue(key, {
          kind: "signal_waiting",
          name,
          ...(timeoutSec !== undefined ? { timeoutSec } : {}),
          waitedAt,
        }).then(() => undefined);

    // A signal that came first is taken before waiting (oldest first).
    const unread = this.buffers.get(name)?.shift();
    if (unread) {
      await opening;
      await this.enqueue(key, { kind: "signal_received", name, value: unread.value });
      // The consumption marker goes second: a crash between the two redelivers (at-least-once) rather than loses.
      await this.enqueue(unread.key, { kind: "signal_received", name, value: unread.value });
      return handOut(unread.value);
    }

    const waiter: SignalWaiter = { key, settled: false, value: deferred<unknown>() };
    const open = this.waiters.get(name) ?? [];
    open.push(waiter);
    this.waiters.set(name, open);
    const leave = () => {
      const list = this.waiters.get(name);
      if (list) {
        const at = list.indexOf(waiter);
        if (at >= 0) list.splice(at, 1);
      }
    };

    const timedOut = Symbol("timeout");
    try {
      await opening;
      const remainingMs = timeoutSec === undefined ? undefined : timeoutSec * 1000 - (this.host.now() - waitedAt);
      const racers: Promise<unknown>[] = [waiter.value.promise];
      if (remainingMs !== undefined) {
        // `false` is an abort, which `cancellable` reports; it must not look like a timeout.
        racers.push(this.host.timer(Math.max(0, remainingMs)).then((fired) => (fired ? timedOut : new Promise<never>(() => {}))));
      }
      const result = await this.cancellable(Promise.race(racers));
      if (result !== timedOut) return handOut(result);
      if (waiter.settled) return handOut(await waiter.value.promise);
      waiter.settled = true;
      leave();
      await this.enqueue(key, { kind: "signal_received", name, value: null });
      return null;
    } catch (error) {
      if (!waiter.settled) {
        waiter.settled = true;
        leave();
      }
      throw error;
    }
  }

  /**
   * Deliver to the oldest open waiter of `name`, else buffer for the next `waitFor`.
   * False only for a value JSON cannot carry, or when a name's unread buffer is full.
   */
  async signal(name: string, value: unknown): Promise<boolean> {
    let clean: unknown;
    try {
      const text = JSON.stringify(value === undefined ? null : value);
      if (text === undefined) return false;
      clean = JSON.parse(text);
    } catch {
      return false;
    }
    const open = this.waiters.get(name);
    const waiter = open?.shift();
    if (waiter) {
      waiter.settled = true;
      try {
        await this.enqueue(waiter.key, { kind: "signal_received", name, value: clean });
      } catch (error) {
        waiter.value.reject(error);
        throw error;
      }
      waiter.value.resolve(clean);
      return true;
    }
    const list = this.buffers.get(name) ?? [];
    if (list.length >= SIGNAL_BUFFER_CAP) return false;
    const k = this.bufferN.get(name) ?? 0;
    this.bufferN.set(name, k + 1);
    const key = `signal:${name}#buffered${k}`;
    list.push({ key, value: clean });
    this.buffers.set(name, list);
    await this.enqueue(key, { kind: "signal_received", name, value: clean });
    return true;
  }

  // ---- shell -----------------------------------------------------------------------

  /**
   * `idempotent: true` is the script's statement that running the command a second time is
   * harmless; it is what lets a replay re-run a command that was started before a crash and
   * never journaled a result. (The sandbox wrapper must accept the option; see the report.)
   */
  async sh(
    cmd: string,
    opts: { cwd?: string; timeoutSec?: number; idempotent?: boolean },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const key = `sh:${this.shN++}`;
    const events = this.eventsFor(key);
    const prior = events.find((event) => event.payload.kind === "shell")?.payload as P<"shell"> | undefined;
    if (prior) return handOut({ exitCode: prior.exitCode, stdout: prior.stdout, stderr: prior.stderr });
    const started = events.some((event) => event.payload.kind === "shell_started");
    if (started && opts.idempotent !== true) {
      throw new Error(
        `sh(${JSON.stringify(cmd.length > 80 ? `${cmd.slice(0, 79)}…` : cmd)}): this command was started before the server stopped and its result was never recorded, so it may have already run (partly or fully). It is not run again automatically. If running it twice is harmless, call sh(cmd, {idempotent: true}) to re-run it on resume.`,
      );
    }

    const cwd = await this.resolveCwd(opts.cwd);
    await this.cancellable(this.host.whenRunning());
    const timeoutSec = Math.min(opts.timeoutSec ?? SH_DEFAULT_TIMEOUT_SEC, ENGINE_LIMITS.stepTimeoutSec.max);
    // Before the side effect, never after: a crash in between must leave a trace that it may have run.
    if (!started) await this.enqueue(key, { kind: "shell_started", cmd, cwd: opts.cwd ?? null });
    const raw = await this.cancellable(this.host.exec(cmd, { cwd, timeoutSec }));
    const result = {
      exitCode: raw.exitCode,
      stdout: truncate(raw.stdout ?? "", "stdout"),
      stderr: truncate(raw.stderr ?? "", "stderr"),
    };
    await this.enqueue(key, { kind: "shell", cmd, cwd: opts.cwd ?? null, ...result });
    return handOut(result);
  }

  private async resolveCwd(requested: string | undefined): Promise<string> {
    const base = path.resolve(this.host.cwd());
    const target = requested ? path.resolve(base, requested) : base;
    const refuse = () => new Error(`sh: cwd "${requested}" is outside the project directory`);
    if (!inside(base, target)) throw refuse();
    // A symlink inside the project must not lead out of it. A missing target is exec's to report.
    let escaped = false;
    try {
      escaped = !inside(await realpath(base), await realpath(target));
    } catch {
      escaped = false;
    }
    if (escaped) throw refuse();
    return target;
  }

  // ---- artifacts ---------------------------------------------------------------------

  async artifact(name: string, data: unknown): Promise<void> {
    const occurrence = this.artifactOcc.get(name) ?? 0;
    this.artifactOcc.set(name, occurrence + 1);
    const key = `artifact:${name}#${occurrence}`;
    const journaled = this.eventsFor(key).find((event) => event.payload.kind === "artifact")?.payload as P<"artifact"> | undefined;

    if (typeof name !== "string" || name === "" || name.includes("\0")) throw new Error("artifact(name, data): name must be a non-empty string");
    const dir = path.resolve(await this.host.artifactDir());
    const file = path.resolve(dir, name);
    const rel = path.relative(dir, file);
    if (rel === "" || !inside(dir, file)) throw new Error(`artifact: "${name}" resolves outside the run's artifact directory`);
    const relPath = rel.split(path.sep).join("/");

    if (journaled) {
      const present = await stat(file).then(
        (s) => s.isFile(),
        () => false,
      );
      if (present) return;
    }
    const content = typeof data === "string" ? data : JSON.stringify(data, null, 2);
    if (content === undefined) throw new Error("artifact(name, data): data is not JSON-serializable");
    await this.cancellable(mkdir(path.dirname(file), { recursive: true }).then(() => writeFile(file, content, "utf8")));
    if (journaled) return; // the file was lost, the record was not: rewritten, not re-recorded
    await this.enqueue(key, { kind: "artifact", name, relPath, bytes: Buffer.byteLength(content) });
  }

  // ---- state ---------------------------------------------------------------------------

  setState(statePath: string, value: unknown): void {
    const n = this.stateN++;
    const journaled = this.stateReplay.get(n);
    if (journaled) {
      setPath(this.state, journaled.path, clone(journaled.value));
      return;
    }
    const clean = clone(value);
    setPath(this.state, statePath, clean);
    const write: Promise<void> = this.enqueue(`state:${n}`, { kind: "state_set", path: statePath, value: clean }).then(
      () => undefined,
      (error: unknown) => {
        this.fault ??= error;
      },
    );
    this.stateWrites.add(write);
    void write.then(() => this.stateWrites.delete(write));
  }

  getState(statePath: string): unknown {
    return handOut(getPath(this.state, statePath));
  }
}
