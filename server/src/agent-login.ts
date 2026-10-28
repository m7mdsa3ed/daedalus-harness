import * as acp from "./acp.js";
import { pool } from "./acp-connection.js";
import { resolveAgentSpawn } from "./acp-bridge.js";
import { evictAgentStatus, getAgentStatus, LOGIN_PROBE_ENV, locateCommand, offeredMethod, statusProject } from "./agent-status.js";
import { HttpError } from "./http-error.js";
import { withAgentConnection } from "./probe.js";
import { defaultProfileFor } from "./profiles.js";
import { invalidateQuota } from "./quota.js";
import type { AgentDef } from "./registry.js";
import { createSetupTerminal, type TerminalInfo } from "./terminals.js";

/*
 * Logging an agent in from the app, with no vendor's login command spelled
 * anywhere: the agent names its own ways in (`initialize` → `authMethods`,
 * read by the status probe into `AgentStatus.login`), and the harness runs the
 * two generic shapes ACP defines.
 *
 * - `terminal`: the agent's own invocation plus the method's `args`/`env`, in
 *   a PTY the person answers (a URL to open, a code to paste back). Exit 0 is
 *   success (ACP `AuthMethodTerminal`).
 * - `agent`: ACP `authenticate {methodId}` on a connection of its own. Codex's
 *   device code arrives as a URL elicitation; the login completes on the
 *   provider's side and `authenticate` returns.
 *
 * Nothing from a request becomes a command: the body names a method id, which
 * must be one the probe returned, and nothing else of it is read — codex's
 * `authenticate` would take an API key or a gateway's settings from `_meta`,
 * and those are a profile's, never a login door's.
 *
 * A login is the server's OS user's — one per runtime, shared by every thread
 * and every person on this server, exactly as a CLI login is.
 */

/** One login per agent at a time: two would race on one credentials file. */
const busy = new Set<string>();

async function methodFor(agent: AgentDef, methodId: string, kind: "terminal" | "agent") {
  const status = await getAgentStatus(agent);
  const method = status.login.find((m) => m.id === methodId);
  if (!method || method.kind !== kind) throw new HttpError(`${agent.name} offers no ${kind} login "${methodId}"`, 400);
  return method;
}

/** What a login changes, said everywhere it was remembered: the status and
    quota readings, and the warm processes that `initialize`d before it. */
async function settle(agent: AgentDef): Promise<void> {
  evictAgentStatus(agent.id);
  await invalidateQuota(defaultProfileFor(agent.id, agent.name), agent.id).catch(() => {});
  pool.retireIdle(agent.id);
}

/** Start a terminal login. Answers the terminal for the client to attach to. */
export async function startTerminalLogin(agent: AgentDef, methodId: string): Promise<TerminalInfo> {
  const method = await methodFor(agent, methodId, "terminal");
  if (busy.has(agent.id)) throw new HttpError(`${agent.name} is already logging in`, 409);
  /* The method as the agent sent it, `args` and `env` included —
     `LoginMethod` keeps only what the client draws. */
  const offered = offeredMethod(agent.id, methodId);
  const spec = await resolveAgentSpawn(defaultProfileFor(agent.id, agent.name), agent.id, statusProject());
  const file = locateCommand(spec.command, { cwd: spec.cwd }) ?? spec.command;
  busy.add(agent.id);
  try {
    return createSetupTerminal({
      title: `${agent.name} · ${method.name}`,
      file,
      args: [...spec.args, ...(offered && "args" in offered ? (offered.args ?? []) : [])],
      env: { ...spec.env, ...(offered && "env" in offered ? offered.env : {}), ...LOGIN_PROBE_ENV },
      cwd: spec.cwd,
      onExit: () => {
        busy.delete(agent.id);
        void settle(agent);
      },
    });
  } catch (err) {
    busy.delete(agent.id);
    throw err;
  }
}

/** What the agent-handled login says while it runs, one JSON line each. */
export type LoginEvent =
  | { elicitation: { url: string; message: string } }
  | { done: true; ok: boolean; error?: string };

/** A device code takes minutes to type; ten is the order of its own lifetime. */
const AUTHENTICATE_TIMEOUT_MS = 10 * 60_000;

/**
 * Check and lock an agent-handled login, then hand back the run: ACP
 * `authenticate`, reported as it goes. The caller's stream owns the
 * connection: `signal` aborting (the client went away, or pressed Cancel)
 * declines any elicitation still open — codex cancels its login on a decline —
 * and ends the process, and the lock is released however it ended.
 */
export async function beginAgentLogin(
  agent: AgentDef,
  methodId: string,
): Promise<(emit: (event: LoginEvent) => void, signal: AbortSignal) => Promise<void>> {
  /* Refused before the caller opens its stream, so a refusal is a status and
     not a line in a 200. The lock is taken here and released by the run. */
  await methodFor(agent, methodId, "agent");
  if (busy.has(agent.id)) throw new HttpError(`${agent.name} is already logging in`, 409);
  busy.add(agent.id);
  return (emit, signal) => runAgentLogin(agent, methodId, emit, signal);
}

async function runAgentLogin(
  agent: AgentDef,
  methodId: string,
  emit: (event: LoginEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const pending = new Set<(response: acp.CreateElicitationResponse) => void>();
  const declineAll = () => {
    for (const answer of pending) answer({ action: "decline" });
    pending.clear();
  };
  signal.addEventListener("abort", declineAll, { once: true });
  try {
    await withAgentConnection(
      defaultProfileFor(agent.id, agent.name),
      agent.id,
      statusProject(),
      {
        name: "daedalus-login",
        env: LOGIN_PROBE_ENV,
        timeoutMs: AUTHENTICATE_TIMEOUT_MS,
        signal,
        handlers: (app) => {
          app.onRequest(acp.methods.client.elicitation.create, (ctx) => {
            const params = ctx.params as { mode?: string; url?: string; message?: string };
            /* Only a link can be shown here; a form has nobody to fill it. */
            if (params.mode !== "url" || !params.url) return { action: "decline" };
            emit({ elicitation: { url: params.url, message: params.message ?? "" } });
            return new Promise<acp.CreateElicitationResponse>((answer) => pending.add(answer));
          });
          app.onNotification(acp.methods.client.elicitation.complete, () => pending.clear());
        },
      },
      (conn) => conn.request(acp.methods.agent.authenticate, { methodId }),
    );
    emit({ done: true, ok: true });
  } catch (err) {
    emit({ done: true, ok: false, error: err instanceof Error ? err.message : String(err) });
  } finally {
    signal.removeEventListener("abort", declineAll);
    declineAll();
    busy.delete(agent.id);
    await settle(agent);
  }
}
