import { randomUUID } from "node:crypto";
import { eq, like } from "drizzle-orm";
import { z } from "zod";
import {
  MODEL_KINDS,
  MODEL_WIRES,
  USAGE_KINDS,
  agentOptions as agentOptionsTable,
  agentQuota as agentQuotaTable,
  db,
  profiles as profilesTable,
  type ProfileAgentLink,
  type ProfileUsage,
} from "./db/index.js";

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
    .record(z.string().min(1), z.object({ baseUrl: z.string().optional(), protocol: z.enum(["openai", "anthropic"]).optional() }))
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
        iconUrl: z.string().optional(),
        // User-written, not enrichment: a label the user puts on a model so the
        // picker draws the ones sharing it under one heading (schema.ts
        // `ModelDef.group`). Declared here or Zod strips it on save and the
        // group is gone the moment the form is submitted.
        group: z.string().optional(),
        // What the model is and how it is called (schema.ts `ModelDef.kind`/
        // `wire`, docs/plans/model-kinds.md). Absent = a chat model, so a payload
        // from a client that predates kinds still means what it always meant.
        // Declared here for the same reason `group` is: Zod strips what it does
        // not know, and a decision model that comes back as a chat model is one
        // the picker offers for a thread.
        kind: z.enum(MODEL_KINDS).optional(),
        wire: z.enum(MODEL_WIRES).optional(),
        // Retired (`docs/model-roles.md`): the role → model map moved onto the
        // thread (`sessions.helper_models`) and nothing reads this any more. Left
        // declared so Zod does not strip a legacy field off an old payload.
        roles: z.array(z.string()).optional(),
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
  /** How to read this provider's subscription usage, when it sells one and
      exposes an API for it (see ProfileUsage / usage-api.ts). Absent or
      `{kind:"none"}` means there is nothing to read, and the agent's own
      `quotaProbe` — the machine's `claude`/`codex login` — answers instead. */
  usage: z
    .object({
      kind: z.enum(USAGE_KINDS),
      baseUrl: z.string().optional(),
      apiKey: z.string().optional(),
    })
    .nullish(),
  /** Drop Codex's "Model metadata for `…` not found. Defaulting to fallback
      metadata" notice for threads spawned on this profile. The profile already
      carries the model's numbers, so the nag is noise the user has chosen to
      not see (see acp-bridge.ts — the bridge is where it is dropped). */
  suppressModelMetadataWarning: z.boolean().default(false),
  /** Seconds the gateway shim waits for this provider's response headers
      (db/schema.ts). Null/absent = the shim's default. */
  upstreamTimeoutSeconds: z.number().int().min(10).max(3600).nullish(),
  /** Extra headers the gateway shim adds upstream for this profile
      (gateway-shim.ts, `profiles.headers` in db/schema.ts). Declared here or
      Zod strips it on save and the headers are gone the moment the form is
      submitted — the trap `group` fell into. */
  headers: z.array(z.object({ name: z.string().min(1), value: z.string() })).nullish(),
  /** Kept but not offered when starting a new thread — see `profiles.hidden`
      and `profiles.disabled` in db/schema.ts. Defaulted, so a payload from a
      client that predates the flags shows the profile rather than failing the
      write. */
  hidden: z.boolean().default(false),
  disabled: z.boolean().default(false),
  /** Logo shown next to the profile in pickers — a URL (models.dev serves
      provider marks at https://models.dev/logos/<provider>.svg). Empty means
      "no logo of its own", and the client falls back to the agent's mark. */
  logoUrl: z.string().optional().default(""),
});

export type ProfileInput = z.infer<typeof ProfileInputSchema>;
export type Profile = Omit<ProfileInput, "smallModel" | "suppressModelMetadataWarning" | "hidden" | "disabled"> & {
  /** Null on rows predating the column; `resolveSpawn` reads it as empty, which
      falls back to the session model. */
  smallModel: string | null;
  /** Optional on purpose, like `smallModel`: hand-built profile literals
      (tests, the virtual Default's twin) predate it, and every reader treats
      absence as false. Stored rows always carry it once `pnpm db:push` has run. */
  suppressModelMetadataWarning?: boolean;
  /** Optional on purpose, like `suppressModelMetadataWarning`: a hand-built
      profile literal predates the flags, and every reader treats absence as
      "shown and enabled", which is the only safe reading. Stored rows carry
      the booleans. */
  hidden?: boolean;
  disabled?: boolean;
  /** Voice backend for calls on this profile's threads; null/absent = no say. */
  voiceProvider?: string | null;
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
    // No provider usage either, for the same reason: a Default carries no
    // credentials, so there is no provider account to ask about. The agent's
    // own probe is exactly the right reader here.
    usage: null,
    suppressModelMetadataWarning: false,
    // A Default can never be hidden or disabled: it is the agent as it ships,
    // and the one profile that must always be pickable next to the user's own.
    hidden: false,
    disabled: false,
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

/** The wire protocol this agent should speak to the endpoint; OpenAI-compatible
    unless the profile's link says otherwise. */
export function profileProtocol(profile: Profile, agentId: string): "openai" | "anthropic" {
  return profile.agents?.[agentId]?.protocol ?? "openai";
}

/** A row with the nullable columns read back as the empty
    strings the schema defaults them to. */
function toProfile(row: Record<string, unknown>): Profile {
  const { id, ...rest } = row;
  return {
    ...(rest as Omit<ProfileInput, "smallModel">),
    id: id as string,
    // A row from before the column existed reads back `{}` (the column
    // default); the migration filled every row that had an agent.
    agents: (row.agents as Record<string, ProfileAgentLink> | null | undefined) ?? {},
    smallModel: (row.smallModel as string | null | undefined) ?? "",
    logoUrl: (row.logoUrl as string | null | undefined) ?? "",
    voiceProvider: (row.voiceProvider as string | null | undefined) ?? null,
    usage: (row.usage as ProfileUsage | null | undefined) ?? null,
    suppressModelMetadataWarning: row.suppressModelMetadataWarning === true,
    hidden: row.hidden === true,
    disabled: row.disabled === true,
  };
}

/** Stored profiles only. `listProfiles` is what the API and spawning use. */
async function storedProfiles(): Promise<Profile[]> {
  const rows = await db.select().from(profilesTable);
  return rows.map((row) => toProfile(row));
}

/**
 * Every agent's virtual default, then the stored profiles.
 *
 * The default is offered for *every* agent, not just unconfigured ones: "run
 * this agent as it ships" is a real choice next to "run it on my gateway", and
 * the only way back to it once a profile exists would otherwise be deleting the
 * profile. It sorts first because it is the baseline the others depart from.
 */
export async function listProfiles(agents: { id: string; name?: string }[] = []): Promise<Profile[]> {
  const virtual = agents.map((agent) => defaultProfileFor(agent.id, agent.name));
  return [...virtual, ...(await storedProfiles())];
}

export async function getProfile(id: string): Promise<Profile | undefined> {
  if (isVirtualProfile(id)) {
    return defaultProfileFor(id.slice(DEFAULT_PROFILE_PREFIX.length));
  }
  const row = (await db.select().from(profilesTable).where(eq(profilesTable.id, id)).limit(1))[0];
  return row ? toProfile(row) : undefined;
}

/** Secrets never leave the server: each key is replaced by a boolean the client
    uses to render the "leave empty to keep it" hint. `usage.apiKey` is the
    second one — a separate dashboard token where a provider issues one — and it
    is redacted the same way rather than being sent back because it sits one
    level down in a JSON column. */
export function redact(profile: Profile) {
  const { apiKey, usage, ...rest } = profile;
  return {
    ...rest,
    usage: usage ? { kind: usage.kind, baseUrl: usage.baseUrl ?? "", hasApiKey: Boolean(usage.apiKey) } : null,
    hasApiKey: Boolean(apiKey),
  };
}

/** The columns of the profiles table. */
function columnsOf(profile: Profile) {
  const { virtual: _v, ...columns } = profile;
  return columns;
}

export async function createProfile(input: ProfileInput): Promise<Profile> {
  const profile: Profile = { id: randomUUID(), ...input };
  await db.transaction(async (tx) => {
    await tx.insert(profilesTable).values(columnsOf(profile));
  });
  return (await getProfile(profile.id))!;
}

/** The usage block as saved, with an empty `apiKey` reading as "keep the stored
    one" — the same bargain the profile's own key makes, for the same reason:
    the client is sent a boolean, so it has nothing to send back. A switch to
    another provider still keeps it, which is deliberate; changing providers is
    also how you would clear a key that no longer applies, and the alternative
    is silently dropping a credential on an unrelated edit. */
function keepUsageKey(next: ProfileInput["usage"], previous: ProfileUsage | null | undefined) {
  if (!next) return next ?? null;
  return { ...next, apiKey: next.apiKey || previous?.apiKey || "" };
}

async function saveProfileUpdate(updated: Profile): Promise<Profile> {
  await db.transaction(async (tx) => {
    await tx.update(profilesTable).set(columnsOf(updated)).where(eq(profilesTable.id, updated.id));
    /* The probe cache is keyed `profileId:agentId:cwd`, and the answer depends
       on what was just edited (a new base URL is a new gateway catalog, a new
       key may change what it serves). A stale row would keep answering the
       draft menu until someone found `?refresh=1`. */
    await tx.delete(agentOptionsTable).where(like(agentOptionsTable.key, `${updated.id}:%`));
    /* Same argument, and it did not apply before this profile could name a usage
       provider: the quota cache expires on a TTL because a quota moves on its
       own, but an edit to the credentials or the provider makes the cached
       number an answer about a different account, which no TTL covers. */
    await tx.delete(agentQuotaTable).where(like(agentQuotaTable.key, `${updated.id}:%`));
  });
  return (await getProfile(updated.id))!;
}

export async function updateProfile(id: string, input: ProfileInput): Promise<Profile | undefined> {
  if (isVirtualProfile(id)) return undefined;
  const existing = (await db.select().from(profilesTable).where(eq(profilesTable.id, id)).limit(1))[0];
  if (!existing) return undefined;
  // Empty apiKey in an update means "keep the stored key" (the client never sees it).
  const updated: Profile = {
    ...input,
    id,
    apiKey: input.apiKey || existing.apiKey,
    usage: keepUsageKey(input.usage, existing.usage),
  };
  return saveProfileUpdate(updated);
}

/** Replace a destination profile from a one-way sync. Credentials are preserved
    when excluded, and replaced exactly (including clearing) when explicitly
    included. */
export async function syncProfile(
  id: string,
  input: ProfileInput,
  includeSecrets: boolean,
): Promise<Profile | undefined> {
  if (!id.startsWith("sync:") || isVirtualProfile(id)) return undefined;
  const existing = (await db.select().from(profilesTable).where(eq(profilesTable.id, id)).limit(1))[0];
  if (!existing) {
    const created: Profile = { id, ...input };
    await db.insert(profilesTable).values(columnsOf(created));
    return await getProfile(id);
  }
  const updated: Profile = {
    ...input,
    id,
    apiKey: includeSecrets ? input.apiKey : existing.apiKey,
    usage: includeSecrets
      ? input.usage ?? null
      : keepUsageKey(input.usage, existing.usage),
  };
  return saveProfileUpdate(updated);
}

/** Export a stored profile for a deliberate cross-server copy. */
export async function exportProfile(id: string, includeSecrets: boolean): Promise<ProfileInput | undefined> {
  const profile = await getProfile(id);
  if (!profile || profile.virtual) return undefined;
  const { id: _id, virtual: _virtual, ...input } = profile;
  return {
    ...input,
    smallModel: input.smallModel ?? "",
    suppressModelMetadataWarning: input.suppressModelMetadataWarning ?? false,
    hidden: input.hidden ?? false,
    disabled: input.disabled ?? false,
    apiKey: includeSecrets ? input.apiKey : "",
    usage: input.usage
      ? { ...input.usage, apiKey: includeSecrets ? input.usage.apiKey ?? "" : "" }
      : null,
  };
}

/**
 * Flip only the selection flags, for the list's switches.
 *
 * A dedicated write rather than a `PUT` of the whole row: a profile's payload
 * carries credentials the client never holds (`redact` sends `hasApiKey`), so a
 * toggle that round-tripped through the editor would have to mean "keep the
 * stored key" the same way a blank field does. One column, one route, nothing
 * else touched — and no probe or quota eviction, because neither flag changes
 * the endpoint nor the account the cached reading is about.
 */
export async function setProfileFlags(
  id: string,
  flags: { hidden?: boolean; disabled?: boolean; smallModel?: string; voiceProvider?: string },
): Promise<Profile | undefined> {
  if (isVirtualProfile(id)) return undefined;
  const patch: { hidden?: boolean; disabled?: boolean; smallModel?: string; voiceProvider?: string | null } = {};
  if (flags.voiceProvider !== undefined) patch.voiceProvider = flags.voiceProvider || null;
  if (flags.hidden !== undefined) patch.hidden = flags.hidden;
  if (flags.disabled !== undefined) patch.disabled = flags.disabled;
  if (flags.smallModel !== undefined) patch.smallModel = flags.smallModel.trim();
  if (Object.keys(patch).length === 0) return await getProfile(id);
  const result = await db.update(profilesTable).set(patch).where(eq(profilesTable.id, id));
  if ((result.rowCount ?? 0) === 0) return undefined;
  return await getProfile(id);
}

/**
 * A copy of a stored profile, credentials included, under a fresh id.
 *
 * Server-side because `redact` is: the client is sent `hasApiKey` and never the
 * key, so a duplicate assembled in the browser would come back keyless — the
 * same argument the flags PATCH and the `/models` append make. The virtual
 * Default has nothing to copy (no credentials, no catalog) and is refused.
 *
 * The copy is hidden from the pickers until it is edited: a duplicate exists to
 * be changed, and two identically-named profiles in the composer is the one
 * outcome nobody wants.
 */
export async function duplicateProfile(id: string): Promise<Profile | undefined> {
  const source = await getProfile(id);
  if (!source || source.virtual) return undefined;
  const { id: _id, virtual: _virtual, ...input } = source;
  return await createProfile({
    ...input,
    name: `${source.name} (copy)`,
    smallModel: source.smallModel ?? "",
    suppressModelMetadataWarning: source.suppressModelMetadataWarning ?? false,
    hidden: true,
    disabled: source.disabled ?? false,
  });
}

export async function deleteProfile(id: string): Promise<boolean> {
  if (isVirtualProfile(id)) return false;
  return ((await db.delete(profilesTable).where(eq(profilesTable.id, id))).rowCount ?? 0) > 0;
}
