import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { db, modelRoles as modelRolesTable } from "./db/index.js";

/**
 * Model roles: the free-form, ordered vocabulary a profile's models tag
 * themselves with (`ModelDef.roles`), so a subagent is spawned on a role
 * (e.g. "small", "advisor") rather than a hardcoded model.
 *
 * Global — one list per server, edited in Settings, the shape `rules` takes.
 * Deliberately no `projectId`: a role is about what a model *is*, not where a
 * thread runs. The rows are only the vocabulary; the assignment is JSON on the
 * profile's models (`ModelDef.roles`), so no foreign key runs from an
 * assignment to a row and a deleted role leaves dangling tags every reader
 * ignores. `id` is what an assignment points at and is stable; `label` is what
 * a person reads, so a rename does not strand every tag. See docs/model-roles.md.
 */

/** A role row as stored. */
export interface ModelRole {
  id: string;
  label: string;
  description: string;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

/** One role on the wire. `id` is absent when a caller is adding a role and the
    server should mint one; it is required when replacing the vocabulary, where
    the id is what every assignment points at. */
export const ModelRoleInputSchema = z.object({
  id: z.string().min(1).optional(),
  label: z.string().min(1),
  description: z.string().optional().default(""),
  sortOrder: z.number().int().optional(),
});
export type ModelRoleInput = z.infer<typeof ModelRoleInputSchema>;

/** A whole vocabulary, as an ordered replace. */
export const ModelRolesInputSchema = z.array(ModelRoleInputSchema);

const now = () => Date.now();

/** All roles, ordered by sortOrder then creation. */
export async function listModelRoles(): Promise<ModelRole[]> {
  return await db
    .select()
    .from(modelRolesTable)
    .orderBy(asc(modelRolesTable.sortOrder), asc(modelRolesTable.createdAt));
}

/** Get a single role by id. */
export async function getModelRole(id: string): Promise<ModelRole | undefined> {
  return (await db.select().from(modelRolesTable).where(eq(modelRolesTable.id, id)).limit(1))[0];
}

/** Create a new role. Mints an id when the input names none. Returns the row. */
export async function addModelRole(input: ModelRoleInput): Promise<ModelRole> {
  const id = input.id ?? randomUUID();
  const t = now();
  const row: ModelRole = {
    id,
    label: input.label.trim(),
    description: input.description ?? "",
    sortOrder: input.sortOrder ?? 0,
    createdAt: t,
    updatedAt: t,
  };
  await db.insert(modelRolesTable).values(row);
  return row;
}

/** Update an existing role. Returns the updated row or undefined. */
export async function updateModelRole(
  id: string,
  input: Partial<ModelRoleInput>,
): Promise<ModelRole | undefined> {
  const set: Record<string, unknown> = {};
  if (input.label !== undefined) set.label = input.label.trim();
  if (input.description !== undefined) set.description = input.description;
  if (input.sortOrder !== undefined) set.sortOrder = input.sortOrder;
  set.updatedAt = now();
  const changed = ((await db.update(modelRolesTable).set(set).where(eq(modelRolesTable.id, id))).rowCount ?? 0);
  return changed > 0 ? getModelRole(id) : undefined;
}

/** Delete a role. Returns true if it existed. An assignment naming it is left
    dangling on purpose — the reader ignores an id no row answers for. */
export async function deleteModelRole(id: string): Promise<boolean> {
  return ((await db.delete(modelRolesTable).where(eq(modelRolesTable.id, id))).rowCount ?? 0) > 0;
}

/** Replace the whole vocabulary in one write — the ordered list a Settings save
    (or a bulk import) sends. Named rows keep their id (the thing every
    assignment points at); an unnamed one gets a fresh id, and a row the input
    does not name is deleted. Order is the input's, unless a row names its own
    `sortOrder`. Returns the vocabulary as stored. */
export async function setModelRoles(input: ModelRoleInput[]): Promise<ModelRole[]> {
  const t = now();
  await db.transaction(async (tx) => {
    await tx.delete(modelRolesTable);
    if (input.length === 0) return;
    const rows = input.map((role, i): ModelRole => ({
      id: role.id ?? randomUUID(),
      label: role.label.trim(),
      description: role.description ?? "",
      sortOrder: role.sortOrder ?? i,
      createdAt: t,
      updatedAt: t,
    }));
    await tx.insert(modelRolesTable).values(rows);
  });
  return await listModelRoles();
}

/** The roles a fresh install ships. `id` is stable and is what an assignment
    points at; `small` is the one the `small_model` backfill ensures. Three are
    tiers a subagent can run cheaper or stronger than the session model on
    (`small`, `fast`, `reasoning`); the rest are kinds of work. */
const DEFAULT_MODEL_ROLES: { id: string; label: string; description: string }[] = [
  { id: "small", label: "Small", description: "Cheap side-jobs in a subagent: titles, summaries, compaction, quick classification. Also what Claude Code's own subagents fall back to." },
  { id: "fast", label: "Fast", description: "Quick, low-latency lookups and mechanical edits where speed beats depth." },
  { id: "reasoning", label: "Reasoning", description: "Hard, multi-step problems that need a stronger model than the session's." },
  { id: "advisor", label: "Advisor", description: "A second opinion: critique a plan, a diff or a finished answer." },
  { id: "explore", label: "Explore", description: "Read-only codebase search and orientation; reports findings, changes nothing." },
  { id: "code", label: "Code", description: "Focused implementation or a refactor, run as a subagent." },
  { id: "long-context", label: "Long context", description: "Reading many or very large files without losing the thread." },
];

/** Seed the default roles, once — a no-op once the table holds anything.
    Called at boot (index.ts), the same idempotent guard `migrateLegacyRules`
    uses: the vocabulary is the user's the moment a row exists. */
export async function seedDefaultModelRoles(): Promise<void> {
  const existing = await db.select().from(modelRolesTable).limit(1);
  if (existing.length > 0) return;
  const t = now();
  await db.insert(modelRolesTable).values(
    DEFAULT_MODEL_ROLES.map((role, i) => ({
      id: role.id,
      label: role.label,
      description: role.description,
      sortOrder: i,
      createdAt: t,
      updatedAt: t,
    })),
  );
}
