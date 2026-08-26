import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, profiles as profilesTable } from "./db/index.js";

// A profile is the AGENT configuration used in a session (credentials, models);
// the workspace side lives in projects.ts.
export const ProfileInputSchema = z.object({
  name: z.string().min(1),
  agentId: z.string().min(1),
  baseUrl: z.string().optional().default(""),
  apiKey: z.string().optional().default(""),
  models: z
    .array(
      z.object({
        id: z.string().min(1),
        label: z.string().min(1),
        contextWindow: z.number().int().positive().optional(),
        maxOutputTokens: z.number().int().positive().optional(),
        // Effort levels the model accepts; empty = no effort control.
        reasoningEfforts: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  defaultModel: z.string().optional().default(""),
});

export type ProfileInput = z.infer<typeof ProfileInputSchema>;
export type Profile = ProfileInput & {
  id: string;
  /** Not stored: synthesized for an agent so it can always be run as it ships.
      See `defaultProfileFor`. Nothing may edit or delete one. */
  virtual?: boolean;
};

/** `default:<agentId>` — the id of an agent's virtual profile. Prefixed rather
    than a UUID so it is recognisable on sight, in a URL and in sessions. */
export const DEFAULT_PROFILE_PREFIX = "default:";

/**
 * Every agent's own defaults, as a profile.
 *
 * An agent that has been configured with no profile still needs one: a profile
 * is what the server spawns from and what carries credentials. This is that
 * profile, and it deliberately carries *nothing* — no baseUrl, no key, and
 * above all no `models`, because an empty catalog is what tells the client the
 * agent owns its own model and effort selectors (see CLAUDE.md). The agent runs
 * exactly as it ships, on whatever credentials its own environment gives it.
 *
 * Making a real profile for that agent is how you override any of it.
 */
export function defaultProfileFor(agentId: string, _agentName?: string): Profile {
  return {
    id: DEFAULT_PROFILE_PREFIX + agentId,
    name: "Default",
    agentId,
    baseUrl: "",
    apiKey: "",
    models: [],
    defaultModel: "",
    virtual: true,
  };
}

export function isVirtualProfile(id: string): boolean {
  return id.startsWith(DEFAULT_PROFILE_PREFIX);
}

/** Stored profiles only. `listProfiles` is what the API and spawning use. */
function storedProfiles(): Profile[] {
  return db.select().from(profilesTable).all();
}

/**
 * Every agent's virtual default, then the stored profiles.
 *
 * The default is offered for *every* agent, not just unconfigured ones: "run
 * this agent as it ships" is a real choice next to "run it on my gateway", and
 * the only way back to it once a profile exists would otherwise be deleting the
 * profile. It sorts first because it is the baseline the others depart from.
 */
export function listProfiles(agents: { id: string; name?: string }[] = []): Profile[] {
  const virtual = agents.map((agent) => defaultProfileFor(agent.id, agent.name));
  return [...virtual, ...storedProfiles()];
}

export function getProfile(id: string): Profile | undefined {
  if (isVirtualProfile(id)) {
    return defaultProfileFor(id.slice(DEFAULT_PROFILE_PREFIX.length));
  }
  return db.select().from(profilesTable).where(eq(profilesTable.id, id)).get();
}

/** API keys never leave the server. */
export function redact(profile: Profile) {
  const { apiKey, ...rest } = profile;
  return { ...rest, hasApiKey: Boolean(apiKey) };
}

export function createProfile(input: ProfileInput): Profile {
  const profile: Profile = { id: randomUUID(), ...input };
  db.insert(profilesTable).values(profile).run();
  return profile;
}

export function updateProfile(id: string, input: ProfileInput): Profile | undefined {
  if (isVirtualProfile(id)) return undefined;
  const existing = db.select().from(profilesTable).where(eq(profilesTable.id, id)).get();
  if (!existing) return undefined;
  // Empty apiKey in an update means "keep the stored key" (the client never sees it).
  const updated: Profile = { ...input, id, apiKey: input.apiKey || existing.apiKey };
  db.update(profilesTable).set(updated).where(eq(profilesTable.id, id)).run();
  return updated;
}

export function deleteProfile(id: string): boolean {
  if (isVirtualProfile(id)) return false;
  return db.delete(profilesTable).where(eq(profilesTable.id, id)).run().changes > 0;
}
