/* ── `@KEY-12` task mentions ──
 *
 * A task from the board, mentioned in a message, reaches the agent as the task
 * itself: its fields, checklist, links, subtasks and recent comments, plus how
 * to work it through the `harness` MCP server.
 *
 * The composer asks for this at send (`POST /api/tasks/mention-context`) and
 * appends it to the message, the way it expands a long paste — so the
 * transcript holds exactly what the agent got, and the bubble folds the
 * `<tasks>` block back into a popover on the `@KEY-12` chip (`collapseTasks`,
 * client). It only asks when the thread carries the Harness MCP: the block
 * tells the agent to call it.
 */
import { getBoard, getSprint, listStatuses, type Board } from "./boards.js";
import { MENTION_RE, TRAILING } from "./mentions.js";
import { findTaskByKey, getTask, getTaskDetail, type Task } from "./tasks-board.js";

/** Board keys are stored upper-case (`BoardKey`); the composer chips the same shape. */
const TASK_KEY = /^[A-Z][A-Z0-9]{1,5}-\d+$/;
const MAX_TASKS = 10;
const MAX_DESCRIPTION = 8000;
const MAX_COMMENTS = 10;
const MAX_COMMENT = 1500;
const MAX_RELATED = 20;

/** Free text never closes the block it sits in — the bubble finds the block by its tags. */
const safe = (text: string) => text.replace(/<\/(tasks?)>/gi, "</ $1>");
const clip = (text: string, max: number) =>
  safe(text.length > max ? `${text.slice(0, max)}… (truncated — tasks_get has the rest)` : text);
const day = (ms: number | null) => (ms == null ? null : new Date(ms).toISOString().slice(0, 10));

/** The `@KEY-N` tokens in `text`, in order, deduplicated. */
export function taskMentionKeys(text: string): string[] {
  const keys = new Set<string>();
  for (const match of text.matchAll(MENTION_RE)) {
    const raw = match[1]!.replace(TRAILING, "");
    if (TASK_KEY.test(raw)) keys.add(raw);
  }
  return [...keys].slice(0, MAX_TASKS);
}

/**
 * The text to append to a prompt for every task it mentions, and the keys that
 * matched (so `mentionLinks` does not also look for them as files). An unknown
 * key is left alone; a failed read leaves the message as typed.
 */
export async function expandTaskMentions(text: string): Promise<{ text: string; keys: Set<string> }> {
  const keys = new Set<string>();
  const wanted = taskMentionKeys(text);
  if (wanted.length === 0) return { text: "", keys };
  try {
    const boards = new Map<string, Board | undefined>();
    const boardOf = async (id: string) => {
      if (!boards.has(id)) boards.set(id, await getBoard(id));
      return boards.get(id);
    };
    const keyOf = async (task: Task) => `${(await boardOf(task.boardId))?.key ?? "TASK"}-${task.number ?? "?"}`;
    const blocks: string[] = [];
    for (const key of wanted) {
      const found = await findTaskByKey(key);
      const detail = found && (await getTaskDetail(found.id));
      if (!detail) continue;
      keys.add(key);
      blocks.push(await taskBlock(key, detail, boardOf, keyOf));
    }
    if (blocks.length === 0) return { text: "", keys };
    return {
      text: [
        "",
        "",
        "<tasks>",
        `The message above mentions ${blocks.length === 1 ? "a task" : `${blocks.length} tasks`} from the harness task board. ${blocks.length === 1 ? "Its" : "Their"} full, current content is below, read as this message was sent — work from it directly; do not fetch ${blocks.length === 1 ? "it" : "them"} again, except with \`tasks_get\` {id} for a part marked truncated or omitted. Write back through the \`harness\` MCP server (\`harness_run\`): record progress with \`tasks_update\` {id, ...} (checklist, statusId); post findings with \`tasks_comment\` {id, body}; and when the work is finished, move the task to its board's done column with \`tasks_update\` {id, statusId}.`,
        ...blocks,
        "</tasks>",
      ].join("\n"),
      keys,
    };
  } catch (error) {
    console.log(`[task-mentions] ${wanted.join(", ")}: ${error instanceof Error ? error.message : String(error)}`);
    return { text: "", keys: new Set() };
  }
}

async function taskBlock(
  key: string,
  { task, comments, links, children }: NonNullable<Awaited<ReturnType<typeof getTaskDetail>>>,
  boardOf: (id: string) => Promise<Board | undefined>,
  keyOf: (task: Task) => Promise<string>,
): Promise<string> {
  const board = await boardOf(task.boardId);
  const columns = await listStatuses(task.boardId);
  const column = columns.find((s) => s.id === task.statusId);
  const done = columns.find((s) => s.category === "done");
  const ref = async (id: string) => {
    const other = await getTask(id);
    return other ? `${await keyOf(other)} "${other.title}" (id ${other.id})` : id;
  };
  const lines = [
    "",
    `<task key="${key}" id="${task.id}">`,
    `Title: ${safe(task.title)}`,
    `Type: ${task.type} · Priority: ${task.priority} · Status: ${column?.name ?? task.statusId} (statusId ${task.statusId})${task.completedAt ? ` · completed ${day(task.completedAt)}` : ""}`,
    `Board: ${board?.name ?? task.boardId} (${board?.key ?? "?"}) · Columns: ${columns.map((s) => `${s.name}=${s.id}${s.category === "done" ? " [done]" : ""}`).join(", ")}${done ? "" : " · no done column"}`,
  ];
  if (task.labels.length) lines.push(`Labels: ${task.labels.join(", ")}`);
  const custom = Object.entries(task.custom ?? {}).filter(([, value]) => value !== null && value !== "");
  if (custom.length) {
    const names = new Map((board?.customFields ?? []).map((f) => [f.id, f.name]));
    lines.push(`Custom fields: ${custom.map(([id, value]) => `${names.get(id) ?? id}=${JSON.stringify(value)}`).join(", ")}`);
  }
  if (task.assignees.length) lines.push(`Assignees: ${task.assignees.join(", ")}`);
  if (task.parentId) lines.push(`Parent: ${await ref(task.parentId)}`);
  if (task.sprintId) {
    const sprint = await getSprint(task.sprintId);
    lines.push(`Sprint: ${sprint ? `${sprint.name} (${sprint.state})` : task.sprintId}`);
  }
  const dates = [
    task.startAt != null && `start ${day(task.startAt)}`,
    task.dueAt != null && `due ${day(task.dueAt)}`,
    task.estimate != null && `estimate ${task.estimate} pt`,
    task.timeEstimate != null && `time estimate ${task.timeEstimate} min`,
    task.timeTracked != null && `tracked ${task.timeTracked} min`,
  ].filter(Boolean);
  if (dates.length) lines.push(`Schedule: ${dates.join(" · ")}`);
  lines.push(`Created ${day(task.createdAt)} · updated ${day(task.updatedAt)}`);
  if (task.description?.trim()) lines.push("Description:", clip(task.description.trim(), MAX_DESCRIPTION));
  else lines.push("Description: (none)");
  if (task.note?.trim()) lines.push(`Note: ${clip(task.note.trim(), MAX_COMMENT)}`);
  if (task.checklist.length) {
    lines.push("Checklist:", ...task.checklist.map((item) => `- [${item.done ? "x" : " "}] ${item.text} (id ${item.id})`));
  }
  if (children.length) {
    lines.push(`Subtasks${children.length > MAX_RELATED ? ` (first ${MAX_RELATED} of ${children.length}; tasks_get has the rest)` : ""}:`);
    for (const child of children.slice(0, MAX_RELATED)) {
      const state = columns.find((s) => s.id === child.statusId)?.name ?? child.statusId;
      lines.push(`- ${await keyOf(child)} [${state}] ${child.title} (id ${child.id})`);
    }
  }
  if (links.length) {
    lines.push(`Links${links.length > MAX_RELATED ? ` (first ${MAX_RELATED} of ${links.length}; tasks_get has the rest)` : ""}:`);
    for (const link of links.slice(0, MAX_RELATED)) {
      const outgoing = link.fromId === task.id;
      const verb =
        link.kind === "blocks" ? (outgoing ? "blocks" : "blocked by")
          : link.kind === "duplicates" ? (outgoing ? "duplicates" : "duplicated by")
            : "relates to";
      lines.push(`- ${verb} ${await ref(outgoing ? link.toId : link.fromId)}`);
    }
  }
  if (comments.length) {
    const recent = comments.slice(-MAX_COMMENTS);
    lines.push(
      recent.length < comments.length
        ? `Comments (latest ${recent.length} of ${comments.length}; ${comments.length - recent.length} earlier omitted, tasks_get has them):`
        : `Comments (${comments.length}):`,
    );
    for (const c of recent) lines.push(`- ${c.author ?? "someone"}, ${day(c.createdAt)}: ${clip(c.body.trim(), MAX_COMMENT)}`);
  }
  lines.push("</task>");
  return lines.join("\n");
}
