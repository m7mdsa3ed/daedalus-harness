import type { Hono } from "hono";
import { z } from "zod";
import { fillMiddle } from "../fim.js";
import { sideTarget } from "../side-models.js";

/** The composer's completion call (`docs/plans/fim-composer.md`). The choice of
    which profile and model answer it is the side-model lane's, and lives in
    `routes/side-models.ts` beside the decision lane's — both are `/api/fim` and
    `/api/decision` reads of the same shape. */

/** A prompt longer than this is a document, not a gap. The composer's own slice
    is far smaller; the ceiling is here so a hand call cannot bill a novel. */
const MAX_PROMPT = 8_000;
const MAX_SUFFIX = 8_000;

const CallSchema = z.object({
  /** Both absent = the stored default. Both present = a named candidate, which
      is how a settings row proves one before saving it. */
  profileId: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  prompt: z.string(),
  /** The thread recap (`lib/thread/recap.ts`): optional, capped, and only ever a
      hint — a completion still stands on the text either side of the caret. */
  context: z.string().optional(),
  suffix: z.string().optional(),
  maxTokens: z.number().int().optional(),
  /** Absent means a newline — one line, which is what a `!` command wants. */
  stop: z.array(z.string()).max(8).optional(),
});

export function fimRoutes(app: Hono): void {
  /* One completion. Not a turn: nothing is journaled, queued or sent to an
     agent, and a client that navigated away aborts it (`c.req.raw.signal`) —
     a composer that moved on should not raise an error about it. */
  app.post("/api/fim", async (c) => {
    const parsed = CallSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "prompt is required" }, 400);
    const { profileId, model, prompt, context, suffix, maxTokens, stop } = parsed.data;

    if (prompt.length + (context?.length ?? 0) > MAX_PROMPT) {
      return c.json({ error: `there is too much text to complete (${MAX_PROMPT} characters at most)` }, 413);
    }
    if ((suffix?.length ?? 0) > MAX_SUFFIX) {
      return c.json({ error: `there is too much text after the gap (${MAX_SUFFIX} characters at most)` }, 413);
    }

    const target = await sideTarget("completion", { profileId, model });
    const result = await fillMiddle(target.profile, {
      model: target.model,
      prompt,
      context,
      suffix,
      maxTokens,
      stop,
      signal: c.req.raw.signal,
    });
    return c.json({ ...result, profileId: target.profile.id });
  });
}
