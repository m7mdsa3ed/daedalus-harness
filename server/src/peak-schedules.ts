import { eq } from "drizzle-orm";
import { appSettings, db, profiles as profilesTable, type ModelDef } from "./db/index.js";
import type { PeakSchedule } from "./peak.js";

/**
 * The published time-of-day rate cards, applied to models already in the
 * catalogue.
 *
 * A preset stamps its schedule onto the models it fills (`profile-presets.ts`),
 * but a profile saved before `ModelDef.peak` existed has none — and the point of
 * the badge is that it works on the profiles a person already has, not only on
 * one they make again. So the families whose pricing genuinely moves with the
 * clock are named here once, matched by **family** rather than by exact id (a
 * gateway prefixes its ids — `cmd/deepseek/deepseek-v4.1-flash`,
 * `cc/claude-sonnet-5-5` — and a fork renames them), and stamped onto every
 * model that matches and has no schedule yet.
 *
 * **Only the two families that actually bill this way are here.** Checked
 * against the providers' own rate cards, October 2026:
 *
 *   - DeepSeek — peak is 01:00-04:00 and 06:00-10:00 UTC, Monday to Friday, at
 *     twice the off-peak rate. Weekends and Chinese public holidays are
 *     off-peak all day. (`api-docs.deepseek.com/quick_start/pricing`)
 *   - Z.AI / Zhipu GLM coding plans — peak is Mon-Fri 14:00-18:00 Singapore
 *     time, and everything else bills at 50% of the standard credit rate.
 *     (`docs.z.ai/devpack/overview`)
 *
 * Deliberately absent, because a schedule is a billing fact and an invented one
 * is worse than none:
 *
 *   - **Anthropic** — the 5am-11am PT peak-hour reduction on Claude Code was
 *     *removed* on 2026-05-06 (`anthropic.com/news/higher-limits-spacex`). API
 *     token rates have no time component.
 *   - **OpenAI** — Batch and Fast are tiers you choose, not hours that arrive.
 *   - **Mistral** — Batch and Priority likewise; no time-of-day card.
 *   - **Alibaba/Qwen** — night discounts exist, but on the *credit* plans and
 *     region by region rather than on the token rate card this harness prices
 *     against, so a schedule here would be a guess about which plan a key is
 *     on. A profile on a Token Plan can carry one of its own through the editor.
 */

/** One published rate card, and how to recognise the models it prices. */
interface KnownSchedule {
  /** A word for the log line, never shown in the UI. */
  label: string;
  /** Matched against the model's own leaf name, lower-cased. */
  match: RegExp;
  /** The schedule. `windows` is written in the zone the provider publishes it
      in, so a reader can compare it with the docs unchanged. */
  peak: PeakSchedule;
}

export const KNOWN_PEAK_SCHEDULES: KnownSchedule[] = [
  {
    label: "DeepSeek",
    /* `deepseek-v4-pro`, `deepseek-v4.1-flash`, `deepseek/deepseek-v4-pro`,
       `cmd/deepseek/deepseek-v4.1-flash` — any path, any version, either model
       family. `deepseek-web/` is an agent wrapper, not a token-billed model, and
       is excluded below by the absence of a `pricing` row. */
    match: /(^|\/)deepseek[-.]?v?\d*(\.\d+)?[-.]?(pro|flash|chat|reasoner)?$/i,
    peak: { windows: "Mon-Fri 01:00-04:00, 06:00-10:00 UTC", when: "peak", multiplier: 2 },
  },
  {
    label: "Z.AI GLM coding plan",
    match: /(^|\/)(z-ai\/)?glm[-.]?[45]/i,
    peak: { windows: "Mon-Fri 14:00-18:00 Asia/Singapore", when: "peak", multiplier: 2 },
  },
];

/** The card a model id falls under, when one does. The leaf is what matches, so
    a gateway's `cmd/` prefix or a namespace's `z-ai/` is not part of the test. */
export function knownPeakFor(id: string): PeakSchedule | null {
  const leaf = id.split("/").pop() ?? id;
  /* A free tier is a different product with no rate card at all — the gateways
     here serve `oc/deepseek-v4.1-flash-free` beside the paid id, and stamping a
     peak multiplier onto something that bills nothing would be a badge about a
     price that is not being paid. */
  if (/-free$/i.test(leaf) || /-free\//i.test(id)) return null;
  for (const known of KNOWN_PEAK_SCHEDULES) {
    if (known.match.test(leaf) || known.match.test(id)) return { ...known.peak };
  }
  return null;
}

const DONE_KEY = "peakSchedulesBackfilled";

/**
 * Stamp the published rate cards onto the models a profile already holds.
 *
 * Once, at boot, and only onto entries that have no `peak` of their own: a
 * schedule the user wrote is the user's, exactly as `seedAgents` leaves a
 * repointed `command` alone. A model with no `pricing` row is skipped too — it
 * is either free or a wrapper, and a multiplier on a price nobody pays is noise.
 */
export async function backfillPeakSchedules(): Promise<number> {
  const done = (
    await db.select().from(appSettings).where(eq(appSettings.key, DONE_KEY)).limit(1)
  )[0];
  if (done) return 0;

  let stamped = 0;
  const rows = await db.select({ id: profilesTable.id, models: profilesTable.models }).from(profilesTable);
  for (const row of rows) {
    const models: ModelDef[] = row.models ?? [];
    let changed = false;
    const next = models.map((model) => {
      if (model.peak || !model.pricing) return model;
      const peak = knownPeakFor(model.id);
      if (!peak) return model;
      changed = true;
      stamped += 1;
      return { ...model, peak };
    });
    if (changed) await db.update(profilesTable).set({ models: next }).where(eq(profilesTable.id, row.id));
  }

  await db.insert(appSettings).values({ key: DONE_KEY, value: "1" }).onConflictDoNothing();
  return stamped;
}
