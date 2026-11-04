import { randomUUID } from "node:crypto";
import { hostname, platform } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import * as acp from "./acp.js";
import {
  stepCountIs,
  streamText,
  type FilePart,
  type LanguageModelUsage,
  type ModelMessage,
  type StreamTextResult,
  type ToolSet,
  type UserContent,
} from "ai";
import { makeRepairToolCall } from "./tools/repair.js";
import { expandCommand } from "./commands.js";
import { compact, needsCompaction, windowFor } from "./compaction.js";
import type { AgentEnv } from "./env.js";
import { findInstructionFiles, readInstructions } from "./instructions.js";
import { loadModelPrompts, modelPromptLayer } from "./model-prompts.js";
import type { SessionStore } from "./persistence.js";
import { stepOptions, type ModelFactory } from "./provider.js";
import {
  PAUSED_NOTIFICATION,
  RETRY_NOTIFICATION,
  type ErrorHold,
  type PausedNotification,
  type RetryNotification,
  type Release,
} from "./hold.js";
import type { Session } from "./session.js";
import { buildTools, metaFor, type ToolMeta, type ToolRuntime } from "./tools/index.js";
import { deferMcpTools } from "./tools/tool-search.js";
import { generateTitle } from "./title.js";
import { Emitter } from "./updates.js";
import { Meter, normalizeUsage, toAcpUsage, totalOf, type CallMetering, type StepLead, type WaitCause } from "./metering.js";
import { Tracer, type CallHooks, type ModelCall } from "./trace.js";

export interface TurnDeps {
  env: AgentEnv;
  store: SessionStore;
  makeModel: ModelFactory;
  clientCaps: () => acp.ClientCapabilities | null;
}

const MAX_STEPS = 100;
/* A summary that is itself near the window buys nothing, and a turn that
   re-crosses the threshold after every step would otherwise compact forever —
   each cycle burning a whole step to ask the same summarizer. */
const MAX_MID_TURN_COMPACTIONS = 3;
const OUTPUT_CONTENT_LIMIT = 30_000;
const SUBAGENT_REPORT_LIMIT = 32_000;
/* The harness's retries, and the only ones: `maxRetries: 0` on every
   `streamText` below. Left at the SDK's default the log's holds all began
   "Failed after 3 attempts" — three tries inside six seconds, then a
   `RetryError` the classifier did not recognise, so a 429 that said "retry
   after a brief wait" was handed to the user before the wait was over. Four
   retries at 2s doubling is ~30s of patience, and a Retry-After header can
   stretch any one wait up to the cap. */
const MAX_STREAM_RETRIES = 4;
const STREAM_RETRY_BASE_MS = 2_000;
const STREAM_RETRY_MAX_MS = 60_000;

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
  /* A between-turns compaction has no turn holding it, so the prompt waits for
     it here. Pushed into a history the summarizer is still reading, this
     message would be dropped by the replacement that lands a moment later. */
  if (session.compacting) await session.compacting;

  const text = promptText(params.prompt);
  const expanded = (await expandCommand(session.commands, text)) ?? text;

  /* A prompt landing mid-turn is steering: its content joins the running turn
     at the next model step (prepareStep drains the queue), and its JSON-RPC
     response is the same turn's end — exactly the contract the harness's
     `inflight` counter expects. */
  if (session.turnActive) {
    /* The same rendering the non-steer door uses: a steer that carried an image
       is still a prompt with an image in it, and flattening it to `expanded`
       dropped the bytes while keeping the `[attached: …]` prose — the model was
       told a screenshot was there and never given it. */
    session.steerQueue.push({ messages: [{ role: "user", content: promptContent(params.prompt, expanded) }] });
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

  /* Every model call the turn makes, metered as each one answers
     (`metering.ts`) — the root loop, its retries, its subagents, the
     summarizer and the title call alike. Not read off a stream's `finish`,
     which a cancelled turn never reaches. */
  const meter = new Meter();
  /* And every one of them traced: the request the SDK sent joined to the
     response it got, as one `_daedalus/model_call` record (`trace.ts`). */
  const tracer = new Tracer();

  /* Only a session's very first message is named: a reloaded session has no
     `title` either, but it has messages. */
  const naming = !session.title && session.messages.length === 0 && deps.env.autoTitle;
  if (!session.title) session.title = firstLine(text);
  /* Naming sends the fallback only if the model fails to do better: the
     harness takes an agent title only while its own prompt-derived one stands,
     so a first-line update landing first would lock the good one out. */
  if (session.title && !naming) {
    await emit.update({
      sessionUpdate: "session_info_update",
      title: session.title,
      updatedAt: new Date().toISOString(),
    });
  }
  deps.store.touch(session.id, session.title ?? undefined);
  if (naming) {
    const fallback = session.title;
    void generateTitle(deps.env, deps.makeModel, session.modelId, text, abort.signal, traced(tracer, emit, "title", meter.record)).then((title) => {
      const next = title ?? fallback;
      if (!next) return;
      session.title = next;
      if (title) deps.store.retitle(session.id, title);
      return emit.update({ sessionUpdate: "session_info_update", title: next, updatedAt: new Date().toISOString() });
    }).catch(() => {});
  }

  /* One compaction attempt, whichever door asked for it. Resolves false when
     the summarizer failed — the `failed` compaction_update has already said
     so, and the turn runs on uncompacted; a user abort is not a summarizer
     failure and still ends the turn, so it is rethrown. */
  const compactOnce = async (): Promise<boolean> => {
    const announce = Boolean(deps.clientCaps()?.session?.compaction);
    try {
      await meter.during("compactMs", () =>
        compact(session, deps.env, deps.makeModel, emit, announce, abort.signal, traced(tracer, emit, "compaction", meter.record)),
      );
      return true;
    } catch (err) {
      if (abort.signal.aborted) throw err;
      process.stderr.write(`compaction failed: ${errorText(err)}\n`);
      return false;
    }
  };

  /* Whether a retry has been announced and not yet taken back. The notice is
     absolute, so the clearing one is owed exactly where one went out — and it
     is owed on *every* way out, including the throw, which is why this lives
     outside the try and is swept by its `finally` rather than paired with each
     `return`. */
  let retryAnnounced = false;
  const clearRetry = async (): Promise<void> => {
    if (!retryAnnounced) return;
    retryAnnounced = false;
    await notifyRetry(ctx, { sessionId: session.id, attempt: null });
  };

  try {
    /* Compact before the prompt that tripped the threshold joins the history:
       the summarizer must not eat the message the user just typed, and the
       JSONL compact barrier has to land before it so a load replay keeps it. */
    if (needsCompaction(session, deps.env)) await compactOnce();

    /* The prompt as the *provider* must see it: the text plus any image/audio
       bytes the bridge put on the wire (`attachment-blocks.ts` picks that
       branch against this runtime's capability and the thread's model). `expanded`
       is the plain-text rendering for callers that only want the words; the
       message keeps the parts. */
    const userMessage: ModelMessage = { role: "user", content: promptContent(params.prompt, expanded) };
    session.messages.push(userMessage);
    deps.store.appendMessages(session.id, [userMessage]);
    /* Journal the user's words for load replay; live, the harness draws the
       user side itself, so this is persist-only. */
    emit.record({
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text },
      messageId: randomUUID(),
    });

    /* Every attempt's tokens, not the last attempt's — that is what `meter`
       is (declared above): a turn that burned 60k reading a repo, hit a quota
       wall, held while the model was changed and finished on another one is
       still one turn, and reporting only the second model's tokens would
       under-count exactly the expensive turns — the ones `refreshQuota` is
       drawn against. */
    let attempt = 0;
    /* Mid-turn compaction bookkeeping: how many times this turn has summarized
       its own history, and whether the summarizer has already failed once —
       a second ask after a failure would spend the turn stopping at every
       boundary to request the same answer again. */
    let midTurnCompactions = 0;
    let compactionDead = false;

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
      /* Set by `prepareStep` when the context the next step would send has
         crossed the compaction threshold. `stopWhen` ends the attempt at the
         step it is on — everything it produced is persisted below — and the
         turn loops into a compaction instead of a return. */
      let compactMidTurn = false;
      /* Which door asked for it. A compaction the *user* asked for does not
         spend the automatic budget and a failure of it does not disable the
         automatic path — the caps exist to stop the threshold retrying itself
         forever, and neither reason applies to a button someone pressed. */
      let compactManual = false;
      /* How many model steps this attempt took, read off the messages the turn
         kept (one assistant message per step). Checked at the late-steer
         boundary below against the same `MAX_STEPS` the stream is stopped at,
         so a thought that arrives at the ceiling waits for the next turn
         instead of driving a step past the cap. */
      let stepsTaken = 0;

      /* Read whatever steering has arrived, and answer with the messages it
         contributed, having already recorded and persisted them. Called at a
         step boundary (`prepareStep`, before the next model call) and after an
         attempt's last step has streamed — the two places a steer can be picked
         up. A steer's words are the user's, so they are pushed into the history
         and journaled here rather than flattened into the prompt: the replay
         has to draw the bubble where it landed. `steered` collects them for
         this attempt's rollback — they are already on disk, so a failed attempt
         must put them back rather than truncate them away. */
      const drainSteers = (): ModelMessage[] => {
        const words = session.steerQueue.flatMap((s) => s.messages);
        session.steerQueue = [];
        /* Media an MCP tool returned rides the same door, first — it belongs
           to the tool results just before it — but is not the user's words, so
           it is persisted and never journaled as a bubble. */
        const media = mediaMessage(session, deps.env);
        const injected = media ? [media, ...words] : words;
        if (injected.length === 0) return [];
        session.messages.push(...injected);
        steered.push(...injected);
        deps.store.appendMessages(session.id, injected);
        for (const m of words) {
          emit.record({
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text: contentText(m) },
            messageId: randomUUID(),
          });
        }
        return injected;
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
          env: deps.env,
          runSubagent: (name, prompt, toolCallId, modelId, role) =>
            /* A subagent's spend is the turn's spend: its steps never touch
               `session.lastTokens` (they measure the child's own window), so
               the only place its tokens can land is the turn's meter, the one
               every call of the root adds to. */
            runSubagent(deps, session, ctx, emit, toolCallId ?? "unknown", name, prompt, tracer, meter.record, undefined, modelId, role),
          listSubagents: () =>
            deps.store.listSubagents(session.id).map(({ id, name, task, status }) => ({ id, name, task, status })),
          sendMessage: (agent, message) =>
            runSubagent(deps, session, ctx, emit, `message-${randomUUID()}`, agent, message, tracer, meter.record, agent),
        };
        const { tools, meta } = buildTools(rt);
        const deferral = deferMcpTools(tools, session.messages);

        /* The system prompt names the tools that are never deferred; a loaded
           MCP tool is said by the search result that loaded it, so a load never
           rewrites the prompt — not this turn, and not the next one either. */
        const sections = systemSections(session, deps.env, { toolNames: deferral?.base ?? Object.keys(tools) });
        const system = sections.map((part) => part.text).join("\n\n");

        const result = streamText({
          model,
          system,
          messages: session.messages,
          tools,
          abortSignal: abort.signal,
          maxRetries: 0,
          stopWhen: [
            stepCountIs(MAX_STEPS),
            /* The step boundary is the only place a mid-turn compaction can
               happen, so asking for one is what ends the attempt there. */
            () => compactMidTurn,
          ],
          reasoning: session.effort ?? undefined,
          maxOutputTokens: deps.env.maxOutputTokens ?? undefined,
          /* A tool call the model got slightly wrong — another harness's tool
             name, another harness's parameter name, arguments encoded twice —
             is repaired in place instead of costing a failed step. */
          repairToolCall: makeRepairToolCall({
            onRepair: (note) => process.stderr.write(`${note}\n`),
            readFiles: session.readFiles,
          }),
          providerOptions: stepOptions(deps.env, session.id, session.modelId, session.effort),
          ...traced(tracer, emit, "turn", (call) => {
            meter.record(call);
            meter.span(call);
          }, { sections }),
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
            await meter.during("heldMs", () => session.gate(abort.signal));
            /* The window is crossed *inside* a turn — every step's tool results
               join the prompt, and the between-turns check only ever saw what
               the last turn left behind. The threshold's 20% headroom is what
               pays for the one extra step this costs. */
            /* The harness's own trigger (`_daedalus/session/compact`) is read
               here rather than acted on when it arrives, for the reason the
               threshold is: this boundary is the only place the history is
               whole. It outranks the threshold check because it is the same
               work for a better reason, and it is cleared whether or not the
               summarizer goes on to succeed — an unconsumed flag would compact
               again at every boundary for the rest of the turn. */
            if (session.compactRequested) {
              session.compactRequested = false;
              compactMidTurn = true;
              compactManual = true;
            } else if (
              !compactionDead &&
              midTurnCompactions < MAX_MID_TURN_COMPACTIONS &&
              needsCompaction(session, deps.env)
            ) {
              compactMidTurn = true;
            }
            const injected = drainSteers();
            if (injected.length === 0) return {};
            return { messages: [...messages, ...injected] };
          },
        });

        const outcome = await pumpStream(
          result,
          emit,
          meta,
          deps.env,
          session.modelId,
          session,
          subagentsNegotiated(deps),
          { cwd: session.cwd, model: session.modelId },
          meter.take,
        );

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
          stepsTaken = generated.filter((m) => m.role === "assistant").length;
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
            ? failedFinish(outcome.finishReason, stepsTaken >= MAX_STEPS)
            : undefined;
        if (outcome.error !== undefined || finishFailure) {
          failure = outcome.error ?? finishFailure;
          /* Twenty tool calls into a turn, a rate limit must not cost twenty
             tool calls. What the model already did and saw is kept; only the
             step it was in the middle of is lost, because a tool call with no
             result is a message most providers refuse outright. */
          settled = settledPrefix(generated);
        } else {
          /* The attempt worked, so whatever was said about retrying is over —
             taken back here rather than at the return, because a mid-turn
             compaction carries on round the loop without one. */
          await clearRetry();
          /* Persisted only now that the attempt is known to have produced an
             answer — and on the failing path, only down to the last settled
             step (`rollback`). Written before the check, a failed attempt left
             its own half of a step in the JSONL for good: an assistant message
             carrying tool calls with no matching results, which the next
             `session/load` hands straight back to a provider that rejects it. */
          session.messages.push(...generated);
          deps.store.appendMessages(session.id, generated);
          deps.store.touch(session.id);

          /* The attempt was stopped for the compaction, not because the model
             was done — `tool-calls` is the only finish `stopWhen` can have
             interrupted (a prose finish ends the loop on its own). The history
             is whole and written, so it is summarized on the same terms the
             between-turns compaction runs on, and the turn carries on against
             the compacted context instead of ending. */
          if (compactMidTurn && outcome.finishReason === "tool-calls" && !outcome.aborted) {
            if (!compactManual) midTurnCompactions += 1;
            if (!(await compactOnce()) && !compactManual) compactionDead = true;
            continue;
          }

          const stopReason: acp.StopReason = outcome.aborted
            ? "cancelled"
            : outcome.finishReason === "tool-calls" && stepsTaken >= MAX_STEPS
              ? "max_turn_requests"
              : mapFinishReason(outcome.finishReason);

          /* A steer can land after `prepareStep` has run for the last time —
             the model had already streamed its answer, so no step boundary is
             left to read it. Ending here would leave the words in the history
             for a turn that never comes: the user watched their steer join a
             turn that never acted on it. So the same drain runs once more, and
             a steer that arrived is read in one more step of *this* turn. The
             one bound is the step cap: at the last step the loop has nowhere
             left to send it, and the `finally` below keeps it as context for
             the next turn rather than dropping it. */
          const late = abort.signal.aborted || stepsTaken >= MAX_STEPS ? [] : drainSteers();
          if (late.length > 0) {
            attempt = 0;
            continue;
          }

          const promptResponse: acp.PromptResponse = {
            stopReason,
            usage: toAcpUsage(meter.usage),
            _meta: meter.meta(),
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
        const delayMs = retryDelayMs(failure, attempt);
        /* The log gets the whole thing — a headline is cut to fit a row in a
           transcript, and stderr is not a row. It is also what gets spliced
           into an error on the way out (see CLAUDE.md), so a cut here is a cut
           in the one place the reason was still recoverable. */
        process.stderr.write(
          `stream retry ${attempt}/${MAX_STREAM_RETRIES} in ${delayMs}ms: ${errorText(unwrapRetry(failure)).trim()}\n`,
        );
        /* Said before the wait, not after it: the backoff is most of the
           silence, and a notice that arrives when the next attempt starts
           explains a pause that has already happened. */
        retryAnnounced = true;
        await notifyRetry(ctx, {
          sessionId: session.id,
          attempt,
          of: MAX_STREAM_RETRIES,
          delayMs,
          ...describeHold(failure),
        });
        /* Abortable: a Stop pressed during a 30s backoff must not wait it
           out. The loop head rethrows on the aborted signal. */
        await meter.during("retryMs", () => sleep(delayMs, undefined, { signal: abort.signal }).catch(() => {}));
        /* The backoff is over and the next attempt is about to run — the
           silence the notice explains is behind us. Left up until the attempt
           *finishes*, it sat over a turn that was streaming normally, for as
           long as that turn took. A failure of this attempt announces again. */
        await clearRetry();
        continue;
      }

      /* Out of retries. Rather than throw the turn away — with every tool call
         it has already made — hold it here and let the user change the model
         or the profile, which the harness can do on the running process. The
         next pass re-reads `session.modelId`, so the change is the whole of
         what makes the retry different. */
      /* Out of retries, so the retry notice is not merely stale — the hold
         about to go out is the same failure said again, and two live states
         describing one turn is one of them drawn over the other. */
      await clearRetry();
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
        usage: toAcpUsage(meter.usage),
        _meta: meter.meta(),
      };
      settleParked(session, (p) => p.resolve(cancelled));
      return cancelled;
    }
  } catch (err) {
    process.stderr.write(`turn failed: ${(err as Error)?.stack ?? String(err)}\n`);
    /* A rejected prompt has no response to carry usage in, and the calls that
       ran before it failed were billed all the same — they ride the error. */
    const failed = withSpend(err, meter);
    settleParked(session, (p) => p.reject(failed));
    throw failed;
  } finally {
    session.turnActive = false;
    session.abort = null;
    /* Whatever ended the turn — an answer, a throw, a cancel — it is not
       retrying any more. Fire-and-forget: this block must not become async. */
    void clearRetry();
    /* Media from a tool the model never got another step to look at. */
    session.mcp?.media.splice(0);
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
  // Whole, for the same reason the retry's line is: stderr is the log, and it
  // is what gets spliced into an error on the way out.
  process.stderr.write(`turn held: ${errorText(unwrapRetry(failure)).trim() || hold.message}\n`);
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

/** The same bargain for a retry: best-effort, because a retry nobody could be
    told about is still a retry and throwing here would end the turn on the
    reporting rather than on the failure. */
async function notifyRetry(ctx: acp.AgentContext, params: RetryNotification): Promise<void> {
  try {
    await ctx.notify(RETRY_NOTIFICATION, params as unknown as never);
  } catch {
    // See `notifyPaused`.
  }
}

/* The sentence to show and the provider's own account of it, folded. Split on
   the first line because an OpenAI-compatible error is usually one readable
   sentence followed by a JSON body nobody wants unbidden. */
function describeHold(failure: unknown): ErrorHold {
  const text = errorText(unwrapRetry(failure)).trim() || "the model provider returned an error";
  const [first = text, ...rest] = text.split("\n");
  const detail = rest.join("\n").trim();
  const message = first.length > 200 ? `${first.slice(0, 200)}…` : first;
  /* The headline is cut to a headline's length, but nothing is cut *away*: the
     ellipsis promises a rest, and a one-line provider error had none to open —
     the whole reason it says `Too big: expected number to be <=…` and stops
     right before the parameter's name. A cut headline carries the entire text
     as its detail; an uncut one carries only what came after it. */
  return {
    message,
    ...(message === first ? (detail ? { detail } : {}) : { detail: text }),
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

function failNoModel(): never {
  throw new Error(
    "No model configured: the profile names no model and DAEDALUS_AGENT_MODEL is empty",
  );
}

interface StreamOutcome {
  finishReason: string;
  aborted: boolean;
  error: unknown;
  /** The assistant's final prose, accumulated for subagent reports. */
  text: string;
}

/* One fullStream → ACP mapping, shared by the main turn and every subagent
   loop (which passes `childId`-addressed emitters). Text and thought deltas
   stream live and are journaled coalesced — one chunk per block — so a load
   replay is a handful of updates, not thousands.

   `contextOf` is the session whose context gauge (`lastTokens`) each step's
   own reading updates: the root loop's only. A subagent's steps measure its
   own, far smaller window, and writing them onto the parent session made
   compaction threshold against a context the parent never had — a child's
   4k step reset the parent's 190k reading to zero mid-turn. */
async function pumpStream(
  result: Pick<StreamTextResult<ToolSet, Record<string, unknown>, never>, "fullStream">,
  emit: Emitter,
  meta: Record<string, ToolMeta>,
  env: AgentEnv,
  /* The model these requests are going out on, which is what decides the
     window they are measured against. Passed rather than read off `contextOf`:
     a subagent has no context gauge of its own here but its requests still
     carry a window, and it runs on the same session's model. */
  modelId: string,
  contextOf: Session | null,
  /* Whether the client negotiated the subagent RFD — the one thing that
     decides if `announcesOwnSession` has anything to defer to. */
  subagentsRfd = false,
  callContext?: { cwd: string; model: string },
  /* The root loop's meter reading of the waits booked since the last request,
     for the lead on a step's first call. A subagent passes none. */
  takeWaits?: () => Partial<Record<WaitCause, number>>,
): Promise<StreamOutcome> {
  const outcome: StreamOutcome = {
    finishReason: "stop",
    aborted: false,
    error: undefined,
    text: "",
  };
  let messageId = randomUUID();
  let block = { kind: "" as "text" | "reasoning" | "", buffer: "" };
  /* One id per model request (`start-step`), stamped on every call it makes, so
     the client knows which calls were one response's parallel batch instead of
     guessing from their timing. Opaque: equal means "same request", nothing
     else, and it is never compared across turns. */
  let stepId = randomUUID();
  const stepMeta = () => ({ daedalus: { stepId } });
  /* Where the step's wait went, said once on its first visible call: the
     causes booked before it, the model's time to first output, and how long it
     wrote (prose, thinking) before the call opened. */
  let stepStartedAt = performance.now();
  let firstOutputAt: number | null = null;
  let waited: Partial<Record<WaitCause, number>> = {};
  let leadSent = false;
  const output = () => (firstOutputAt ??= performance.now());
  const leadMeta = () => {
    if (leadSent) return stepMeta();
    leadSent = true;
    const first = firstOutputAt ?? performance.now();
    const lead: StepLead = {
      ...waited,
      ttftMs: Math.round(first - stepStartedAt),
      writeMs: Math.round(performance.now() - first),
    };
    return { daedalus: { stepId, lead } };
  };
  /* Calls whose row was withheld, by id, so the result can be dropped and a
     failure can be sent whole. Keyed on the id `tool-input-start` carries,
     which is the `toolCallId` the later parts use. */
  const silenced = new Map<string, ToolMeta>();
  const silent = (m: ToolMeta): boolean => subagentsRfd && m.announcesOwnSession === true;

  /* `keepOpen` journals what has been written and leaves the block (and its
     `messageId`) standing. A tool call's `tool-input-start` is not the end of
     the prose around it: some gateways open a call while the text block is
     still streaming, and the deltas that follow belong to the same message.
     Closing there left them with no block to land in — streamed live, never
     journaled — and a `session/load` replayed the message cut short. The
     journal keeps the call between the two halves, as the live stream did. */
  const flushBlock = (keepOpen = false) => {
    if (block.kind && block.buffer) {
      emit.record({
        sessionUpdate: block.kind === "text" ? "agent_message_chunk" : "agent_thought_chunk",
        content: { type: "text", text: block.buffer },
        messageId,
      });
    }
    block = keepOpen && block.kind ? { kind: block.kind, buffer: "" } : { kind: "", buffer: "" };
  };

  try {
    for await (const part of result.fullStream) {
      switch (part.type) {
        case "text-start":
          output();
          flushBlock();
          messageId = randomUUID();
          block = { kind: "text", buffer: "" };
          break;
        /* An empty delta says nothing, and forwarding one is what drew an
           empty thought for a model that sends its thinking text-less. */
        case "text-delta":
          if (!part.text) break;
          block.buffer += part.text;
          outcome.text += part.text;
          await emit.transient({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: part.text },
            messageId,
          });
          break;
        case "reasoning-start":
          output();
          flushBlock();
          messageId = randomUUID();
          block = { kind: "reasoning", buffer: "" };
          break;
        case "reasoning-delta":
          if (!part.text) break;
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
        case "start-step":
          stepId = randomUUID();
          stepStartedAt = performance.now();
          firstOutputAt = null;
          waited = takeWaits?.() ?? {};
          leadSent = false;
          break;
        case "tool-input-start": {
          output();
          flushBlock(true);
          const m = metaFor(meta, part.toolName);
          if (silent(m)) {
            silenced.set(part.id, m);
            break;
          }
          await emit.update({
            sessionUpdate: "tool_call",
            toolCallId: part.id,
            title: m.title({}),
            name: part.toolName,
            kind: m.kind,
            status: "pending",
            _meta: leadMeta(),
          });
          break;
        }
        case "tool-call": {
          const m = metaFor(meta, part.toolName);
          if (silent(m)) {
            silenced.set(part.toolCallId, m);
            break;
          }
          await emit.update({
            sessionUpdate: "tool_call_update",
            toolCallId: part.toolCallId,
            title: m.title(part.input),
            status: "in_progress",
            rawInput: (part.input ?? {}) as Record<string, unknown>,
            locations: m.locations?.(part.input) ?? [],
            _meta: stepMeta(),
          });
          break;
        }
        case "tool-result": {
          if (silenced.delete(part.toolCallId)) break;
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
          const content = [
            { type: "content" as const, content: { type: "text" as const, text: errorText(part.error) } },
          ];
          /* A silenced tool has no row on the client to fold an update into,
             so its failure arrives as the whole call — the one thing about it
             worth a row. */
          const quiet = silenced.get(part.toolCallId);
          silenced.delete(part.toolCallId);
          if (callContext) {
            try {
              emit.logToolError({
                timestamp: new Date().toISOString(),
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                cwd: callContext.cwd,
                model: callContext.model,
                input: part.input,
                error: errorDetails(part.error),
              });
            } catch (logError) {
              process.stderr.write(`could not write tool error log: ${errorText(logError)}\n`);
            }
          }
          await emit.update(
            quiet
              ? {
                  sessionUpdate: "tool_call",
                  toolCallId: part.toolCallId,
                  title: quiet.title(part.input),
                  name: part.toolName,
                  kind: quiet.kind,
                  status: "failed",
                  content,
                  _meta: stepMeta(),
                }
              : {
                  sessionUpdate: "tool_call_update",
                  toolCallId: part.toolCallId,
                  status: "failed",
                  content,
                },
          );
          break;
        }
        case "finish-step": {
          const stepUsage = normalizeUsage(part.usage);
          const used = totalOf(stepUsage);
          /* ponytail: lags by whatever is appended after the last model reply —
             the final step's tool results, the next user message — since only a
             request reports. The output reserve in `windowFor` absorbs it;
             add a tokenizer only if a real turn is seen overflowing. */
          if (contextOf) contextOf.lastTokens = used;
          /* Per-step, because a turn's total hides where the cache was lost:
             a run that misses on one step of thirteen and a run that misses on
             all thirteen add up to different totals but to the same story, and
             only the step series says which happened. ACP has no field for it,
             so it rides `_meta` — journaled with the event, which is what makes
             a cold step answerable by a query instead of a reconstruction.
             `_meta.cache` is the provider's own counters, exact. */
          const cacheRead = stepUsage.inputTokenDetails?.cacheReadTokens ?? null;
          const cacheWrite = stepUsage.inputTokenDetails?.cacheWriteTokens ?? null;
          const window = windowFor(env, modelId);
          const cache =
            cacheRead === null && cacheWrite === null
              ? null
              : { read: cacheRead, write: cacheWrite, prompt: stepUsage.inputTokens ?? null };
          /* `size` is required by the schema and there is no way to say "I do
             not know", so an unknown window ships the fallback and says so
             beside it — the client draws the reading as approximate rather
             than as a percentage of a number nobody measured. */
          const usageMeta = {
            ...(cache ? { cache } : {}),
            /* The step's own bill in `acp.Usage` shape, so a reader can keep a
               running total while the turn is still going instead of waiting
               for `turn_ended` — which still carries the authoritative sum. */
            daedalus: { step: toAcpUsage(stepUsage), ...(window.known ? {} : { windowEstimated: true }) },
          };
          await emit.update({
            sessionUpdate: "usage_update",
            used,
            size: window.size,
            _meta: Object.keys(usageMeta).length > 0 ? usageMeta : undefined,
          });
          break;
        }
        case "finish":
          outcome.finishReason = part.finishReason;
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

/* Whether the client is listening to the subagent RFD. Read in two places —
   the spawn itself, and the gate that withholds an `announcesOwnSession`
   tool's row — and they must agree: a row withheld for a card that was never
   sent is a child that ran invisibly. */
function subagentsNegotiated(deps: TurnDeps): boolean {
  return Boolean((deps.clientCaps() as { subagents?: unknown } | null)?.subagents);
}

/* The two callbacks every model-call site passes: `record` is the site's own
   metering (the turn's meter and whatever it adds — a span, a child's attempt
   meter), and the tracer turns the same call into a `_daedalus/model_call` on
   `emit` — the child's emitter for a subagent, so the record lands on the
   child's session. Returned to the SDK, which awaits it: the record is in the
   journal before the step's tools run, so it can never land after its turn. */
function traced(
  tracer: Tracer,
  emit: Emitter,
  who: ModelCall["who"],
  record: (call: CallMetering) => void,
  opts: { childId?: string; sections?: SystemSection[] } = {},
): CallHooks {
  return {
    onLanguageModelCallStart: tracer.start,
    onLanguageModelCallEnd: (call) => {
      record(call);
      return emit.update({ sessionUpdate: "_daedalus/model_call", call: tracer.end(call, who, opts) });
    },
  };
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
  toolCallId: string,
  name: string,
  prompt: string,
  /** The turn's tracer: the child's calls are its records too, on the child's
      session id. */
  tracer: Tracer,
  /** Every model call the child makes, as it answers, whatever becomes of the
      attempt — the parent turn's answer is the one figure a reader sees, and a
      turn that spent most of its budget in three children reported only the
      root's. */
  reportCall: (call: CallMetering) => void,
  existingId?: string,
  /** The model the child runs on — the `task` tool's `role`/`model` resolved to
      an id. Absent, the session model (today's behaviour). Its context window
      is read off `env.modelWindows` like any other model, so a child on a role
      is measured against the window it actually runs in. */
  modelId?: string,
  /** The role that named `modelId`, when one did — saved and announced. */
  role?: string,
): Promise<string> {
  const existing = existingId ? deps.store.subagent(session.id, existingId) : null;
  if (existingId && !existing) throw new Error(`No saved subagent named or identified by '${existingId}'.`);
  /* The one id every reading below is taken against — the request's model, the
     window it is measured with, and the model the transcript names. Resolved
     once so the three cannot disagree. A follow-up runs where the child was
     spawned: a message to the advisor is still the advisor's. */
  const childModel = modelId ?? existing?.model ?? session.modelId;
  const childRole = existing?.role ?? role;
  const childId = existing?.id ?? randomUUID();
  if (!deps.store.claimSubagent(session.id, childId)) {
    throw new Error(`Subagent '${existing?.name ?? name}' is already running; wait for it to stop before messaging it.`);
  }
  const rfd = subagentsNegotiated(deps);
  const childName = existing?.name ?? name;
  const task = existing?.task ?? prompt;
  if (!existing) {
    deps.store.createSubagent(session.id, {
      id: childId,
      name: childName,
      task,
      status: "running",
      model: childModel,
      role: childRole,
    });
  } else {
    deps.store.setSubagentStatus(session.id, childId, "running");
  }
  if (rfd) {
    await parentEmit.update({
      sessionUpdate: "subagent_spawned",
      subagentSessionId: childId,
      name: childName,
      task: task.length > 500 ? `${task.slice(0, 500)}…` : task,
      /* What the child runs on, for its row: ACP's spawn names no model. */
      _meta: { daedalus: { parentToolUseId: toolCallId, model: childModel, role: childRole, prompt: task } },
    });
  }
  const childEmit = parentEmit.asChild(childId, rfd);
  const rt: ToolRuntime = {
    ctx,
    session,
    emit: childEmit,
    clientCaps: deps.clientCaps(),
    env: deps.env,
    runSubagent: () => Promise.reject(new Error("subagents cannot launch subagents")),
    listSubagents: () => [],
    sendMessage: () => Promise.reject(new Error("subagents cannot message sibling agents")),
  };
  const { tools, meta } = buildTools(rt, { subagent: true });
  let messages: ModelMessage[] = existing?.messages.length
    ? [...existing.messages, { role: "user", content: prompt }]
    : [{ role: "user", content: prompt }];
  childEmit.record({
    sessionUpdate: "user_message_chunk",
    content: { type: "text", text: prompt },
    messageId: randomUUID(),
  });
  const deferral = deferMcpTools(tools, messages);
  if (!existing) deps.store.appendSubagentMessages(session.id, childId, messages);
  else deps.store.appendSubagentMessages(session.id, childId, [{ role: "user", content: prompt }]);

  try {
    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_STREAM_RETRIES; attempt++) {
      if (attempt > 0) {
        const delayMs = retryDelayMs(lastError, attempt);
        process.stderr.write(`subagent stream retry ${attempt}/${MAX_STREAM_RETRIES} in ${delayMs}ms\n`);
        await sleep(delayMs, undefined, { signal: session.abort?.signal }).catch(() => {});
        if (session.abort?.signal.aborted) throw lastError;
      }

      const sections = systemSections(session, deps.env, { subagent: true, toolNames: deferral?.base ?? Object.keys(tools) });
      const system = sections.map((part) => part.text).join("\n\n");
      let settled: ModelMessage[] = [];
      /* This attempt's own bill, for the child's card; each call also goes to
         the parent's meter, which is the turn's. */
      const attemptMeter = new Meter();
      const result = streamText({
        model: deps.makeModel(deps.env, childModel),
        system,
        messages,
        tools,
        abortSignal: session.abort?.signal,
        maxRetries: 0,
        stopWhen: stepCountIs(MAX_STEPS),
        reasoning: session.effort ?? undefined,
        maxOutputTokens: deps.env.maxOutputTokens ?? undefined,
        repairToolCall: makeRepairToolCall({ readFiles: session.readFiles }),
        providerOptions: stepOptions(deps.env, session.id, childModel, session.effort),
        ...traced(tracer, childEmit, "subagent", (call) => {
          attemptMeter.record(call);
          reportCall(call);
        }, { childId, sections }),
        onError: () => {},
        onStepEnd: async (step) => {
          const candidate = [...settled, ...(step.response.messages as ModelMessage[])];
          const safe = settledPrefix(candidate);
          if (safe.length !== candidate.length) return;
          const delta = candidate.slice(settled.length);
          settled = candidate;
          deps.store.appendSubagentMessages(session.id, childId, delta);
        },
        /* A subagent pauses with its parent: the Codex thread-tree issue's
           complaint is exactly a root held while its collaborators keep
           spending, so the child's steps pass the same gate. */
        prepareStep: async () => {
          await session.gate(session.abort?.signal);
          return {};
        },
      });

      try {
        const outcome = await pumpStream(
          result,
          childEmit,
          meta,
          deps.env,
          childModel,
          null,
          rfd,
          { cwd: session.cwd, model: childModel },
        );
        const attemptUsage = toAcpUsage(attemptMeter.usage);
        if (rfd && attemptUsage) {
          await parentEmit.update({
            sessionUpdate: "_daedalus/subagent_usage",
            subagentSessionId: childId,
            usage: attemptUsage,
          });
        }
        if (outcome.error !== undefined) {
          if (isRetriableStreamError(outcome.error) && attempt < MAX_STREAM_RETRIES && !session.abort?.signal.aborted) {
            lastError = outcome.error;
            messages = [...messages, ...settled];
            if (settled.length > 0) deps.store.appendSubagentMessages(session.id, childId, settled);
            settled = [];
            continue;
          }
          throw outcome.error;
        }
        if (outcome.aborted) throw new Error("subagent cancelled");
        const generated = (await result.responseMessages) as ModelMessage[];
        const complete = settledPrefix(generated);
        if (complete.length > settled.length) {
          const delta = complete.slice(settled.length);
          settled = complete;
          deps.store.appendSubagentMessages(session.id, childId, delta);
        }
        messages = [...messages, ...settled];
        const report = outcome.text.trim() || "(the subagent produced no report)";
        deps.store.setSubagentStatus(session.id, childId, "completed");
        if (rfd) {
          await parentEmit.update({
            sessionUpdate: "subagent_state_update",
            subagentSessionId: childId,
            state: "completed",
          });
        }
        return report.length > SUBAGENT_REPORT_LIMIT ? `${report.slice(0, SUBAGENT_REPORT_LIMIT)}…` : report;
      } catch (err) {
        if (isRetriableStreamError(err) && attempt < MAX_STREAM_RETRIES && !session.abort?.signal.aborted) {
          lastError = err;
          messages = [...messages, ...settled];
          if (settled.length > 0) deps.store.appendSubagentMessages(session.id, childId, settled);
          settled = [];
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  } catch (err) {
    const status = session.abort?.signal.aborted ? "stopped" : "failed";
    deps.store.setSubagentStatus(session.id, childId, status);
    if (rfd) {
      await parentEmit.update({
        sessionUpdate: "subagent_state_update",
        subagentSessionId: childId,
        state: status === "stopped" ? "cancelled" : "failed",
      });
    }
    throw err;
  } finally {
    deps.store.releaseSubagent(session.id, childId);
  }
}

export function systemPrompt(
  session: Session,
  env: AgentEnv,
  opts: { subagent?: boolean; toolNames?: string[] } = {},
): string {
  return systemSections(session, env, opts)
    .map((part) => part.text)
    .join("\n\n");
}

/** One block of the system prompt, named for the Tokens panel. Joined with a
    blank line they are the prompt byte for byte — splitting them changes
    nothing a provider's cache keys on. */
export interface SystemSection {
  name: string;
  text: string;
}

export function systemSections(
  session: Session,
  env: AgentEnv,
  opts: { subagent?: boolean; toolNames?: string[] } = {},
): SystemSection[] {
  const parts: SystemSection[] = [];
  const section = (name: string, text: string) => parts.push({ name, text });
  /* What is actually built for this turn, not what the prompt remembers being
     built. Plan mode strips every writing tool and a subagent strips `task`,
     and a prompt that names a tool the loop did not offer is a NoSuchToolError
     the model cannot see coming: "use bash for read-only commands" in plan
     mode, where bash is not there at all, is exactly how that failed. */
  const toolNames = opts.toolNames ?? [];
  const has = (name: string) => toolNames.length === 0 || toolNames.includes(name);
  section(
    opts.subagent ? "Subagent brief" : "Core instructions",
    opts.subagent
      ? "You are Daedalus Agent, running as a subagent on a delegated task. Complete the task and end with a concise report of what you did and found — your final message is all the caller sees."
      : `You are Daedalus Agent, a coding agent running in the Daedalus harness on the user's computer. The harness draws your tool calls, diffs and todos in a live transcript, and renders your text as GitHub-flavored markdown in a monospace terminal.

## General

- Answer from the tools you actually have rather than from product documentation you are guessing at, including when the user asks what you can do.
- Never generate or guess a URL unless you are confident it helps with the programming task. A URL the user gave you, or one you read out of a local file, is fine.
- Output text to talk to the user. Every character you write outside a tool call is shown to them; tools are for doing the work, never for saying something — not a shell command that echoes, not a file, not a code comment.
- Tool results and user messages may include <system-reminder> tags. They carry useful information and reminders, and are not part of the user's input or of the tool result.

## Personality

Concise, direct and friendly — a teammate, not a narrator.
- Prioritize technical accuracy over validating the user's beliefs. State facts, disagree when the facts say so, and skip superlatives, praise and emotional validation. Where there is uncertainty, go and find out rather than confirming what the user already thinks.
- Minimize output tokens while keeping the answer helpful, correct and complete. Address the task at hand and leave out tangents.
- Keep answers short. A question with a short answer gets a short answer — one word where one word is the answer — with no introduction, conclusion or restatement of the question. Avoid "The answer is…", "Here is the content of the file…", "Based on the information provided…" and "Here is what I will do next…". Work you actually performed is the exception: report what changed and why, at the length the change deserves, following "Presenting your work" below.
- Use emojis only if the user asks for them.
- If you cannot or will not do something, say so in a sentence or two without explaining what it could lead to, and offer the nearest thing you can do.

## Responsiveness

Before a batch of tool calls, send one short sentence saying what you are about to do and why. This is the running commentary of the session, and it is not the same thing as preamble on a final answer, which you do not write.
- Group related work into a single note: one line for a batch of reads, not one line per read.
- Present tense, specific, no filler: "Tracing where reconnects are booked before touching the socket." beats "Let me investigate."
- Build on what you have already said instead of restating the request.
- Skip it for a single trivial call, and never write one just to fill the silence.

## Planning

You have write_todos, and its list is drawn in the transcript for the user.
- Skip the plan for straightforward work — roughly the easiest quarter of tasks — and never write a single-step plan.
- Use it for multi-step, long-running or ambiguous work: short, verifiable steps, ordered, with no filler item like "explore the codebase".
- Keep exactly one item in progress, and mark an item completed the moment it is done rather than batching updates at the end.
- When the plan turns out to be wrong, rewrite it. A stale plan is worse than none.
- Close the plan before you finish: every item done, blocked with a one-sentence reason and the question it needs, or dropped with a reason. Never leave one in progress.
- Unless the plan is the deliverable you were asked for — plan mode, or an explicit "make me a plan" — never end a turn holding only a plan.

## Task execution

Keep going until the request is completely resolved. Finish the whole task before you hand it back.
- Understand the code before you change it: search for the existing pattern, read the range around it, and follow the conventions already there rather than importing your own.
- Match the fix to the cause. Trace the error or the behaviour the task names back to where it actually originates, and change that — not the first place its symptom shows, and not a workaround layered on top.
- Implement with the tools you have, in the smallest change that does the job, and make it whole: the edit, the call site it belongs to, and the name that now reads wrong all ship together.
- Do the work rather than asking about it. Treat a short task as sufficient direction and infer the rest by reading the repo.
- Bias to action: default to implementing with reasonable assumptions, and do not end a turn on a clarification unless you are truly blocked. Every turn should close with a concrete change or an explicit blocker and the one question that unblocks it.
- Persist to the end within the turn: carry the work through implementation, verification and a clear account of the outcome rather than stopping at analysis or a partial fix, unless the user pauses or redirects you.
- Watch for the loop: re-reading or re-editing the same files without clear progress is a signal to stop, say what you found, and ask what you need. Local checklists are fine; never spend a turn restating a plan instead of acting on it.
- Never commit unless the user explicitly asks. Committing uninvited reads as being out of control, even when the change is right.

## Code quality

- Act as a discerning engineer: correctness, clarity and reliability over speed. No risky shortcuts, speculative changes or hacks just to make something run — cover the root cause or the core ask, not the symptom or a narrow slice.
- Conform to the codebase's own conventions — patterns, helpers, naming, formatting — and say why if you must diverge.
- Complete the change across every surface it touches, so behaviour stays consistent rather than half-wired.
- Keep behaviour safe by default: preserve intended UX, and gate or flag an intentional behaviour change rather than letting it land silently.
- Handle errors tightly: no broad catch-all, no silent fallback that turns a failure into apparent success. Surface or propagate, following the repo's existing idiom.
- Read enough context before editing and batch the logical edits together, rather than thrashing with a run of micro-edits.
- Keep types honest: the build and type-check must pass, and casts like \`as any\` are a last resort, not a way to close a gap.
- Search for prior art before adding a helper: reuse or extract the shared one instead of a second copy.

## Working efficiently

Every step is a round trip — the model call, the tool call and its result are all sent again on the next one — so a task finished correctly in three steps is worth more than the same task in eight.
- Start at the decisive action: the read or the search that tells you what to do, rather than a survey of everything that might be related.
- Read the range a decision needs, not the whole file. Grep for the name, then read around the hit.
- Batch what is independent into one message — several reads, several greps, the status check and the diff — so the round trips overlap instead of queueing.
- When a call fails, read the error before repeating the call. A retry that changes nothing is a loop; change the argument, the path or the approach.
- Take the shortest correct path. Don't add a helper, an abstraction or a guard the task did not ask for.

## Testing your work

- Verify with the project's own tests or build when it has them. Never assume a framework or a script name — read the README or the package manifest and find out.
${has("bash") ? "- When the task is done, run the project's lint and typecheck commands (npm run lint, npm run typecheck, ruff, and so on) if you know them." : "- When the task is done, say which lint and typecheck commands should be run to check it — you cannot run them yourself this turn."} If you cannot find the right command, ask the user for it, and suggest writing it into AGENTS.md so the next session knows.
- Report what you actually ran. A check you skipped is said to be skipped; a failing test is quoted, not paraphrased away.

## Reviews

When the user asks for a review, it is a code review: find the bugs, risks, behavioural regressions and missing tests, and make the findings the body of the answer.
- Findings first, worst first, each with a file and line reference and enough of the code to see the problem.
- Then open questions and assumptions, then a short summary — and only after the findings. A summary that leads buries the one thing the reader asked for.
- Report nothing you cannot point at: if you found no issues, say so plainly and name the residual risks and the tests you did not run.

## Ambition vs. precision

- On a fresh, unconstrained task, be ambitious: pick a sensible design, build the whole thing and demonstrate it working.
- Inside an existing codebase, be precise: do what was asked, in the idiom already there, and leave unrelated code alone. A drive-by refactor the user did not ask for is a cost they have to review.
- Either way, do not silently narrow the scope. If part of the task is blocked, finish the rest and say what you left out.

## Working from what you already have

The conversation above is your memory of this session, and it is authoritative. Before you reach for a tool, check whether the answer is already in it.
- Do not re-read a file whose contents are already in this conversation, and do not re-run a search you have already run. The earlier result is still true unless something changed it.
- Something changed it means: you edited or wrote the file, a bash command you ran touched it, or the user says it changed. Then re-read only the part that moved — use \`offset\`/\`limit\` rather than pulling the whole file back.
- A tool call records its own result: if you just wrote or edited a file, do not read it back to confirm the tool did what it said — but a read is how you see the file as it stands now, and that is the version your next edit has to match.
- Read the range you need, not the file. When you are looking for one function, grep for it and read around the hit; a whole-file read to answer a one-line question is wasted context for the rest of the session.
- When the user follows up on work you just did, continue from what you already know instead of re-exploring the codebase from scratch. Re-establish context only for the parts of the repo this session has genuinely not seen.
- This is not a licence to guess. If a fact was never established here, or it was compacted away and you cannot see it, go and read it — the rule is "don't fetch twice", never "answer from memory you don't have".

## Tool usage

- Call independent tools in one message so they run in parallel; that includes independent bash commands, such as \`git status\` and \`git diff\`.
${
  has("bash")
    ? `- Prefer the specialized tool over a shell equivalent: read_file over cat/head/tail, edit_file over sed/awk, write_file over a heredoc or echo redirection, glob and grep over find and grep. Reserve bash for what genuinely needs a shell.
- Explain a non-trivial bash command as you run it — what it does and why — especially one that changes the user's system.`
    : `- Read with read_file and search with glob and grep. There is no shell this turn, so anything you would have reached for a command line to learn has to come from those three.`
}
${
  has("task")
    ? `- For broad exploration — a question that is not a needle query for one file, class or function — use the task tool instead of running the searches yourself. It keeps the search out of your context.
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

${
  has("edit_file")
    ? `## Editing constraints
- Default to ASCII when editing or creating files. Only introduce non-ASCII or other Unicode characters when there is a clear justification and the file already uses them.
- Add a comment only where it makes a non-obvious block easier to understand.
- Use edit_file for a change to part of a file and write_file only for a whole file. Read a file before you edit or overwrite it, and copy old_string out of what read_file returned — without its line-number prefix — rather than retyping it from memory: an edit fails when the text is not byte-for-byte what is on disk.
- Make old_string unique by including a line or two of surrounding context. Reach for replace_all only when you mean every occurrence.
- Scripting a mechanical change across many files (a rename, a codemod) through bash is fine, and often better than a long run of edits.

## Git and workspace hygiene
- You may be in a dirty git worktree.
    * Never revert existing changes you did not make unless the user asks — they are the user's.
    * If asked to commit or edit where there are unrelated changes in the same files, leave those changes alone.
    * If the changes are in files you have touched recently, read them carefully and work with them rather than reverting them.
    * If the changes are in unrelated files, ignore them.
- Do not amend commits unless asked.
- Never run a destructive command such as \`git reset --hard\` or \`git checkout --\` unless the user asked for it or approved it.`
    : "## Editing constraints\nNothing writes this turn. Do not describe an edit as made, and do not promise one you cannot make here."
}

## Frontend tasks

When doing frontend design tasks, avoid collapsing into bland, generic layouts. Aim for interfaces that feel intentional and deliberate.
- Typography: use expressive, purposeful fonts and avoid default stacks (Inter, Roboto, Arial, system).
- Color and look: choose a clear visual direction; define CSS variables; avoid purple-on-white defaults. No purple bias or dark mode bias.
- Motion: a few meaningful animations (page-load, staggered reveals) rather than generic micro-motions.
- Background: don't rely on a flat single color; use gradients, shapes or subtle patterns to build atmosphere.
- Overall: avoid boilerplate layouts and interchangeable UI patterns. Vary themes, type families and visual languages across outputs.
- Make sure the page loads properly on both desktop and mobile.
- Finish it: a layout left as a skeleton, a placeholder section or a stub handler is not done. Ship something in a working state the user can run and try, without inventing adjacent features or services around it.

Exception: inside an existing website or design system, preserve the established patterns, structure and visual language.

## Sharing progress updates

On a long task, say where you are as you go rather than going silent for many tool calls: what is done, what you found, what is next, in one or two sentences. Surface a surprise — a wrong assumption, a blocked step, a larger change than expected — when you hit it, not in the final message.

## Presenting your work and final message

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

### Final answer structure and style guidelines

- Plain text; CLI handles styling. Use structure only when it helps scannability.
- Headers: optional; short Title Case (1-3 words) wrapped in **…**; no blank line before the first bullet; add only if they truly help.
- Bullets: use - ; merge related points; keep to one line when possible; 4–6 per list ordered by importance; keep phrasing consistent.
- Monospace: backticks for commands/paths/env vars/code ids and inline examples; use for literal keyword bullets; never combine with **.
- Code samples or multi-line snippets should be wrapped in fenced code blocks; include an info string as often as possible.
- Structure: group related bullets; order sections general → specific → supporting; for subsections, start with a bolded keyword bullet, then items; match complexity to the task.
- Tone: collaborative, concise, factual; present tense, active voice; self‑contained; no "above/below"; parallel wording.
- Don'ts: no nested bullets/hierarchies; no ANSI codes; don't cram unrelated keywords; keep keyword lists short—wrap/reformat if long; avoid naming formatting styles in answers.
- Adaptation: code explanations → precise, structured with code refs; simple tasks → lead with outcome; big changes → logical walkthrough + rationale + next actions; casual one-offs → plain sentences, no headers/bullets.
- File and code references: name the location so the user can click through to it.
  * Use inline code to make file paths clickable, and give each reference a standalone path, even the same file twice.
  * Accepted: absolute, workspace‑relative, a/ or b/ diff prefixes, or bare filename/suffix.
  * Point at a function or a line with \`file_path:line_number\` (1‑based; \`:line[:column]\` or \`#Lline[Ccolumn]\`, column defaults to 1). Never a range of lines.
  * Do not use URIs like file://, vscode://, or https://.
  * Examples: src/app.ts, src/app.ts:42, b/server/index.js#L10, C:\\repo\\project\\main.rs:12:5
<example>
user: Where are errors from the client handled?
assistant: Clients are marked as failed in the \`connectToServer\` function in src/services/process.ts:712.
</example>`,
  );
  /* What engine is under the agent, and how that engine is best driven — an
     assigned row from the model-prompt library, else the built-in family
     calibration (agent/src/model-prompts.ts). Identity-adjacent and a fact
     about the runtime, so it sits ahead of the project's files and the persona,
     which are the choices made on top of the ground; byte-stable per model and
     library, so the prefix cache survives it. Resolved per turn off
     `session.modelId`, which is how a live model change swaps the guidance
     with no respawn. A session with no model (a spawn that never got one) is
     told nothing. */
  if (session.modelId) {
    section(
      "Model guidance",
      modelPromptLayer(
        session.modelId,
        env.modelPromptsFile ? loadModelPrompts(env.modelPromptsFile) : [],
      ),
    );
  }
  /* Drawn answers (the `openui-lang` lane) are not this runtime's to teach:
     the whole trailer, component table included, rides the persona door with
     every other thread-level behaviour (`server/src/personas.ts`), so this
     runtime is told exactly what any other on the profile is told. */
  /* Its own block, and pushed for a subagent as well as for a root turn.
     Every failure this section exists to stop — a call to a tool the turn did
     not build, two calls' arguments run into one buffer, an `edit_file` that
     forgot its `path` — is a failure a subagent makes in exactly the same way,
     and it was only ever told the short brief. */
  if (toolNames.length) {
    section(
      "Tool guidance",
      `## Tools available to you
${toolNames.map((n) => `- ${n}`).join("\n")}

That list is exhaustive for this turn${toolNames.includes("search_tools") ? ", except for the held-back MCP tools search_tools can load" : ""}. A tool that is not on it does not exist here — do not call it, and do not tell the user you will. If something you need is missing, say so and use what you have.

## Calling tools correctly
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
    section(
      "Plan mode",
      `## Plan mode

You are in PLAN MODE. Every tool that can change anything — writing files, editing them, running shell commands, MCP tools — is not built for this turn: it is absent, not merely discouraged. ${
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
    section(
      "Workspace instructions",
      "Standing instructions for this workspace, from the files below. Follow them as though the user had written them here; anything the user says directly in this conversation wins over them.",
    );
    /* One section per file, so the panel can say which file is the heavy one. */
    for (const block of instructions) {
      const head = block.slice(0, block.indexOf(":\n"));
      section(`Instructions: ${head.replace(/^Instructions from /, "")}`, block);
    }
  }
  if (session.personaText) section("Persona", session.personaText.trim());
  if (session.skills.length && !opts.subagent) {
    const listing = session.skills
      .map((s) => `- ${s.name}: ${s.description || "(no description)"} — ${s.path}`)
      .join("\n");
    section(
      "Skills",
      `Skills available in this workspace (read the SKILL.md before relying on one):\n${listing}`,
    );
  }
  /* What each connected server says about how it wants to be used — the
     spec's `instructions`, which a client is meant to put in front of the
     model. Tool descriptions say what one tool does; this says how they fit. */
  for (const { server, text } of session.mcp?.instructions ?? []) {
    section(`MCP instructions: ${server}`, `Instructions from the ${server} MCP server:\n${text}`);
  }
  const failures = session.mcp?.failures ?? [];
  if (failures.length) {
    section("MCP failures", `These MCP servers failed to start and their tools are unavailable:\n${failures.join("\n")}`);
  }
  /* Last, and deliberately so. Prompt caching keys on an exact byte-for-byte
     prefix: a single changed byte near the front of the prompt invalidates
     the whole cached prefix — system, tools, and every instruction block ahead
     of it. So the one part of the system prompt that is genuinely fresh every
     turn (hostname and today's date, plus a cwd that differs from repo to
     repo) is pinned to the very end, keeping the identity, persona, skills and
     instructions that precede it byte-identical and therefore cacheable. */
  section(
    "Environment",
    `WorkDir: ${session.cwd} | Platform: ${platform()} (${hostname()}) | Date: ${new Date().toDateString()}`,
  );
  return parts;
}

function settleParked(session: Session, settle: (p: Parked) => void): void {
  const parked = parkedBySession.get(session);
  if (!parked) return;
  parkedBySession.delete(session);
  for (const p of parked) settle(p);
}

/* The two renderings of one ACP prompt, walked once. `promptText` is the
   plain-text projection — the session title, the journaled user bubble, the
   prose every consumer that cannot carry a binary needs. `promptContent` is
   the provider's: the same text, but `image`/`audio` blocks ride through as
   content parts instead of being flattened to nothing.

   They share the walk so a new block kind is handled in one place. The text
   halves are byte-identical between them, which is what lets the bridge's own
   `[attached: …]` suffix (already appended to the text block) stay the single
   description of a file in the prose. */
export function promptText(blocks: acp.ContentBlock[]): string {
  return promptParts(blocks)
    .filter((p): p is string => typeof p === "string")
    .join("\n")
    .trim();
}

function promptParts(blocks: acp.ContentBlock[]): (string | FilePart)[] {
  const parts: (string | FilePart)[] = [];
  for (const block of blocks) {
    if (block.type === "text") parts.push(block.text);
    else if (block.type === "resource_link") parts.push(`@${block.uri}`);
    else if (block.type === "resource" && "text" in block.resource) {
      parts.push(`<attached uri="${block.resource.uri}">\n${block.resource.text}\n</attached>`);
    } else if (block.type === "image") {
      /* The `file` part, not the deprecated `image` one (the SDK warns on it):
         a mediaType of `image/*` is what `createOpenAICompatible` turns into an
         `image_url` data URI. */
      parts.push({ type: "file", mediaType: block.mimeType, data: block.data });
    } else if (block.type === "audio") {
      parts.push({ type: "file", mediaType: block.mimeType, data: block.data });
    }
  }
  return parts;
}

/* A string when the prompt carries no binary — the AI SDK reads a lone-string
   user message the same way, and it keeps the persisted JSONL small and
   readable. With media it becomes parts: one text part holding the whole
   prose (the bridge's `[attached: …]` suffix included), then the images. */
function promptContent(blocks: acp.ContentBlock[], text: string): UserContent {
  const media = promptParts(blocks).filter((p): p is FilePart => typeof p !== "string");
  if (media.length === 0) return text;
  return [{ type: "text", text }, ...media];
}

/* The images and audio MCP tools returned since the last step, as one user
   message — or null. A model whose catalog entry names its modalities and
   leaves one out is not sent that kind (the tool's text already names what it
   returned); a model with no entry is, which is `delivery.ts`'s rule too: a
   catalog that lists modalities is a statement, and silence is not a no. */
function mediaMessage(session: Session, env: AgentEnv): ModelMessage | null {
  const pending = session.mcp?.media.splice(0) ?? [];
  const accepts = env.modelModalities[session.modelId];
  const shown = pending.filter((m) => !accepts || accepts.includes(m.mediaType.split("/")[0] ?? ""));
  if (shown.length === 0) return null;
  const tools = [...new Set(shown.map((m) => m.tool))].join(", ");
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: `[Media returned by ${tools}. A tool result carries text only, so it is attached here — this is not a message from the user.]`,
      },
      ...shown.map((m): FilePart => ({ type: "file", mediaType: m.mediaType, data: m.data })),
    ],
  };
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
function failedFinish(reason: string, stepCapped = false): Error | undefined {
  switch (reason) {
    case "tool-calls":
      /* The loop was cut by the step cap while the model still wanted tools:
         unfinished work, which used to end as a clean `end_turn`. */
      return stepCapped ? new Error(`the turn hit the ${MAX_STEPS}-step limit before the work was done`) : undefined;
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

/* The spend a failed turn still has to report, attached to the error the
   harness reads it back from (`data.daedalus`, the server's `settleTurn`).
   A plain `Error` becomes an internal-error `RequestError` with the same
   message, which is what the SDK would have made of it on the wire. */
function withSpend(err: unknown, meter: Meter): unknown {
  const usage = toAcpUsage(meter.usage);
  if (!usage) return err;
  const generation = meter.reading();
  const spend = { daedalus: { usage, ...(generation ? { generation } : {}) } };
  if (err instanceof acp.RequestError) {
    err.data = { ...(err.data && typeof err.data === "object" ? err.data : {}), ...spend };
    return err;
  }
  const wrapped = new acp.RequestError(-32603, err instanceof Error ? err.message : String(err), spend);
  if (err instanceof Error) wrapped.stack = err.stack;
  return wrapped;
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

function errorDetails(error: unknown): {
  name: string;
  message: string;
  stack?: string;
  cause?: unknown;
  details?: Record<string, unknown>;
} {
  if (!(error instanceof Error)) {
    const detail = safeErrorValue(error);
    return {
      name: typeof error,
      message: typeof detail === "string" ? detail : JSON.stringify(detail) ?? String(detail),
    };
  }
  const cause = (error as Error & { cause?: unknown }).cause;
  return {
    name: error.name,
    message: error.message,
    ...(error.stack ? { stack: error.stack } : {}),
    ...(cause === undefined ? {} : { cause: safeErrorValue(cause) }),
    details: Object.fromEntries(
      Object.entries(error).map(([key, value]) => [key, safeErrorValue(value)]),
    ),
  };
}

function safeErrorValue(value: unknown): unknown {
  if (value instanceof Error) return errorDetails(value);
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? String(value) : JSON.parse(encoded);
  } catch {
    return String(value);
  }
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

/* The SDK's `RetryError` wraps the failure that actually happened; every
   reading of a failure — retriable or not, what to tell the user — is of
   the inner one. Defensive now that `maxRetries` is 0, cheap to keep. */
function unwrapRetry(err: unknown): unknown {
  return err instanceof Error && err.name === "AI_RetryError"
    ? ((err as { lastError?: unknown }).lastError ?? err)
    : err;
}

function isRetriableStreamError(err: unknown): boolean {
  err = unwrapRetry(err);
  if (!(err instanceof Error)) return false;
  /* A wall that will still be there in thirty seconds is held at once — the
     five-hour usage cap, an exhausted quota, a key that stopped working. A
     provider sends these as 429/403 too, and retrying into one only costs the
     user the wait before the same hold. */
  if (/usage limit|quota|insufficient|billing|unauthori[sz]ed|invalid api key/i.test(err.message)) return false;
  /* A 400 is the provider saying the request itself is wrong — a bad model id,
     a `max_tokens` above its ceiling. The same bytes sent again get the same
     answer, so four backoffs only put a minute in front of the hold. */
  if ((err as { statusCode?: number }).statusCode === 400) return false;
  /* A relay that passes an upstream 400 through under its own 503 defeats the
     status check above, and its `retry-after` then books four rounds of the
     same rejection before the hold. The upstream's words survive the relay, so
     a request the text itself calls invalid is held like the 400 it is. */
  if (/\[400\]|(?:bad|invalid) request/i.test(err.message)) return false;
  if (err.name === "AI_InvalidResponseDataError") return true;
  if (err.name === "AI_APICallError" && (err as { isRetryable?: boolean }).isRetryable) return true;
  return /ECONNRESET|EPIPE|ETIMEDOUT|socket hang up|network|fetch failed|terminated/i.test(err.message);
}

/* Exponential backoff, floored by the provider's own Retry-After where it
   sends one and capped so a bad header cannot park the turn for an hour. */
function retryDelayMs(err: unknown, attempt: number): number {
  const backoff = STREAM_RETRY_BASE_MS * 2 ** (attempt - 1);
  const headers = (unwrapRetry(err) as { responseHeaders?: Record<string, string> } | null)?.responseHeaders;
  const retryAfterMs = headers?.["retry-after-ms"]
    ? parseFloat(headers["retry-after-ms"])
    : headers?.["retry-after"]
      ? parseFloat(headers["retry-after"]) * 1000
      : NaN;
  return Number.isFinite(retryAfterMs) && retryAfterMs >= 0
    ? Math.min(Math.max(retryAfterMs, backoff), STREAM_RETRY_MAX_MS)
    : backoff;
}
