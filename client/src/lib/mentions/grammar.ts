/* ── The `@` token grammar, client half ──
   Two shapes ride in a message as `@token`: a path (`@src/index.ts`, the
   original) and a typed reference, `@kind:ref` — `@thread:abc`, `@git:staged`.
   A kind is **two or more lowercase letters, then a colon**, and one of
   `MENTION_KINDS`: that is what keeps `C:\x` and `C:/x`, and an unknown
   `foo:bar`, reading as the paths they always were.

   Pure on purpose — no imports — because `composer/editor-text.ts` is run by
   a plain-node check. `MENTION_KINDS` is a copy of the server's
   (`server/src/mentions/grammar.ts`); `pnpm test:mentions` fails when the two
   lists drift. */

export const MENTION_KINDS = ["thread", "commit", "branch", "tag", "git", "run", "kb", "term", "mcp"] as const
export type MentionKind = (typeof MENTION_KINDS)[number]

export const isMentionKind = (value: string): value is MentionKind =>
  (MENTION_KINDS as readonly string[]).includes(value)

const KIND_TOKEN = /^([a-z]{2,}):(.+)$/
const KIND_QUERY = /^([a-z]{2,}):(.*)$/

/** `thread:abc` → `{kind, ref}`; null for an unknown kind, an empty ref, or a
    drive path. The token must already be cleaned of trailing punctuation. */
export function parseKindToken(token: string): { kind: MentionKind; ref: string } | null {
  const match = KIND_TOKEN.exec(token)
  return match && isMentionKind(match[1]) ? { kind: match[1], ref: match[2] } : null
}

/** What the menu is routing: the query typed after `@`, when it opens with a
    known `kind:`. `rest` is the part after the colon, possibly empty. */
export function splitKindQuery(query: string): { kind: MentionKind; rest: string } | null {
  const match = KIND_QUERY.exec(query)
  return match && isMentionKind(match[1]) ? { kind: match[1], rest: match[2] } : null
}

const TOKEN = /(?:^|[\s(])@([^\s@]+)/g
const TRAILING = /[.,;:!?)\]}'"]+$/

/** `src/a.ts:40-80` (or `:40`) → the file and its lines. The server inlines
    them (`server/src/mentions/resolvers/file-range.ts`); the chip says them. */
const RANGE_TOKEN = /^(.+?):(\d+)(?:-(\d+))?$/

export function parseRangeToken(token: string): { path: string; from: number; to: number } | null {
  const match = RANGE_TOKEN.exec(token)
  if (!match || parseKindToken(token)) return null
  const from = Number(match[2])
  const to = match[3] === undefined ? from : Number(match[3])
  return from >= 1 && to >= from ? { path: match[1], from, to } : null
}

/** Whether a message holds a finished-looking `@kind:ref` or `@path:lines` —
    what decides that the send asks the server to expand it. */
export function hasKindMention(text: string): boolean {
  for (const match of text.matchAll(TOKEN)) {
    const token = match[1].replace(TRAILING, "")
    if (parseKindToken(token) || parseRangeToken(token)) return true
  }
  return false
}
