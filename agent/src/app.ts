import { randomUUID } from "node:crypto";
import * as acp from "@agentclientprotocol/sdk";
import { scanCommands, scanSkills, toAvailableCommands } from "./commands.js";
import type { AgentEnv } from "./env.js";
import { connectMcpServers } from "./mcp.js";
import { SessionStore } from "./persistence.js";
import { makeModel as defaultMakeModel, type ModelFactory } from "./provider.js";
import { Session } from "./session.js";
import { handlePrompt, type TurnDeps } from "./turn.js";

export const VERSION = "0.1.0";

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
       silently disable the whole subagent path. */
    .onRequest("initialize", (params: unknown) => params as acp.InitializeRequest, ({ params }) => {
      clientCaps = params.clientCapabilities ?? null;
      return {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentInfo: { name: "daedalus-agent", version: VERSION },
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: false, audio: false, embeddedContext: true },
          sessionCapabilities: { list: {} },
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
    });
}
