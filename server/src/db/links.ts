import { eq, inArray } from "drizzle-orm";
import type { AnySQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import {
  commands as commandsTable,
  db,
  mcpServers as mcpServersTable,
  profileCommands,
  profileMcpServers,
  profileSkills,
  sessionCommands,
  sessionMcpServers,
  sessionSkills,
  skills as skillsTable,
} from "./index.js";

/**
 * The three library links — MCP servers, skills, slash commands — that a
 * profile and a session each carry.
 *
 * They used to be id arrays on the owning record, which nothing kept honest:
 * deleting an MCP server left its id behind in every owner that referenced
 * it, and the readers filtered the corpses out at spawn time. They are join
 * tables with `ON DELETE CASCADE` now, so a dangling id is not a thing that
 * can exist — which is why nothing downstream filters any more. Both owners
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
  table: SQLiteTable;
  owner: AnySQLiteColumn;
  target: AnySQLiteColumn;
  ownerKey: string;
  targetKey: string;
}

export interface LinkTables {
  mcp: LinkTable;
  skill: LinkTable;
  command: LinkTable;
}

export const PROFILE_LINKS: LinkTables = {
  mcp: { table: profileMcpServers, owner: profileMcpServers.profileId, target: profileMcpServers.mcpServerId, ownerKey: "profileId", targetKey: "mcpServerId" },
  skill: { table: profileSkills, owner: profileSkills.profileId, target: profileSkills.skillId, ownerKey: "profileId", targetKey: "skillId" },
  command: { table: profileCommands, owner: profileCommands.profileId, target: profileCommands.commandId, ownerKey: "profileId", targetKey: "commandId" },
};

export const SESSION_LINKS: LinkTables = {
  mcp: { table: sessionMcpServers, owner: sessionMcpServers.sessionId, target: sessionMcpServers.mcpServerId, ownerKey: "sessionId", targetKey: "mcpServerId" },
  skill: { table: sessionSkills, owner: sessionSkills.sessionId, target: sessionSkills.skillId, ownerKey: "sessionId", targetKey: "skillId" },
  command: { table: sessionCommands, owner: sessionCommands.sessionId, target: sessionCommands.commandId, ownerKey: "sessionId", targetKey: "commandId" },
};

/** The database handle inside `db.transaction` — the same query surface, minus
    the driver escape hatch, so helpers can take either. */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function readOne(link: LinkTable, ownerIds: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (ownerIds.length === 0) return out;
  const rows = db
    .select({ owner: link.owner, target: link.target })
    .from(link.table)
    .where(inArray(link.owner, ownerIds))
    .all() as { owner: string; target: string }[];
  for (const row of rows) out.set(row.owner, [...(out.get(row.owner) ?? []), row.target]);
  return out;
}

/** Every owner's links, grouped — one query per table however many owners. */
export function readLinks(tables: LinkTables, ownerIds: string[]): Map<string, LinkSet> {
  const mcp = readOne(tables.mcp, ownerIds);
  const skill = readOne(tables.skill, ownerIds);
  const command = readOne(tables.command, ownerIds);
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

export function linksOf(tables: LinkTables, ownerId: string): LinkSet {
  return readLinks(tables, [ownerId]).get(ownerId) ?? emptyLinks();
}

/** Ids the library actually holds. A request naming an entry that no longer
    exists is stale, not fatal — it links what it can, which is what the old
    read-time filtering did, only now the stored state is clean too. */
function existing(
  ids: string[],
  table: typeof mcpServersTable | typeof skillsTable | typeof commandsTable,
): string[] {
  if (ids.length === 0) return [];
  const unique = [...new Set(ids)];
  const found = db
    .select({ id: table.id })
    .from(table)
    .where(inArray(table.id, unique))
    .all()
    .map((r) => r.id);
  return unique.filter((id) => found.includes(id));
}

function writeOne(tx: Tx, link: LinkTable, ownerId: string, ids: string[]): void {
  tx.delete(link.table).where(eq(link.owner, ownerId)).run();
  for (const id of ids) {
    // The descriptor names the two columns; the table type is erased above,
    // so the row is built by key rather than typed per table.
    tx.insert(link.table)
      .values({ [link.ownerKey]: ownerId, [link.targetKey]: id } as Record<string, string>)
      .run();
  }
}

/** Replace an owner's links wholesale. Inside the caller's transaction. */
export function writeLinks(tx: Tx, tables: LinkTables, ownerId: string, links: LinkSet): void {
  writeOne(tx, tables.mcp, ownerId, existing(links.mcpServerIds, mcpServersTable));
  writeOne(tx, tables.skill, ownerId, existing(links.skillIds, skillsTable));
  writeOne(tx, tables.command, ownerId, existing(links.commandIds, commandsTable));
}

/** The union of several link sets, first-seen order, no duplicates. */
export function unionLinks(...sets: (LinkSet | null | undefined)[]): LinkSet {
  const uniq = (key: keyof LinkSet) => [...new Set(sets.flatMap((s) => s?.[key] ?? []))];
  return { mcpServerIds: uniq("mcpServerIds"), skillIds: uniq("skillIds"), commandIds: uniq("commandIds") };
}
