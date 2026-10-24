/* The server's mention registry: every kind's resolver, listed once. A new kind
   is its resolver file and one line here (plus the kind in `grammar.ts` and the
   client's copy). */
import { expandMentionsWith, type ExpandScope } from "./expand.js";
import type { MentionResolver } from "./types.js";
import { fileRangeResolver } from "./resolvers/file-range.js";
import { gitResolvers } from "./resolvers/git.js";
import { kbResolver } from "./resolvers/kb.js";
import { mcpResolver } from "./resolvers/mcp.js";
import { runResolver } from "./resolvers/run.js";
import { termResolver } from "./resolvers/term.js";
import { threadResolver } from "./resolvers/thread.js";

export const RESOLVERS: readonly MentionResolver[] = [
  threadResolver,
  fileRangeResolver,
  ...gitResolvers,
  runResolver,
  kbResolver,
  termResolver,
  mcpResolver,
];

export function expandMentions(text: string, ctx: ExpandScope) {
  return expandMentionsWith(RESOLVERS, text, ctx);
}

export { CONTEXT_BUDGET, MAX_MENTIONS } from "./expand.js";
export { MENTION_KINDS, kindMentions, parseKindToken, parseRangeToken, rangeMentions, type MentionKind } from "./grammar.js";
export type { MentionBlock, MentionContext, MentionResolution, MentionResolver } from "./types.js";
