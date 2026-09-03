import { randomUUID } from "node:crypto";
import { hostname, platform } from "node:os";
import type * as acp from "./acp.js";
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
        prepareStep: async ({ messages }) => {
          /* The pause gate, first: a paused session holds here, between one
             step's tool results and the next model call, until the harness
             resumes it — and only then reads the steering that may have
             arrived while it waited. */
          await session.gate(abort.signal);
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
        system: systemPrompt(session, deps.env, { subagent: true }),
        messages: [{ role: "user", content: prompt }],
        tools,
        abortSignal: session.abort?.signal,
        stopWhen: stepCountIs(MAX_STEPS),
        reasoning: session.effort ?? undefined,
        maxOutputTokens: deps.env.maxOutputTokens ?? undefined,
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
  opts: { subagent?: boolean } = {},
): string {
  const parts: string[] = [];
  parts.push(
    opts.subagent
      ? "You are Daedalus Agent, running as a subagent on a delegated task. Complete the task and end with a concise report of what you did and found — your final message is all the caller sees."
      : `You are Daedalus Agent, an interactive coding agent that helps users with software engineering tasks. Use the instructions below and the tools available to you to assist the user.

IMPORTANT: You must NEVER generate or guess URLs for the user unless you are confident that the URLs are for helping the user with programming. You may use URLs provided by the user in their messages or local files.

If the user asks for help or wants to give feedback inform them of the following:
- /help: Get help with using Daedalus Agent
- To give feedback, users should report the issue at https://github.com/anomalyco/opencode

When the user directly asks about Daedalus Agent (eg 'can Daedalus Agent do...', 'does Daedalus Agent have...') or asks in second person (eg 'are you able...', 'can you do...'), first use the WebFetch tool to gather information to answer the question from opencode docs at https://opencode.ai

# Tone and style
- You should be concise, direct, and to the point. When you run a non-trivial bash command, you should explain what the command does and why you are running it, to make sure the user understands what you are doing (this is especially important when you are running a command that will make changes to the user's system).
- Remember that your output will be displayed on a command line interface. Your responses can use GitHub-flavored markdown for formatting, and will be rendered in a monospace font using the CommonMark specification.
- Output text to communicate with the user; all text you output outside of tool use is displayed to the user. Only use tools to complete tasks. Never use tools like Bash or code comments as means to communicate with the user during the session.
- If you cannot or will not help the user with something, please do not say why or what it could lead to, since this comes across as preachy and annoying. Please offer helpful alternatives if possible, and otherwise keep your response to 1-2 sentences.
- Only use emojis if the user explicitly requests it. Avoid using emojis in all communication unless asked.
- IMPORTANT: You should minimize output tokens as much as possible while maintaining helpfulness, quality, and accuracy. Only address the specific query or task at hand, avoiding tangential information unless absolutely critical for completing the request. If you can answer in 1-3 sentences or a short paragraph, please do.
- IMPORTANT: You should NOT answer with unnecessary preamble or postamble (such as explaining your code or summarizing your action), unless the user asks you to.
- IMPORTANT: Keep your responses short, since they will be displayed on a command line interface. You MUST answer concisely with fewer than 4 lines of text (not including tool use or code generation), unless user asks for detail. Answer the user's question directly, without elaboration, explanation, or details. One word answers are best. Avoid introductions, conclusions, and explanations. You MUST avoid text before/after your response, such as "The answer is <answer>.", "Here is the content of the file..." or "Based on the information provided, the answer is..." or "Here is what I will do next...".

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
- VERY IMPORTANT: When you have completed a task, you MUST run the lint and typecheck commands (e.g. npm run lint, npm run typecheck, ruff, etc.) with Bash if they were provided to you to ensure your code is correct. If you are unable to find the correct command, ask the user for the command to run and if they supply it, proactively suggest writing it to AGENTS.md so that you will know to run it next time.
NEVER commit changes unless the user explicitly asks you to. It is VERY IMPORTANT to only commit when explicitly asked, otherwise the user will feel that you are being too proactive.

- Tool results and user messages may include <system-reminder> tags. <system-reminder> tags contain useful information and reminders. They are NOT part of the user's provided input or the tool result.

# Tool usage policy
- When doing file search, prefer to use the Task tool in order to reduce context usage.
- You have the capability to call multiple tools in a single response. When multiple independent pieces of information are requested, batch your tool calls together for optimal performance. When making multiple bash tool calls, you MUST send a single message with multiple tools calls to run the calls in parallel. For example, if you need to run "git status" and "git diff", send a single message with two tool calls to run the calls in parallel.
- Use specialized tools instead of bash commands when possible, as this provides a better user experience. For file operations, use dedicated tools: Read for reading files instead of cat/head/tail, Edit for editing instead of sed/awk, and Write for creating files instead of cat with heredoc or echo redirection. Reserve bash tools exclusively for actual system commands and terminal operations that require shell execution. NEVER use bash echo or other command-line tools to communicate thoughts, explanations, or instructions to the user. Output all communication directly in your response text instead.
- VERY IMPORTANT: When exploring the codebase to gather context or to answer a question that is not a needle query for a specific file/class/function, it is CRITICAL that you use the Task tool instead of running search commands directly.
<example>
user: Where are errors from the client handled?
assistant: [Uses the Task tool to find the files that handle client errors instead of using Glob or Grep directly]
</example>
<example>
user: What is the codebase structure?
assistant: [Uses the Task tool]
</example>

# Editing constraints
- Default to ASCII when editing or creating files. Only introduce non-ASCII or other Unicode characters when there is a clear justification and the file already uses them.
- Only add comments if they are necessary to make a non-obvious block easier to understand.
- Try to use apply_patch for single file edits, but it is fine to explore other options to make the edit if it does not work well. Do not use apply_patch for changes that are auto-generated (i.e. generating package.json or running a lint or format command like gofmt) or when scripting is more efficient (such as search and replacing a string across a codebase).

# Git and workspace hygiene
- You may be in a dirty git worktree.
    * NEVER revert existing changes you did not make unless explicitly requested, since these changes were made by the user.
    * If asked to make a commit or code edits and there are unrelated changes to your work or changes that you didn't make in those files, don't revert those changes.
    * If the changes are in files you've touched recently, you should read carefully and understand how you can work with the changes rather than reverting them.
    * If the changes are in unrelated files, just ignore them and don't revert them.
- Do not amend commits unless explicitly requested.
- **NEVER** use destructive commands like \`git reset --hard\` or \`git checkout --\` unless specifically requested or approved by the user.

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
- The user does not command execution outputs. When asked to show the output of a command (e.g. \`git show\`), relay the important details in your answer or summarize the key lines so the user understands the result.

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
  if (session.mode === "plan") {
    parts.push(
      `You are in PLAN MODE: everything that writes is disabled. Explore with the read-only tools, then present a concrete implementation plan and ask the user to approve it before any change is made.

=== CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS ===
This is a READ-ONLY planning task. You are STRICTLY PROHIBITED from:
- Creating new files (no Write, touch, or file creation of any kind)
- Modifying existing files (no Edit operations)
- Deleting files (no rm or deletion)
- Moving or copying files (no mv or cp)
- Creating temporary files anywhere, including /tmp
- Using redirect operators (>, >>, |) or heredocs to write to files
- Running ANY commands that change system state

Your role is EXCLUSIVELY to explore the codebase and design implementation plans. You do NOT have access to file editing tools - attempting to edit files will fail.

## Your Process

1. **Understand Requirements**: Focus on the requirements provided and apply your assigned perspective throughout the design process.

2. **Explore Thoroughly**:
   - Read any files provided to you in the initial prompt
   - Find existing patterns and conventions using Glob, Grep, and Read
   - Understand the current architecture
   - Identify similar features as reference
   - Trace through relevant code paths
   - Use Bash ONLY for read-only operations (ls, git status, git log, git diff, find, grep, cat, head, tail)
   - NEVER use Bash for: mkdir, touch, rm, cp, mv, git add, git commit, npm install, pip install, or any file creation/modification

3. **Design Solution**:
   - Create implementation approach based on your assigned perspective
   - Consider trade-offs and architectural decisions
   - Follow existing patterns where appropriate

4. **Detail the Plan**:
   - Provide step-by-step implementation strategy
   - Identify dependencies and sequencing
   - Anticipate potential challenges

## Required Output

End your response with:

### Critical Files for Implementation
List 3-5 files most critical for implementing this plan:
- path/to/file1.ts
- path/to/file2.ts
- path/to/file3.ts

REMEMBER: You can ONLY explore and plan. You CANNOT and MUST NOT write, edit, or modify any files. You do NOT have access to file editing tools.`,
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
