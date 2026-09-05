import { randomUUID } from "node:crypto";
import * as acp from "./acp.js";
import { scanCommands, scanSkills, toAvailableCommands } from "./commands.js";
import type { AgentEnv } from "./env.js";
import { connectMcpServers } from "./mcp.js";
import { SessionStore } from "./persistence.js";
import { makeModel as defaultMakeModel, type ModelFactory } from "./provider.js";
import {
  PAUSE_CAPABILITY,
  PAUSE_METHOD,
  RESUME_METHOD,
  type PauseResponse,
} from "./hold.js";
import { Session } from "./session.js";
import { handlePrompt, type TurnDeps } from "./turn.js";

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
      throw acp.RequestError.invalidParams(`unknown session: ${sessionId}`);
    }
    return session;
  };

  const openSession = async (sessionId: string, cwd: string, mcpServers: acp.McpServer[]) => {
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
    session.commands = scanCommands(cwd);
    session.skills = scanSkills(cwd);
    session.mcp = await connectMcpServers(mcpServers);
    sessions.set(sessionId, session);
    return session;
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
    /* Registered with an identity parser on purpose: the SDK's generated
       schema strips capability keys it has not heard of — `subagents` (the
       RFD opt-in the harness sends) above all — and a stripped claim would
       silently disable the whole subagent path. The server's bridge meets
       the same closed schema from the other side (`agentStream` in
       server/src/acp-bridge.ts); docs/protocol.md "The SDK seam" is the one
       write-up of both. */
    .onRequest("initialize", (params: unknown) => params as acp.InitializeRequest, ({ params }) => {
      clientCaps = params.clientCapabilities ?? null;
      return {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentInfo: { name: "daedalus-agent", version: VERSION },
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: false, audio: false, embeddedContext: true },
          sessionCapabilities: { list: {} },
          /* ACP has no pause — only `session/cancel`, which throws the step
             away. This runtime owns its loop, so it can stop at a step
             boundary and carry on; the harness reads this to offer it. */
          _meta: { [PAUSE_CAPABILITY]: true },
        },
      } satisfies acp.InitializeResponse;
    })
    .onRequest("session/new", async ({ params, client }) => {
      const sessionId = randomUUID();
      const session = await openSession(sessionId, params.cwd, params.mcpServers);
      store.create(sessionId, params.cwd);
      announceCommands(client, session);
      return {
        sessionId,
        modes: session.modeState(),
        configOptions: session.configOptions(booleanCapable()),
      } satisfies acp.NewSessionResponse;
    })
    .onRequest("session/load", async ({ params, client }) => {
      const history = store.read(params.sessionId);
      if (!history) {
        throw acp.RequestError.invalidParams(`no session found for id ${params.sessionId}`);
      }
      const session = await openSession(
        params.sessionId,
        params.cwd || history.cwd,
        params.mcpServers,
      );
      session.messages = history.messages;
      /* The whole prior conversation streams back as ordinary updates before
         the response — the contract the harness's revive path is built on. */
      for (const u of history.updates) {
        await client.notify("session/update", u as acp.SessionNotification);
      }
      announceCommands(client, session);
      return {
        modes: session.modeState(),
        configOptions: session.configOptions(booleanCapable()),
      } satisfies acp.LoadSessionResponse;
    })
    .onRequest("session/prompt", ({ params, client }) => {
      const session = get(params.sessionId);
      return handlePrompt(deps, session, client, params);
    })
    .onRequest("session/set_mode", async ({ params, client }) => {
      const session = get(params.sessionId);
      if (!["default", "acceptEdits", "bypassPermissions", "plan"].includes(params.modeId)) {
        throw acp.RequestError.invalidParams(`unknown mode: ${params.modeId}`);
      }
      session.mode = params.modeId as Session["mode"];
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
      const { sessions: entries, nextCursor } = store.list(params.cwd, params.cursor);
      return {
        sessions: entries.map((e) => ({
          sessionId: e.sessionId,
          cwd: e.cwd,
          title: e.title,
          updatedAt: new Date(e.updatedAt).toISOString(),
        })),
        nextCursor,
      } satisfies acp.ListSessionsResponse;
    })
    .onNotification("session/cancel", ({ params }) => {
      sessions.get(params.sessionId)?.cancel();
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
    });
}
