import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as acp from "../../src/acp.js";
import type { LanguageModelV4StreamPart, LanguageModelV4Usage } from "@ai-sdk/provider";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import type { AgentEnv } from "../../src/env.js";
import type { ModelFactory } from "../../src/provider.js";
import { PAUSED_NOTIFICATION, type PausedNotification } from "../../src/hold.js";
import type { UpdateParams } from "../../src/types.js";

export function testEnv(overrides: Partial<AgentEnv> = {}): AgentEnv {
  return {
    apiKey: "test-key",
    baseUrl: null,
    model: "test-model",
    smallModel: "test-small",
    effort: null,
    contextWindow: null,
    maxOutputTokens: null,
    personaFile: null,
    /* Off by default in tests: the scan walks to the filesystem root and reads
       the *real* ~/.claude/CLAUDE.md, so leaving it on would make every prompt
       assertion depend on the machine. instructions.test.ts turns it on
       against a home and a tree it controls. */
    projectInstructions: false,
    promptCacheKey: true,
    /* Off by default: a held turn is a turn that has not answered yet, so a
       test that did not ask for one would hang rather than fail. The hold
       tests turn it on. */
    holdOnError: false,
    home: mkdtempSync(join(tmpdir(), "daedalus-agent-test-")),
    ...overrides,
  };
}

export function usage(input: number, output: number): LanguageModelV4Usage {
  return {
    inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: output, text: output, reasoning: undefined },
  } as LanguageModelV4Usage;
}

export function textScript(text: string, opts: { input?: number; output?: number } = {}): LanguageModelV4StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t1" },
    ...text.split(/(?<= )/).map((delta): LanguageModelV4StreamPart => ({ type: "text-delta", id: "t1", delta })),
    { type: "text-end", id: "t1" },
    {
      type: "finish",
      finishReason: { unified: "stop", raw: "stop" } as never,
      usage: usage(opts.input ?? 10, opts.output ?? 5),
    },
  ];
}

export function toolCallScript(
  toolName: string,
  input: Record<string, unknown>,
  opts: { id?: string } = {},
): LanguageModelV4StreamPart[] {
  const id = opts.id ?? "call-1";
  return [
    { type: "stream-start", warnings: [] },
    { type: "tool-input-start", id, toolName },
    { type: "tool-input-end", id },
    { type: "tool-call", toolCallId: id, toolName, input: JSON.stringify(input) },
    {
      type: "finish",
      finishReason: { unified: "tool-calls", raw: "tool_calls" } as never,
      usage: usage(20, 8),
    },
  ];
}

/** A ModelFactory that answers each doStream call with the next script in the queue. */
export function scriptedModel(scripts: LanguageModelV4StreamPart[][]): ModelFactory {
  const queue = [...scripts];
  return () =>
    new MockLanguageModelV4({
      doStream: async () => {
        const script = queue.shift();
        if (!script) throw new Error("scripted model ran out of scripts");
        return { stream: convertArrayToReadableStream(script) };
      },
    });
}

/**
 * A ModelFactory with a queue *per model id* — the factory's second argument,
 * which `scriptedModel` ignores.
 *
 * It is what lets a test say "this model fails, that one succeeds", which is
 * the whole of a held turn: the hold is only interesting because the model can
 * change while the turn waits, and a factory that answers the same script
 * whatever it is asked for cannot express that.
 */
export function scriptedModelsById(
  scripts: Record<string, LanguageModelV4StreamPart[][]>,
): ModelFactory {
  const queues = new Map(Object.entries(scripts).map(([id, list]) => [id, [...list]]));
  return (_env, modelId) =>
    new MockLanguageModelV4({
      doStream: async () => {
        const queue = queues.get(modelId);
        if (!queue) throw new Error(`scripted model has no scripts for ${modelId}`);
        const script = queue.shift();
        if (!script) throw new Error(`scripted model ran out of scripts for ${modelId}`);
        return { stream: convertArrayToReadableStream(script) };
      },
    });
}

export interface Harness {
  updates: UpdateParams[];
  /** `_daedalus/session/paused` — the hold the runtime took on its own, which
      is the only way a test can see a failed turn waiting rather than ending. */
  holds: PausedNotification[];
  permissionRequests: acp.RequestPermissionRequest[];
  elicitations: acp.CreateElicitationRequest[];
  answerPermission: (optionId: string) => void;
  answerElicitation: (response: acp.CreateElicitationResponse) => void;
  updatesOf: (kind: string) => UpdateParams[];
}

export interface ClientOptions {
  capabilities?: Record<string, unknown>;
}

export const FULL_CAPS = {
  fs: { readTextFile: false, writeTextFile: false },
  session: { compaction: {}, configOptions: { boolean: {} } },
  plan: {},
  elicitation: { form: {}, url: {} },
  subagents: {},
  _meta: { "subagent-transcript": true },
};

/* An in-process ACP client shaped like the harness: full capabilities, a
   recording session/update handler (registered with an identity parser, since
   the SDK's built-in one rejects the RFD subagent kinds the real harness
   re-addresses before validation), and scriptable permission/elicitation
   answers. */
export function makeClient(options: ClientOptions = {}): { app: acp.ClientApp; harness: Harness } {
  const harness: Harness = {
    updates: [],
    holds: [],
    permissionRequests: [],
    elicitations: [],
    answerPermission: () => {},
    answerElicitation: () => {},
    updatesOf: (kind) => harness.updates.filter((u) => (u.update as { sessionUpdate: string }).sessionUpdate === kind),
  };
  let nextPermission = "allow";
  let nextElicitation: acp.CreateElicitationResponse = { action: "decline" };
  harness.answerPermission = (optionId) => {
    nextPermission = optionId;
  };
  harness.answerElicitation = (response) => {
    nextElicitation = response;
  };

  const app = acp
    .client({ name: "test-client" })
    .onNotification(
      "session/update",
      (params: unknown) => params as UpdateParams,
      ({ params }) => {
        harness.updates.push(params);
      },
    )
    /* The RFD subagent updates arrive re-addressed (see connectPair), exactly
       as the harness's own bridge receives them. */
    .onNotification(
      "_daedalus/subagent_update",
      (params: unknown) => params as UpdateParams,
      ({ params }) => {
        harness.updates.push(params);
      },
    )
    .onNotification(
      PAUSED_NOTIFICATION,
      (params: unknown) => params as PausedNotification,
      ({ params }) => {
        harness.holds.push(params);
      },
    )
    .onRequest("session/request_permission", ({ params }) => {
      harness.permissionRequests.push(params);
      return { outcome: { outcome: "selected", optionId: nextPermission } } as acp.RequestPermissionResponse;
    })
    .onRequest("elicitation/create", ({ params }) => {
      harness.elicitations.push(params);
      return nextElicitation;
    });
  void options;
  return { app, harness };
}

const RFD_KINDS = new Set(["subagent_spawned", "subagent_state_update"]);

/* Connects agent and client over message streams with the same re-addressing
   the server's `agentStream` does: the SDK's SessionUpdateRouter validates
   every `session/update` against its closed union before any handler, so the
   RFD kinds have to travel under a private method name. Direct `connectWith`
   composition offers no seam for that — this is the seam. */
export async function connectPair(
  agent: acp.AgentApp,
  client: acp.ClientApp,
  op: (ctx: acp.ClientContext) => Promise<void>,
): Promise<void> {
  const readdress = (msg: unknown): unknown => {
    const m = msg as { method?: string; params?: { update?: { sessionUpdate?: string } } };
    if (
      m?.method === "session/update" &&
      m.params?.update?.sessionUpdate &&
      RFD_KINDS.has(m.params.update.sessionUpdate)
    ) {
      return { ...m, method: "_daedalus/subagent_update" };
    }
    return msg;
  };
  const a2c = new TransformStream<unknown, unknown>({
    transform: (msg, controller) => controller.enqueue(readdress(msg)),
  });
  const c2a = new TransformStream<unknown, unknown>();
  const agentConn = agent.connect({ writable: a2c.writable, readable: c2a.readable } as acp.Stream);
  const clientConn = client.connect({ writable: c2a.writable, readable: a2c.readable } as acp.Stream);
  try {
    await op(clientConn.agent);
  } finally {
    clientConn.close();
    agentConn.close();
  }
}

export async function initialize(
  ctx: acp.ClientContext,
  capabilities: Record<string, unknown> = FULL_CAPS,
): Promise<acp.InitializeResponse> {
  return ctx.request("initialize", {
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: capabilities as acp.ClientCapabilities,
  });
}

export function promptOf(text: string): acp.PromptRequest["prompt"] {
  return [{ type: "text", text }];
}
