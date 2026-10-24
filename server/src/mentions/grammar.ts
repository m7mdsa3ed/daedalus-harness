/* ── The `@` token grammar, server half ──
 *
 * Two shapes ride in a prompt as `@token`:
 *   - `@path`      a file or directory (the original shape; `mentions.ts` links it),
 *   - `@kind:ref`  a typed reference — a thread, a commit, a run… — which the
 *                  composer expands at send into a `<context>` block
 *                  (`mentions/expand.ts`).
 *
 * A kind is **two or more lowercase letters, then a colon**, and one of
 * `MENTION_KINDS`. That is what keeps `C:\x` and `C:/x` (one uppercase letter)
 * and an unknown `foo:bar` reading as what they always were. The client keeps a
 * byte-identical copy of this list in `client/src/lib/mentions/grammar.ts`
 * (`test:mentions` fails when the two drift) — it cannot import the server.
 */

/** A token after a whitespace boundary: `@` then a run of non-space. The
    boundary is what keeps `user@example.com` from reading as a mention. */
export const MENTION_RE = /(?:^|[\s(])@([^\s@]+)/g;

/** Punctuation a sentence puts after a path but which is never part of one. */
export const TRAILING = /[.,;:!?)\]}'"]+$/;

/** Every kind `@kind:ref` understands. Adding one is this list, the client's
    copy, and a resolver registered in `mentions/index.ts`. */
export const MENTION_KINDS = ["thread", "commit", "branch", "tag", "git", "run", "kb", "term", "mcp"] as const;
export type MentionKind = (typeof MENTION_KINDS)[number];

export const isMentionKind = (value: string): value is MentionKind =>
  (MENTION_KINDS as readonly string[]).includes(value);

const KIND_TOKEN = /^([a-z]{2,}):(.+)$/;

/** `thread:abc` → `{kind:"thread", ref:"abc"}`; null for an unknown kind, an
    empty ref, or anything that is not shaped like one. The token must already
    be cleaned of trailing punctuation. */
export function parseKindToken(token: string): { kind: MentionKind; ref: string } | null {
  const match = KIND_TOKEN.exec(token);
  if (!match || !isMentionKind(match[1]!)) return null;
  return { kind: match[1], ref: match[2]! };
}

export interface KindMention {
  kind: MentionKind;
  ref: string;
  /** `kind:ref` — the form `claimed` sets and `mentionLinks`' skip set use. */
  token: string;
}

/** Every distinct `@kind:ref` in `text`, in order of first appearance. */
export function kindMentions(text: string): KindMention[] {
  const seen = new Map<string, KindMention>();
  for (const match of text.matchAll(MENTION_RE)) {
    const token = match[1]!.replace(TRAILING, "");
    const parsed = parseKindToken(token);
    if (parsed && !seen.has(token)) seen.set(token, { ...parsed, token });
  }
  return [...seen.values()];
}

/** `src/a.ts:40-80` (or `:40`) → the file and the lines. A path that carries
    a drive (`C:\x`) has no digits after its colon, so it is never one. */
const RANGE_TOKEN = /^(.+?):(\d+)(?:-(\d+))?$/;

export function parseRangeToken(token: string): { path: string; from: number; to: number } | null {
  const match = RANGE_TOKEN.exec(token);
  if (!match || parseKindToken(token)) return null;
  const from = Number(match[2]);
  const to = match[3] === undefined ? from : Number(match[3]);
  return from >= 1 && to >= from ? { path: match[1]!, from, to } : null;
}

export interface RangeMention {
  /** `file` — the synthetic kind a range expands under; not a `MentionKind`. */
  kind: "file";
  /** The whole `path:from-to`, as typed. */
  ref: string;
  token: string;
  path: string;
  from: number;
  to: number;
}

/** Every distinct `@path:from-to` in `text`, in order of first appearance. */
export function rangeMentions(text: string): RangeMention[] {
  const seen = new Map<string, RangeMention>();
  for (const match of text.matchAll(MENTION_RE)) {
    const token = match[1]!.replace(TRAILING, "");
    const parsed = parseRangeToken(token);
    if (parsed && !seen.has(token)) seen.set(token, { kind: "file", ref: token, token: `file:${token}`, ...parsed });
  }
  return [...seen.values()];
}
