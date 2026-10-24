/* The defaults of a `@kind:ref` source, so a stub — and the real source that
   replaces it — states only what is its own. A source file calls
   `defineKindSource({ kind, icon, hint, ...overrides })`; every override is a
   plain `MentionSource` member (`useData`, `debounceMs`, `available`, `search`,
   `insert`, `face`, `row`, `key`). Nothing here is per-kind. */
import type { LucideIcon } from "lucide-react"
import type { MentionKind } from "./grammar"
import type { KindMatch, MentionSource } from "./types"

export function defineKindSource<M extends KindMatch = KindMatch, D = undefined>(
  def: { kind: MentionKind; icon: LucideIcon; hint: string } & Partial<MentionSource<M, D>>,
): MentionSource<M, D> {
  const { kind, icon } = def
  return {
    id: kind,
    // A stub offers nothing: no hint row, no matches, until its track says otherwise.
    available: () => false,
    search: () => [],
    key: (match) => match.ref,
    insert: (match) => ({ type: "text", text: `@${kind}:${match.ref}`, open: false }),
    face: (ref) => ({ icon, label: ref }),
    row: (match) => ({
      icon,
      label: match.label,
      description: match.description,
      aside: match.aside,
      badge: kind,
    }),
    ...def,
  }
}
