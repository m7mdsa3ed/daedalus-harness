import { and, eq, sql } from "drizzle-orm";
import type { PromptResponse } from "./acp.js";
import { AcpConnection, pool as defaultPool, type AcpPool } from "./acp-connection.js";
import type { AcpBridge } from "./acp-bridge.js";
import { dropProcessState, loadProcessStates, type OrphanPrompt, type ProcessState } from "./adopt-state.js";
import { db, sessionEvents } from "./db/index.js";
import type { Handle, Sandbox } from "./sandbox/index.js";
import type { AdoptClaim } from "./sessions.js";

/**
 * Boot adoption (docs/protocol.md "Adopting a process"): agent hosts that
 * outlived the previous server are matched with the `agent_processes` rows it
 * left, reattached from the saved offset and bound to the threads that were
 * mid-turn on them.
 *
 * Two phases, because they have different needs. `adoptAgents` is quick and runs
 * BEFORE the server listens: it reconciles hosts with rows, attaches, builds the
 * (held) connections, registers the shared ones in the pool and claims the
 * threads, so nothing a client sends can race it. The returned `bind` opens the
 * bridges and re-enters the turns; it runs once the server listens, because the
 * agent reaches back for its MCP servers over loopback while it resumes.
 *
 * What is adopted: a process, and the threads that had a `session/prompt` in
 * flight on it. A thread that was idle on an adopted shared process simply
 * revives on its next send and finds the process warm in the pool; an idle
 * thread on a process of its own has no way to find it again (nothing records
 * which thread a host served), so that host is not kept — see `bind`.
 * Everything that goes wrong falls back to the pre-adopt behaviour (host killed,
 * thread revives on its next send). Nothing here throws.
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (msg: string) => console.log(`[adopt] ${msg}`);

/** End a host and give it a moment to say so. */
async function terminate(h: Handle): Promise<void> {
  h.kill("SIGTERM");
  await Promise.race([h.exited, sleep(2000)]);
  h.detach();
}

export async function killHost(sb: Sandbox, id: string): Promise<void> {
  try {
    await terminate(await sb.attach(id, Number.MAX_SAFE_INTEGER));
  } catch {
    /* already gone */
  }
}

/** The text the prompt was sent with and when the turn began (epoch ms), as the journal's `turn_started` has them. */
async function turnStart(sessionId: string, turnId: string): Promise<{ text: string; at?: number }> {
  try {
    const rows = await db
      .select({ payload: sessionEvents.payload })
      .from(sessionEvents)
      .where(
        and(
          eq(sessionEvents.sessionId, sessionId),
          eq(sessionEvents.kind, "turn_started"),
          sql`${sessionEvents.payload}->>'turnId' = ${turnId}`,
        ),
      )
      .limit(1);
    const p = rows[0]?.payload as { text?: string; at?: number } | undefined;
    return { text: p?.text ?? "", at: typeof p?.at === "number" ? p.at : undefined };
  } catch {
    return { text: "" };
  }
}

export interface AdoptManager {
  claimForAdopt(acpSessionId: string): AdoptClaim | null;
  bindAdopted(claim: AdoptClaim, conn: AcpConnection, made: () => void): Promise<AcpBridge | null>;
}

interface Adopted {
  conn: AcpConnection;
  state: ProcessState;
  claims: AdoptClaim[];
}

export async function adoptAgents(
  sb: Sandbox,
  mgr: AdoptManager,
  pool: AcpPool = defaultPool,
): Promise<{ adopted: number; bind: () => Promise<void> }> {
  const adopted: Adopted[] = [];
  try {
    const [infos, states] = await Promise.all([sb.list(), loadProcessStates()]);
    const stateById = new Map(states.map((s) => [s.hostId, s]));
    const hostIds = new Set(infos.map((i) => i.id));
    // A host nobody has a row for is a process nothing can drive: end it.
    for (const info of infos)
      if (!stateById.has(info.id)) {
        log(`host ${info.id.slice(0, 8)} has no saved state; killing it`);
        await killHost(sb, info.id);
      }
    // A row with no live host is a process that died with the old server.
    for (const s of states)
      if (!hostIds.has(s.hostId)) {
        log(`host ${s.hostId.slice(0, 8)} is gone; dropping its state`);
        await dropProcessState(s.hostId);
      }
    for (const info of infos) {
      const state = stateById.get(info.id);
      if (!state) continue;
      let handle: Handle | null = null;
      const attachStart = Date.now();
      try {
        handle = await sb.attach(state.hostId, state.offset);
        log(`host ${state.hostId.slice(0, 8)} attached in ${Date.now() - attachStart}ms`);
        // A host whose child already exited answers with its exit frame.
        await Promise.race([handle.exited, sleep(150)]);
        if (!handle.running) {
          log(`host ${state.hostId.slice(0, 8)} had already finished; dropping its state`);
          handle.detach();
          await dropProcessState(state.hostId);
          continue;
        }
        if (handle.lossy) {
          log(`host ${state.hostId.slice(0, 8)} dropped output we had not read; not adopting it`);
          await terminate(handle);
          await dropProcessState(state.hostId);
          continue;
        }
        const conn = AcpConnection.adopt(handle, state);
        pool.adopt(conn);
        const claims: AdoptClaim[] = [];
        try {
          for (const id of new Set(state.prompts.map((p) => p.acpSessionId))) {
            const claim = mgr.claimForAdopt(id);
            if (claim) claims.push(claim);
          }
        } catch (error) {
          for (const c of claims) c.release(); // a claim holds its thread's sends; never leave one behind
          throw error;
        }
        adopted.push({ conn, state, claims });
      } catch (error) {
        console.warn(`[adopt] ${state.hostId.slice(0, 8)} failed: ${error instanceof Error ? error.message : String(error)}`);
        if (handle) await terminate(handle).catch(() => {});
        await dropProcessState(state.hostId).catch(() => {});
      }
    }
  } catch (error) {
    console.warn(`[adopt] boot reconcile failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (adopted.length) log(`reattached ${adopted.length} agent process(es)`);

  const bind = async (): Promise<void> => {
    await Promise.all(adopted.map((a) => bindOne(a, mgr, pool).catch((e) => console.warn("[adopt] bind failed", e))));
  };
  return { adopted: adopted.length, bind };
}

async function bindOne({ conn, claims }: Adopted, mgr: AdoptManager, pool: AcpPool): Promise<void> {
  type Reply = NonNullable<OrphanPrompt["reply"]>;
  const ledger = conn.ledger!; // an adopted connection always has one
  const cancelled = { result: { stopReason: "cancelled" } as PromptResponse };
  // One deferred answer per orphan prompt, settled by the watcher below.
  // Taken now: an answered orphan settles itself out of the ledger as soon as the wire opens.
  const orphans = [...ledger.orphans.values()];
  const answers = new Map<number, { promise: Promise<Reply>; resolve: (r: Reply) => void }>();
  for (const o of ledger.orphans.values()) {
    let resolve!: (r: Reply) => void;
    const promise = new Promise<Reply>((r) => (resolve = r));
    void promise.then(() => ledger.settleOrphan(o.requestId));
    answers.set(o.requestId, { promise, resolve });
  }
  // The process dying leaves nobody to answer: end the turns it owed.
  const ended = () => {
    for (const a of answers.values())
      a.resolve({ error: { code: -32603, message: "The agent process ended while the server was restarting." } });
  };
  conn.proc.on("exit", ended);
  ledger.watchOrphans((o) => {
    if (o.reply) answers.get(o.requestId)?.resolve(o.reply);
  });

  try {
    let pending = claims.length;
    const made = (): void => {
      if (--pending <= 0) setImmediate(() => conn.open()); // the handshakes' requests are out by then
    };
    if (claims.length === 0) conn.open();
    const bridges = await Promise.all(
      claims.map((claim) => {
        let once = false;
        const bindStart = Date.now();
        return mgr
          .bindAdopted(claim, conn, () => {
            if (!once) {
              once = true;
              made();
            }
          })
          .finally(() => log(`thread ${claim.sessionId.slice(0, 8)} bound in ${Date.now() - bindStart}ms`));
      }),
    );
    conn.open();
    const claimed = new Set<number>();
    for (let i = 0; i < claims.length; i++) {
      const claim = claims[i]!;
      const bridge = bridges[i];
      try {
        for (const o of orphans) {
          if (o.acpSessionId !== claim.acpSessionId) continue;
          claimed.add(o.requestId);
          const answer = answers.get(o.requestId)!;
          if (bridge) {
            const start = await turnStart(claim.sessionId, o.turnId);
            bridge.adoptTurn(o.turnId, start.text, answer.promise, start.at);
          }
          else answer.resolve(cancelled);
        }
      } catch (error) {
        console.warn(`[adopt] ${claim.sessionId.slice(0, 8)} could not take its turn back: ${error instanceof Error ? error.message : String(error)}`);
        for (const o of orphans) if (o.acpSessionId === claim.acpSessionId) answers.get(o.requestId)?.resolve(cancelled);
      } finally {
        claim.release();
      }
    }
    // Orphans of a session no thread could take: nothing to tell.
    for (const [id, a] of answers) if (!claimed.has(id)) a.resolve(cancelled);
    // Questions the agent is still blocked on: every bridge exists, so ask them again (an unowned one is answered cancelled).
    ledger.reinject();
    if (conn.sessionCount > 0) return;
    if (conn.shared) pool.release(conn);
    else {
      log(`host ${conn.proc.id.slice(0, 8)} serves no thread; ending it`);
      conn.kill();
    }
  } catch (error) {
    for (const a of answers.values()) a.resolve(cancelled); // nobody will read them
    throw error;
  } finally {
    // Whatever threw above: every claim is let go (release is idempotent).
    for (const c of claims) c.release();
  }
}
