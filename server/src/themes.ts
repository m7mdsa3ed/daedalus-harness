import { asc, eq } from "drizzle-orm";
import { db, themes as themesTable } from "./db/index.js";

/**
 * Themes: the studio's saved user-made themes, stored here so they follow the
 * account and not the browser.
 *
 * A theme is the same three halves the client edits — `light` / `dark` colour
 * token maps and the mode-independent `base` (radius, the three font roles,
 * depth, tracking, blur, width — preset and font ids, never resolved stacks).
 * The payload is opaque: nothing here needs to know what a token means, only
 * that a theme has a name and three record halves. The client's custom-theme
 * store is a cache of these rows; the gallery hydrates from `listThemes` and
 * the studio writes through on every edit.
 */

/** A theme row as stored. */
export interface Theme {
  id: string
  name: string
  light: Record<string, string>
  dark: Record<string, string>
  base: Record<string, string>
  createdAt: number
  updatedAt: number
}

export interface ThemeInput {
  id: string
  name: string
  light: Record<string, string>
  dark: Record<string, string>
  base: Record<string, string>
}

const now = () => Date.now()

/** Every saved theme, oldest first — the gallery's order. */
export async function listThemes(): Promise<Theme[]> {
  return db.select().from(themesTable).orderBy(asc(themesTable.createdAt), asc(themesTable.name))
}

/** One theme, when it exists. */
export async function getTheme(id: string): Promise<Theme | undefined> {
  return (await db.select().from(themesTable).where(eq(themesTable.id, id)).limit(1))[0]
}

/** Create a theme. The id is the client's — the studio mints one when a theme
    is created and every gallery/editor URL names it — so a duplicate create
    answers with the row the client already has rather than failing. */
export async function createTheme(input: ThemeInput): Promise<Theme> {
  const t = now()
  const row: Theme = { ...input, createdAt: t, updatedAt: t }
  await db.insert(themesTable).values(row)
  return row
}

/** Replace a theme's payload. Returns the saved row or undefined when the id
    is unknown. */
export async function updateTheme(
  id: string,
  input: Partial<Omit<ThemeInput, "id">>
): Promise<Theme | undefined> {
  const existing = await getTheme(id)
  if (!existing) return undefined
  const row: Theme = { ...existing, ...input, updatedAt: now() }
  await db
    .update(themesTable)
    .set({ name: row.name, light: row.light, dark: row.dark, base: row.base, updatedAt: row.updatedAt })
    .where(eq(themesTable.id, id))
  return row
}

/** Delete a theme. False when there was nothing to delete. */
export async function deleteTheme(id: string): Promise<boolean> {
  return ((await db.delete(themesTable).where(eq(themesTable.id, id))).rowCount ?? 0) > 0
}