import { eq } from "drizzle-orm";
import { appSettings, db, type ModelDef } from "./db/index.js";
import { HttpError } from "./http-error.js";
import { getProfile, listProfiles, type Profile } from "./profiles.js";

/* ── Side models: one (profile, model) default per lane ──
 *
 * A side model is a model the harness uses for something that is not a thread:
 * a completion that finishes the line being typed (`docs/plans/fim-composer.md`),
 * a decision that answers typed questions (`docs/plans/model-kinds.md`). Both
 * are a row inside a profile, so the choice is a fact about this install's
 * catalogue rather than about one browser: it lives in `app_settings` under one
 * key per lane, every device reads the same answer, and — because a user-authored
 * single value is *data* — it travels in a backup bundle.
 *
 * One implementation, two lanes: the pair is chosen, validated, stored and
 * resolved identically, and what differs is the kind and the wire a lane
 * accepts. A third lane would be a row in `LANES`, not a second module.
 *
 * **Resolution happens on every read, never from a cached id.** A stored profile
 * can be deleted, disabled or emptied between the pick and the keystroke, so
 * `sideDefault` re-resolves each time and falls back to the first candidate it
 * can see. Nothing calling a side model should ever spend a 500 on a row
 * somebody deleted.
 */

export type SideLane = "completion" | "decision";

/** What a lane is, in the words its surfaces use. `key` is the `app_settings`
 *  row: `fim` is the completion lane's and predates the generalisation, so it
 *  keeps its name rather than moving a stored value for tidiness. */
const LANES: Record<SideLane, { kind: "completion" | "decision"; wires: readonly string[]; key: string; noun: string }> = {
  completion: { kind: "completion", wires: ["openai-completions"], key: "fim", noun: "completion" },
  /* Both System One doors: the editor offers `systemone-gateway` for a decision
     model, and a lane that accepted only `systemone` never listed it. */
  decision: { kind: "decision", wires: ["systemone", "systemone-gateway"], key: "decision", noun: "decision" },
};

export const SIDE_LANES = Object.keys(LANES) as SideLane[];

/** One choice, as the settings page and the route both carry it. */
export interface SideChoice {
  profileId: string;
  profileName: string;
  model: string;
  label: string;
}

/** Where a choice came from: stored by someone, or the fallback this server
    picked because nothing is stored (yet). */
export type SideSource = "explicit" | "fallback";

export interface SideDefault {
  default: SideChoice | null;
  source: SideSource | null;
}

/** A model this lane can actually call: the lane's kind, and a wire it speaks. */
function callable(profile: Profile, lane: SideLane): ModelDef[] {
  const spec = LANES[lane];
  return profile.models.filter((model) => model.kind === spec.kind && !!model.wire && spec.wires.includes(model.wire));
}

/** Every callable model on one profile, in catalogue order. */
function choicesOf(profile: Profile, lane: SideLane): SideChoice[] {
  return callable(profile, lane).map((model) => ({
    profileId: profile.id,
    profileName: profile.name,
    model: model.id,
    label: model.label || model.id,
  }));
}

/** Every model the server could be told to use for this lane, in profile order. */
export async function sideCandidates(lane: SideLane): Promise<SideChoice[]> {
  const profiles = await listProfiles();
  return profiles
    .filter((p) => !p.virtual && !p.hidden && !p.disabled && (p.baseUrl ?? "").trim().length > 0)
    .flatMap((p) => choicesOf(p, lane));
}

/** The stored choice, read defensively: a row somebody hand-edited is "nothing
 *  stored", not a crash on every keystroke. */
async function readStored(lane: SideLane): Promise<{ profileId: string; model: string } | null> {
  const row = (await db.select().from(appSettings).where(eq(appSettings.key, LANES[lane].key)).limit(1))[0];
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as { profileId?: unknown; model?: unknown };
    if (typeof parsed?.profileId !== "string" || typeof parsed?.model !== "string") return null;
    if (!parsed.profileId || !parsed.model) return null;
    return { profileId: parsed.profileId, model: parsed.model };
  } catch {
    return null;
  }
}

/**
 * What answers this lane right now: the stored choice when it still resolves,
 * else the first callable model on the first visible profile, else nothing.
 *
 * The fallback is what makes an unconfigured install work — a profile seeded with
 * a completion model answers before anyone picks — and `source` says which of the
 * two this was, so a page can draw a fallback as the thing that runs rather than
 * as a choice nobody made.
 */
export async function sideDefault(lane: SideLane): Promise<SideDefault> {
  const stored = await readStored(lane);
  const candidates = await sideCandidates(lane);
  if (stored) {
    const found = candidates.find((c) => c.profileId === stored.profileId && c.model === stored.model);
    if (found) return { default: found, source: "explicit" };
  }
  const fallback = candidates[0] ?? null;
  return { default: fallback, source: fallback ? "fallback" : null };
}

/**
 * Store the choice, or clear it with `null`.
 *
 * Everything is checked on the way *in* as well as on the way out: a stored row
 * naming a chat model would be refused on every call, so it is refused here —
 * where the person who can fix it is looking.
 */
export async function setSideDefault(
  lane: SideLane,
  choice: { profileId: string; model: string } | null,
): Promise<SideDefault> {
  const spec = LANES[lane];
  if (choice === null) {
    await db.delete(appSettings).where(eq(appSettings.key, spec.key));
    return await sideDefault(lane);
  }
  const profile = await getProfile(choice.profileId);
  if (!profile) throw new HttpError(`unknown profile: ${choice.profileId}`, 404);
  if (profile.virtual) throw new HttpError("the Default profile has no endpoint", 409);
  if (!(profile.baseUrl ?? "").trim()) throw new HttpError("that profile has no base URL", 409);

  const entry = profile.models.find((model) => model.id === choice.model);
  if (!entry) throw new HttpError(`that profile has no model "${choice.model}"`, 404);
  if ((entry.kind ?? "chat") !== spec.kind) {
    throw new HttpError(`"${choice.model}" is not a ${spec.noun} model`, 400);
  }
  if (!entry.wire || !spec.wires.includes(entry.wire)) {
    throw new HttpError(`"${choice.model}" has no ${spec.wires.join(" or ")} wire, so nothing here could call it`, 400);
  }

  const value = JSON.stringify({ profileId: profile.id, model: entry.id });
  await db
    .insert(appSettings)
    .values({ key: spec.key, value })
    .onConflictDoUpdate({ target: appSettings.key, set: { value } });
  return await sideDefault(lane);
}

/**
 * Which profile and model a call should use.
 *
 * Neither named means the default — so a caller's request carries only its own
 * input, and cannot name a profile it has no business naming. Both named is a
 * settings page proving a candidate before saving it. One without the other is a
 * mistake worth saying out loud rather than guessing a pairing nobody meant.
 */
export async function sideTarget(
  lane: SideLane,
  opts: { profileId?: string; model?: string },
): Promise<{ profile: Profile; model: string }> {
  const profileId = opts.profileId?.trim();
  const model = opts.model?.trim();
  if (profileId && !model) throw new HttpError("a model is required beside a profile", 400);
  if (model && !profileId) throw new HttpError("a profile is required beside a model", 400);

  if (profileId && model) {
    const profile = await getProfile(profileId);
    if (!profile) throw new HttpError(`unknown profile: ${profileId}`, 404);
    return { profile, model };
  }

  const resolved = await sideDefault(lane);
  if (!resolved.default) {
    const noun = LANES[lane].noun;
    throw new HttpError(`no ${noun} model is chosen — pick one in Settings, under AI`, 409);
  }
  const profile = await getProfile(resolved.default.profileId);
  if (!profile) throw new HttpError(`the chosen ${LANES[lane].noun} profile no longer exists`, 409);
  return { profile, model: resolved.default.model };
}

/* ── The persona question's thresholds ──
 *
 * A decision answers with a distribution, so "pick the top label" is not a
 * decision: the pick must clear `minProbability` and beat the runner-up by
 * `margin` (`persona-classify.ts`). They are the persona question's numbers, not
 * the lane's — the lane is install-wide and will have other consumers — so they
 * are their own `app_settings` key, read as defensively as `readStored`: a row
 * somebody hand-edited is the defaults, never a crash on a first send.
 */
export interface PersonaDecisionThresholds {
  minProbability: number;
  margin: number;
}

export const PERSONA_DECISION_DEFAULTS: PersonaDecisionThresholds = { minProbability: 0.5, margin: 0.15 };
const PERSONA_DECISION_KEY = "personaDecision";

const unit = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;

export async function readPersonaDecision(): Promise<PersonaDecisionThresholds> {
  const row = (await db.select().from(appSettings).where(eq(appSettings.key, PERSONA_DECISION_KEY)).limit(1))[0];
  if (!row) return PERSONA_DECISION_DEFAULTS;
  try {
    const parsed = JSON.parse(row.value) as { minProbability?: unknown; margin?: unknown } | null;
    return {
      minProbability: unit(parsed?.minProbability, PERSONA_DECISION_DEFAULTS.minProbability),
      margin: unit(parsed?.margin, PERSONA_DECISION_DEFAULTS.margin),
    };
  } catch {
    return PERSONA_DECISION_DEFAULTS;
  }
}

/** Store the thresholds; a number outside 0..1 is refused where the person is looking. */
export async function setPersonaDecision(next: Partial<PersonaDecisionThresholds>): Promise<PersonaDecisionThresholds> {
  for (const [name, value] of Object.entries(next)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new HttpError(`${name} must be a number from 0 to 1`, 400);
    }
  }
  const merged = { ...(await readPersonaDecision()), ...next };
  const value = JSON.stringify(merged);
  await db
    .insert(appSettings)
    .values({ key: PERSONA_DECISION_KEY, value })
    .onConflictDoUpdate({ target: appSettings.key, set: { value } });
  return merged;
}
