import { asc, eq } from "drizzle-orm";
import { appSettings, commands, db, personas, savedPrompts } from "./db/index.js";

/**
 * Saved prompts (and the personas before them) are slash commands now: the
 * library's `commands`. Once, at boot, copy every legacy row over and leave a
 * marker so one deleted afterwards does not come back. Both legacy tables stay
 * declared only so `db:push` does not drop them before this has run; nothing else
 * reads or writes either.
 *
 * A row keeps its id (a restored built-in is never a second row) and loses its
 * `title`. A command is linked per thread, so nothing is linked here: they are
 * library rows like any other.
 */
const DONE_KEY = "savedPromptsToCommands";
/** Set by the old personas -> saved prompts migration. */
const PERSONAS_DONE_KEY = "savedPromptsMigrated";

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
  const done = async (key: string) => (await db.select().from(appSettings).where(eq(appSettings.key, key)).limit(1))[0];
  if (await done(DONE_KEY)) return;
  const have = await db.select({ id: commands.id, name: commands.name }).from(commands);
  const ids = new Set(have.map((r) => r.id));
  const used = new Set(have.map((r) => r.name.toLowerCase()));
  const rows: LegacyPrompt[] = await db.select().from(savedPrompts).orderBy(asc(savedPrompts.sortOrder), asc(savedPrompts.name));
  // Personas the first migration already carried (or the user deleted since) are not re-offered.
  if (!(await done(PERSONAS_DONE_KEY))) {
    const seen = new Set(rows.map((r) => r.id));
    rows.push(...(await db.select().from(personas).orderBy(asc(personas.sortOrder), asc(personas.name))).filter((p) => !seen.has(p.id)));
  }
  for (const p of rows) {
    if (ids.has(p.id)) continue;
    await db.insert(commands).values(commandFromPrompt(p, used));
  }
  await db.insert(appSettings).values({ key: DONE_KEY, value: "1" }).onConflictDoNothing();
}
