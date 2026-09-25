/* ── A path the thread names, as something to open ──
   `FileLink` is the one face: a path that resolves into the thread's project
   (`projectPath`) is a button that opens it in the Preview panel, and anything
   else — outside the project, or no thread in reach — is drawn as it was
   written. `remarkMentions` is how a user bubble's `@path` reaches it. */
import * as React from "react"

import { FilePreviewContext, projectPath } from "@/lib/file-preview"
import { cn } from "@/lib/utils"

export function FileLink({
  path,
  className,
  children,
}: {
  /** As named: relative to the thread's cwd, absolute, `~/`, or a `file://` URI. */
  path: string
  className?: string
  children: React.ReactNode
}) {
  const ctx = React.useContext(FilePreviewContext)
  const target = ctx ? projectPath(path, ctx.scope) : null
  if (!ctx || !target) return <span className={className}>{children}</span>
  return (
    <button
      type="button"
      title={`Preview ${target}`}
      onClick={() => ctx.open(target)}
      className={cn(
        "cursor-pointer text-primary underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none",
        className
      )}
    >
      {children}
    </button>
  )
}

/* The server's own mention grammar (`server/src/mentions.ts`): an `@` after a
   boundary, a run of non-space, trailing sentence punctuation left out. */
const MENTION_RE = /(^|[\s(])@([^\s@]+)/g
const TRAILING = /[.,;:!?)\]}'"]+$/

type MdNode = { type: string; value?: string; children?: MdNode[]; data?: object }

/** Splits prose text nodes on `@path` into `file-mention` elements. Only text
    nodes are touched, so an `@` in a code span or a fence stays literal. */
export function remarkMentions() {
  const walk = (node: MdNode) => {
    if (!node.children) return
    node.children = node.children.flatMap((child): MdNode[] => {
      if (child.type !== "text" || !child.value?.includes("@")) {
        walk(child)
        return [child]
      }
      const out: MdNode[] = []
      const text = child.value
      let last = 0
      for (const match of text.matchAll(MENTION_RE)) {
        const path = match[2].replace(TRAILING, "")
        if (!path) continue
        const start = match.index + match[1].length
        if (start > last) out.push({ type: "text", value: text.slice(last, start) })
        out.push({
          type: "text",
          value: `@${path}`,
          data: { hName: "file-mention", hProperties: { path } },
        })
        last = start + 1 + path.length
      }
      if (last < text.length) out.push({ type: "text", value: text.slice(last) })
      return out
    })
  }
  return (tree: MdNode) => walk(tree)
}

export const FileMention = ({
  path,
  children,
}: {
  path?: string
  children?: React.ReactNode
  node?: unknown
}) => (
  <FileLink path={path ?? ""} className="font-mono text-[0.9em]">
    {children}
  </FileLink>
)
