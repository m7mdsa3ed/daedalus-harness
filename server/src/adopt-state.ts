import { eq } from "drizzle-orm";
import * as acp from "./acp.js";
import { agentProcesses, db } from "./db/index.js";

/**
 * What a restarted server needs to take over an agent process that kept
 * running (docs/protocol.md): persisted per process in `agent_processes`, and
 * the wire bookkeeping that produces it (`WireLedger`).
 *
 * The SDK's request counter cannot be told where to start, so ids are shifted
 * on the wire instead: the SDK counts 0,1,2… and the ledger sends
 * `idBase + n`, undoing the shift on the answer. `idBase` is the saved
 * high-water mark, so a new connection never reuses an id the old one sent —
 * which matters because the agent may still answer one (an orphan, below).
 */

export interface InflightPrompt {
  acpSessionId: string;
  /** The wire id of the `session/prompt` request. */
  requestId: number;
  turnId: string;
}

export interface ProcessState {
  hostId: string;
  poolKey: string | null;
  agentId: string;
  initResult: acp.InitializeResponse;
  nextRequestId: number;
  /** Output frames consumed; an adopt attaches from here. */
  offset: number;
  prompts: InflightPrompt[];
  /** Agent->client requests the agent is blocked on (`WireLedger.requests`), whole frames. */
  requests?: acp.AnyMessage[];
  createdAt?: number;
}

export type ProgressState = Pick<ProcessState, "nextRequestId" | "offset" | "prompts" | "requests">;

/** Insert or replace the whole row. */
export async function saveProcessState(s: ProcessState): Promise<void> {
  const now = Date.now();
  const row = {
    hostId: s.hostId,
    poolKey: s.poolKey,
    agentId: s.agentId,
    initResult: s.initResult,
    nextRequestId: s.nextRequestId,
    outputOffset: s.offset,
    prompts: s.prompts,
    pendingRequests: s.requests ?? [],
    createdAt: s.createdAt ?? now,
    updatedAt: now,
  };
  await db
    .insert(agentProcesses)
    .values(row)
    .onConflictDoUpdate({ target: agentProcesses.hostId, set: { ...row, createdAt: undefined } });
}

/** Update only what advances (the init answer is not re-sent). */
export async function saveProcessProgress(hostId: string, p: ProgressState): Promise<void> {
  await db
    .update(agentProcesses)
    .set({ nextRequestId: p.nextRequestId, outputOffset: p.offset, prompts: p.prompts, pendingRequests: p.requests ?? [], updatedAt: Date.now() })
    .where(eq(agentProcesses.hostId, hostId));
}

export async function loadProcessStates(): Promise<ProcessState[]> {
  const rows = await db.select().from(agentProcesses);
  return rows.map((r) => ({
    hostId: r.hostId,
    poolKey: r.poolKey,
    agentId: r.agentId,
    initResult: r.initResult,
    nextRequestId: r.nextRequestId,
    offset: r.outputOffset,
    prompts: r.prompts,
    requests: r.pendingRequests as acp.AnyMessage[],
    createdAt: r.createdAt,
  }));
}

export async function dropProcessState(hostId: string): Promise<void> {
  await db.delete(agentProcesses).where(eq(agentProcesses.hostId, hostId));
}

/** A `session/prompt` the previous server sent whose answer only a successor
    can read. `reply` is set once it has arrived. */
export interface OrphanPrompt extends InflightPrompt {
  reply?: { result: acp.PromptResponse } | { error: { code: number; message: string; data?: unknown } };
}

/** Agent->client requests that wait on a person, so the only ones worth
    surviving a restart. ponytail: `fs/*` and `terminal/*` are machine-answered
    in milliseconds and not idempotent (a re-run write), so they are not tracked. */
const isTrackedRequest = (method: string) =>
  method === acp.methods.client.session.requestPermission || method === acp.methods.client.elicitation.create;

type Msg = acp.AnyMessage & { id?: number | string | null; method?: string; params?: { sessionId?: string } };

/**
 * Sits between the SDK and the pipes: shifts request ids, tracks the high-water
 * mark, the in-flight prompts and the consumed offset, and swallows answers to
 * requests the SDK never made (orphans). `onChange(urgent)` says the persisted
 * progress is stale; urgent = the prompt set changed.
 */
export class WireLedger {
  private readonly idBase: number;
  private sent = 0;
  /** One flag per host line not yet counted, in line order: true = fully
      consumed. Lines the SDK's parser drops (blank, not JSON) are born true; a
      frame's flips when it has been delivered downstream. The offset only
      advances over a settled head, so it never passes an undelivered frame. */
  private readonly lineQueue: boolean[] = [];
  private consumed = 0;
  /** Highest id a persisted row promises we have not used (see `outbound`). */
  private reserved: number;
  /** While set, inbound frames wait (an adopted connection is held until every
      bridge that will own a session on it exists, or buffered updates would be
      dropped as unowned). */
  private gate: Promise<void> | null = null;
  private readonly offsetBase: number;
  /** Turn ids noted by the bridge, consumed in order by the next outgoing
      `session/prompt` of that session. */
  private readonly noted = new Map<string, string[]>();
  private readonly prompts = new Map<number, InflightPrompt>();
  readonly orphans = new Map<number, OrphanPrompt>();
  /** Requests the agent sent that have no outbound answer yet, by id. */
  private readonly requests = new Map<string | number, acp.AnyMessage>();
  /** Saved requests the wire has not re-delivered (yet): `reinject` hands them over. */
  private readonly toInject = new Map<string | number, acp.AnyMessage>();
  /** Ids `reinject` already delivered; the host's replay of the same frame is dropped once. */
  private readonly injected = new Set<string | number>();
  private inboundController: TransformStreamDefaultController<acp.AnyMessage> | null = null;
  private orphanListener: ((o: OrphanPrompt) => void) | null = null;
  onChange: (urgent: boolean) => void = () => {};

  constructor(saved?: Pick<ProcessState, "nextRequestId" | "offset" | "prompts" | "requests">) {
    this.idBase = saved?.nextRequestId ?? 0;
    this.reserved = this.idBase;
    this.offsetBase = saved?.offset ?? 0;
    for (const p of saved?.prompts ?? []) this.orphans.set(p.requestId, { ...p });
    for (const f of saved?.requests ?? []) {
      const id = (f as Msg).id;
      if (id === undefined || id === null) continue;
      this.requests.set(id, f);
      this.toInject.set(id, f);
    }
  }

  /** The next id this connection will put on the wire. */
  get nextRequestId(): number {
    return this.idBase + this.sent;
  }
  /** Host lines consumed: the unit `Handle.offset` and `attach(fromOffset)` use. */
  get offset(): number {
    return this.offsetBase + this.consumed;
  }

  /** Hold inbound frames until the returned release is called (or `maxMs`). */
  hold(maxMs = 30_000): () => void {
    let release!: () => void;
    const g = new Promise<void>((r) => (release = r));
    const timer = setTimeout(release, maxMs).unref();
    this.gate = g;
    return () => {
      clearTimeout(timer);
      if (this.gate === g) this.gate = null;
      release();
    };
  }

  /**
   * Passes bytes through untouched and counts the lines the SDK's `ndJsonStream`
   * will refuse (it drops blank lines and non-JSON ones, so a frame count alone
   * would drift from the host's line count). Same test as the SDK's: trimmed,
   * parses, and is an object or array.
   */
  lines(): TransformStream<Uint8Array, Uint8Array> {
    let tail = Buffer.alloc(0);
    return new TransformStream({
      transform: (chunk, controller) => {
        let buf = tail.length ? Buffer.concat([tail, chunk]) : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        for (let i = buf.indexOf(10); i >= 0; i = buf.indexOf(10)) {
          const text = buf.subarray(0, i).toString("utf8").trim();
          buf = buf.subarray(i + 1);
          let ok = false;
          if (text) {
            try {
              ok = typeof JSON.parse(text) === "object";
            } catch {
              /* counted below */
            }
          }
          this.lineQueue.push(!ok);
        }
        tail = Buffer.from(buf);
        controller.enqueue(chunk);
      },
    });
  }
  snapshot(): ProgressState {
    return {
      // The reservation, not the counter: a crash before the next write must not let a successor reuse an id.
      nextRequestId: Math.max(this.reserved, this.nextRequestId),
      offset: this.offset,
      // Orphans still owed an answer stay persisted: a second restart must not forget them.
      prompts: [...this.orphans.values()].filter((o) => !o.reply).map(({ acpSessionId, requestId, turnId }) => ({ acpSessionId, requestId, turnId })).concat([...this.prompts.values()]),
      requests: [...this.requests.values()],
    };
  }

  /** The bridge is about to send a prompt for `turnId` on this session. */
  noteTurn(acpSessionId: string, turnId: string): void {
    const q = this.noted.get(acpSessionId) ?? [];
    q.push(turnId);
    this.noted.set(acpSessionId, q);
  }

  /** Called with each orphan's answer, now for those already in and as they come. */
  watchOrphans(fn: (o: OrphanPrompt) => void): void {
    this.orphanListener = fn;
    for (const o of this.orphans.values()) if (o.reply) fn(o);
  }

  /** One frame (a valid line) has been delivered: settle the oldest open line, then count the settled head. */
  private consume(): void {
    const i = this.lineQueue.indexOf(false);
    if (i >= 0) this.lineQueue[i] = true;
    let n = 0;
    while (n < this.lineQueue.length && this.lineQueue[n]) n++;
    if (n) {
      this.lineQueue.splice(0, n);
      this.consumed += n;
    }
  }

  outbound(): TransformStream<acp.AnyMessage, acp.AnyMessage> {
    return new TransformStream({
      transform: (m, controller) => {
        const msg = m as Msg;
        let urgent = false;
        if (typeof msg.method === "string" && typeof msg.id === "number") {
          // A request of ours (an answer to the agent's request has no method).
          const id = this.idBase + msg.id;
          this.sent = Math.max(this.sent, msg.id + 1);
          // Persist a promise of ids ahead of use; the write starts with 512 ids to spare.
          if (this.reserved < id + 512) {
            this.reserved = id + 1024;
            urgent = true;
          }
          if (msg.method === acp.methods.agent.session.prompt && msg.params?.sessionId) {
            const turnId = this.noted.get(msg.params.sessionId)?.shift();
            if (turnId) {
              this.prompts.set(id, { acpSessionId: msg.params.sessionId, requestId: id, turnId });
              urgent = true;
            }
          }
          controller.enqueue({ ...msg, id } as acp.AnyMessage);
        } else {
          // An answer to the agent's request (no `method`): the question is closed.
          if (typeof msg.method !== "string" && msg.id !== undefined && msg.id !== null && this.requests.delete(msg.id)) urgent = true;
          controller.enqueue(m);
        }
        this.onChange(urgent);
      },
    });
  }

  inbound(): TransformStream<acp.AnyMessage, acp.AnyMessage> {
    const stream = new TransformStream<acp.AnyMessage, acp.AnyMessage>({
      start: (controller) => {
        this.inboundController = controller;
      },
      transform: (m, controller) => (this.gate ? this.gate.then(() => step(m, controller)) : step(m, controller)),
    });
    const step = (m: acp.AnyMessage, controller: TransformStreamDefaultController<acp.AnyMessage>): void => {
      try {
        this.deliver(m, controller);
      } finally {
        this.consume();
      }
      this.onChange(false);
    };
    return stream;
  }

  private deliver(m: acp.AnyMessage, controller: TransformStreamDefaultController<acp.AnyMessage>): void {
        const msg = m as Msg;
        if (typeof msg.method === "string" && isTrackedRequest(msg.method) && msg.id !== undefined && msg.id !== null) {
          this.toInject.delete(msg.id);
          // The replay of a request `reinject` already handed over: once is enough.
          if (this.injected.delete(msg.id)) return;
          this.requests.set(msg.id, m);
          this.onChange(true);
          controller.enqueue(m);
          return;
        }
        if (typeof msg.method !== "string" && typeof msg.id === "number") {
          const orphan = this.orphans.get(msg.id);
          if (orphan) {
            const r = msg as unknown as { result?: acp.PromptResponse; error?: { code: number; message: string; data?: unknown } };
            orphan.reply = r.error ? { error: r.error } : { result: r.result ?? ({} as acp.PromptResponse) };
            this.orphanListener?.(orphan);
            this.onChange(true);
            return;
          }
          if (this.prompts.delete(msg.id)) this.onChange(true);
          if (msg.id < this.idBase) return; // an answer to nothing we could have asked
          controller.enqueue({ ...msg, id: msg.id - this.idBase } as acp.AnyMessage);
        } else controller.enqueue(m);
  }

  /** Hand the saved, still-unanswered requests to the SDK as if the agent had just
      sent them. Call once every bridge exists and the gate is open: a request whose
      session has no bridge is answered `cancelled` by the connection's own sink. */
  reinject(): void {
    for (const [id, f] of this.toInject) {
      this.injected.add(id);
      this.inboundController?.enqueue(f);
    }
    this.toInject.clear();
  }

  /** The orphan's answer has been acted on; stop persisting it. */
  settleOrphan(requestId: number): void {
    if (this.orphans.delete(requestId)) this.onChange(true);
  }
}
