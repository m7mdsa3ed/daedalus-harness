/* ── The inspector's Changes tab ──
   The newest gated turn's files, drawn by source control narrowed to them —
   never a list of its own (a second list of the same files that could not
   stage, discard or commit is the changes tab this app already removed). A
   file opens in the Monaco diff surface over the list, with a way back.

   Its own module, loaded lazily by `thread-inspector.tsx`: source control and
   the diff editor are a chunk a reader who never opens this tab never pays
   for. */
import * as React from "react"
import { ArrowLeftIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { DiffTab } from "@/components/workspace/diff-tab"
import { ScmView } from "@/components/workspace/scm-view"
import type { ScmFilter } from "@/lib/ide/scm-filter"
import type { Comparison, TurnChanges } from "@/lib/workspace/git-api"

export default function InspectorChanges({
  projectId,
  changes,
}: {
  projectId: string
  changes: TurnChanges
}) {
  /* A fresh filter per turn, keyed on the turn: the view reads `paths` and the
     label, and a new object per render would re-derive its rows for nothing. */
  const filter = React.useMemo<ScmFilter>(
    () => ({
      label: `${changes.files.length} ${changes.files.length === 1 ? "file" : "files"} from the last turn`,
      paths: new Set(changes.files.map((file) => file.path)),
      nonce: 0,
    }),
    [changes]
  )
  const [diff, setDiff] = React.useState<{ path: string; left: Comparison; right: Comparison } | null>(null)

  if (diff)
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center border-b border-border/60 px-1 py-0.5">
          <Button variant="ghost" size="xs" onClick={() => setDiff(null)}>
            <ArrowLeftIcon data-icon="inline-start" />
            Changes
          </Button>
        </div>
        <div className="min-h-0 flex-1">
          <DiffTab projectId={projectId} path={diff.path} left={diff.left} right={diff.right} active />
        </div>
      </div>
    )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ScmView
        projectId={projectId}
        filter={filter}
        onOpenDiff={(path, left, right) => setDiff({ path, left, right })}
        /* A file with nothing to compare (untracked) is still a diff: empty on
           the left, the file on the right. */
        onOpenFile={(path) => setDiff({ path, left: "head", right: "worktree" })}
      />
    </div>
  )
}
