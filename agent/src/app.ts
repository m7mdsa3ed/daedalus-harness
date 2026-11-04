import { randomUUID } from "node:crypto";
import * as acp from "./acp.js";
import { scanCommands, scanSkills, toAvailableCommands } from "./commands.js";
import {
  COMPACT_CAPABILITY,
  COMPACT_METHOD,
  compact,
  type CompactResponse,
} from "./compaction.js";
import type { AgentEnv } from "./env.js";
import { connectMcpServers } from "./mcp.js";
import { mcpHooks } from "./mcp-hooks.js";
import { SessionStore, type ArchiveFilter } from "./persistence.js";
import { makeModel as defaultMakeModel, type ModelFactory } from "./provider.js";
import {
  PAUSE_CAPABILITY,
  PAUSE_METHOD,
  RESUME_METHOD,
  type PauseResponse,
} from "./hold.js";
import { Session } from "./session.js";
import { handlePrompt, type TurnDeps } from "./turn.js";
import { Emitter } from "./updates.js";

export const VERSION = "0.1.0";

/* The pause/hold protocol lives in `hold.ts` (turn.ts sends the outbound half,
   so naming it here would be a cycle); re-exported because this module is the
   package's public face. */
export {
  PAUSE_CAPABILITY,
  PAUSE_METHOD,
  PAUSED_NOTIFICATION,
  RESUME_METHOD,
  type PauseResponse,
} from "./hold.js";
/* The compaction trigger is named in `compaction.ts` for the same reason —
   `turn.ts` reads its flag — and re-exported here for the same one. */
export { COMPACT_CAPABILITY, COMPACT_METHOD, type CompactResponse } from "./compaction.js";

/* AIR's `customInstructions` (`_meta.jetbrains.air`): the client's standing
   instructions, sent on every `session/new`, `session/load` and
   `session/resume` — the same door claude-agent-acp and codex-acp read, so the
   harness spells it once for every runtime that advertises it. Since ACP grew
   its own `systemPrompt` (below) this is the fallback: read only when the
   request carries no `systemPrompt`, and landing in exactly the same slot. */
const CUSTOM_INSTRUCTIONS_CAPABILITY = "customInstructions";

/** The instructions a session request carries, or undefined when it names none. */
export function customInstructions(meta: unknown): string | undefined {
  const value = (meta as { jetbrains?: { air?: Record<string, unknown> } } | null | undefined)
    ?.jetbrains?.air?.[CUSTOM_INSTRUCTIONS_CAPABILITY];
  return typeof value === "string" ? value : undefined;
}

/* ACP's own door for the same text (`systemPrompt` on session/new, load,
   resume and fork — schema v1.29, unstable). Two modes, both taken:

   - `append` lands exactly where `customInstructions` lands today — the
     session's persona text, which `systemSections` writes beneath the repo's
     instruction files — so the harness sending the same words through either
     door builds a byte-identical prompt (instructions.test.ts pins that).
   - `override` replaces the runtime's built-in default instructions
     (`Session.systemPromptOverride`, read by `systemSections`); tools, modes
     and workspace context stay, as the spec says they may.

   The spec is strict about the rest: a mode we did not advertise, or a block
   we cannot carry, is an error *instead of* a session — never a quiet
   fallback to `append`. Text is the one block kind a system prompt can hold. */
const SYSTEM_PROMPT_MODES = new Set(["append", "override"]);

interface SessionInstructions {
  /** What goes where `customInstructions` goes (the persona slot). */
  persona: string | undefined;
  /** What stands in for the core instructions, or undefined for the runtime's own. */
  override: string | undefined;
}

/** The instructions a session request carries, from either door — the ACP
    `systemPrompt` first, AIR's `customInstructions` as the fallback when it is
    absent. Throws invalid params for a `systemPrompt` this runtime cannot
    apply; a request with neither names nothing, and the env file stands. */
export function sessionInstructions(
  systemPrompt: acp.SystemPrompt | null | undefined,
  meta: unknown,
): SessionInstructions {
  const fallback = customInstructions(meta);
  if (!systemPrompt) return { persona: fallback, override: undefined };
  if (!SYSTEM_PROMPT_MODES.has(systemPrompt.mode)) {
    throw acp.RequestError.invalidParams(`unsupported systemPrompt mode: ${systemPrompt.mode}`);
  }
  const texts: string[] = [];
  for (const block of systemPrompt.content ?? []) {
    if (block.type !== "text") {
      throw acp.RequestError.invalidParams(`unsupported systemPrompt content block: ${block.type}`);
    }
    texts.push(block.text);
  }
  const text = texts.join("\n");
  if (systemPrompt.mode === "override") return { persona: fallback, override: text };
  /* `append`: the request's text outranks the env file exactly as
     `customInstructions` does; an empty one names nothing and so defers to
     the fallback rather than blanking the persona. */
  return { persona: text || fallback, override: undefined };
}

/* `ListSessionsRequest.archived` — unknown values are the spec's -32602,
   never read as `exclude`. */
const ARCHIVE_FILTERS = new Set<ArchiveFilter>(["exclude", "include", "only"]);
function archiveFilter(value: string | null | undefined): ArchiveFilter {
  if (value == null) return "exclude";
  if (!ARCHIVE_FILTERS.has(value as ArchiveFilter)) {
    throw acp.RequestError.invalidParams(`unsupported archived filter: ${value}`);
  }
  return value as ArchiveFilter;
}

const sessionRef = (params: unknown): { sessionId: string } => {
  const sessionId = (params as { sessionId?: unknown } | null)?.sessionId;
  if (typeof sessionId !== "string") throw acp.RequestError.invalidParams("sessionId is required");
  return { sessionId };
};

export interface AppOptions {
  env: AgentEnv;
  makeModel?: ModelFactory;
}

export function buildAgentApp(options: AppOptions): acp.AgentApp {
  const env = options.env;
  const store = new SessionStore(env.home);
  const sessions = new Map<string, Session>();
  let clientCaps: acp.ClientCapabilities | null = null;

  const deps: TurnDeps = {
    env,
    store,
    makeModel: options.makeModel ?? defaultMakeModel,
    clientCaps: () => clientCaps,
  };

  const booleanCapable = () => Boolean(clientCaps?.session?.configOptions?.boolean);

  const get = (sessionId: string): Session => {
    const session = sessions.get(sessionId);
    if (!session) {
      throw acp.RequestError.sessionNotFound(sessionId);
    }
    return session;
  };

  const openSession = async (
    sessionId: string,
    cwd: string,
    mcpServers: acp.McpServer[],
    client: acp.AgentContext,
    meta: unknown,
    systemPrompt?: acp.SystemPrompt | null,
  ) => {
    /* Resolved before anything is torn down: a request this runtime must
       refuse (an unadvertised mode) leaves the prior session standing. */
    const instructions = sessionInstructions(systemPrompt, meta);
    /* A re-load of a live id replaces the session: the old handle's MCP
       children must die before fresh ones connect, or every reload leaks a
       process per server. */
    const prior = sessions.get(sessionId);
    if (prior) {
      sessions.delete(sessionId);
      prior.cancel();
      await prior.mcp?.close();
    }
    const session = new Session(sessionId, cwd, env);
    /* The request's instructions outrank the env file: a harness row seeded
       before either door existed still names `{personaFile}`, and both is the
       same text said twice. */
    session.personaText = instructions.persona ?? session.personaText;
    session.systemPromptOverride = instructions.override ?? null;
    session.skills = scanSkills(cwd);
    const fileCommands = scanCommands(cwd);
    session.mcp = await connectMcpServers(
      mcpServers,
      mcpHooks(session, client, {
        env,
        makeModel: deps.makeModel,
        caps: clientCaps,
        onPromptsChanged: () => {
          session.commands = [...fileCommands, ...(session.mcp?.prompts ?? [])];
          announceCommands(client, session);
        },
      }),
    );
    /* File commands first: `expandCommand` takes the first match, so a command
       the user wrote shadows a server prompt of the same name — the same
       bargain the agent's commands make with the harness's. */
    session.commands = [...fileCommands, ...session.mcp.prompts];
    sessions.set(sessionId, session);
    return session;
  };

  const restore = async (
    params: {
      sessionId: string;
      cwd: string;
      mcpServers?: acp.McpServer[];
      systemPrompt?: acp.SystemPrompt | null;
      _meta?: unknown;
    },
    client: acp.AgentContext,
    replay: boolean,
  ) => {
    const history = store.read(params.sessionId);
    if (!history) {
      throw acp.RequestError.sessionNotFound(params.sessionId);
    }
    const session = await openSession(
      params.sessionId,
      params.cwd || history.cwd,
      params.mcpServers ?? [],
      client,
      params._meta,
      params.systemPrompt,
    );
    session.messages = history.messages;
    session.lastTokens = history.lastTokens;
    /* The mode the thread was left in — a load that answers default for a
       thread running in plan mode is the reset this record exists to stop.
       Guarded on the known ids, so a record written by a newer runtime
       cannot smuggle an unknown mode into this one. */
    if (history.mode && history.mode !== session.mode) {
      const known = ["default", "acceptEdits", "bypassPermissions", "plan"];
      if (known.includes(history.mode)) session.mode = history.mode as Session["mode"];
    }
    /* The whole prior conversation streams back as ordinary updates before
       the response — the contract the harness's revive path is built on. */
    if (replay) {
      for (const u of history.updates) {
        await client.notify("session/update", u as acp.SessionNotification);
      }
    }
    announceCommands(client, session);
    return {
      modes: session.modeState(),
      configOptions: session.configOptions(booleanCapable()),
    } satisfies acp.LoadSessionResponse;
  };

  const announceCommands = (ctx: acp.AgentContext, session: Session) => {
    if (!session.commands.length) return;
    /* After the response — a notification about a session the client has not
       been told the id of yet is one it cannot file. */
    queueMicrotask(() => {
      void ctx
        .notify("session/update", {
          sessionId: session.id,
          update: {
            sessionUpdate: "available_commands_update",
            availableCommands: toAvailableCommands(session.commands),
          },
        })
        .catch(() => {});
    });
  };

  return acp
    .agent({ name: "daedalus-agent" })
    .onRequest("initialize", ({ params }) => {
      clientCaps = params.clientCapabilities ?? null;
      return {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentInfo: { name: "daedalus-agent", version: VERSION },
        agentCapabilities: {
          loadSession: true,
          /* `image` is a claim about what the *loop* can carry, not about the
             model behind it: the content part is converted below (turn.ts) and
             forwarded through `createOpenAICompatible`, which is what every
             profile is served by. Whether the selected model can actually read
             it is the model's half and is decided at send time against
             `modalities` (delivery.ts), so the model-less Default thread — the
             one place this capability is authoritative — inlines correctly.
             Advertising it `true` is prerequisite to ever getting there: a
             `false` here vetoes every image to a file path before `modalities`
             is even consulted. */
          promptCapabilities: { image: true, audio: true, embeddedContext: true },
          /* The two remote transports `connectMcpServers` actually speaks. An
             unadvertised kind is a server the client must not send; before this
             claim existed an SSE server arrived, failed to connect, and the
             only trace was one line folded into the system prompt. */
          mcpCapabilities: { http: true, sse: true },
          sessionCapabilities: {
            list: {},
            fork: {},
            close: {},
            delete: {},
            resume: {},
            /* `systemPrompt`: `{}` alone would be `append` only; `mode.override`
               says the core instructions can be replaced too (`sessionInstructions`). */
            systemPrompt: { mode: { override: {} } },
            /* `session/archive` and `session/unarchive`, plus the `archived`
               filter and field on `session/list`. */
            archive: {},
          },
          /* ACP has no pause — only `session/cancel`, which throws the step
             away. This runtime owns its loop, so it can stop at a step
             boundary and carry on; the harness reads this to offer it. */
          _meta: {
            [PAUSE_CAPABILITY]: true,
            [COMPACT_CAPABILITY]: true,
            jetbrains: { air: { version: 1, capabilities: [CUSTOM_INSTRUCTIONS_CAPABILITY] } },
          },
        },
      } satisfies acp.InitializeResponse;
    })
    .onRequest("session/new", async ({ params, client }) => {
      const sessionId = randomUUID();
      const session = await openSession(
        sessionId,
        params.cwd,
        params.mcpServers,
        client,
        params._meta,
        params.systemPrompt,
      );
      store.create(sessionId, params.cwd);
      announceCommands(client, session);
      return {
        sessionId,
        modes: session.modeState(),
        configOptions: session.configOptions(booleanCapable()),
      } satisfies acp.NewSessionResponse;
    })
    .onRequest("session/load", ({ params, client }) => restore(params, client, true))
    /* `session/resume`: the same restore without the narration. The client
       already holds the transcript (the harness keeps its journal across a
       revive), so streaming it back again is seconds of updates nobody reads. */
    .onRequest("session/resume", async ({ params, client }) => {
      const { modes, configOptions } = await restore(params, client, false);
      return { modes, configOptions } satisfies acp.ResumeSessionResponse;
    })
    /* `session/fork`, with the jetbrains.air fork point (`_meta`) that says
       *where* — the same extension the harness's rewind and fork cut at. The
       store owns the cut (persistence.ts `fork`); this is only the door. A
       request with no readable point is the spec's own fork-at-tip, which the
       store answers by copying the whole log. */
    .onRequest("session/fork", async ({ params }) => {
      /* The fork opens no live session here (the harness loads the new id
         next, and that load carries the prompt again), so the text has
         nowhere to land yet — but a `systemPrompt` this runtime cannot apply
         is still the spec's error instead of a fork. */
      sessionInstructions(params.systemPrompt, params._meta);
      const point =
        (params._meta as { jetbrains?: { air?: { fork?: { messageId?: string } } } } | undefined)
          ?.jetbrains?.air?.fork?.messageId ?? null;
      const forked = store.fork(params.sessionId, point);
      if (!forked) {
        /* Two different absences: a session this store never held is the
           protocol's own -32002 (`data.sessionId`, so the client can tell
           "gone" from "bad request"); a point the session does hold no
           message at is the caller's parameter. */
        if (point === null || !store.read(params.sessionId)) {
          throw acp.RequestError.sessionNotFound(params.sessionId);
        }
        throw acp.RequestError.invalidParams(
          `no message ${point} in session ${params.sessionId} to fork at`,
        );
      }
      return { sessionId: forked } satisfies acp.ForkSessionResponse;
    })
    /* The request's own signal — aborted by a `$/cancel_request` for it and
       when the connection closes — rides into the turn beside `session/cancel`,
       so a client that drops mid-turn takes the model stream and the MCP
       children down with it instead of leaving them running for nobody. */
    .onRequest("session/prompt", ({ params, client, signal }) => {
      const session = get(params.sessionId);
      return handlePrompt(deps, session, client, params, signal);
    })
    .onRequest("session/set_mode", async ({ params, client }) => {
      const session = get(params.sessionId);
      if (!["default", "acceptEdits", "bypassPermissions", "plan"].includes(params.modeId)) {
        throw acp.RequestError.invalidParams(`unknown mode: ${params.modeId}`);
      }
      session.mode = params.modeId as Session["mode"];
      /* Durable, so a `session/load` after a process restart answers the mode
         the thread was left in rather than the default a fresh session gets. */
      store.setMode(session.id, session.mode);
      await client.notify("session/update", {
        sessionId: session.id,
        update: { sessionUpdate: "current_mode_update", currentModeId: session.mode },
      });
      return {} satisfies acp.SetSessionModeResponse;
    })
    .onRequest("session/set_config_option", async ({ params, client }) => {
      const session = get(params.sessionId);
      if (!session.setConfig(params)) {
        throw acp.RequestError.invalidParams(
          `invalid config option: ${params.configId} = ${String(params.value)}`,
        );
      }
      const configOptions = session.configOptions(booleanCapable());
      await client.notify("session/update", {
        sessionId: session.id,
        update: { sessionUpdate: "config_option_update", configOptions },
      });
      return { configOptions } satisfies acp.SetSessionConfigOptionResponse;
    })
    .onRequest("session/list", ({ params }) => {
      const { sessions: entries, nextCursor } = store.list(
        params.cwd,
        params.cursor,
        archiveFilter(params.archived),
      );
      return {
        sessions: entries.map((e) => ({
          sessionId: e.sessionId,
          cwd: e.cwd,
          title: e.title,
          updatedAt: new Date(e.updatedAt).toISOString(),
          archived: e.archived === true,
        })),
        nextCursor,
      } satisfies acp.ListSessionsResponse;
    })
    /* `session/archive`: out of the default listing, and — as the spec asks —
       closed here first if it is live, exactly as `session/close` would. The
       log stays: an archived session still loads, and `session/unarchive`
       is a flag flip that loads nothing. Both are idempotent on their own
       state and -32002 on an id this store never held. */
    .onRequest("session/archive", async ({ params }) => {
      /* The flag first: a live session with no index row (a log-only session
         `session/load` served, the index having been lost) is -32002 here,
         and an answer that says "does not exist" must not have closed it. */
      if (!store.setArchived(params.sessionId, true)) {
        throw acp.RequestError.sessionNotFound(params.sessionId);
      }
      const session = sessions.get(params.sessionId);
      if (session) {
        sessions.delete(session.id);
        session.cancel();
        await session.mcp?.close();
      }
      return {} satisfies acp.ArchiveSessionResponse;
    })
    .onRequest("session/unarchive", ({ params }) => {
      if (!store.setArchived(params.sessionId, false)) {
        throw acp.RequestError.sessionNotFound(params.sessionId);
      }
      return {} satisfies acp.UnarchiveSessionResponse;
    })
    .onNotification("session/cancel", ({ params }) => {
      sessions.get(params.sessionId)?.cancel();
    })
    /* `session/close`: the client is done with this session here. The turn is
       cancelled and the MCP children reaped, but the log stays — `session/load`
       can still bring the thread back into a later process. A close of a
       session this process no longer holds answers anyway: teardown is
       idempotent, and a second close is not a failure to report. */
    .onRequest("session/close", sessionRef, async ({ params }) => {
      const session = sessions.get(params.sessionId);
      if (!session) return {} satisfies acp.CloseSessionResponse;
      sessions.delete(session.id);
      session.cancel();
      await session.mcp?.close();
      return {} satisfies acp.CloseSessionResponse;
    })
    /* `session/delete`: gone for good — the live handle (if any) is closed and
       the log and its index row are removed. Unlike a close, an unknown id is
       an error: a delete that has nothing to delete is the caller's bug, and
       answering success would hide it. */
    .onRequest("session/delete", sessionRef, async ({ params }) => {
      const session = sessions.get(params.sessionId);
      if (session) {
        sessions.delete(session.id);
        session.cancel();
        await session.mcp?.close();
      }
      if (!store.delete(params.sessionId) && !session) {
        throw acp.RequestError.sessionNotFound(params.sessionId);
      }
      return {} satisfies acp.DeleteSessionResponse;
    })
    /* The harness's own pair (extension methods, `_`-prefixed as the spec
       asks). Both answer at once with the session's state: a pause takes
       effect at the next step boundary, not on the wire, and the harness is
       told so by the flag rather than by waiting for the step to end. */
    .onRequest(PAUSE_METHOD, sessionRef, ({ params }) => {
      const session = get(params.sessionId);
      session.pause();
      return { paused: true, turnActive: session.turnActive } satisfies PauseResponse;
    })
    /* Resume takes an options bag from the start. Context length is the one
       hold a model change often cannot fix — the window is read from the
       spawn env, not from the model — so "compact and continue" has to be a
       second button later rather than a second method. */
    .onRequest(RESUME_METHOD, sessionRef, ({ params }) => {
      const session = get(params.sessionId);
      session.resume();
      return { paused: false, turnActive: session.turnActive } satisfies PauseResponse;
    })
    /* The second button that comment asked for. Three cases, and which one you
       are in is decided by where the loop is standing, not by what the caller
       says:

       - **Held** — a turn that failed, or a pause. The loop is parked *between
         attempts*, outside `streamText`, so the history is quiescent and can be
         summarized in place; the attempt that follows the release re-reads
         `session.messages` and so runs against the compacted context. This is
         "compact and continue", and it is the case that matters: a turn held on
         a context-length error is one a model change cannot fix.
       - **Running** — the history is being read by a live stream, so nothing
         may touch it here. The request is booked and the next step boundary
         spends it, which is the same door the threshold uses and the only place
         a turn can be summarized without losing the step in flight.
       - **Idle** — compact now, and park the promise where the next prompt
         waits for it.

       The booked case answers at once — a step boundary is not something to
       wait on the wire for — and the other two answer when the summary is
       actually in place, so `compacted: true` is a fact rather than an
       intention. Progress in the meantime is the `compaction_update` stream,
       which the harness is already drawing. */
    .onRequest(COMPACT_METHOD, sessionRef, async ({ params, client, signal: requestSignal }) => {
      const session = get(params.sessionId);
      if (session.turnActive && !session.held) {
        session.compactRequested = true;
        return { compacted: false, deferred: true, turnActive: true } satisfies CompactResponse;
      }
      if (session.compacting) await session.compacting;
      const emit = new Emitter(client, session.id, store);
      const announce = Boolean(clientCaps?.session?.compaction);
      /* The summarizer stops for either reason: the held turn's own abort (a
         `session/cancel`), or the request's signal — this compact being
         cancelled, or the connection it came in on closing. */
      const signal = session.abort
        ? AbortSignal.any([session.abort.signal, requestSignal])
        : requestSignal;
      const work = compact(session, env, deps.makeModel, emit, announce, signal).catch((err) => {
        /* The `failed` compaction_update has already said so to anyone
           listening; this end keeps the thread usable and uncompacted. */
        process.stderr.write(`compaction failed: ${(err as Error)?.message ?? String(err)}\n`);
      });
      session.compacting = work.finally(() => {
        session.compacting = null;
      });
      await session.compacting;
      return {
        compacted: true,
        deferred: false,
        turnActive: session.turnActive,
      } satisfies CompactResponse;
    });
}
