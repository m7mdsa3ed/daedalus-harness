import { eq, inArray } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import {
  commands as commandsTable,
  db,
  mcpServers as mcpServersTable,
  sessionCommands,
  sessionMcpServers,
  sessionSkills,
  skills as skillsTable,
} from "./index.js";

/**
 * The library links — MCP servers, skills, slash commands — that a session
 * carries.
 *
 * They used to be id arrays on the owning record, which nothing kept honest:
 * deleting an MCP server left its id behind in every owner that referenced
 * it, and the readers filtered the corpses out at spawn time. They are join
 * tables with `ON DELETE CASCADE` now, so a dangling id is not a thing that
 * can exist — which is why nothing downstream filters any more. All owners
 * share one shape and one reader/writer here. (Projects were a third owner
 * once; a project is a directory now and links nothing. Routines carry MCP
 * links too, but only the one kind, so theirs live beside the routines code
 * as `ROUTINE_LINKS`, built on these same helpers.)
 */
export interface LinkSet {
  mcpServerIds: string[];
  skillIds: string[];
  commandIds: string[];
}

export const emptyLinks = (): LinkSet => ({ mcpServerIds: [], skillIds: [], commandIds: [] });

/** One join table: which column names the owner and which the library row.
    `ownerKey`/`targetKey` are the JS property names an insert takes. */
interface LinkTable {
  table: PgTable;
  owner: AnyPgColumn;
  target: AnyPgColumn;
  ownerKey: string;
  targetKey: string;
}

export interface LinkTables {
  mcp: LinkTable;
  skill: LinkTable;
  command: LinkTable;
}

export const SESSION_LINKS: LinkTables = {
  mcp: { table: sessionMcpServers, owner: sessionMcpServers.sessionId, target: sessionMcpServers.mcpServerId, ownerKey: "sessionId", targetKey: "mcpServerId" },
  skill: { table: sessionSkills, owner: sessionSkills.sessionId, target: sessionSkills.skillId, ownerKey: "sessionId", targetKey: "skillId" },
  command: { table: sessionCommands, owner: sessionCommands.sessionId, target: sessionCommands.commandId, ownerKey: "sessionId", targetKey: "commandId" },
};

/** The database handle inside `db.transaction` — the same query surface, minus
    the driver escape hatch, so helpers can take either. */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function readOne(link: LinkTable, ownerIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (ownerIds.length === 0) return out;
  const rows = (await db
    .select({ owner: link.owner, target: link.target })
    .from(link.table)
    .where(inArray(link.owner, ownerIds))) as { owner: string; target: string }[];
  for (const row of rows) out.set(row.owner, [...(out.get(row.owner) ?? []), row.target]);
  return out;
}

/** Every owner's links, grouped — one query per table however many owners. */
export async function readLinks(
  tables: LinkTables,
  ownerIds: string[],
): Promise<Map<string, LinkSet>> {
  // Three independent reads: awaited together rather than in sequence, because
  // an async driver charges a round trip for each and they do not depend on
  // one another.
  const [mcp, skill, command] = await Promise.all([
    readOne(tables.mcp, ownerIds),
    readOne(tables.skill, ownerIds),
    readOne(tables.command, ownerIds),
  ]);
  const out = new Map<string, LinkSet>();
  for (const id of ownerIds) {
    out.set(id, {
      mcpServerIds: mcp.get(id) ?? [],
      skillIds: skill.get(id) ?? [],
      commandIds: command.get(id) ?? [],
    });
  }
  return out;
}

export async function linksOf(tables: LinkTables, ownerId: string): Promise<LinkSet> {
  return (await readLinks(tables, [ownerId])).get(ownerId) ?? emptyLinks();
}

/** Ids the library actually holds. A request naming an entry that no longer
    exists is stale, not fatal — it links what it can, which is what the old
    read-time filtering did, only now the stored state is clean too. */
async function existing(
  tx: Tx,
  ids: string[],
  table: typeof mcpServersTable | typeof skillsTable | typeof commandsTable,
): Promise<string[]> {
  if (ids.length === 0) return [];
  const unique = [...new Set(ids)];
  /* Read inside the caller's transaction rather than through `db`. It always
     should have been: a library row deleted between this check and the insert
     below took the link's foreign key with it, and outside the transaction
     that is a window the write can lose. */
  const rows = await tx.select({ id: table.id }).from(table).where(inArray(table.id, unique));
  const found = rows.map((r) => r.id);
  return unique.filter((id) => found.includes(id));
}

async function writeOne(tx: Tx, link: LinkTable, ownerId: string, ids: string[]): Promise<void> {
  await tx.delete(link.table).where(eq(link.owner, ownerId));
  for (const id of ids) {
    // The descriptor names the two columns; the table type is erased above,
    // so the row is built by key rather than typed per table.
    await tx
      .insert(link.table)
      .values({ [link.ownerKey]: ownerId, [link.targetKey]: id } as Record<string, string>);
  }
}

/** Replace an owner's links wholesale. Inside the caller's transaction. */
export async function writeLinks(
  tx: Tx,
  tables: LinkTables,
  ownerId: string,
  links: LinkSet,
): Promise<void> {
  await writeOne(tx, tables.mcp, ownerId, await existing(tx, links.mcpServerIds, mcpServersTable));
  await writeOne(tx, tables.skill, ownerId, await existing(tx, links.skillIds, skillsTable));
  await writeOne(tx, tables.command, ownerId, await existing(tx, links.commandIds, commandsTable));
}

/** The union of several link sets, first-seen order, no duplicates. */
export function unionLinks(...sets: (LinkSet | null | undefined)[]): LinkSet {
  const uniq = (key: keyof LinkSet) => [...new Set(sets.flatMap((s) => s?.[key] ?? []))];
  return { mcpServerIds: uniq("mcpServerIds"), skillIds: uniq("skillIds"), commandIds: uniq("commandIds") };
}
