/*
 * What happens to a routine run's answer once its turn has settled.
 *
 * A transcript nobody opens is not a result, and a routine whose only outlet is
 * one more thread in a list is one people stop reading inside a week. So a
 * routine carries `onFinish` actions — optional, plural, ordered — and every
 * kind here is built out of something the harness already has: the push the
 * turn-end hook already sends, `knowledge.ts`, `boards.ts`, and the fire path
 * itself pointed back at ourselves.
 *
 * Two rules hold for all of them, and they are the reason this is a module of
 * its own rather than a switch inside the engine's settle path.
 *
 * **An action's failure is recorded on the run and never fails the run.** The
 * work already happened — the agent ran, the answer exists, the transcript is
 * readable. A knowledge base that was mid-write or a board whose column was
 * deleted since must not turn a completed overnight review into a red row, or
 * the status stops meaning anything about the work and starts meaning something
 * about the plumbing.
 *
 * **Actions run at most once per run**, from the one settle hook, before the
 * run's thread is retired. The engine calls this exactly once and stores what
 * comes back; nothing here retries, because a retry of `task` is a duplicate
 * card and a retry of `routine` is a second agent.
 *
 * The two outside effects — sending a push, firing another routine — arrive as
 * callbacks rather than imports. `Push` is constructed in `index.ts` with the
 * install's FCM config and the engine is constructed there too, so injecting it
 * costs one line and buys this module a test that needs neither; and taking
 * `fire` as a callback is what keeps the cycle out (the engine imports this, so
 * this must not import the engine).
 */
import { firstStatusId } from "./boards.js";
import { addKnowledge } from "./knowledge.js";
import { createTask } from "./tasks-board.js";
import type { RoutineAction, RoutineActionRecord } from "./db/index.js";

/** How much of a run's prose a knowledge entry or a task note may carry.
    `knowledge.ts` caps content at 50k and a task note at 2000 — both would
    *reject* an over-long write, which would record a failure about the size of
    a successful answer, so the text is cut here instead and said to be cut. */
const KNOWLEDGE_MAX = 50_000;
const NOTE_MAX = 2_000;
const TITLE_MAX = 500;

/** Everything an action can read about the run it is closing out. Deliberately
    the finished facts and not the engine: an action cannot reach back into the
    run it belongs to, which is what stops "file a card" from growing the power
    to restart the thread. */
export interface ActionContext {
  routineId: string;
  routineName: string;
  projectId: string;
  runId: string;
  /** The run's thread, so a notification can deep-link to it. Null only for a
      run that never got one, which never reaches here. */
  sessionId: string | null;
  /** The run's final prose. Empty when the agent said nothing, which is a real
      outcome and not a failure — the actions that need words say so below. */
  output: string;
  /** The parsed answer when the routine declared an `output` schema. */
  verdict: unknown;
  status: string;
}

export interface ActionDeps {
  /** Data-only push, exactly the shape `Push.send` takes. */
  notify: (title: string, body: string, data: Record<string, string>) => Promise<void>;
  /** Fire another routine with this run's prose as the untrusted payload. The
      engine passes its own `fire` bound with the chain depth already advanced. */
  fire: (routineId: string, text: string) => Promise<{ id: string }>;
}

/**
 * Run every action, in order, collecting one record each.
 *
 * Sequential rather than parallel on purpose: the records come back in the
 * order the user wrote them, which is the order the UI lists them, and two
 * actions that both write to the same board should not race for a position in
 * its first column.
 */
export async function runFinishActions(
  actions: RoutineAction[],
  ctx: ActionContext,
  deps: ActionDeps,
): Promise<RoutineActionRecord[]> {
  const records: RoutineActionRecord[] = [];
  for (const action of actions) {
    try {
      records.push({ kind: action.kind, ok: true, ...(await runOne(action, ctx, deps)) });
    } catch (error) {
      records.push({ kind: action.kind, ok: false, error: describe(error) });
    }
  }
  return records;
}

async function runOne(
  action: RoutineAction,
  ctx: ActionContext,
  deps: ActionDeps,
): Promise<{ ref?: string }> {
  switch (action.kind) {
    case "push": {
      /* The routine's name, not the thread's title. A run's thread is titled
         "<routine> · <when>", so a notification saying only the title would
         read as a timestamp on a phone's lock screen. `sessionId` is what the
         service worker's `notificationclick` routes on, so the notification
         opens the run rather than the app's root. */
      await deps.notify(
        `${ctx.routineName} finished`,
        firstLine(ctx.output) || `the run ${ctx.status}`,
        ctx.sessionId ? { sessionId: ctx.sessionId } : {},
      );
      return {};
    }
    case "knowledge": {
      /* The point of this one: a nightly routine accumulates something the
         *next* thread can read, in the project it ran in, through the same
         table the built-in `knowledge` MCP server reads. An empty answer is
         refused rather than written, because a knowledge base of blank entries
         is worse than one that missed a night — and `addKnowledge` would
         reject it anyway (its content minimum is 1), as a failure whose
         message says nothing about why. */
      const content = ctx.verdict !== undefined && ctx.verdict !== null
        ? JSON.stringify(ctx.verdict, null, 2)
        : ctx.output;
      if (!content.trim()) throw new Error("the run produced no answer to record");
      const entry = addKnowledge(ctx.projectId, {
        title: cut(action.title || ctx.routineName, TITLE_MAX),
        content: cut(content, KNOWLEDGE_MAX),
        tags: ["routine"],
      });
      return { ref: entry.id };
    }
    case "task": {
      /* "Review this repo overnight and tell me what needs doing" wants a card,
         not a transcript. The column is resolved the way every other board
         write resolves one — a named status wins, else the named board's first
         column, else the default board's — rather than hardcoding "todo",
         which is a seeded id a user is free to rename or delete. */
      const statusId = action.statusId ?? (action.boardId ? firstStatusId(action.boardId) : undefined);
      const task = createTask({
        title: cut(action.title || `${ctx.routineName}: ${firstLine(ctx.output) || ctx.status}`, TITLE_MAX),
        description: cut(ctx.output, NOTE_MAX * 4) || null,
        boardId: action.boardId,
        statusId,
        labels: ["routine"],
      });
      return { ref: task.id };
    }
    case "routine": {
      /* Chaining is not a new mechanism: it is the api trigger pointed at
         ourselves, so this run's prose arrives at the next routine inside the
         same untrusted `<routine-fire-payload>` wrapper any other caller's text
         does. Which matters more here than anywhere else — the text was written
         by a model, so treating it as instruction would be a model deciding
         what the next model is told to do. The engine's own chain-depth guard
         is what stops two routines naming each other from running forever. */
      if (!ctx.output.trim()) throw new Error("the run produced no answer to pass on");
      const run = await deps.fire(action.routineId, ctx.output);
      return { ref: run.id };
    }
  }
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  return cut(line.trim(), 200);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
