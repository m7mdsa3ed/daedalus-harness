/* ── `@kind:ref` expansion ──
 *
 * A typed mention reaches the agent as the thing it names. At send the composer
 * posts the message to `POST /api/mentions/context` and appends the answer, the
 * way it appends a task's `<tasks>` block — so the transcript holds exactly
 * what the agent was sent, and the bubble folds the block back into a popover
 * on each chip (`client/src/lib/mentions/context.ts`).
 *
 * The block:
 *
 *     <context>
 *     The message above mentions 2 items. …
 *     <mention kind="thread" ref="abc123">
 *     …body…
 *     </mention>
 *     <mention kind="git" ref="changes">
 *     …body…
 *     </mention>
 *     </context>
 *
 * One output budget is shared by every mention in the message (not one per
 * resolver): the smallest bodies keep all they have and the rest split what is
 * left evenly, so one huge diff cannot starve a one-line thread. A body cut to
 * its share ends in a hint naming the tool that has the rest.
 */
import { kindMentions, rangeMentions, type KindMention, type RangeMention } from "./grammar.js";
import type { MentionBlock, MentionContext, MentionResolver } from "./types.js";

/** Characters of body, in total, one message's mentions may add. */
export const CONTEXT_BUDGET = 30_000;
/** Past this a message is pasting references, not mentioning them. */
export const MAX_MENTIONS = 20;

/** Free text never closes — or reopens — the block it sits in: the bubble
    finds the block by its tags. */
export const safe = (text: string) => text.replace(/<(\/?)(mention|context)(?=[\s>/])/gi, "<$1 $2");
const attr = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Shares of `total` for bodies of these lengths: whoever needs less than an
    even split keeps all of it, and the surplus is divided among the rest. */
export function allocate(sizes: number[], total: number): number[] {
  const shares = sizes.map(() => 0);
  let left = Math.max(total, 0);
  const order = sizes.map((_, i) => i).sort((a, b) => sizes[a]! - sizes[b]!);
  order.forEach((index, rank) => {
    const give = Math.min(sizes[index]!, Math.floor(left / (order.length - rank)));
    shares[index] = give;
    left -= give;
  });
  return shares;
}

function clip(block: MentionBlock, max: number): string {
  const body = block.body.trim();
  if (body.length <= max) return body;
  const hint = `… (truncated — ${block.readMore ? `read more via ${block.readMore}` : "the rest is omitted"})`;
  return `${body.slice(0, Math.max(max - hint.length, 0)).trimEnd()}${hint}`;
}

export interface ExpandScope {
  projectId: string;
  sessionId?: string;
  cwd: string;
  /** Total budget for the message; `CONTEXT_BUDGET` when absent. */
  budget?: number;
  /** See `MentionContext.readMcpResource`. */
  readMcpResource?: MentionContext["readMcpResource"];
}

/**
 * The text to append to a prompt for every `@kind:ref` it mentions, and the
 * `kind:ref` tokens that were claimed (so `mentionLinks` does not also look
 * for them as files). A kind with no resolver, an unknown ref and a resolver
 * that throws all leave the message as typed.
 */
export async function expandMentionsWith(
  resolvers: readonly MentionResolver[],
  text: string,
  scope: ExpandScope,
): Promise<{ text: string; claimed: Set<string> }> {
  const claimed = new Set<string>();
  const mentions: (KindMention | RangeMention)[] = [...kindMentions(text), ...rangeMentions(text)].slice(0, MAX_MENTIONS);
  if (mentions.length === 0) return { text: "", claimed };
  const total = scope.budget ?? CONTEXT_BUDGET;

  const byKind = new Map<string, (KindMention | RangeMention)[]>();
  for (const mention of mentions) byKind.set(mention.kind, [...(byKind.get(mention.kind) ?? []), mention]);

  const found = new Map<string, MentionBlock>();
  await Promise.all(
    resolvers.map(async (resolver) => {
      const wanted = byKind.get(resolver.kind);
      if (!wanted) return;
      const refs = wanted.map((m) => m.ref);
      const ctx: MentionContext = {
        projectId: scope.projectId,
        sessionId: scope.sessionId,
        cwd: scope.cwd,
        readMcpResource: scope.readMcpResource,
        budget: Math.floor((total * refs.length) / mentions.length),
      };
      try {
        const out = await resolver.resolve(refs, ctx);
        for (const block of out.blocks) {
          if (refs.includes(block.ref) && block.body.trim()) found.set(`${resolver.kind}:${block.ref}`, block);
        }
        for (const ref of out.claimed) if (refs.includes(ref)) claimed.add(`${resolver.kind}:${ref}`);
      } catch (error) {
        console.log(`[mentions] ${resolver.kind}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
  );

  const ordered = mentions.filter((m) => found.has(m.token));
  if (ordered.length === 0) return { text: "", claimed };
  const blocks = ordered.map((m) => found.get(m.token)!);
  const shares = allocate(
    blocks.map((b) => b.body.trim().length),
    total,
  );
  const parts = ordered.map(
    (m, i) =>
      `<mention kind="${m.kind}" ref="${attr(m.ref)}">\n${safe(clip(blocks[i]!, shares[i]!))}\n</mention>`,
  );
  const many = parts.length === 1 ? "an item" : `${parts.length} items`;
  return {
    text: [
      "",
      "",
      "<context>",
      `The message above mentions ${many} by reference. ${parts.length === 1 ? "Its" : "Their"} content is below, read as this message was sent — work from it directly. A part marked truncated names the tool that has the rest.`,
      ...parts,
      "</context>",
    ].join("\n"),
    claimed,
  };
}
