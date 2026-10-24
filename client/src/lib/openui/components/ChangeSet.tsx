/* ── ChangeSet ──
   The files a change touched, with how much of each. `FileTree` draws a layout
   (and a marker per file); an explanation of a diff, a commit or a PR needs the
   other reading — a flat list in the order that matters, each path with its
   added and removed line counts and the five-block bar a diff summary wears, and
   a header that adds them up. The counts are the model's to supply from `git
   diff --numstat`; a file with none draws without them rather than with zeros. */
import { z } from "zod/v4"
import { defineComponent } from "@openuidev/react-lang"
import { cn } from "@/lib/utils"
import { Box, BoxHeader, META, PAD_ROW, TONE_DOT } from "@/lib/openui/kit"
import { RichText } from "@/lib/openui/rich-text"

const STATUS = {
  added: { word: "added", dot: TONE_DOT.success },
  modified: { word: "modified", dot: TONE_DOT.warn },
  deleted: { word: "deleted", dot: TONE_DOT.error },
  renamed: { word: "renamed", dot: TONE_DOT.info },
} as const

const BLOCKS = 5

/** Five blocks, green for the share that was added and red for the rest — a
    file with only one side is all of that colour. */
function Blocks({ added, removed }: { added: number; removed: number }) {
  const total = added + removed
  if (total <= 0) return null
  // Each side that exists keeps at least one block, so a 1-line removal beside 900 added still shows red.
  const green = added > 0 ? Math.min(removed > 0 ? BLOCKS - 1 : BLOCKS, Math.max(1, Math.round((added / total) * BLOCKS))) : 0
  const red = removed > 0 ? BLOCKS - green : 0
  return (
    <span aria-hidden className="inline-flex shrink-0 gap-px">
      {Array.from({ length: BLOCKS }, (_, i) => (
        <span
          key={i}
          className={cn("size-2 rounded-[2px]", i < green ? "bg-success" : i < green + red ? "bg-destructive" : "bg-muted")}
        />
      ))}
    </span>
  )
}

export const ChangeSet = defineComponent({
  name: "ChangeSet",
  description:
    "The files a change touched: each a path with optional added and removed line counts, a status and a short note, under a header that totals them.",
  props: z.object({
    title: z.string(),
    files: z.array(
      z.object({
        path: z.string(),
        added: z.number().optional(),
        removed: z.number().optional(),
        status: z.enum(["added", "modified", "deleted", "renamed"]).optional(),
        note: z.string().optional(),
      })
    ),
  }),
  component: ({ props }) => {
    const files = (props.files ?? []).filter((file) => file?.path)
    const added = files.reduce((sum, file) => sum + (file.added ?? 0), 0)
    const removed = files.reduce((sum, file) => sum + (file.removed ?? 0), 0)
    const counted = files.some((file) => file.added !== undefined || file.removed !== undefined)
    return (
      <Box>
        <BoxHeader
          title={props.title}
          meta={
            files.length > 0 && (
              <span className="tabular-nums">
                {files.length} {files.length === 1 ? "file" : "files"}
                {counted && (
                  <>
                    {" "}
                    <span className="text-success">+{added}</span> <span className="text-destructive">-{removed}</span>
                  </>
                )}
              </span>
            )
          }
        />
        {files.length > 0 && (
          <ul aria-label={props.title} className="w-full min-w-0 list-none divide-y">
            {files.map((file, index) => {
              const slash = file.path.lastIndexOf("/")
              const dir = slash >= 0 ? file.path.slice(0, slash + 1) : ""
              const name = file.path.slice(slash + 1)
              const status = file.status && STATUS[file.status]
              const hasCounts = file.added !== undefined || file.removed !== undefined
              return (
                <li key={index} className={cn("min-w-0 space-y-0.5", PAD_ROW)}>
                  <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                    <span
                      className={cn(
                        "min-w-0 font-mono text-sm leading-snug break-all",
                        file.status === "deleted" && "text-muted-foreground line-through"
                      )}
                    >
                      <span className="text-muted-foreground">{dir}</span>
                      <span className="font-medium text-foreground">{name}</span>
                    </span>
                    <span className="inline-flex shrink-0 items-center gap-2">
                      {status && (
                        <span className={cn(META, "inline-flex items-center gap-1")}>
                          <span aria-hidden className={cn("size-1.5 rounded-full", status.dot)} />
                          {status.word}
                        </span>
                      )}
                      {hasCounts && (
                        <span className="inline-flex items-center gap-1.5 font-mono text-xs tabular-nums">
                          <span className="text-success">+{file.added ?? 0}</span>
                          <span className="text-destructive">-{file.removed ?? 0}</span>
                          <Blocks added={file.added ?? 0} removed={file.removed ?? 0} />
                        </span>
                      )}
                    </span>
                  </div>
                  {file.note && (
                    <p className={cn(META, "text-pretty")}>
                      <RichText text={file.note} />
                    </p>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </Box>
    )
  },
})
