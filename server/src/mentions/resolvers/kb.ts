/* Resolver for `@kb:<id>`: a knowledge-base entry of this project, inlined —
   title, tags and content. Scoped by project like every knowledge query, so a
   ref from another workspace answers nothing. The ref is the entry's id or a
   unique prefix of it (the menu inserts eight characters). */
import { and, desc, eq, like } from "drizzle-orm";
import { db, knowledge } from "../../db/index.js";
import type { MentionResolver } from "../types.js";

export const ID_PREFIX = /^[0-9a-f-]{6,36}$/i;

export async function knowledgeEntry(projectId: string, ref: string) {
  if (!ID_PREFIX.test(ref)) return null;
  const rows = await db
    .select()
    .from(knowledge)
    .where(and(eq(knowledge.projectId, projectId), like(knowledge.id, `${ref.toLowerCase()}%`)))
    .limit(2);
  // An ambiguous prefix is no answer: guessing would hand the agent the wrong note.
  return rows.length === 1 ? rows[0]! : null;
}

export async function recentKnowledge(projectId: string, limit = 50) {
  return db.select().from(knowledge).where(eq(knowledge.projectId, projectId)).orderBy(desc(knowledge.updatedAt)).limit(limit);
}

export const kbResolver: MentionResolver = {
  kind: "kb",
  async resolve(refs, ctx) {
    const blocks = [];
    for (const ref of refs) {
      const entry = await knowledgeEntry(ctx.projectId, ref);
      if (!entry) continue;
      const tags = entry.tags?.length ? `Tags: ${entry.tags.join(", ")}\n` : "";
      blocks.push({ ref, body: `${entry.title}\n${tags}\n${entry.content}`, readMore: "the `knowledge` MCP server (knowledge_search)" });
    }
    return { blocks, claimed: [...refs] };
  },
};
