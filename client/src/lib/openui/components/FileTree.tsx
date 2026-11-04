/* ── FileTree ──
   A directory tree from flat paths. The schema takes `path` strings and the
   nesting happens here: a model that has to emit a recursive `children` shape
   gets the depth wrong far more often than it gets a path wrong, and a streaming
   half-written list still draws as a half-written tree. Inert — a row is text.

   The indent is a multiple of the row's own leading rather than a pixel step,
   so a tree at 12px and the same tree at 14px are the same shape. */
import { z } from "zod/v4"
import { File, Folder } from "lucide-react"
import { defineComponent } from "@openuidev/react-lang"
import { cn } from "@/lib/utils"
import { Box, BoxHeader, META, StateLine } from "@/lib/openui/kit"

type Change = "added" | "modified" | "deleted"
type Node = { name: string; children: Map<string, Node>; file: boolean; note?: string; change?: Change }

/* The word beside the dot, so a change is never told by colour alone. */
const CHANGE = {
  added: { word: "added", tone: "success" },
  modified: { word: "modified", tone: "warn" },
  deleted: { word: "deleted", tone: "error" },
} as const

function build(files: { path?: string; note?: string; change?: Change }[]) {
  const root: Node = { name: "", children: new Map(), file: false }
  for (const f of files) {
    const parts = (f?.path ?? "").split("/").filter((p) => p && p !== ".")
    let at = root
    parts.forEach((name, i) => {
      let next = at.children.get(name)
      if (!next) at.children.set(name, (next = { name, children: new Map(), file: false }))
      at = next
      if (i === parts.length - 1) {
        at.file = true
        at.note = f.note
        at.change = f.change
      }
    })
  }
  return root
}

/** Folders first, then by name — the order a file explorer reads in. */
const ordered = (node: Node) =>
  [...node.children.values()].sort(
    (a, b) => Number(a.children.size === 0 && a.file) - Number(b.children.size === 0 && b.file) || a.name.localeCompare(b.name)
  )

function Branch({ node, depth }: { node: Node; depth: number }) {
  const isDir = node.children.size > 0
  const change = node.change && CHANGE[node.change]
  return (
    <li className="min-w-0">
      <div
        className="flex min-w-0 flex-wrap items-baseline gap-x-2 py-px pe-2.5 @panel-sm:pe-3"
        style={{ paddingInlineStart: `calc(var(--spacing) * 2.5 + ${depth * 13}px)` }}
      >
        <span className="inline-flex min-w-0 items-center gap-1">
          {isDir ? (
            <Folder aria-hidden className="size-3 shrink-0 text-muted-foreground" />
          ) : (
            <File aria-hidden className="size-3 shrink-0 text-muted-foreground" />
          )}
          <span
            className={cn(
              "font-mono text-[0.75rem] leading-[1.6] break-words",
              isDir ? "font-medium text-foreground" : "text-foreground",
              node.change === "deleted" && "text-muted-foreground line-through"
            )}
          >
            {node.name}
            {isDir && "/"}
          </span>
        </span>
        {change && <StateLine tone={change.tone}>{change.word}</StateLine>}
        {node.note && <span className={cn(META, "min-w-0 basis-full @panel-sm:basis-auto")}>{node.note}</span>}
      </div>
      {isDir && (
        <ul>
          {ordered(node).map((child) => (
            <Branch key={child.name} node={child} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  )
}

export const FileTree = defineComponent({
  name: "FileTree",
  description: "A directory tree built from flat file paths, each with an optional note and added/modified/deleted marker.",
  props: z.object({
    title: z.string(),
    files: z.array(
      z.object({
        path: z.string(),
        note: z.string().optional(),
        change: z.enum(["added", "modified", "deleted"]).optional(),
      })
    ),
  }),
  component: ({ props }) => {
    const root = build(props.files ?? [])
    return (
      <Box>
        <BoxHeader title={props.title} />
        <ul aria-label={props.title} className="py-1.5">
          {ordered(root).map((child) => (
            <Branch key={child.name} node={child} depth={0} />
          ))}
        </ul>
      </Box>
    )
  },
})
