/**
 * Telling the runtime a thread was trashed — ACP `session/archive`
 * (v1.29, unstable) — and `session/unarchive` when it is restored.
 *
 * The harness's own trash is a `deletedAt` on the row; the runtime's store
 * never heard of it, so a conversation trashed here kept showing up in the
 * import dialog's `session/list` as if it were new. Archiving hides it there
 * and keeps the id and the history, which is exactly what a soft delete needs:
 * a restore revives through `session/load` on the same id.
 *
 * Best effort, in the background, on a one-shot connection of its own
 * (`withAgentConnection`, the import list's door) — one per (profile, agent,
 * project) for a whole tree of threads, never one per thread: the thread's
 * process is being retired at the same moment, so a request on *its* wire
 * would race the close, and a retired thread has no wire at all. Sent only to a runtime that
 * advertises `sessionCapabilities.archive` — pre-filtered on the last measured
 * `initialize` so a runtime known not to have the door costs no spawn, and
 * checked again on the one-shot's own answer. A `-32002` (the runtime never
 * had, or already forgot, the session) is a fine answer; any other failure is
 * one line of log, because nothing of the harness depends on it.
 */
import * as acp from "./acp.js";
import { isSessionNotFound } from "./acp-bridge.js";
import { lastAgentCapabilities } from "./agent-capabilities.js";
import { withAgentConnection } from "./probe.js";
import { getProfile } from "./profiles.js";
import { getProject } from "./projects.js";

/** Whether `sessionCapabilities.archive` was advertised: the object's presence,
    `null`/omitted being "not advertised", per the schema. */
export function archiveAdvertised(capabilities: acp.AgentCapabilities | null | undefined): boolean {
  const cap = capabilities?.sessionCapabilities?.archive;
  return cap !== null && cap !== undefined;
}

/** The decision, pure: spawn for a runtime measured to have the door or not
    measured at all (the one-shot's own handshake decides then); never for one
    measured without it. */
export function shouldAskArchive(measured: acp.AgentCapabilities | undefined): boolean {
  return measured === undefined || archiveAdvertised(measured);
}

export interface ArchivableThread {
  id: string;
  profileId: string;
  agentId: string;
  projectId: string;
  acpSessionId?: string;
}

/** Spawned for one batch of requests and killed after it. */
const ARCHIVE_TIMEOUT_MS = 30_000;

/**
 * Archive (`archive: true`) or unarchive the runtime's session behind a thread.
 * Resolves `true` when the runtime took it, `false` when it was not asked or
 * could not; never rejects.
 */
export async function archiveAgentSession(thread: ArchivableThread, archive: boolean): Promise<boolean> {
  const [taken] = await archiveAgentSessions([thread], archive);
  return taken === true;
}

/**
 * The same for a set of threads — a trashed thread and its tree (workflow
 * steps, asks) — on ONE process per (profile, agent, project): the requests
 * are sent over that connection in turn, so a dozen step threads cost one
 * spawn and not a dozen. Groups run one after another, so a runtime the first
 * group's `initialize` measured without the door (`recordAgentCapabilities`,
 * which `withAgentConnection` does) spares every later group of the same
 * runtime its spawn. One answer per thread, in the input's order.
 */
export async function archiveAgentSessions(threads: readonly ArchivableThread[], archive: boolean): Promise<boolean[]> {
  const answers = new Array<boolean>(threads.length).fill(false);
  const groups = new Map<string, number[]>();
  threads.forEach((thread, i) => {
    if (!thread.acpSessionId) return;
    const key = `${thread.profileId}\u0000${thread.agentId}\u0000${thread.projectId}`;
    const group = groups.get(key);
    if (group) group.push(i);
    else groups.set(key, [i]);
  });
  for (const indexes of groups.values()) {
    const taken = await archiveGroup(indexes.map((i) => threads[i]), archive);
    indexes.forEach((i, k) => {
      answers[i] = taken[k];
    });
  }
  return answers;
}

/** One connection for threads that share a (profile, agent, project). */
async function archiveGroup(threads: readonly ArchivableThread[], archive: boolean): Promise<boolean[]> {
  const none = threads.map(() => false);
  const { profileId, agentId, projectId } = threads[0];
  if (!shouldAskArchive(lastAgentCapabilities(agentId))) return none;
  const verb = archive ? "archive" : "unarchive";
  const ids = threads.map((t) => `${t.id} (${t.acpSessionId})`).join(", ");
  try {
    const [profile, project] = await Promise.all([getProfile(profileId), getProject(projectId)]);
    if (!profile || !project) return none;
    return await withAgentConnection(
      profile,
      agentId,
      project,
      { name: `daedalus-${verb}`, timeoutMs: ARCHIVE_TIMEOUT_MS },
      async (agent, init, signal) => {
        if (!archiveAdvertised(init.agentCapabilities)) return none;
        const taken: boolean[] = [];
        for (const thread of threads) {
          const acpSessionId = thread.acpSessionId!;
          try {
            await agent.request(
              archive ? acp.methods.agent.session.archive : acp.methods.agent.session.unarchive,
              { sessionId: acpSessionId },
              { cancellationSignal: signal, stopWaitingOnCancel: true },
            );
            taken.push(true);
          } catch (error) {
            /* The runtime does not hold this session (never did, or dropped
               it): there is nothing to hide, which is the state we wanted. Any
               other refusal is this thread's alone; the rest are still asked. */
            if (isSessionNotFound(error, acpSessionId)) taken.push(true);
            else {
              console.warn(`session/${verb} for thread ${thread.id} (${acpSessionId}) did not land:`, error instanceof Error ? error.message : error);
              taken.push(false);
            }
          }
        }
        return taken;
      },
    );
  } catch (error) {
    console.warn(`session/${verb} for threads ${ids} did not land:`, error instanceof Error ? error.message : error);
    return none;
  }
}
