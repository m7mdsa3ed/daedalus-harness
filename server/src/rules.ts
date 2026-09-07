import { eq, isNull } from "drizzle-orm";
import { db, rules as rulesTable, appSettings } from "./db/index.js";
import { randomUUID } from "node:crypto";

/**
 * Rules: standing instructions every thread starts with, written once instead
 * of retyped into a persona per thread.
 *
 * Two layers, general to specific: global rules (projectId = null) and
 * project-scoped rules (projectId set). A spawn composes both with
 * `spawnRules` — undefined when neither layer says anything.
 *
 * Each rule has a title and content, so they can be managed
 * individually rather than as one blob of text. `spawnRules` joins
 * them all into the text block each runtime receives through its
 * existing door — claude-code's `_meta.systemPrompt.append`,
 * codex's `developer_instructions`, opencode's instructions file —
 * and no door learns rules exist. Like a persona, a rules change is
 * a spawn-time fact: live threads pick it up on their next respawn.
 */

/** A rule row as stored. */
export interface Rule {
  id: string
  projectId: string | null
  title: string
  content: string
  sortOrder: number
  createdAt: number
  updatedAt: number
}

const now = () => Date.now()

/** All global rules, ordered by sortOrder. */
export async function globalRules(): Promise<Rule[]> {
  return await db.select().from(rulesTable).where(isNull(rulesTable.projectId)).orderBy(rulesTable.sortOrder)
}

/** All rules for a project, ordered by sortOrder. */
export async function projectRules(projectId: string): Promise<Rule[]> {
  return await db.select().from(rulesTable).where(eq(rulesTable.projectId, projectId)).orderBy(rulesTable.sortOrder)
}

/** Get a single rule by id. */
export async function getRule(id: string): Promise<Rule | undefined> {
  return (await db.select().from(rulesTable).where(eq(rulesTable.id, id)).limit(1))[0]
}

/** Create a new rule. Returns the created row. */
export async function createRule(input: { projectId: string | null; title: string; content: string }): Promise<Rule> {
  const id = randomUUID()
  const t = now()
  const row = { id, ...input, sortOrder: 0, createdAt: t, updatedAt: t }
  await db.insert(rulesTable).values(row)
  return row
}

/** Update an existing rule. Returns the updated row or undefined. */
export async function updateRule(id: string, input: { title?: string; content?: string; sortOrder?: number }): Promise<Rule | undefined> {
  const set: Record<string, unknown> = {}
  if (input.title !== undefined) set.title = input.title
  if (input.content !== undefined) set.content = input.content
  if (input.sortOrder !== undefined) set.sortOrder = input.sortOrder
  set.updatedAt = now()
  if (Object.keys(set).length === 0) return getRule(id)
  const changed = ((await db.update(rulesTable).set(set).where(eq(rulesTable.id, id))).rowCount ?? 0)
  return changed > 0 ? getRule(id) : undefined
}

/** Delete a rule. Returns true if it existed. */
export async function deleteRule(id: string): Promise<boolean> {
  return ((await db.delete(rulesTable).where(eq(rulesTable.id, id))).rowCount ?? 0) > 0
}

/** Compose the rules text a spawn starts from: global rules first,
    then the project's own, joined by double newlines.
    Undefined when neither layer says anything. */
export function spawnRules(projectRules?: string | null): string | undefined {
  const parts = [globalRulesText(), (projectRules ?? "").trim() || undefined].filter(Boolean)
  return parts.length > 0 ? parts.join("\n\n") : undefined
}

/** The text of all global rules joined, for embedding in spawn. */
async function globalRulesText(): Promise<string | undefined> {
  const rows = await globalRules()
  if (rows.length === 0) return undefined
  return rows.map((r) => r.content).join("\n\n")
}

/** The text of all project rules joined, for embedding in spawn. */
async function projectRulesText(projectId: string): Promise<string | undefined> {
  const rows = await projectRules(projectId)
  if (rows.length === 0) return undefined
  return rows.map((r) => r.content).join("\n\n")
}

/** Initialize the rules table from the old app_settings blob.
    Called once at boot — idempotent, and a no-op after the migration
    has run. */
export async function migrateLegacyRules(): Promise<void> {
  const row = (await db.select().from(appSettings).where(eq(appSettings.key, "rules")).limit(1))[0]
  if (!row?.value?.trim()) return
  const content = row.value.trim()
  // Only migrate if the rules table is empty — don't duplicate.
  const existing = await db.select().from(rulesTable).limit(1)
  if (existing.length > 0) return
  const id = randomUUID()
  const t = now()
  await db.insert(rulesTable).values({
    id, projectId: null, title: "Global rules",
    content, sortOrder: 0, createdAt: t, updatedAt: t,
  })
  // Remove the old app_settings row so it doesn't accumulate.
  await db.delete(appSettings).where(eq(appSettings.key, "rules"))
}
