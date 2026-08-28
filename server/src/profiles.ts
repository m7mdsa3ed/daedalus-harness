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
  /** Replace the agent's built-in web tools with the harness's `web-search` MCP
      server. A profile opts in; unset means off. The other fields override the
      server-global `webSearch` in config.json — each only when set, and the
      token is stored (redacted on read) like apiKey. */
  webSearch: z
    .object({
      enabled: z.boolean().default(false),
      searchApiBaseUrl: z.string().optional(),
      searchApiToken: z.string().optional(),
      searchModel: z.string().optional(),
      fetchModel: z.string().optional(),
    })
    .optional()
    .default({ enabled: false }),
  /** Opt the agent into the harness's `knowledge` MCP server. Just the flag —
      there is no per-profile config to override (unlike webSearch), so a profile
      only says whether the tools are advertised at all. Off by default. */
  knowledge: z.object({ enabled: z.boolean().default(false) }).optional().default({ enabled: false }),
});

export type ProfileInput = z.infer<typeof ProfileInputSchema>;
export type Profile = Omit<ProfileInput, "webSearch" | "knowledge"> & {
  id: string;
  /** Not stored: synthesized for an agent so it can always be run as it ships.
      See `defaultProfileFor`. Nothing may edit or delete one. */
  virtual?: boolean;
  /** Opt-in to the harness's `web-search` MCP server. Stored rows predating the
      column read back null; treated as off so a profile that never opted in
      stays off. The other fields override the server-global default. */
  webSearch:
    | { enabled: boolean; searchApiBaseUrl?: string; searchApiToken?: string; searchModel?: string; fetchModel?: string }
    | null;
  /** Opt-in to the harness's `knowledge` MCP server. Like webSearch, a stored row
      predating the column reads back null, treated as off. */
  knowledge: { enabled: boolean } | null;
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
    webSearch: { enabled: false },
    knowledge: { enabled: false },
    virtual: true,
  };
}

export function isVirtualProfile(id: string): boolean {
  return id.startsWith(DEFAULT_PROFILE_PREFIX);
}

/** A stored row predating the `web_search` column reads back as null, which
    `Profile` never produces (its schema defaults it). Treat null as "off" so a
    profile that never opted in stays off, not a type that no longer fits. */
function toProfile(row: Record<string, unknown>): Profile {
  const { id, ...rest } = row;
  return {
    ...(rest as Omit<ProfileInput, "webSearch" | "knowledge">),
    id: id as string,
    webSearch: (row.webSearch as { enabled: boolean } | undefined | null) ?? { enabled: false },
    knowledge: (row.knowledge as { enabled: boolean } | undefined | null) ?? { enabled: false },
  };
}

/** Stored profiles only. `listProfiles` is what the API and spawning use. */
function storedProfiles(): Profile[] {
  return db.select().from(profilesTable).all().map(toProfile);
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

/** Secrets never leave the server — API keys, and a profile's own web-search
    token. Each is replaced by a boolean the client uses to render the
    "leave empty to keep it" hint. The token key is deleted, not set to
    undefined, so it cannot appear in a serialized payload even by accident. */
export function redact(profile: Profile) {
  const { apiKey, ...rest } = profile;
  const webSearch = rest.webSearch;
  return {
    ...rest,
    hasApiKey: Boolean(apiKey),
    ...(webSearch
      ? {
          webSearch: {
            enabled: webSearch.enabled,
            searchApiBaseUrl: webSearch.searchApiBaseUrl,
            searchModel: webSearch.searchModel,
            fetchModel: webSearch.fetchModel,
            hasWebSearchToken: Boolean(webSearch.searchApiToken),
          },
        }
      : {}),
  };
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
  // Same for the web-search token: an empty one keeps the stored secret sent by
  // the client (which never sees it back). The client always sends a webSearch
  // object (its form defaults enabled to false), so `input.webSearch` is set.
  const webSearch = input.webSearch;
  const current = existing.webSearch ?? { enabled: false };
  updated.webSearch = {
    ...current,
    ...webSearch,
    searchApiToken: webSearch.searchApiToken || current.searchApiToken || undefined,
  };
  db.update(profilesTable).set(updated).where(eq(profilesTable.id, id)).run();
  return updated;
}

export function deleteProfile(id: string): boolean {
  if (isVirtualProfile(id)) return false;
  return db.delete(profilesTable).where(eq(profilesTable.id, id)).run().changes > 0;
}
