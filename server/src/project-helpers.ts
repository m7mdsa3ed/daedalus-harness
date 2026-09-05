import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, projectHelpers as helpersTable } from "./db/index.js";

/**
 * A project's helper commands — the small shell actions a person runs against
 * this workspace from its page's header ("Restart server", "Run migrations").
 * They are the user's own buttons, not the library's: nothing here reaches an
 * agent, nothing is materialised into the cwd, and the rows die with the
 * project (`ON DELETE CASCADE`). Run is a bounded one-shot shell in the
 * project's cwd — the same trust level as the project's terminals, with the
 * output capped so a chatty command cannot flood the browser.
 */

export const HelperInputSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
});
export type HelperInput = z.infer<typeof HelperInputSchema>;

export interface HelperCommand {
  id: string;
  projectId: string;
  name: string;
  command: string;
  createdAt: number;
}

const rowToHelper = (row: typeof helpersTable.$inferSelect): HelperCommand => ({
  id: row.id,
  projectId: row.projectId,
  name: row.name,
  command: row.command,
  createdAt: row.createdAt,
});

export function listHelpers(projectId: string): HelperCommand[] {
  return db
    .select()
    .from(helpersTable)
    .where(eq(helpersTable.projectId, projectId))
    .all()
    .map(rowToHelper)
    .sort((a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name));
}

/** Every project's helpers, grouped — one query for the project list, which
    embeds them, rather than one per project. */
export function helpersByProject(projectIds: string[]): Map<string, HelperCommand[]> {
  const out = new Map<string, HelperCommand[]>();
  if (projectIds.length === 0) return out;
  const rows = db
    .select()
    .from(helpersTable)
    .where(inArray(helpersTable.projectId, projectIds))
    .all()
    .map(rowToHelper)
    .sort((a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name));
  for (const row of rows) out.set(row.projectId, [...(out.get(row.projectId) ?? []), row]);
  return out;
}

export function getHelper(projectId: string, helperId: string): HelperCommand | undefined {
  const row = db
    .select()
    .from(helpersTable)
    .where(and(eq(helpersTable.projectId, projectId), eq(helpersTable.id, helperId)))
    .get();
  return row ? rowToHelper(row) : undefined;
}

export function addHelper(projectId: string, input: HelperInput): HelperCommand {
  const row = {
    id: randomUUID(),
    projectId,
    name: input.name.trim(),
    command: input.command.trim(),
    createdAt: Date.now(),
  };
  db.insert(helpersTable).values(row).run();
  return row;
}

export function updateHelper(
  projectId: string,
  helperId: string,
  input: HelperInput,
): HelperCommand | undefined {
  const changed = db
    .update(helpersTable)
    .set({ name: input.name.trim(), command: input.command.trim() })
    .where(and(eq(helpersTable.projectId, projectId), eq(helpersTable.id, helperId)))
    .run().changes;
  return changed > 0 ? getHelper(projectId, helperId) : undefined;
}

export function deleteHelper(projectId: string, helperId: string): boolean {
  return (
    db
      .delete(helpersTable)
      .where(and(eq(helpersTable.projectId, projectId), eq(helpersTable.id, helperId)))
      .run().changes > 0
  );
}

export interface HelperRunResult {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  output: string;
}

/** Longest a helper may run before its process group is killed. A helper is a
    quick action — a restart, a migration — not a place to host a server; the
    dev server the harness itself manages has its own controls. */
const RUN_TIMEOUT_MS = 120_000;
/** Tail kept of the combined output; the head is dropped with a marker, since
    what a failed command said last is what explains it. */
const MAX_OUTPUT = 16_000;

/** Run a helper's command in the project's cwd. A non-zero exit is a *result*
    (the route answers it 200 with `ok: false`), not a thrown error — the
    output is the answer, and the browser has the dialog to show it in. */
export function runHelperCommand(cwd: string, command: string): Promise<HelperRunResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    // A group leader, so the timeout can take down the shell *and* whatever it
    // started — a helper that hangs usually has a grandchild holding the pipe.
    const child = spawn(command, { cwd, shell: true, detached: true });

    let chunks: Buffer[] = [];
    let bytes = 0;
    let timedOut = false;
    const collect = (chunk: Buffer) => {
      chunks.push(chunk);
      bytes += chunk.length;
      // Keep the tail: drop whole chunks off the head once over the ceiling.
      while (bytes > MAX_OUTPUT && chunks.length > 1) {
        bytes -= chunks[0].length;
        chunks = chunks.slice(1);
      }
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    }, RUN_TIMEOUT_MS);

    const finish = (exitCode: number | null) => {
      clearTimeout(timer);
      let output = Buffer.concat(chunks).toString("utf8").trimEnd();
      if (bytes > MAX_OUTPUT) output = `… output truncated …\n${output.slice(-MAX_OUTPUT)}`;
      if (timedOut) output += `\n\n[killed after ${Math.round(RUN_TIMEOUT_MS / 1000)}s]`;
      resolve({
        ok: !timedOut && exitCode === 0,
        exitCode,
        timedOut,
        durationMs: Date.now() - started,
        output,
      });
    };

    child.on("error", (err) => {
      chunks.push(Buffer.from(`\n[failed to start: ${err.message}]`));
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}
