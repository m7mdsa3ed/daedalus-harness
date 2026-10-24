/* The hint row: `thread:` for `@` or a prefix of a kind. Not a searchable
   source (the hook builds its matches from the kind sources that are
   available), so it is not in the registry list. Picking one completes
   `@kind:` and keeps the token open, like a directory. */
import type { LucideIcon } from "lucide-react"
import type { MentionKind } from "../grammar"
import type { MentionSource } from "../types"

export interface KindHint {
  kind: MentionKind
  icon: LucideIcon
  hint: string
}

export const kindHintSource: MentionSource<KindHint> = {
  id: "kind",
  available: () => true,
  search: () => [],
  key: (match) => match.kind,
  insert: (match) => ({ type: "text", text: `@${match.kind}:`, open: true }),
  face: () => null,
  row: (match) => ({ icon: match.icon, label: `${match.kind}:`, description: match.hint, badge: "kind" }),
}
