/* ── What's new ──
   The deployment's changelog from /api/meta, browsable as a dialog. One
   component, two doors: the sidebar header's ⋯ menu and Settings › General's
   About group. Opening it marks the release seen on this device
   (lib/whats-new), which is what the ⋯ menu's dot reads. */
import * as React from "react"

import { Button } from "@/components/ui/button"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogFooter,
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
      <ResponsiveDialogContent className="sm:max-w-lg">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Changelog</ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        <div className="max-h-[60vh] overflow-y-auto pr-1">
          {(meta.data?.changelog ?? []).map((entry) => (
            <ChangelogEntryView key={entry.version} entry={entry} />
          ))}
        </div>
        <ResponsiveDialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

function ChangelogEntryView({ entry }: { entry: ChangelogEntry }) {
  return (
    <div className="border-b py-3 last:border-b-0">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-medium">{entry.version}</span>
        {entry.date && <span className="text-xs text-muted-foreground">{entry.date}</span>}
      </div>
      {entry.sections.length === 0 ? (
        <p className="mt-1 text-sm text-muted-foreground">Nothing yet.</p>
      ) : (
        entry.sections.map((section) => (
          <div key={section.title} className="mt-1.5">
            {section.title && (
              <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{section.title}</div>
            )}
            <ul className="mt-0.5 list-disc space-y-0.5 pl-4 text-sm">
              {section.items.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          </div>
        ))
      )}
    </div>
  )
}
