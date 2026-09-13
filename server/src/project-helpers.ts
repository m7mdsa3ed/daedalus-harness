import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, projectHelpers as helpersTable } from "./db/index.js";

/**
 * A project's helper commands — the small shell actions a person runs against
 * this workspace from its page's header ("Restart server", "Run migrations").
 * They are the user's own buttons, not the library's: nothing here reaches an
 * agent, nothing is materialised into the cwd, and the rows die with the
 * project (`ON DELETE CASCADE`).
 *
 * **This module stores helpers; it does not run them.** A helper runs in a
 * terminal (`terminals.ts`) — a PTY in a dock panel, opened by
 * `POST /api/projects/:id/helpers/:helperId/terminal`. It used to be a
 * one-shot `spawn` whose captured output was posted back to a dialog, which
 * meant a command that asked anything — a `select an environment` prompt, a
 * password, a `[y/N]` — hung against a stdin that was never coming and then
 * died at the two-minute timeout with the question as its last line. A PTY is
 * the thing that can be answered, and the terminal panel is where the harness
 * already knows how to draw one, so a helper is now a terminal that starts
 * with its command typed in. That is why there is no timeout here either: the
 * terminal's own detach grace and idle sweep bound it, and a countdown that
 * kills a program *while it is waiting for the user's answer* is not a
 * setting, it is a bug.
 */

export const HelperInputSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  /** Project-relative directory to run in; absent/empty = the project's cwd. */
  cwd: z.string().nullish(),
  /** Extra environment variables layered over the server's own. */
  env: z.record(z.string(), z.string()).nullish(),
  description: z.string().nullish(),
  confirm: z.boolean().nullish(),
  /** This helper starts the project's dev server — the command the Browser
      panel offers when a preview URL is set but nothing answers on it. */
  preview: z.boolean().nullish(),
});
export type HelperInput = z.infer<typeof HelperInputSchema>;

export interface HelperCommand {
  id: string;
  projectId: string;
  name: string;
  command: string;
  cwd: string | null;
  env: Record<string, string> | null;
  description: string | null;
  confirm: boolean;
  /** True when this helper is the one that starts the dev server. */
  preview: boolean;
  createdAt: number;
}

/** The row stores `env` as JSON text; a row a hand or an old bundle mangled
    degrades to "no extra env" rather than taking the read down. */
const parseEnv = (text: string | null): Record<string, string> | null => {
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) if (typeof v === "string") out[k] = v;
    return Object.keys(out).length > 0 ? out : null;
  } catch {
    return null;
  }
};

const rowToHelper = (row: typeof helpersTable.$inferSelect): HelperCommand => ({
  id: row.id,
  projectId: row.projectId,
  name: row.name,
  command: row.command,
  cwd: row.cwd,
  env: parseEnv(row.env),
  description: row.description,
  confirm: row.confirm,
  preview: row.preview === true,
  createdAt: row.createdAt,
});

/** Trim and fold the wire input into the stored shape — one place, so add and
    update cannot drift. An empty cwd/description/env means null, not "". */
const toColumns = (input: HelperInput) => ({
  name: input.name.trim(),
  command: input.command.trim(),
  cwd: input.cwd?.trim() || null,
  env:
    input.env && Object.keys(input.env).length > 0
      ? JSON.stringify(
          Object.fromEntries(
            Object.entries(input.env).filter(([k]) => k.trim().length > 0),
          ),
        )
      : null,
  description: input.description?.trim() || null,
  confirm: input.confirm === true,
  preview: input.preview === true,
});

export async function listHelpers(projectId: string): Promise<HelperCommand[]> {
  return await (await db
    .select()
    .from(helpersTable)
    .where(eq(helpersTable.projectId, projectId)))
    
    .map(rowToHelper)
    .sort((a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name));
}

/** Every project's helpers, grouped — one query for the project list, which
    embeds them, rather than one per project. */
export async function helpersByProject(projectIds: string[]): Promise<Map<string, HelperCommand[]>> {
  const out = new Map<string, HelperCommand[]>();
  if (projectIds.length === 0) return out;
  const rows = await (await db
    .select()
    .from(helpersTable)
    .where(inArray(helpersTable.projectId, projectIds)))
    
    .map(rowToHelper)
    .sort((a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name));
  for (const row of rows) out.set(row.projectId, [...(out.get(row.projectId) ?? []), row]);
  return out;
}

export async function getHelper(projectId: string, helperId: string): Promise<HelperCommand | undefined> {
  const row = (await db
    .select()
    .from(helpersTable)
    .where(and(eq(helpersTable.projectId, projectId), eq(helpersTable.id, helperId)))
    .limit(1))[0];
  return row ? rowToHelper(row) : undefined;
}

export async function addHelper(projectId: string, input: HelperInput): Promise<HelperCommand> {
  const id = randomUUID();
  await db.insert(helpersTable)
    .values({ id, projectId, ...toColumns(input), createdAt: Date.now() });
  return (await getHelper(projectId, id))!;
}

export async function updateHelper(
  projectId: string,
  helperId: string,
  input: HelperInput,
): Promise<HelperCommand | undefined> {
  const changed = ((await db
    .update(helpersTable)
    .set(toColumns(input))
    .where(and(eq(helpersTable.projectId, projectId), eq(helpersTable.id, helperId)))
    ).rowCount ?? 0);
  return changed > 0 ? getHelper(projectId, helperId) : undefined;
}

export async function deleteHelper(projectId: string, helperId: string): Promise<boolean> {
  return (
    ((await db
      .delete(helpersTable)
      .where(and(eq(helpersTable.projectId, projectId), eq(helpersTable.id, helperId)))
      ).rowCount ?? 0) > 0
  );
}
