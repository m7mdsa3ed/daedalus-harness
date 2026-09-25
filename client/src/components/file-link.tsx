/* ── A path the thread names, as something to open ──
   `FileLink` is the one face: a path that resolves into the thread's project
   (`projectPath`) is a button that opens it in the Preview panel, and anything
   else — outside the project, or no thread in reach — is drawn as it was
   written. A user bubble's `@path` is a chip instead (`thread-items/user-chips.tsx`). */
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
