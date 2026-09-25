import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { generateText, type ModelMessage } from "ai";
import type * as acp from "./acp.js";
import type { AgentEnv } from "./env.js";
import { blocksText, type McpHooks } from "./mcp.js";
import { checkPermission } from "./permissions.js";
import type { ModelFactory } from "./provider.js";
import type { Session } from "./session.js";

/**
 * The three things an MCP server may ask of its client, answered for one
 * session — and only while a turn is running. A server asks in the middle of a
 * tool call; a request with no turn behind it has nobody in front of it to
 * answer and no turn to spend model tokens on, so it is declined rather than
 * left waiting.
 *
 * - **Elicitation** is forwarded as ACP's own `elicitation/create` — the door
 *   `ask_user` already uses, so the harness draws it with the stepper it has.
 *   Offered only in the modes the client claimed.
 * - **Sampling** runs on the session's own model, behind a permission ask: a
 *   server spending the user's model and credentials is a tool call like any
 *   other, and the gate's sticky answers and modes apply to it.
 * - **Roots** is the session's cwd, which is already the thread's worktree
 *   when it has one (the spawn cwd is `threadCwd`).
 */
export function mcpHooks(
  session: Session,
  ctx: acp.AgentContext,
  opts: {
    env: AgentEnv;
    makeModel: ModelFactory;
    caps: acp.ClientCapabilities | null;
    onPromptsChanged(): void;
  },
): McpHooks {
  const hooks: McpHooks = {
    roots: () => [{ uri: pathToFileURL(session.cwd).href, name: basename(session.cwd) }],
    onPromptsChanged: opts.onPromptsChanged,
    sample: async (server, params, signal) => {
      if (!session.turnActive) throw new Error("no turn is running to sample in");
      const messages: ModelMessage[] = params.messages.map((m) => {
        const blocks = Array.isArray(m.content) ? m.content : [m.content];
        const { text, media } = blocksText(blocks);
        if (m.role === "assistant") return { role: "assistant", content: text };
        return media.length
          ? {
              role: "user",
              content: [
                { type: "text", text },
                ...media.map((x) => ({ type: "file" as const, mediaType: x.mediaType, data: x.data })),
              ],
            }
          : { role: "user", content: text };
      });
      const first = messages.find((m) => m.role === "user");
      const preview = first ? blocksPreview(first) : "";
      await checkPermission(ctx, session, "mcp", {
        toolCallId: randomUUID(),
        toolName: `mcp__${server}__sampling`,
        title: `${server} asks the model${preview ? `: ${preview}` : ""}`,
        kind: "think",
        rawInput: { systemPrompt: params.systemPrompt, maxTokens: params.maxTokens, messages: params.messages },
      });
      const result = await generateText({
        model: opts.makeModel(opts.env, session.modelId),
        system: params.systemPrompt,
        messages,
        maxOutputTokens: params.maxTokens,
        temperature: params.temperature,
        stopSequences: params.stopSequences,
        abortSignal: AbortSignal.any([signal, ...(session.abort ? [session.abort.signal] : [])]),
        maxRetries: 0,
      });
      return {
        role: "assistant",
        model: session.modelId,
        stopReason: result.finishReason === "length" ? "maxTokens" : "endTurn",
        content: { type: "text", text: result.text },
      };
    },
  };

  const elicitation = opts.caps?.elicitation;
  if (elicitation?.form) {
    hooks.elicitUrl = Boolean(elicitation.url);
    hooks.elicit = async (server, params) => {
      if (!session.turnActive) return { action: "decline" };
      const message = `${server}: ${params.message}`;
      const request =
        params.mode === "url"
          ? { sessionId: session.id, mode: "url", message, url: params.url, elicitationId: params.elicitationId }
          : { sessionId: session.id, mode: "form", message, requestedSchema: params.requestedSchema };
      const response = await ctx.request("elicitation/create", request as acp.CreateElicitationRequest);
      if (response.action === "accept") {
        const content = (response as { content?: Record<string, unknown> }).content;
        return content ? { action: "accept", content: content as never } : { action: "accept" };
      }
      return { action: response.action === "decline" ? "decline" : "cancel" };
    };
  }
  return hooks;
}

function blocksPreview(message: ModelMessage): string {
  const text =
    typeof message.content === "string"
      ? message.content
      : message.content.map((p) => ("text" in p && typeof p.text === "string" ? p.text : "")).join(" ");
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}
