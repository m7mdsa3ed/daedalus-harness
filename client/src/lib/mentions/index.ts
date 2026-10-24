/* ── The client's mention registry ──
   Every source the `@` menu can draw from, listed once and in the order the
   menu draws them. A new source is its own file under `./sources/` and one line
   here. The order of the first five is the menu's: they are the original
   completer, moved, and their order is the contract (tasks, MCP servers,
   projects, files, MCP resources). The `kind` sources come after and only
   answer to `@kind:` (or hint themselves when the server advertises
   `mentionKinds`). */
import { MENTION_KINDS, parseKindToken, type MentionKind } from "./grammar"
import type { AnyMentionSource } from "./types"
import type { ChipFace } from "@/components/inline-chip"
import { tasksSource } from "./sources/tasks"
import { mcpServersSource } from "./sources/mcp-servers"
import { projectsSource } from "./sources/projects"
import { filesSource } from "./sources/files"
import { mcpResourcesSource } from "./sources/mcp-resources"
import { threadSource } from "./sources/thread"
import { commitSource } from "./sources/commit"
import { branchSource } from "./sources/branch"
import { tagSource } from "./sources/tag"
import { gitSource } from "./sources/git"
import { runSource } from "./sources/run"
import { kbSource } from "./sources/kb"
import { termSource } from "./sources/term"
import { mcpSource } from "./sources/mcp"

export const MENTION_SOURCES: readonly AnyMentionSource[] = [
  tasksSource,
  mcpServersSource,
  projectsSource,
  filesSource,
  mcpResourcesSource,
  threadSource,
  commitSource,
  branchSource,
  tagSource,
  gitSource,
  runSource,
  kbSource,
  termSource,
  mcpSource,
]

const KIND_SOURCES = MENTION_SOURCES.filter((source) => source.kind && source.useFace)

export const kindSource = (kind: MentionKind): AnyMentionSource | undefined =>
  MENTION_SOURCES.find((source) => source.kind === kind)

/** The chip face of a finished `@kind:ref` token's text (no `@`): the source's
    own, or null for anything that is not a known kind. */
export function kindFace(token: string): ChipFace | null {
  const parsed = parseKindToken(token)
  return parsed ? (kindSource(parsed.kind)?.face(parsed.ref) ?? null) : null
}

/** `kindFace` for a component: a source that reads live state (`useFace`) draws
    from it, every other kind from its pure `face`. The hooks run for every
    source that has one whatever the token is, so their order never changes. */
export function useKindFace(token: string): ChipFace | null {
  const parsed = parseKindToken(token)
  const live = KIND_SOURCES.map((source) => source.useFace?.(parsed && parsed.kind === source.kind ? parsed.ref : null) ?? null)
  const index = parsed ? KIND_SOURCES.findIndex((source) => source.kind === parsed.kind) : -1
  return (index >= 0 ? live[index] : null) ?? kindFace(token)
}

export { MENTION_KINDS }
export * from "./grammar"
export type * from "./types"
