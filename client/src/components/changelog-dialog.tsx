/* ── What's new ──
   The deployment's changelog from /api/meta, browsable as a dialog. One
   component, two doors: the sidebar header's ⋯ menu and Settings › General's
   About group. Opening it marks the release seen on this device
   (lib/whats-new), which is what the ⋯ menu's dot reads. */
import * as React from "react"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"

import { MARKDOWN_COMPONENTS } from "@/components/prose"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { useAppMeta, type ChangelogEntry } from "@/lib/queries"
import { markReleaseSeen } from "@/lib/whats-new"

export function ChangelogDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const meta = useAppMeta()
  React.useEffect(() => {
    if (open && meta.data) markReleaseSeen(meta.data.version)
  }, [open, meta.data])
  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Changelog</ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        {/* The dialog's body is the scroller; a second one inside it traps the wheel. */}
        <div>
          {(meta.data?.changelog ?? []).map((entry) => (
            <ChangelogEntryView key={entry.version} entry={entry} />
          ))}
        </div>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

/* One release: its version and date as the row's own head, the body as the
   markdown the changelog file holds — so `### Added`, a bold lead-in, a table or
   a link read the way they were written rather than as a flattened list. */
function ChangelogEntryView({ entry }: { entry: ChangelogEntry }) {
  return (
    <div className="border-b py-3 last:border-b-0">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-medium">{entry.version}</span>
        {entry.date && <span className="text-xs text-muted-foreground">{entry.date}</span>}
      </div>
      {/* A release whose body is empty draws nothing under its head — no
          placeholder: the heading row is the whole of what there is to say. */}
      {entry.markdown && (
        <div className="prose prose-sm max-w-none [&_h3:first-child]:mt-2">
          <Markdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
            {entry.markdown}
          </Markdown>
        </div>
      )}
    </div>
  )
}
