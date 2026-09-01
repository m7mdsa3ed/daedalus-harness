import { randomUUID } from "node:crypto";
import { hostname, platform } from "node:os";
import type * as acp from "@agentclientprotocol/sdk";
import {
  stepCountIs,
  streamText,
  type LanguageModelUsage,
  type ModelMessage,
  type StreamTextResult,
  type ToolSet,
} from "ai";
import { expandCommand } from "./commands.js";
import { compact, needsCompaction, windowSize } from "./compaction.js";
import type { AgentEnv } from "./env.js";
import { findInstructionFiles, readInstructions } from "./instructions.js";
import type { SessionStore } from "./persistence.js";
import type { ModelFactory } from "./provider.js";
import type { Session } from "./session.js";
import { buildTools, metaFor, type ToolMeta, type ToolRuntime } from "./tools/index.js";
import { Emitter } from "./updates.js";

export interface TurnDeps {
  env: AgentEnv;
  store: SessionStore;
  makeModel: ModelFactory;
  clientCaps: () => acp.ClientCapabilities | null;
}

const MAX_STEPS = 100;
const OUTPUT_CONTENT_LIMIT = 30_000;
const SUBAGENT_REPORT_LIMIT = 32_000;
const MAX_STREAM_RETRIES = 2;
const STREAM_RETRY_BASE_MS = 1_000;

interface Parked {
  resolve: (r: acp.PromptResponse) => void;
  reject: (err: unknown) => void;
}
const parkedBySession = new WeakMap<Session, Parked[]>();

export async function handlePrompt(
  deps: TurnDeps,
  session: Session,
  ctx: acp.AgentContext,
  params: acp.PromptRequest,
): Promise<acp.PromptResponse> {
  const text = promptText(params.prompt);
  const expanded = expandCommand(session.commands, text) ?? text;

  /* A prompt landing mid-turn is steering: its content joins the running turn
     at the next model step (prepareStep drains the queue), and its JSON-RPC
     response is the same turn's end — exactly the contract the harness's
     `inflight` counter expects. */
  if (session.turnActive) {
    session.steerQueue.push({ messages: [{ role: "user", content: expanded }] });
    return new Promise<acp.PromptResponse>((resolve, reject) => {
      const parked = parkedBySession.get(session) ?? [];
      parked.push({ resolve, reject });
      parkedBySession.set(session, parked);
    });
  }

  session.turnActive = true;
  const abort = new AbortController();
  session.abort = abort;
  const emit = new Emitter(ctx, session.id, deps.store);

  if (!session.title) session.title = firstLine(text);
  deps.store.touch(session.id, session.title ?? undefined);

  try {
    /* Compact before the prompt that tripped the threshold joins the history:
       the summarizer must not eat the message the user just typed, and the
       JSONL compact barrier has to land before it so a load replay keeps it. */
    if (needsCompaction(session, deps.env)) {
      const announce = Boolean(deps.clientCaps()?.session?.compaction);
      try {
        await compact(session, deps.env, deps.makeModel, emit, announce, abort.signal);
      } catch (err) {
        /* A failed summarizer degrades to running the turn uncompacted — the
           'failed' compaction_update already said so. A user abort is not a
           summarizer failure and still ends the turn. */
        if (abort.signal.aborted) throw err;
      }
    }

    const userMessage: ModelMessage = { role: "user", content: expanded };
    session.messages.push(userMessage);
    deps.store.appendMessages(session.id, [userMessage]);
    /* Journal the user's words for load replay; live, the harness draws the
       user side itself, so this is persist-only. */
    emit.record({
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text },
      messageId: randomUUID(),
    });

    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_STREAM_RETRIES; attempt++) {
      if (attempt > 0) {
        process.stderr.write(`stream retry ${attempt}/${MAX_STREAM_RETRIES}\n`);
        session.messages.length = session.messages.length - 1;
        session.messages.push(userMessage);
        await new Promise((r) => setTimeout(r, STREAM_RETRY_BASE_MS * 2 ** (attempt - 1)));
      }

      const msgsBefore = session.messages.length;
      const rt: ToolRuntime = {
        ctx,
        session,
        emit,
        clientCaps: deps.clientCaps(),
        runSubagent: (name, prompt) => runSubagent(deps, session, ctx, emit, name, prompt),
      };
      const { tools, meta } = buildTools(rt);

      const result = streamText({
        model: deps.makeModel(deps.env, session.modelId || failNoModel()),
        system: systemPrompt(session, deps.env),
        messages: session.messages,
        tools,
        abortSignal: abort.signal,
        stopWhen: stepCountIs(MAX_STEPS),
        reasoning: session.effort ?? undefined,
        maxOutputTokens: deps.env.maxOutputTokens ?? undefined,
        onError: () => {
          /* Surfaced through the fullStream 'error' part below; without this
             handler streamText also logs the error, which is fine on stderr. */
        },
        prepareStep: ({ messages }) => {
          if (session.steerQueue.length === 0) return {};
          const injected = session.steerQueue.flatMap((s) => s.messages);
          session.steerQueue = [];
          session.messages.push(...injected);
          deps.store.appendMessages(session.id, injected);
          for (const m of injected) {
            emit.record({
              sessionUpdate: "user_message_chunk",
              content: { type: "text", text: contentText(m) },
              messageId: randomUUID(),
            });
          }
          return { messages: [...messages, ...injected] };
        },
      });

      try {
        const outcome = await pumpStream(result, emit, meta, deps.env, session, undefined);

        try {
          const response = await result.response;
          session.messages.push(...response.messages);
          deps.store.appendMessages(session.id, response.messages);
        } catch {
          // An aborted or failed stream has no response messages to keep.
        }
        deps.store.touch(session.id);

        if (outcome.error !== undefined) {
          if (isRetriableStreamError(outcome.error) && attempt < MAX_STREAM_RETRIES && !abort.signal.aborted) {
            lastError = outcome.error;
            session.messages.length = msgsBefore;
            continue;
          }
          throw outcome.error;
        }

        const stopReason: acp.StopReason = outcome.aborted
          ? "cancelled"
          : mapFinishReason(outcome.finishReason);
        const promptResponse: acp.PromptResponse = {
          stopReason,
          usage: toAcpUsage(outcome.totalUsage),
        };
        settleParked(session, (p) => p.resolve(promptResponse));
        return promptResponse;
      } catch (err) {
        if (isRetriableStreamError(err) && attempt < MAX_STREAM_RETRIES && !abort.signal.aborted) {
          lastError = err;
          session.messages.length = msgsBefore;
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  } catch (err) {
    process.stderr.write(`turn failed: ${(err as Error)?.stack ?? String(err)}\n`);
    settleParked(session, (p) => p.reject(err));
    throw err;
  } finally {
    session.turnActive = false;
    session.abort = null;
    /* Steering that arrived too late to join a step still becomes context the
       next turn sees, rather than words that vanish. */
    if (session.steerQueue.length) {
      const leftover = session.steerQueue.flatMap((s) => s.messages);
      session.steerQueue = [];
      session.messages.push(...leftover);
      deps.store.appendMessages(session.id, leftover);
    }
  }
}

function failNoModel(): never {
  throw new Error(
    "No model configured: the profile names no model and DAEDALUS_AGENT_MODEL is empty",
  );
}

interface StreamOutcome {
  finishReason: string;
  totalUsage: LanguageModelUsage | null;
  aborted: boolean;
  error: unknown;
  /** The assistant's final prose, accumulated for subagent reports. */
  text: string;
}

/* One fullStream → ACP mapping, shared by the main turn and every subagent
   loop (which passes `childId`-addressed emitters). Text and thought deltas
   stream live and are journaled coalesced — one chunk per block — so a load
   replay is a handful of updates, not thousands. */
async function pumpStream(
  result: Pick<StreamTextResult<ToolSet, Record<string, unknown>, never>, "fullStream">,
  emit: Emitter,
  meta: Record<string, ToolMeta>,
  env: AgentEnv,
  session: Session,
  onUsage: ((usage: LanguageModelUsage) => void) | undefined,
): Promise<StreamOutcome> {
  const outcome: StreamOutcome = {
    finishReason: "stop",
    totalUsage: null,
    aborted: false,
    error: undefined,
    text: "",
  };
  let messageId = randomUUID();
  let block = { kind: "" as "text" | "reasoning" | "", buffer: "" };

  const flushBlock = () => {
    if (!block.kind || !block.buffer) {
      block = { kind: "", buffer: "" };
      return;
    }
    emit.record({
      sessionUpdate: block.kind === "text" ? "agent_message_chunk" : "agent_thought_chunk",
      content: { type: "text", text: block.buffer },
      messageId,
    });
    block = { kind: "", buffer: "" };
  };

  try {
    for await (const part of result.fullStream) {
      switch (part.type) {
        case "text-start":
          flushBlock();
          messageId = randomUUID();
          block = { kind: "text", buffer: "" };
          break;
        case "text-delta":
          block.buffer += part.text;
          outcome.text += part.text;
          await emit.transient({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: part.text },
            messageId,
          });
          break;
        case "reasoning-start":
          flushBlock();
          messageId = randomUUID();
          block = { kind: "reasoning", buffer: "" };
          break;
        case "reasoning-delta":
          block.buffer += part.text;
          await emit.transient({
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: part.text },
            messageId,
          });
          break;
        case "text-end":
        case "reasoning-end":
          flushBlock();
          break;
        case "tool-input-start": {
          flushBlock();
          const m = metaFor(meta, part.toolName);
          await emit.update({
            sessionUpdate: "tool_call",
            toolCallId: part.id,
            title: m.title({}),
            name: part.toolName,
            kind: m.kind,
            status: "pending",
          });
          break;
        }
        case "tool-call": {
          const m = metaFor(meta, part.toolName);
          await emit.update({
            sessionUpdate: "tool_call_update",
            toolCallId: part.toolCallId,
            title: m.title(part.input),
            status: "in_progress",
            rawInput: (part.input ?? {}) as Record<string, unknown>,
            locations: m.locations?.(part.input) ?? [],
          });
          break;
        }
        case "tool-result": {
          const text = outputText(part.output);
          await emit.update({
            sessionUpdate: "tool_call_update",
            toolCallId: part.toolCallId,
            status: "completed",
            content: [{ type: "content", content: { type: "text", text } }],
            rawOutput: rawOutputOf(part.output),
          });
          break;
        }
        case "tool-error": {
          await emit.update({
            sessionUpdate: "tool_call_update",
            toolCallId: part.toolCallId,
            status: "failed",
            content: [
              {
                type: "content",
                content: { type: "text", text: errorText(part.error) },
              },
            ],
          });
          break;
        }
        case "finish-step": {
          const used = totalOf(part.usage);
          session.lastTokens = used;
          onUsage?.(part.usage);
          await emit.update({
            sessionUpdate: "usage_update",
            used,
            size: windowSize(env),
          });
          break;
        }
        case "finish":
          outcome.finishReason = part.finishReason;
          outcome.totalUsage = part.totalUsage;
          break;
        case "abort":
          outcome.aborted = true;
          break;
        case "error":
          outcome.error = part.error;
          break;
        default:
          break;
      }
    }
  } catch (err) {
    if (isAbortError(err)) outcome.aborted = true;
    else if (outcome.error === undefined) outcome.error = err;
  }
  flushBlock();
  if (outcome.aborted) outcome.error = undefined;
  return outcome;
}

/* A subagent is a nested loop in the same process: same cwd, same model, same
   permission memory (its asks carry the parent session id, which is the one
   the harness is holding). With the RFD negotiated its work streams as a
   child session bracketed by spawned/state events; without it the loop runs
   journal-only and the tool result carries the report. */
async function runSubagent(
  deps: TurnDeps,
  session: Session,
  ctx: acp.AgentContext,
  parentEmit: Emitter,
  name: string,
  prompt: string,
): Promise<string> {
  const childId = randomUUID();
  const rfd = Boolean((deps.clientCaps() as { subagents?: unknown } | null)?.subagents);
  if (rfd) {
    await parentEmit.update({
      sessionUpdate: "subagent_spawned",
      subagentSessionId: childId,
      name,
      task: prompt.length > 500 ? `${prompt.slice(0, 500)}…` : prompt,
    });
  }
  const childEmit = parentEmit.asChild(childId, rfd);
  const rt: ToolRuntime = {
    ctx,
    session,
    emit: childEmit,
    clientCaps: deps.clientCaps(),
    runSubagent: () => Promise.reject(new Error("subagents cannot launch subagents")),
  };
  const { tools, meta } = buildTools(rt, { subagent: true });
  childEmit.record({
    sessionUpdate: "user_message_chunk",
    content: { type: "text", text: prompt },
    messageId: randomUUID(),
  });

  try {
    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_STREAM_RETRIES; attempt++) {
      if (attempt > 0) {
        process.stderr.write(`subagent stream retry ${attempt}/${MAX_STREAM_RETRIES}\n`);
        await new Promise((r) => setTimeout(r, STREAM_RETRY_BASE_MS * 2 ** (attempt - 1)));
      }

      const result = streamText({
        model: deps.makeModel(deps.env, session.modelId),
        system: systemPrompt(session, deps.env, { subagent: true }),
        messages: [{ role: "user", content: prompt }],
        tools,
        abortSignal: session.abort?.signal,
        stopWhen: stepCountIs(MAX_STEPS),
        reasoning: session.effort ?? undefined,
        maxOutputTokens: deps.env.maxOutputTokens ?? undefined,
        onError: () => {},
      });

      try {
        const outcome = await pumpStream(result, childEmit, meta, deps.env, session, undefined);
        if (outcome.error !== undefined) {
          if (isRetriableStreamError(outcome.error) && attempt < MAX_STREAM_RETRIES && !session.abort?.signal.aborted) {
            lastError = outcome.error;
            continue;
          }
          throw outcome.error;
        }
        if (outcome.aborted) {
          if (rfd) {
            await parentEmit.update({
              sessionUpdate: "subagent_state_update",
              subagentSessionId: childId,
              state: "cancelled",
            });
          }
          throw new Error("subagent cancelled");
        }
        if (rfd) {
          await parentEmit.update({
            sessionUpdate: "subagent_state_update",
            subagentSessionId: childId,
            state: "completed",
          });
        }
        const report = outcome.text.trim() || "(the subagent produced no report)";
        return report.length > SUBAGENT_REPORT_LIMIT ? `${report.slice(0, SUBAGENT_REPORT_LIMIT)}…` : report;
      } catch (err) {
        if (isRetriableStreamError(err) && attempt < MAX_STREAM_RETRIES && !session.abort?.signal.aborted) {
          lastError = err;
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  } catch (err) {
    if (rfd) {
      await parentEmit.update({
        sessionUpdate: "subagent_state_update",
        subagentSessionId: childId,
        state: "failed",
      });
    }
    throw err;
  }
}

export function systemPrompt(
  session: Session,
  env: AgentEnv,
  opts: { subagent?: boolean } = {},
): string {
  const parts: string[] = [];
  parts.push(
    opts.subagent
      ? "You are Daedalus Agent, running as a subagent on a delegated task. Complete the task and end with a concise report of what you did and found — your final message is all the caller sees."
      : "You are Daedalus Agent, an interactive coding agent. You help the user with software engineering tasks using the tools available to you. Be direct and keep working until the task is done; use tools rather than guessing about the state of the system.",
  );
  if (session.mode === "plan") {
    parts.push(
      "You are in PLAN MODE: everything that writes is disabled. Explore with the read-only tools, then present a concrete implementation plan and ask the user to approve it before any change is made.",
    );
  }
  /* Before the persona, because a persona is the choice made for *this*
     thread and the repo's rules are the ground it is made on — later text is
     what a model treats as more specific.

     The walk runs every turn, not once at `session/new`. It is ~70 `statSync`
     calls against a turn that is about to spend seconds in a model, and
     resolving it once meant a `CLAUDE.md` that did not exist when the thread
     opened was invisible until a respawn — which is precisely the file an
     agent asked to "write down how this repo works" has just created, and
     precisely the moment it should start applying. */
  const instructions = session.projectInstructions
    ? readInstructions(findInstructionFiles(session.cwd, session.instructionsHome))
    : [];
  if (instructions.length) {
    parts.push(
      [
        "Standing instructions for this workspace, from the files below. Follow them as though the user had written them here; anything the user says directly in this conversation wins over them.",
        ...instructions,
      ].join("\n\n"),
    );
  }
  if (session.personaText) parts.push(session.personaText.trim());
  if (session.skills.length && !opts.subagent) {
    const listing = session.skills
      .map((s) => `- ${s.name}: ${s.description || "(no description)"} — ${s.path}`)
      .join("\n");
    parts.push(
      `Skills available in this workspace (read the SKILL.md before relying on one):\n${listing}`,
    );
  }
  const failures = session.mcp?.failures ?? [];
  if (failures.length) {
    parts.push(`These MCP servers failed to start and their tools are unavailable:\n${failures.join("\n")}`);
  }
  /* Last, and deliberately so. Prompt caching keys on an exact byte-for-byte
     prefix: a single changed byte near the front of the prompt invalidates
     the whole cached prefix — system, tools, and every instruction block ahead
     of it. So the one part of the system prompt that is genuinely fresh every
     turn (hostname and today's date, plus a cwd that differs from repo to
     repo) is pinned to the very end, keeping the identity, persona, skills and
     instructions that precede it byte-identical and therefore cacheable. */
  parts.push(
    `WorkDir: ${session.cwd} | Platform: ${platform()} (${hostname()}) | Date: ${new Date().toDateString()}`,
  );
  return parts.join("\n\n");
}

function settleParked(session: Session, settle: (p: Parked) => void): void {
  const parked = parkedBySession.get(session);
  if (!parked) return;
  parkedBySession.delete(session);
  for (const p of parked) settle(p);
}

export function promptText(blocks: acp.ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === "text") parts.push(block.text);
    else if (block.type === "resource_link") parts.push(`@${block.uri}`);
    else if (block.type === "resource" && "text" in block.resource) {
      parts.push(`<attached uri="${block.resource.uri}">\n${block.resource.text}\n</attached>`);
    }
  }
  return parts.join("\n").trim();
}

function contentText(message: ModelMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((p) => (typeof p === "object" && "text" in p ? String(p.text) : ""))
    .join("");
}

function firstLine(text: string): string | null {
  const line = text.split("\n").find((l) => l.trim());
  if (!line) return null;
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}

function mapFinishReason(reason: string): acp.StopReason {
  switch (reason) {
    case "length":
      return "max_tokens";
    case "content-filter":
      return "refusal";
    case "tool-calls":
    case "stop":
    default:
      return "end_turn";
  }
}

function totalOf(usage: LanguageModelUsage): number {
  return usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
}

function toAcpUsage(usage: LanguageModelUsage | null): acp.Usage | null {
  if (!usage) return null;
  return {
    totalTokens: totalOf(usage),
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    thoughtTokens: usage.outputTokenDetails?.reasoningTokens ?? null,
    cachedReadTokens: usage.inputTokenDetails?.cacheReadTokens ?? null,
    cachedWriteTokens: usage.inputTokenDetails?.cacheWriteTokens ?? null,
  };
}

function outputText(output: unknown): string {
  const text = typeof output === "string" ? output : JSON.stringify(output, null, 2);
  return text.length > OUTPUT_CONTENT_LIMIT ? `${text.slice(0, OUTPUT_CONTENT_LIMIT)}\n[output truncated]` : text;
}

function rawOutputOf(output: unknown): Record<string, unknown> {
  if (output && typeof output === "object" && !Array.isArray(output)) {
    return output as Record<string, unknown>;
  }
  return { output: typeof output === "string" ? clampRaw(output) : output };
}

function clampRaw(text: string): string {
  return text.length > OUTPUT_CONTENT_LIMIT ? text.slice(0, OUTPUT_CONTENT_LIMIT) : text;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : JSON.stringify(error);
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || /abort/i.test(err.message));
}

function isRetriableStreamError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "AI_InvalidResponseDataError") return true;
  if (err.name === "AI_APICallError" && "isRetryable" in err && (err as { isRetryable: boolean }).isRetryable) return true;
  if (/ECONNRESET|EPIPE|ETIMEDOUT|socket hang up|network/i.test(err.message)) return true;
  return false;
}
