import { asc, eq } from "drizzle-orm";
import { appSettings, commands, db, savedPrompts } from "./db/index.js";

/**
 * Saved prompts are slash commands now: the library's `commands`. Once, at
 * boot, copy every legacy row over and leave a marker so one deleted afterwards
 * does not come back. The table stays declared only so `db:push` does not drop
 * it before this has run. Personas are live again (`personas` table) and are
 * no longer copied; a bundle's legacy `personas` key still imports as commands.
 *
 * A row keeps its id (a restored built-in is never a second row) and loses its
 * `title`. A command is linked per thread, so nothing is linked here: they are
 * library rows like any other.
 */
const DONE_KEY = "savedPromptsToCommands";

/** `Think more` -> `think-more`. */
export function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "prompt";
}

/** A command name not in `used`: `name`, else `name-2`, `name-3`… Adds it to `used`. */
export function freeName(name: string, used: Set<string>): string {
  let candidate = name;
  for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${name}-${n}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

export interface LegacyPrompt {
  id: string;
  name: string;
  title?: string;
  description?: string;
  prompt: string;
}

/** The `commands` row for a legacy prompt, its name made free in `used`. */
export function commandFromPrompt(p: LegacyPrompt, used: Set<string>) {
  return {
    id: p.id,
    name: freeName(slug(p.name), used),
    description: p.description || p.title || p.name,
    argumentHint: "what to do (optional)",
    content: p.prompt,
  };
}

export async function migrateLegacyPrompts(): Promise<void> {
  if ((await db.select().from(appSettings).where(eq(appSettings.key, DONE_KEY)).limit(1))[0]) return;
  const have = await db.select({ id: commands.id, name: commands.name }).from(commands);
  const ids = new Set(have.map((r) => r.id));
  const used = new Set(have.map((r) => r.name.toLowerCase()));
  const rows: LegacyPrompt[] = await db.select().from(savedPrompts).orderBy(asc(savedPrompts.sortOrder), asc(savedPrompts.name));
  for (const p of rows) {
    if (ids.has(p.id)) continue;
    await db.insert(commands).values(commandFromPrompt(p, used));
  }
  await db.insert(appSettings).values({ key: DONE_KEY, value: "1" }).onConflictDoNothing();
}
