/*
 * The seam between a thread and the task it was started on.
 *
 * `tasks-board.ts` stays standalone — it never learns what a thread is — and
 * `sessions.taskId` is a plain pointer with no foreign key. This file is the
 * one place that holds both ends: it reads the task for the spawn trailer
 * (`personas.ts`), says who an agent's write was (`threadActor`, also what the
 * harness loopback sends), and moves the card when the thread starts working.
 *
 * Completing a task is deliberately NOT here: a turn ending is not the work
 * being done, so closing it is the agent's call, made through `tasks_update`
 * on the instruction the trailer gives it.
 */
import { getBoard, getStatus, listStatuses } from "./boards.js";
import { getTask, record, updateTask } from "./tasks-board.js";
import { getAgent } from "./registry.js";
import type { Session } from "./sessions.js";

type Threaded = Pick<Session, "id" | "agentId" | "title" | "taskId">;

export interface TaskBrief {
  id: string;
  /** `WEB-12`. */
  key: string;
  title: string;
  /** The column the task is in now. */
  status: string;
  /** The board's columns, so the agent can move the card without a lookup. */
  columns: { id: string; name: string; category: string }[];
}

/** What a thread's agent is told about its task; undefined when the task is gone. */
export async function taskBrief(taskId: string | null | undefined): Promise<TaskBrief | undefined> {
  const task = taskId ? await getTask(taskId) : undefined;
  if (!task) return undefined;
  const [board, columns] = await Promise.all([getBoard(task.boardId), listStatuses(task.boardId)]);
  return {
    id: task.id,
    key: board && task.number ? `${board.key}-${task.number}` : task.id,
    title: task.title,
    status: columns.find((c) => c.id === task.statusId)?.name ?? task.statusId,
    columns: columns.map((c) => ({ id: c.id, name: c.name, category: c.category })),
  };
}

/** "Claude Code · thread title" — the author of a comment and the actor of an
    activity row, said by the harness so an agent cannot name itself. */
export async function threadActor(session: Pick<Session, "agentId" | "title">): Promise<string> {
  return `${(await getAgent(session.agentId))?.name ?? session.agentId} · ${session.title}`;
}

/** The thread was started on the task: one marker in the task's history. */
export async function noteThreadLinked(session: Threaded): Promise<void> {
  if (!session.taskId || !(await getTask(session.taskId))) return;
  await record(session.taskId, Date.now(), "thread", null, { sessionId: session.id }, await threadActor(session));
}

/** A turn began: a card still waiting in a to-do column moves to the board's
    first in-progress one. Anything else — already moving, done, a board with no
    in-progress column — is left exactly where the person put it. */
export async function noteTurnStarted(session: Threaded): Promise<void> {
  if (!session.taskId) return;
  const task = await getTask(session.taskId);
  if (!task || (await getStatus(task.statusId))?.category !== "todo") return;
  const next = (await listStatuses(task.boardId)).find((c) => c.category === "in_progress");
  if (next) await updateTask(task.id, { statusId: next.id }, await threadActor(session));
}
