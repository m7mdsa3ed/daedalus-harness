import { randomUUID } from "node:crypto";
import { hostname, platform } from "node:os";
import type * as acp from "./acp.js";
import type { SharedV4ProviderOptions } from "@ai-sdk/provider";
import {
  stepCountIs,
  streamText,
  type LanguageModelUsage,
  type ModelMessage,
  type StreamTextResult,
  type ToolSet,
} from "ai";
import { makeRepairToolCall } from "./tools/repair.js";
import { expandCommand } from "./commands.js";
import { compact, needsCompaction, windowSize } from "./compaction.js";
import type { AgentEnv } from "./env.js";
import { findInstructionFiles, readInstructions } from "./instructions.js";
import type { SessionStore } from "./persistence.js";
import { PROVIDER_OPTIONS_KEY, type ModelFactory } from "./provider.js";
import {
  PAUSED_NOTIFICATION,
  type ErrorHold,
  type PausedNotification,
  type Release,
} from "./hold.js";
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

    /* Every attempt's tokens, not the last attempt's. A turn that burned 60k
       reading a repo, hit a quota wall, held while the model was changed and
       finished on another one is still one turn, and reporting only the second
       model's tokens would under-count exactly the expensive turns — the ones
       `refreshQuota` is drawn against. */
    let turnUsage: LanguageModelUsage | null = null;
    let attempt = 0;

    for (;;) {
      const msgsBefore = session.messages.length;
      /* Words steered into *this* attempt. They are persisted and journaled as
         they arrive (`prepareStep` below), so rolling the attempt back has to
         put them back rather than drop them: the user said them once, they are
         already on disk, and truncating past them left memory and the file
         disagreeing and a duplicate bubble in the replay. */
      const steered: ModelMessage[] = [];
      /* The part of a failed attempt that is worth keeping: every step whose
         tool calls all came back. Filled from the outcome below. */
      let settled: ModelMessage[] = [];
      /* Undo the attempt, keeping the two things that are not the attempt's to
         throw away — the user's steered words, which are already on disk, and
         the steps that finished. Everything after them is the half-written
         remainder that failed, and it is dropped before it is ever persisted. */
      const rollback = () => {
        session.messages.length = msgsBefore;
        session.messages.push(...steered, ...settled);
        if (settled.length > 0) deps.store.appendMessages(session.id, settled);
      };

      /* Set when this attempt produced no answer. Collected in one variable
         rather than handled twice, because the two ways an attempt can fail
         land in different places: `makeModel`/`failNoModel` throw while the
         arguments are still being built, and a provider error arrives as a
         part in the stream. */
      let failure: unknown;
      try {
        const model = deps.makeModel(deps.env, session.modelId || failNoModel());
        const rt: ToolRuntime = {
          ctx,
          session,
          emit,
          clientCaps: deps.clientCaps(),
          runSubagent: (name, prompt) => runSubagent(deps, session, ctx, emit, name, prompt),
        };
        const { tools, meta } = buildTools(rt);

        const result = streamText({
          model,
          system: systemPrompt(session, deps.env, { toolNames: Object.keys(tools) }),
          messages: session.messages,
          tools,
          abortSignal: abort.signal,
          stopWhen: stepCountIs(MAX_STEPS),
          reasoning: session.effort ?? undefined,
          maxOutputTokens: deps.env.maxOutputTokens ?? undefined,
          /* A tool call the model got slightly wrong — another harness's tool
             name, another harness's parameter name, arguments encoded twice —
             is repaired in place instead of costing a failed step. */
          repairToolCall: makeRepairToolCall({
            onRepair: (note) => process.stderr.write(`${note}\n`),
            readFiles: session.readFiles,
          }),
          providerOptions: cacheAffinity(deps.env, session.id),
          onError: () => {
            /* Surfaced through the fullStream 'error' part below; without this
               handler streamText also logs the error, which is fine on stderr. */
          },
          prepareStep: async ({ messages }) => {
            /* The gate, first: a held session waits here, between one step's
               tool results and the next model call, until the harness lets it
               go — and only then reads the steering that may have arrived
               while it waited. Both reasons a session holds are one wait: the
               user's pause, and a turn that failed and is waiting to be told
               what to try instead. */
            await session.gate(abort.signal);
            if (session.steerQueue.length === 0) return {};
            const injected = session.steerQueue.flatMap((s) => s.messages);
            session.steerQueue = [];
            session.messages.push(...injected);
            steered.push(...injected);
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

        const outcome = await pumpStream(result, emit, meta, deps.env, session, undefined);
        if (outcome.totalUsage) turnUsage = addUsage(turnUsage, outcome.totalUsage);

        /* `result.response` is the *last step's* metadata — its `messages` are
           that step's alone. A tool-using turn is many steps, so keeping them
           threw away every tool call and every tool result the turn made, and
           the next turn started again from system+tools: the model forgot what
           it had just read, and the 40-70k of prefix the turn had built was
           re-sent uncached instead of re-read from the provider's cache.
           `responseMessages` is the accumulated list across all steps. */
        let generated: ModelMessage[] = [];
        try {
          generated = await result.responseMessages;
          if (generated.length === 0 && !outcome.aborted && outcome.error === undefined) {
            process.stderr.write("warning: turn produced no response messages to keep\n");
          }
        } catch (err) {
          /* An aborted or failed stream has no response messages to keep — but
             a *shape* change in the SDK is history loss, so it is not silent. */
          if (!abort.signal.aborted) {
            process.stderr.write(`could not keep response messages: ${errorText(err)}\n`);
          }
        }

        /* A step can fail without ever producing an error part: a provider
           that reports `finishReason: "error"` and nothing else used to end
           the turn as a clean `end_turn` with a truncated answer — a failure
           reported as a success. `content-filter` and `length` are the same
           kind of thing from the other side: the answer is not the one that
           was asked for, and both are fixed by moving off the model.

           Only where a hold can be taken. With nobody to release it,
           `max_tokens` and `refusal` are legitimate endings and stay the stop
           reasons they have always been — a run must not fail on them. */
        const finishFailure =
          outcome.error === undefined && session.holdOnError
            ? failedFinish(outcome.finishReason)
            : undefined;
        if (outcome.error !== undefined || finishFailure) {
          failure = outcome.error ?? finishFailure;
          /* Twenty tool calls into a turn, a rate limit must not cost twenty
             tool calls. What the model already did and saw is kept; only the
             step it was in the middle of is lost, because a tool call with no
             result is a message most providers refuse outright. */
          settled = settledPrefix(generated);
        } else {
          /* Persisted only now that the attempt is known to have produced an
             answer — and on the failing path, only down to the last settled
             step (`rollback`). Written before the check, a failed attempt left
             its own half of a step in the JSONL for good: an assistant message
             carrying tool calls with no matching results, which the next
             `session/load` hands straight back to a provider that rejects it. */
          session.messages.push(...generated);
          deps.store.appendMessages(session.id, generated);
          deps.store.touch(session.id);

          const stopReason: acp.StopReason = outcome.aborted
            ? "cancelled"
            : mapFinishReason(outcome.finishReason);
          const promptResponse: acp.PromptResponse = {
            stopReason,
            usage: toAcpUsage(turnUsage),
          };
          settleParked(session, (p) => p.resolve(promptResponse));
          return promptResponse;
        }
      } catch (err) {
        failure = err;
      }

      /* From here the attempt is over. What finished is kept and written; the
         unfinished remainder is dropped, and was never written — the JSONL is
         append-only, so not writing is the only undo it has. */
      rollback();
      deps.store.touch(session.id);

      if (abort.signal.aborted) throw failure;

      if (isRetriableStreamError(failure) && attempt < MAX_STREAM_RETRIES) {
        attempt++;
        process.stderr.write(`stream retry ${attempt}/${MAX_STREAM_RETRIES}\n`);
        await new Promise((r) => setTimeout(r, STREAM_RETRY_BASE_MS * 2 ** (attempt - 1)));
        continue;
      }

      /* Out of retries. Rather than throw the turn away — with every tool call
         it has already made — hold it here and let the user change the model
         or the profile, which the harness can do on the running process. The
         next pass re-reads `session.modelId`, so the change is the whole of
         what makes the retry different. */
      if (!session.holdOnError) throw failure;
      const release = await holdForFailure(ctx, session, failure, abort.signal);
      if (release === "released") {
        attempt = 0;
        continue;
      }
      /* Cancelled while held. A Stop ends a turn cleanly — the same
         `stopReason` it has always ended with — never as a failure. */
      const cancelled: acp.PromptResponse = {
        stopReason: "cancelled",
        usage: toAcpUsage(turnUsage),
      };
      settleParked(session, (p) => p.resolve(cancelled));
      return cancelled;
    }
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

/**
 * Hold a turn that failed, tell the harness why, and answer how the wait ended.
 *
 * The notification is the one direction the pause pair never had. A pause is
 * something the harness asks for and learns the answer to in the same reply;
 * a hold is taken at this end, on the turn's own initiative, and the harness
 * has no other way to find out — so it travels as `_daedalus/session/paused`,
 * absolute and live-only, the way the state it describes is.
 */
async function holdForFailure(
  ctx: acp.AgentContext,
  session: Session,
  failure: unknown,
  signal: AbortSignal,
): Promise<Release> {
  const hold = describeHold(failure);
  process.stderr.write(`turn held: ${hold.message}\n`);
  await notifyPaused(ctx, { sessionId: session.id, paused: true, reason: "error", ...hold });
  const release = await session.holdError(hold, signal);
  /* Said again on the way out, whichever way it ended: the harness learns a
     resume from its own reply, but a cancel reaches this end as a notification
     and would otherwise leave the toggle drawn as held. */
  await notifyPaused(ctx, { sessionId: session.id, paused: false });
  return release;
}

/** Best-effort: a hold that could not be announced is still a hold, and
    failing here would end the turn for the wrong reason. */
async function notifyPaused(ctx: acp.AgentContext, params: PausedNotification): Promise<void> {
  try {
    await ctx.notify(PAUSED_NOTIFICATION, params as unknown as never);
  } catch {
    // The connection is going away; `close()` on the other side settles the turn.
  }
}

/* The sentence to show and the provider's own account of it, folded. Split on
   the first line because an OpenAI-compatible error is usually one readable
   sentence followed by a JSON body nobody wants unbidden. */
function describeHold(failure: unknown): ErrorHold {
  const text = errorText(failure).trim() || "the model provider returned an error";
  const [first = text, ...rest] = text.split("\n");
  const detail = rest.join("\n").trim();
  return {
    message: first.length > 200 ? `${first.slice(0, 200)}…` : first,
    ...(detail ? { detail } : {}),
  };
}

/**
 * The longest prefix of a step's messages in which every tool call has its
 * result — what survives an attempt that died partway through.
 *
 * A turn is a sequence of assistant messages and the tool messages answering
 * them, and it is only cuttable where nothing is outstanding. Cut anywhere
 * else and the history carries a call with no result, which is not merely
 * untidy: most providers reject the request outright, so the next attempt
 * fails for a reason that has nothing to do with the one that started it.
 */
function settledPrefix(messages: ModelMessage[]): ModelMessage[] {
  const outstanding = new Set<string>();
  let keep = 0;
  messages.forEach((message, index) => {
    if (Array.isArray(message.content)) {
      for (const part of message.content as { type?: string; toolCallId?: string }[]) {
        if (!part.toolCallId) continue;
        if (part.type === "tool-call") outstanding.add(part.toolCallId);
        else if (part.type === "tool-result") outstanding.delete(part.toolCallId);
      }
    }
    if (outstanding.size === 0) keep = index + 1;
  });
  return messages.slice(0, keep);
}

/* One turn, one usage figure, however many attempts it took. Summed field by
   field rather than by `totalTokens` alone, because every one of them is drawn
   separately — the cache rate above all (`toAcpUsage`). */
function addUsage(a: LanguageModelUsage | null, b: LanguageModelUsage): LanguageModelUsage {
  if (!a) return b;
  const sum = (x: number | undefined, y: number | undefined): number | undefined =>
    x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0);
  return {
    ...a,
    inputTokens: sum(a.inputTokens, b.inputTokens),
    outputTokens: sum(a.outputTokens, b.outputTokens),
    totalTokens: sum(a.totalTokens, b.totalTokens),
    inputTokenDetails: {
      ...a.inputTokenDetails,
      cacheReadTokens: sum(a.inputTokenDetails?.cacheReadTokens, b.inputTokenDetails?.cacheReadTokens),
      cacheWriteTokens: sum(a.inputTokenDetails?.cacheWriteTokens, b.inputTokenDetails?.cacheWriteTokens),
    },
    outputTokenDetails: {
      ...a.outputTokenDetails,
      reasoningTokens: sum(a.outputTokenDetails?.reasoningTokens, b.outputTokenDetails?.reasoningTokens),
    },
  };
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
          /* Per-step, because a turn's total hides where the cache was lost:
             a run that misses on one step of thirteen and a run that misses on
             all thirteen add up to different totals but to the same story, and
             only the step series says which happened. ACP has no field for it,
             so it rides `_meta` — journaled with the event, which is what makes
             a cold step answerable by a query instead of a reconstruction. */
          const cacheRead = part.usage.inputTokenDetails?.cacheReadTokens ?? null;
          const cacheWrite = part.usage.inputTokenDetails?.cacheWriteTokens ?? null;
          await emit.update({
            sessionUpdate: "usage_update",
            used,
            size: windowSize(env),
            _meta:
              cacheRead === null && cacheWrite === null
                ? undefined
                : {
                    cache: {
                      read: cacheRead,
                      write: cacheWrite,
                      prompt: part.usage.inputTokens ?? null,
                    },
                  },
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
  /* An abort raised inside `prepareStep` (the pause gate's) reaches the
     stream as an error part rather than an `abort` part; it is the same
     cancellation. */
  if (outcome.error !== undefined && isAbortError(outcome.error)) outcome.aborted = true;
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
        system: systemPrompt(session, deps.env, { subagent: true, toolNames: Object.keys(tools) }),
        messages: [{ role: "user", content: prompt }],
        tools,
        abortSignal: session.abort?.signal,
        stopWhen: stepCountIs(MAX_STEPS),
        reasoning: session.effort ?? undefined,
        maxOutputTokens: deps.env.maxOutputTokens ?? undefined,
        repairToolCall: makeRepairToolCall({ readFiles: session.readFiles }),
        providerOptions: cacheAffinity(deps.env, session.id),
        onError: () => {},
        /* A subagent pauses with its parent: the Codex thread-tree issue's
           complaint is exactly a root held while its collaborators keep
           spending, so the child's steps pass the same gate. */
        prepareStep: async () => {
          await session.gate(session.abort?.signal);
          return {};
        },
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
  opts: { subagent?: boolean; toolNames?: string[] } = {},
): string {
  const parts: string[] = [];
  /* What is actually built for this turn, not what the prompt remembers being
     built. Plan mode strips every writing tool and a subagent strips `task`,
     and a prompt that names a tool the loop did not offer is a NoSuchToolError
     the model cannot see coming: "use bash for read-only commands" in plan
     mode, where bash is not there at all, is exactly how that failed. */
  const toolNames = opts.toolNames ?? [];
  const has = (name: string) => toolNames.length === 0 || toolNames.includes(name);
  parts.push(
    opts.subagent
      ? "You are Daedalus Agent, running as a subagent on a delegated task. Complete the task and end with a concise report of what you did and found — your final message is all the caller sees."
      : `You are Daedalus Agent, an interactive coding agent that helps users with software engineering tasks. Use the instructions below and the tools available to you to assist the user.

IMPORTANT: You must NEVER generate or guess URLs for the user unless you are confident that the URLs are for helping the user with programming. You may use URLs provided by the user in their messages or local files.

You run inside the Daedalus harness, which draws your tool calls, diffs and todos in a live transcript. When the user asks what you can do, answer from the tools you actually have rather than guessing at product documentation.

# Tone and style
- You should be concise, direct, and to the point. When you run a non-trivial bash command, you should explain what the command does and why you are running it, to make sure the user understands what you are doing (this is especially important when you are running a command that will make changes to the user's system).
- Remember that your output will be displayed on a command line interface. Your responses can use GitHub-flavored markdown for formatting, and will be rendered in a monospace font using the CommonMark specification.
- Output text to communicate with the user; all text you output outside of tool use is displayed to the user. Only use tools to complete tasks. Never use tools like Bash or code comments as means to communicate with the user during the session.
- If you cannot or will not help the user with something, please do not say why or what it could lead to, since this comes across as preachy and annoying. Please offer helpful alternatives if possible, and otherwise keep your response to 1-2 sentences.
- Only use emojis if the user explicitly requests it. Avoid using emojis in all communication unless asked.
- IMPORTANT: You should minimize output tokens as much as possible while maintaining helpfulness, quality, and accuracy. Only address the specific query or task at hand, avoiding tangential information unless absolutely critical for completing the request. If you can answer in 1-3 sentences or a short paragraph, please do.
- IMPORTANT: You should NOT answer with unnecessary preamble or postamble (such as explaining your code or summarizing your action), unless the user asks you to.
- IMPORTANT: Keep your responses short. A question with a short answer gets a short answer — one word where one word is the answer — and never an introduction, a conclusion or a restatement of the question. Avoid text before/after your response, such as "The answer is <answer>.", "Here is the content of the file..." or "Based on the information provided, the answer is..." or "Here is what I will do next...". Work you actually performed is the exception: report what changed and why, to the length the change deserves, following "Presenting your work" below.

# Professional objectivity
Prioritize technical accuracy and truthfulness over validating the user's beliefs. Focus on facts and problem-solving, providing direct, objective technical info without any unnecessary superlatives, praise, or emotional validation. It is best for the user if Daedalus Agent honestly applies the same rigorous standards to all ideas and disagrees when necessary, even if it may not be what the user wants to hear. Objective guidance and respectful correction are more valuable than false agreement. Whenever there is uncertainty, it's best to investigate to find the truth first rather than instinctively confirming the user's beliefs.

# Task Management
You have access to the write_todos tool to help you manage and plan tasks. Use these tools VERY frequently to ensure that you are tracking your tasks and giving the user visibility into your progress.
These tools are also EXTREMELY helpful for planning tasks, and for breaking down larger complex tasks into smaller steps. If you do not use this tool when planning, you may forget to do important tasks - and that is unacceptable.
It is critical that you mark todos as completed as soon as you are done with a task. Do not batch up multiple tasks before marking them as completed.
Examples:
<example>
user: Run the build and fix any type errors
assistant: I'm going to use the write_todos tool to write the following items to the todo list:
- Run the build
- Fix any type errors

I'm now going to run the build using Bash.
Looks like I found 10 type errors. I'm going to use the write_todos tool to write 10 items to the todo list.
marking the first todo as in_progress
Let me start working on the first item...
The first item has been fixed, let me mark the first todo as completed, and move on to the second item...
..
..
</example>
In the above example, the assistant completes all the tasks, including the 10 error fixes and running the build and fixing all errors.

<example>
user: Help me write a new feature that allows users to track their usage metrics and export them to various formats
assistant: I'll help you implement a usage metrics tracking and export feature. Let me first use the write_todos tool to plan this task.
Adding the following todos to the todo list:
1. Research existing metrics tracking in the codebase
2. Design the metrics collection system
3. Implement core metrics tracking functionality
4. Create export functionality for different formats

Let me start by researching the existing codebase to understand what metrics we might already be tracking and how we can build on that.
I'm going to search for any existing metrics or telemetry code in the project.

I've found some existing telemetry code. Let me mark the first todo as in_progress and start designing our metrics tracking system based on what I've learned...

[Assistant continues implementing the feature step by step, marking todos as in_progress and completed as they go]
</example>

# Doing tasks
The user will primarily request you perform software engineering tasks. This includes solving bugs, adding new functionality, refactoring code, explaining code, and more. For these tasks the following steps are recommended:
- Use the available search tools to understand the codebase and the user's query. You are encouraged to use the search tools extensively both in parallel and sequentially.
- Implement the solution using all tools available to you
- Verify the solution if possible with tests. NEVER assume specific test framework or test script. Check the README or search codebase to determine the testing approach.
${has("bash") ? "- VERY IMPORTANT: When you have completed a task, you MUST run the lint and typecheck commands (e.g. npm run lint, npm run typecheck, ruff, etc.) with bash if they were provided to you to ensure your code is correct." : "- VERY IMPORTANT: When you have completed a task, say which lint and typecheck commands should be run to check it — you cannot run them yourself this turn."} If you are unable to find the correct command, ask the user for the command to run and if they supply it, proactively suggest writing it to AGENTS.md so that you will know to run it next time.
NEVER commit changes unless the user explicitly asks you to. It is VERY IMPORTANT to only commit when explicitly asked, otherwise the user will feel that you are being too proactive.

- Tool results and user messages may include <system-reminder> tags. <system-reminder> tags contain useful information and reminders. They are NOT part of the user's provided input or the tool result.

# Tool usage policy
- You have the capability to call multiple tools in a single response. When multiple independent pieces of information are requested, batch your tool calls together for optimal performance. When making multiple bash tool calls, you MUST send a single message with multiple tools calls to run the calls in parallel. For example, if you need to run "git status" and "git diff", send a single message with two tool calls to run the calls in parallel.
${
  has("bash")
    ? `- Use specialized tools instead of bash commands when possible, as this provides a better user experience. For file operations, use dedicated tools: read_file instead of cat/head/tail, edit_file instead of sed/awk, write_file instead of a heredoc or echo redirection, and glob/grep instead of find/grep. Reserve bash exclusively for actual system commands and terminal operations that require shell execution. NEVER use bash echo or other command-line tools to communicate thoughts, explanations, or instructions to the user. Output all communication directly in your response text instead.`
    : `- Read with read_file and search with glob and grep. There is no shell this turn, so anything you would have reached for a command line to learn has to come from those three.`
}
${
  has("task")
    ? `- VERY IMPORTANT: When exploring the codebase to gather context or to answer a question that is not a needle query for a specific file/class/function, it is CRITICAL that you use the task tool instead of running search commands directly — it keeps the search out of your context.
<example>
user: Where are errors from the client handled?
assistant: [Uses the task tool to find the files that handle client errors instead of using glob or grep directly]
</example>
<example>
user: What is the codebase structure?
assistant: [Uses the task tool]
</example>`
    : `- There is no subagent tool this turn, so broad exploration is yours to do: narrow it with glob and grep first and read only the ranges you need, rather than pulling whole files in.`
}

# Working from what you already have
The conversation above is your memory of this session, and it is authoritative. Before you reach for a tool, check whether the answer is already in it.
- Do NOT re-read a file whose contents are already in this conversation, and do NOT re-run a search you have already run. The earlier result is still true unless something changed it.
- Something changed it means: you edited or wrote the file, a bash command you ran touched it, or the user says it changed. Then re-read only the part that moved — use \`offset\`/\`limit\` rather than pulling the whole file back.
- Your own edits are recorded above. After an edit_file succeeds, the file is what you just made it; do not read it back to confirm the tool did what it said.
- Read the range you need, not the file. When you are looking for one function, grep for it and read around the hit; a whole-file read to answer a one-line question is wasted context for the rest of the session.
- When the user follows up on work you just did, continue from what you already know instead of re-exploring the codebase from scratch. Re-establish context only for the parts of the repo this session has genuinely not seen.
- This is not a licence to guess. If a fact was never established here, or it was compacted away and you cannot see it, go and read it — the rule is "don't fetch twice", never "answer from memory you don't have".

${
  has("edit_file")
    ? `# Editing constraints
- Default to ASCII when editing or creating files. Only introduce non-ASCII or other Unicode characters when there is a clear justification and the file already uses them.
- Only add comments if they are necessary to make a non-obvious block easier to understand.
- Use edit_file for a change to part of a file and write_file only for a whole file. Read a file before you edit or overwrite it, and copy old_string out of what read_file returned — without its line-number prefix — rather than retyping it from memory: an edit fails when the text is not byte-for-byte what is on disk.
- Make old_string unique by including a line or two of surrounding context. Reach for replace_all only when you mean every occurrence.
- Scripting a mechanical change across many files (a rename, a codemod) through bash is fine and often better than a long run of edits.

# Git and workspace hygiene
- You may be in a dirty git worktree.
    * NEVER revert existing changes you did not make unless explicitly requested, since these changes were made by the user.
    * If asked to make a commit or code edits and there are unrelated changes to your work or changes that you didn't make in those files, don't revert those changes.
    * If the changes are in files you've touched recently, you should read carefully and understand how you can work with the changes rather than reverting them.
    * If the changes are in unrelated files, just ignore them and don't revert them.
- Do not amend commits unless explicitly requested.
- **NEVER** use destructive commands like \`git reset --hard\` or \`git checkout --\` unless specifically requested or approved by the user.`
    : "# Editing constraints\nNothing writes this turn. Do not describe an edit as made, and do not promise one you cannot make here."
}

# Frontend tasks
When doing frontend design tasks, avoid collapsing into bland, generic layouts.
Aim for interfaces that feel intentional and deliberate.
- Typography: Use expressive, purposeful fonts and avoid default stacks (Inter, Roboto, Arial, system).
- Color & Look: Choose a clear visual direction; define CSS variables; avoid purple-on-white defaults. No purple bias or dark mode bias.
- Motion: Use a few meaningful animations (page-load, staggered reveals) instead of generic micro-motions.
- Background: Don't rely on flat, single-color backgrounds; use gradients, shapes, or subtle patterns to build atmosphere.
- Overall: Avoid boilerplate layouts and interchangeable UI patterns. Vary themes, type families, and visual languages across outputs.
- Ensure the page loads properly on both desktop and mobile.

Exception: If working within an existing website or design system, preserve the established patterns, structure, and visual language.

# Presenting your work and final message

You are producing plain text that will later be styled by the CLI. Follow these rules exactly. Formatting should make results easy to scan, but not feel mechanical. Use judgment to decide how much structure adds value.

- Default: be very concise; friendly coding teammate tone.
- Default: do the work without asking questions. Treat short tasks as sufficient direction; infer missing details by reading the codebase and following existing conventions.
- Questions: only ask when you are truly blocked after checking relevant context AND you cannot safely pick a reasonable default. This usually means one of:
  * The request is ambiguous in a way that materially changes the result and you cannot disambiguate by reading the repo.
  * The action is destructive/irreversible, touches production, or changes billing/security posture.
  * You need a secret/credential/value that cannot be inferred (API key, account id, etc.).
- If you must ask: do all non-blocked work first, then ask exactly one targeted question, include your recommended default, and state what would change based on the answer.
- Never ask permission questions like "Should I proceed?" or "Do you want me to run tests?"; proceed with the most reasonable option and mention what you did.
- For substantial work, summarize clearly; follow final‑answer formatting.
- Skip heavy formatting for simple confirmations.
- Don't dump large files you've written; reference paths only.
- No "save/copy this file" - User is on the same machine.
- Offer logical next steps (tests, commits, build) briefly; add verify steps if you couldn't do something.
- For code changes:
  * Lead with a quick explanation of the change, and then give more details on the context covering where and why a change was made. Do not start this explanation with "summary", just jump right in.
  * If there are natural next steps the user may want to take, suggest them at the end of your response. Do not make suggestions if there are no natural next steps.
  * When suggesting multiple options, use numeric lists for the suggestions so the user can quickly respond with a single number.
- The user does not see command execution outputs. When asked to show the output of a command (e.g. \`git show\`), relay the important details in your answer or summarize the key lines so the user understands the result.

# Final answer structure and style guidelines

- Plain text; CLI handles styling. Use structure only when it helps scannability.
- Headers: optional; short Title Case (1-3 words) wrapped in **…**; no blank line before the first bullet; add only if they truly help.
- Bullets: use - ; merge related points; keep to one line when possible; 4–6 per list ordered by importance; keep phrasing consistent.
- Monospace: backticks for commands/paths/env vars/code ids and inline examples; use for literal keyword bullets; never combine with **.
- Code samples or multi-line snippets should be wrapped in fenced code blocks; include an info string as often as possible.
- Structure: group related bullets; order sections general → specific → supporting; for subsections, start with a bolded keyword bullet, then items; match complexity to the task.
- Tone: collaborative, concise, factual; present tense, active voice; self‑contained; no "above/below"; parallel wording.
- Don'ts: no nested bullets/hierarchies; no ANSI codes; don't cram unrelated keywords; keep keyword lists short—wrap/reformat if long; avoid naming formatting styles in answers.
- Adaptation: code explanations → precise, structured with code refs; simple tasks → lead with outcome; big changes → logical walkthrough + rationale + next actions; casual one-offs → plain sentences, no headers/bullets.
- File References: When referencing files in your response follow the below rules:
  * Use inline code to make file paths clickable.
  * Each reference should have a stand alone path. Even if it's the same file.
  * Accepted: absolute, workspace‑relative, a/ or b/ diff prefixes, or bare filename/suffix.
  * Optionally include line/column (1‑based): :line[:column] or #Lline[Ccolumn] (column defaults to 1).
  * Do not use URIs like file://, vscode://, or https://.
  * Do not provide range of lines
  * Examples: src/app.ts, src/app.ts:42, b/server/index.js#L10, C:\\repo\\project\\main.rs:12:5

# Code References
When referencing specific functions or pieces of code include the pattern \`file_path:line_number\` to allow the user to easily navigate to the source code location.
<example>
user: Where are errors from the client handled?
assistant: Clients are marked as failed in the \`connectToServer\` function in src/services/process.ts:712.
</example>`,
  );
  /* Its own block, and pushed for a subagent as well as for a root turn.
     Every failure this section exists to stop — a call to a tool the turn did
     not build, two calls' arguments run into one buffer, an `edit_file` that
     forgot its `path` — is a failure a subagent makes in exactly the same way,
     and it was only ever told the short brief. */
  if (toolNames.length) {
    parts.push(
      `# Tools available to you
${toolNames.map((n) => `- ${n}`).join("\n")}

That list is exhaustive for this turn. A tool that is not on it does not exist here — do not call it, and do not tell the user you will. If something you need is missing, say so and use what you have.

# Calling tools correctly
- Every call carries its own complete JSON arguments object. Never run two calls' arguments together into one, and never leave one of them empty — parallel calls are independent messages, not one message split up.
- Send every required argument, every time. In particular \`edit_file\` and \`write_file\` need \`path\` alongside the strings; the path is the argument that gets dropped when the other arguments are long, so write it first.
- Paths may be absolute or relative to the working directory. Prefer the exact path you saw in an earlier result over one you reconstruct.
- If a call comes back saying its arguments could not be parsed or an argument was missing, that call did not run. Re-issue it once, on its own, with the whole arguments object — do not assume it half-happened and do not change your plan because of it.`,
    );
  }
  if (session.mode === "plan") {
    /* The old text here described a read-only *policy* — "use bash only for
       read-only operations", "never use mkdir/touch/rm" — over a tool set that
       does not contain bash at all. Plan mode is enforced by `buildTools`,
       which never builds a tool that writes, so the model that followed those
       words called a tool that was not there and got a NoSuchToolError back
       for its trouble. What plan mode has to say is which tools exist, not
       which uses of a missing one are forbidden. */
    parts.push(
      `You are in PLAN MODE. Every tool that can change anything — writing files, editing them, running shell commands, MCP tools — is not built for this turn: it is absent, not merely discouraged. ${
        toolNames.length ? `The only tools you have are: ${toolNames.join(", ")}.` : ""
      } Calling anything else fails outright and wastes a step, so do not reach for bash to "just check something".

Explore with the tools you have, then write the plan:
- Read what you were pointed at, and find the existing patterns and conventions around it with glob, grep and read_file.
- Trace the code paths the change would touch, and name the similar feature you are following.
- Then give a concrete, ordered implementation plan: what changes in which file, in what sequence, and what each step depends on. Call out the trade-offs you chose between and the parts you are unsure about.
- Close with the 3-5 files most critical to the change, one path per line.

Nothing is implemented in plan mode. End by asking the user to approve the plan or tell you what to change.`,
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

/* A prefix cache lives on the machine that built it, so a router free to pick
   a different backend per request answers a warm prompt from a cold one. The
   key is the affinity hint that keeps a thread's steps together: OpenAI routes
   on it explicitly, and a gateway that has never heard of it ignores an
   unknown body field. The session id — stable across every step of every turn,
   distinct between threads that share a model — is exactly the grain the cache
   is built at. Env-gated for the strict upstream that rejects what it cannot
   parse rather than ignoring it. */
function cacheAffinity(env: AgentEnv, sessionId: string): SharedV4ProviderOptions | undefined {
  if (!env.promptCacheKey) return undefined;
  return { [PROVIDER_OPTIONS_KEY]: { prompt_cache_key: sessionId } };
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

/**
 * The finish reasons that mean the step did not do what was asked, as an error
 * to hold on — or `undefined` for the ones that mean it did.
 *
 * `"error"` is the one that was silently wrong: a provider that reports it and
 * sends no error part left `mapFinishReason` to fall through to `end_turn`, so
 * a step that failed was reported as one that succeeded and the answer simply
 * stopped mid-sentence. The other two are not errors in the transport sense —
 * they are ACP stop reasons, and honest ones — but they are both "this model
 * would not finish this", which is a thing a reader can fix by moving off it.
 */
function failedFinish(reason: string): Error | undefined {
  switch (reason) {
    case "error":
      return new Error("the model provider ended the step with an error");
    case "content-filter":
      return new Error("the model refused to answer (content filter)");
    case "length":
      return new Error("the model hit its output limit before finishing");
    default:
      /* `other` and `unknown` are not claims of failure — a provider that has
         said nothing has not said something went wrong. */
      return undefined;
  }
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

/* `inputTokens` in this protocol is the part of the prompt the provider had to
   read *fresh* — the client adds the cache figures back to it to draw "the
   prompt" and divides by that sum to draw the cache rate (`lib/tokens.ts`).
   OpenAI-compatible `prompt_tokens`, which is all this runtime ever speaks,
   means the opposite: it is the whole prompt with `cached_tokens` counted
   inside it. Reported raw, every cached token was counted twice — a turn that
   really hit cache on 89% of its prompt was drawn as 47%, and no amount of
   caching could ever have moved it past 50%. Subtract the hit, floor at zero
   for a provider that ever reports more cache than prompt. */
function toAcpUsage(usage: LanguageModelUsage | null): acp.Usage | null {
  if (!usage) return null;
  const cacheRead = usage.inputTokenDetails?.cacheReadTokens ?? null;
  return {
    totalTokens: totalOf(usage),
    inputTokens: Math.max(0, (usage.inputTokens ?? 0) - (cacheRead ?? 0)),
    outputTokens: usage.outputTokens ?? 0,
    thoughtTokens: usage.outputTokenDetails?.reasoningTokens ?? null,
    cachedReadTokens: cacheRead,
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
  if (error instanceof Error) {
    /* The SDK's own tool errors carry the cause that explains them — a Zod
       report, or the arguments that would not parse. Without it the model
       reads "invalid input" and guesses at what was invalid. */
    const cause = (error as { cause?: unknown }).cause;
    const detail =
      cause instanceof Error && cause.message && !error.message.includes(cause.message) ? `\n${cause.message}` : "";
    return `${error.message}${detail}`;
  }
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
