import { randomUUID } from "node:crypto";
import { asc, eq, max, sql } from "drizzle-orm";
import { z } from "zod";
import { db, spaces as spacesTable } from "./db/index.js";

/*
 * Spaces — a named scope above projects ("Personal", "Work").
 *
 * The row is a name and an order and nothing else: there is no space id on a
 * thread, a routine or a knowledge entry, because every one of them is already
 * scoped by its project and a project is scoped by its space. Storing it twice
 * would be a second value that can disagree with the first, which is the drift
 * the schema warns about elsewhere.
 *
 * A project may be in several spaces (`project_spaces`). Deleting a space is
 * refused while a project lives *only* there — the same bargain `deleteProfile`
 * makes with a live thread — so no project is ever left in no space; the
 * memberships of the rest cascade away with the row.
 */

export const SpaceInputSchema = z.object({
  name: z.string().min(1).max(120),
});
export type SpaceInput = z.infer<typeof SpaceInputSchema>;

export interface Space {
  id: string;
  name: string;
  sortOrder: number;
  createdAt: number;
}

const rowToSpace = (row: typeof spacesTable.$inferSelect): Space => ({
  id: row.id,
  name: row.name,
  sortOrder: row.sortOrder,
  createdAt: row.createdAt,
});

export async function listSpaces(): Promise<Space[]> {
  const rows = await db
    .select()
    .from(spacesTable)
    .orderBy(asc(spacesTable.sortOrder), asc(spacesTable.name));
  return rows.map(rowToSpace);
}

export async function getSpace(id: string): Promise<Space | undefined> {
  const row = (await db.select().from(spacesTable).where(eq(spacesTable.id, id)).limit(1))[0];
  return row ? rowToSpace(row) : undefined;
}

/** The space a new project lands in when the caller names none — the first in
    the switcher's order, or a freshly made "Personal" on an install whose only
    space was somehow removed. */
export async function defaultSpaceId(): Promise<string> {
  const first = (
    await db
      .select()
      .from(spacesTable)
      .orderBy(asc(spacesTable.sortOrder), asc(spacesTable.name))
      .limit(1)
  )[0];
  if (first) return first.id;
  const created = await createSpace({ name: "Personal" });
  return created.id;
}

export async function createSpace(input: SpaceInput): Promise<Space> {
  const id = randomUUID();
  const last = (await db.select({ max: max(spacesTable.sortOrder) }).from(spacesTable))[0]?.max ?? 0;
  await db
    .insert(spacesTable)
    .values({ id, name: input.name, sortOrder: last + 1, createdAt: Date.now() });
  return (await getSpace(id))!;
}

export async function updateSpace(id: string, input: SpaceInput): Promise<Space | undefined> {
  const changed =
    (await db.update(spacesTable).set({ name: input.name }).where(eq(spacesTable.id, id))).rowCount ?? 0;
  return changed > 0 ? await getSpace(id) : undefined;
}

/** How many projects would be left in no space by deleting this one — those
    whose only space it is. A project that is also filed elsewhere just loses
    this membership (the join table cascades), so it does not count. */
export async function projectsOnlyIn(id: string): Promise<number> {
  const rows = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM project_spaces ps
    WHERE ps.space_id = ${id}
      AND NOT EXISTS (
        SELECT 1 FROM project_spaces o WHERE o.project_id = ps.project_id AND o.space_id <> ps.space_id
      )
  `);
  return rows.rows[0]?.n ?? 0;
}

/** Whether this is the only space — deleting it would leave the app with no
    scope at all, and the boot backfill would quietly make a new "Personal". */
export async function onlySpace(id: string): Promise<boolean> {
  const rows = await db.execute<{ id: string; n: number }>(
    sql`SELECT id, count(*) OVER ()::int AS n FROM spaces`,
  );
  return rows.rows.length > 0 && rows.rows[0].n <= 1 && rows.rows.some((row) => row.id === id);
}

export async function deleteSpace(id: string): Promise<boolean> {
  const changed = (await db.delete(spacesTable).where(eq(spacesTable.id, id))).rowCount ?? 0;
  return changed > 0;
}
