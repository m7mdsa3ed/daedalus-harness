import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, profiles as profilesTable, type ProfileAgentLink } from "./db/index.js";
import { PROFILE_LINKS, emptyLinks, linksOf, readLinks, writeLinks } from "./db/links.js";

// A profile is the PROVIDER configuration used in a session (credentials,
// models); the workspace side lives in projects.ts. It is not bound to one
// agent: `agents` names every runtime it can spawn, and a thread is a
// (profile, agent) pair chosen when the thread is started.
export const ProfileInputSchema = z.object({
  name: z.string().min(1),
  /** Which agents this profile can spawn, keyed by agent id, with the little
      that differs per agent on one provider (see ProfileAgentLink). At least
      one — a profile no agent can use is a profile no thread can start on. */
  agents: z
    .record(z.string().min(1), z.object({ baseUrl: z.string().optional() }))
    .refine((agents) => Object.keys(agents).length > 0, "a profile needs at least one agent"),
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
        // Optional models.dev-derived metadata; all display only. Optional so
        // payloads from before they existed still parse.
        description: z.string().optional(),
        pricing: z.object({ input: z.number().min(0), output: z.number().min(0) }).optional(),
        modalities: z.array(z.string()).optional(),
        devRef: z.string().optional(),
      }),
    )
    .default([]),
  defaultModel: z.string().optional().default(""),
  /** Model for the agent's cheap side-jobs (Claude Code's Bash permission
      classifier above all). Empty means "the session model", which is what a
      profile promises everywhere else; naming one separately is for a gateway
      that serves a genuinely cheaper tier worth using. Deliberately a bare id
      and not a `models[]` entry — nothing may pick it for a thread. */
  smallModel: z.string().optional().default(""),
  /** Logo shown next to the profile in pickers — a URL (models.dev serves
      provider marks at https://models.dev/logos/<provider>.svg). Empty means
      "no logo of its own", and the client falls back to the agent's mark. */
  logoUrl: z.string().optional().default(""),
  /** Library entries this profile brings to every thread started on it, on
      top of the project's (db/links.ts). The web-search and knowledge flags
      above are the harness's own two servers; these are the user's. */
  mcpServerIds: z.array(z.string()).default([]),
  skillIds: z.array(z.string()).default([]),
  commandIds: z.array(z.string()).default([]),
});

export type ProfileInput = z.infer<typeof ProfileInputSchema>;
export type Profile = Omit<ProfileInput, "smallModel"> & {
  /** Null on rows predating the column; `resolveSpawn` reads it as empty, which
      falls back to the session model. */
  smallModel: string | null;
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
    agents: { [agentId]: {} },
    baseUrl: "",
    apiKey: "",
    models: [],
    defaultModel: "",
    smallModel: "",
    // No logo, deliberately: the Default profile IS the agent as it ships,
    // and the client already draws the agent's own mark for it.
    logoUrl: "",
    ...emptyLinks(),
    virtual: true,
  };
}

export function isVirtualProfile(id: string): boolean {
  return id.startsWith(DEFAULT_PROFILE_PREFIX);
}

/** The agents this profile can spawn, in the order they were saved. */
export const profileAgentIds = (profile: Profile): string[] => Object.keys(profile.agents ?? {});

export const profileSupports = (profile: Profile, agentId: string): boolean =>
  Object.hasOwn(profile.agents ?? {}, agentId);

/**
 * Which agent a request meant when it named a profile and no agent.
 *
 * Only unambiguous when the profile names one agent — an older client, or the
 * virtual Default, which always does. A multi-agent profile with no agent
 * named resolves to nothing rather than to a guess: the caller 404s, because
 * spawning "some" agent on a profile that serves three is not what anyone
 * asked for.
 */
export function resolveProfileAgent(profile: Profile, agentId?: string | null): string | undefined {
  if (agentId) return profileSupports(profile, agentId) ? agentId : undefined;
  const ids = profileAgentIds(profile);
  return ids.length === 1 ? ids[0] : undefined;
}

/** The base URL this agent should be pointed at: its own override on the
    profile when one is set, otherwise the profile's shared one. */
export function profileBaseUrl(profile: Profile, agentId: string): string {
  const link: ProfileAgentLink | undefined = profile.agents?.[agentId];
  return link?.baseUrl?.trim() || profile.baseUrl || "";
}

/** A row plus its links, with the nullable columns read back as the empty
    strings the schema defaults them to. */
function toProfile(row: Record<string, unknown>, links = linksOf(PROFILE_LINKS, row.id as string)): Profile {
  const { id, ...rest } = row;
  return {
    ...links,
    ...(rest as Omit<ProfileInput, "smallModel">),
    id: id as string,
    // A row from before the column existed reads back `{}` (the column
    // default); the migration filled every row that had an agent.
    agents: (row.agents as Record<string, ProfileAgentLink> | null | undefined) ?? {},
    smallModel: (row.smallModel as string | null | undefined) ?? "",
    logoUrl: (row.logoUrl as string | null | undefined) ?? "",
  };
}

/** Stored profiles only. `listProfiles` is what the API and spawning use. */
function storedProfiles(): Profile[] {
  const rows = db.select().from(profilesTable).all();
  const links = readLinks(PROFILE_LINKS, rows.map((r) => r.id));
  return rows.map((row) => toProfile(row, links.get(row.id) ?? emptyLinks()));
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
  const row = db.select().from(profilesTable).where(eq(profilesTable.id, id)).get();
  return row ? toProfile(row) : undefined;
}

/** Secrets never leave the server: the API key is replaced by a boolean the
    client uses to render the "leave empty to keep it" hint. */
export function redact(profile: Profile) {
  const { apiKey, ...rest } = profile;
  return { ...rest, hasApiKey: Boolean(apiKey) };
}

/** The columns of the profiles table, without the link arrays that live in
    their own tables. */
function columnsOf(profile: Profile) {
  const { mcpServerIds: _m, skillIds: _s, commandIds: _c, virtual: _v, ...columns } = profile;
  return columns;
}

export function createProfile(input: ProfileInput): Profile {
  const profile: Profile = { id: randomUUID(), ...input };
  db.transaction((tx) => {
    tx.insert(profilesTable).values(columnsOf(profile)).run();
    writeLinks(tx, PROFILE_LINKS, profile.id, profile);
  });
  return getProfile(profile.id)!;
}

export function updateProfile(id: string, input: ProfileInput): Profile | undefined {
  if (isVirtualProfile(id)) return undefined;
  const existing = db.select().from(profilesTable).where(eq(profilesTable.id, id)).get();
  if (!existing) return undefined;
  // Empty apiKey in an update means "keep the stored key" (the client never sees it).
  const updated: Profile = { ...input, id, apiKey: input.apiKey || existing.apiKey };
  db.transaction((tx) => {
    tx.update(profilesTable).set(columnsOf(updated)).where(eq(profilesTable.id, id)).run();
    writeLinks(tx, PROFILE_LINKS, id, updated);
  });
  return getProfile(id);
}

export function deleteProfile(id: string): boolean {
  if (isVirtualProfile(id)) return false;
  return db.delete(profilesTable).where(eq(profilesTable.id, id)).run().changes > 0;
}
