/* ── The `@` mention source contract ──
   Every row the composer's `@` menu can offer comes from one `MentionSource`,
   listed once in `./index.ts`. A source owns four things for its kind of thing:
   finding matches, the text a pick inserts, the chip a finished token draws,
   and the row in the menu. Nothing else in the client names a vendor of
   mentions — a new source is one file plus one line in the registry. */
import type { LucideIcon } from "lucide-react"
import type { ChipFace } from "@/components/inline-chip"
import type { CompleterRowProps } from "@/components/composer/completer"
import type { McpServerDef, ThreadMcpServer } from "@/lib/settings"
import type { McpResourceMatch } from "./sources/mcp-resources"
import type { MentionKind } from "./grammar"

/** What a source may read when it searches. Memoised by the hook, so it is
    stable across renders that did not change one of its fields. */
export interface MentionCtx {
  /** The thread's project; absent for a thread with none (the menu then offers nothing from files). */
  projectId: string | undefined
  /** The thread being typed in, when it has an id yet. */
  sessionId: string | undefined
  /** A draft — its MCP links can still be changed. */
  draft: boolean
  /** MCP library ids linked to the thread. */
  linked: ReadonlySet<string>
  /** The thread carries the Harness MCP (tasks are mentionable). */
  harness: boolean
  /** The thread's MCP servers and what they offer. */
  mcpServers: ThreadMcpServer[] | undefined
  /** The server advertises `mentionKinds`: only then do `kind` sources exist. */
  kinds: boolean
  /** Side effects a pick may ask for. Stable, always the composer's latest. */
  actions: MentionActions
}

export interface MentionActions {
  onResource?: (resource: McpResourceMatch) => void
  onMcpServer?: (server: McpServerDef) => void
}

/** A row in the menu: the completer's row minus what the menu wires in. */
export type MentionRow = Omit<CompleterRowProps, "selected" | "onPick" | "onHover">

/** What a pick does. `text` is the whole token, `@` included, without its
    trailing space: the menu adds the space when the token is `open: false`,
    and leaves the caret straight after it when `open: true` (a directory's `/`,
    a kind hint's `:`) so the next keystroke keeps narrowing. `remove` deletes
    the token and runs a side effect instead (an MCP resource is attached, not
    named). */
export type MentionInsert =
  | { type: "text"; text: string; open: boolean }
  | { type: "remove"; run: () => void }

/**
 * `M` is the source's own match type, `D` what its `useData` hook returns.
 * Members are declared as methods on purpose: method parameters are bivariant,
 * so a `MentionSource<TaskMatch, TaskRows>` is accepted wherever the registry
 * wants a `MentionSource` — no casts at the registration site.
 */
export interface MentionSource<M = unknown, D = undefined> {
  /** Unique; also the prefix of every row's React key. */
  readonly id: string
  /** Set for a source reached as `@kind:query`. A source without one is a
      *legacy* source: it contributes to the plain `@query` list. */
  readonly kind?: MentionKind
  /** A kind source's mark and one-line description on its hint row (`thread:`). */
  readonly icon?: LucideIcon
  readonly hint?: string
  /** When set, `search` is asked after this many ms of quiet, may return a
      promise, is aborted when the query moves on, and its answer is cached per
      lower-cased query until the menu closes. Unset means `search` is a pure,
      synchronous filter over data the source already holds. */
  readonly debounceMs?: number
  /** Said (toast) when an async `search` rejects, e.g. "Couldn't search for files". */
  readonly errorLabel?: string
  /** A hook, called on every render in registry order whether or not the menu
      is open — so it must be cheap and gate its own fetching on `query`
      (`null` = closed). Return a stable reference. */
  useData?(ctx: MentionCtx, query: string | null): D
  /** Whether the source has anything to offer this thread. A `kind` source is
      never available when the server lacks `mentionKinds`, whatever it says. */
  available(ctx: MentionCtx, data: D): boolean
  /** Matches for the text typed after `@` (or after `@kind:`), best first,
      already limited. */
  search(query: string, ctx: MentionCtx, data: D, signal: AbortSignal): M[] | Promise<M[]>
  /** Unique among this source's matches. */
  key(match: M): string
  insert(match: M, ctx: MentionCtx): MentionInsert
  /** The chip a finished token draws, from the `ref` after the `@kind:` (or the
      whole token for a legacy source). Pure — it runs in the composer's node
      view and in the sent bubble. Null: this source draws no chip. */
  face(ref: string): ChipFace | null
  /** Optional: the same chip, for a face that reads live state (a thread's
      title, from the store). A hook, called on every chip render in registry
      order — `ref` is null when the token is another kind's, and it must then
      return null. When it answers, it wins over `face`, which stays the pure
      fallback. */
  useFace?(ref: string | null): ChipFace | null
  row(match: M): MentionRow
}

/** Any source, whatever its match and data types. */
export type AnyMentionSource = MentionSource<unknown, unknown>

/** The match a plain `kind` source returns until it needs a richer one. */
export interface KindMatch {
  /** What follows `@kind:` in the token. No whitespace, no `@`. */
  ref: string
  label: string
  description?: string
  aside?: string
}

/** A match in the menu, with the source that made it. */
export interface MentionHit {
  key: string
  source: AnyMentionSource
  match: unknown
}
