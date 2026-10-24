/* Resolver for `@thread:<id>` and `@thread:<id>#turn-N`: a recap of another
   thread read from its journal (`../thread-recap.ts`). An unknown or deleted
   id, or a turn the thread does not have, answers nothing — the token stays as
   plain text. */
import type { MentionResolver } from "../types.js";
import { buildRecap, findThreadId, loadThread, parseThreadRef, RECAP_CAP } from "../thread-recap.js";

export const threadResolver: MentionResolver = {
  kind: "thread",
  async resolve(refs, ctx) {
    // Every thread ref is ours, found or not: none of them is ever a path.
    const out = { blocks: [] as { ref: string; body: string; readMore: string }[], claimed: [...refs] };
    const cap = Math.min(RECAP_CAP, Math.max(Math.floor(ctx.budget / Math.max(refs.length, 1)), 500));
    for (const ref of refs) {
      const parsed = parseThreadRef(ref);
      const id = await findThreadId(parsed.id);
      const thread = id ? await loadThread(id) : null;
      const body = thread ? buildRecap(thread, parsed.turn, cap) : null;
      if (body) out.blocks.push({ ref, body, readMore: "the user (this thread's journal is not readable by you)" });
    }
    return out;
  },
};
