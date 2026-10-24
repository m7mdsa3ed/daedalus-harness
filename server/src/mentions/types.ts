import type { MentionKind } from "./grammar.js";

/** What a resolver is told about the message it is reading for. */
export interface MentionContext {
  projectId: string;
  /** The thread the message is for. Absent on a draft that has no row yet. */
  sessionId?: string;
  /** The thread's working directory (its worktree when it has one). */
  cwd: string;
  /** Characters this resolver's blocks may add up to, together. `expandMentions`
      truncates to a fair share regardless; this is so a resolver can avoid
      reading what would be thrown away. */
  budget: number;
  /** Reads a resource of one of the thread's MCP servers as text (`@mcp:`).
      Absent on a draft, which has no thread whose servers could be read. */
  readMcpResource?: (serverId: string, uri: string) => Promise<string | null>;
}

/** One mentioned thing, as the agent will read it. */
export interface MentionBlock {
  /** The `ref` of the `@kind:ref` this answers. */
  ref: string;
  /** Plain text. Free text is fine: `expandMentions` neutralises our own tags. */
  body: string;
  /** The tool that reads the rest, named in the truncation hint
      (`… (truncated — read more via <readMore>)`). */
  readMore?: string;
}

export interface MentionResolution {
  blocks: MentionBlock[];
  /** Refs this resolver recognised as its own (even one it could not read), so
      the file linker never also looks for them as paths. */
  claimed: string[];
}

/** One kind's reader. A resolver never throws for "not found" — it leaves the
    ref out of `blocks`; a throw is a failure and is logged and skipped. */
export interface MentionResolver {
  /** A `MentionKind`, or `file` for `@path:from-to` (not a kind a person types). */
  readonly kind: MentionKind | "file";
  resolve(refs: string[], ctx: MentionContext): Promise<MentionResolution>;
}

/** The empty answer every stub gives until its track lands. */
export const NOTHING: MentionResolution = { blocks: [], claimed: [] };
