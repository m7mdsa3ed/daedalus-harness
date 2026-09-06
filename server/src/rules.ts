import { eq } from "drizzle-orm";
import { db, appSettings } from "./db/index.js";

/**
 * Rules: standing instructions every thread starts with, written once instead
 * of retyped into a persona per thread.
 *
 * Two layers, general to specific: one global block for the whole harness
 * (this file, one row in `app_settings`) and a per-project block on the
 * project row (`projects.rules`, edited with the project). A spawn composes
 * both with `spawnRules` — undefined when both are empty, so "no rules" reads
 * exactly like "no persona" downstream.
 *
 * They ride the persona's doors rather than getting new ones. `personas.ts`
 * folds them into the spawn instructions beneath the persona text, so each
 * runtime carries them through the door it already opens — claude-code's
 * `_meta.systemPrompt.append`, codex's `developer_instructions`, opencode's
 * instructions file — and no door learns rules exist. Like a persona, a rules
 * change is a spawn-time fact: live threads pick it up on their next respawn.
 */

const RULES_KEY = "rules";

/** The global block, "" when never set. */
export function globalRules(): string {
  const row = db.select().from(appSettings).where(eq(appSettings.key, RULES_KEY)).get();
  return row?.value ?? "";
}

/** Store the global block. Empty (or whitespace) removes the row — an empty
    value is "no rules", and a row holding "" would read as a rule that says
    nothing. Returns the stored text. */
export function setGlobalRules(text: string): string {
  const value = text.trim();
  if (value) {
    db.insert(appSettings)
      .values({ key: RULES_KEY, value })
      .onConflictDoUpdate({ target: appSettings.key, set: { value } })
      .run();
  } else {
    db.delete(appSettings).where(eq(appSettings.key, RULES_KEY)).run();
  }
  return value;
}

/** The rules text a spawn starts from: global first, then the project's own.
    Undefined when neither layer says anything. */
export function spawnRules(projectRules?: string | null): string | undefined {
  const parts = [globalRules().trim(), (projectRules ?? "").trim()].filter(Boolean);
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}
