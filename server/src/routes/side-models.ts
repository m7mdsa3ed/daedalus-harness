import type { Hono } from "hono";
import { z } from "zod";
import { sideCandidates, sideDefault, SIDE_LANES, setSideDefault, type SideLane } from "../side-models.js";

/** The install's choice of which (profile, model) answers a side lane: the
    composer's completion (`/api/fim`) and a decision (`/api/decision`). Same
    three doors each, because they are the same question asked about a different
    kind — see `side-models.ts`. The completion lane's *call* is its own route
    (`routes/fim.ts`); a decision has no call until something asks one. */

const ChoiceSchema = z.object({
  profileId: z.string().min(1),
  model: z.string().min(1),
});

/** Where each lane answers. The completion lane keeps `/api/fim`, which is what
    it was called before there was a second lane. */
const PATHS: Record<SideLane, string> = {
  completion: "/api/fim",
  decision: "/api/decision",
};

export function sideModelRoutes(app: Hono): void {
  for (const lane of SIDE_LANES) {
    const path = PATHS[lane];

    /* The choice, and everything it could be — one read, so a settings row draws
       its pickers and its current answer from the same snapshot. */
    app.get(path, async (c) =>
      c.json({ ...(await sideDefault(lane)), candidates: await sideCandidates(lane) }),
    );

    app.put(path, async (c) => {
      const parsed = ChoiceSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json({ error: "profileId and model are required" }, 400);
      return c.json(await setSideDefault(lane, parsed.data));
    });

    /* Back to the fallback — never to "no default", since the fallback is what an
       unconfigured install runs on. */
    app.delete(path, async (c) => c.json(await setSideDefault(lane, null)));
  }
}
