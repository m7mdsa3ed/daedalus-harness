/* ── Which branch the work lands on ──
 *
 * A reading in the composer footer's cluster: the branch is a fact about where
 * this thread's work is going, glanced at constantly. It is a glance and no
 * more — committing, pushing and switching are the Source Control panel's, one
 * click away at the popover's foot, so the composer holds no second copy of
 * them.
 *
 * A project is a directory, not a repository (`server/src/git.ts`), so the
 * popover lists every checkout `git/repos` answers; the trigger names the first,
 * which is the project's own where it has one.
 */
import { useState } from "react"
import { GitBranchIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Popover, PopoverTrigger } from "@/components/ui/popover"
import {
  OpenInInspector,
  READING_MARK,
  READING_TRIGGER,
  ReadingFace,
  ReadingPopoverContent,
} from "@/components/composer/indicator"
import { useProjectRepos } from "@/lib/queries/surfaces"
import type { SessionMeta } from "@/lib/settings"
import { cn } from "@/lib/utils"

export function RepoIndicator({ meta }: { meta: SessionMeta }) {
  const [open, setOpen] = useState(false)
  const { data } = useProjectRepos(meta.projectId)
  const repos = data ?? []
  if (repos.length === 0) return null

  const label = repos[0].branch ?? "detached"

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            className={cn(READING_TRIGGER, "text-muted-foreground hover:text-foreground")}
            title={repos.length > 1 ? `${repos.length} repositories` : `On ${label}`}
            aria-label={`Branch — ${label}`}
          >
            {/* A name has no bubble form: a branch abbreviated to a digit says
                nothing, so a narrow panel draws the bare mark. */}
            <ReadingFace icon={<GitBranchIcon className={READING_MARK} />} label={label} />
          </Button>
        }
      />
      <ReadingPopoverContent
        heading={repos.length > 1 ? "Branches" : "Branch"}
        meta={repos.length > 1 ? repos.length : undefined}
        action={
          <OpenInInspector tab="changes" label="Open Source Control" onOpen={() => setOpen(false)} />
        }
      >
        <ul className="flex flex-col gap-1 text-xs">
          {repos.map((repo) => (
            <li key={repo.path} className="flex min-w-0 items-center gap-2">
              <GitBranchIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate font-mono">{repo.branch ?? "detached"}</span>
              {repos.length > 1 && (
                <span className="ml-auto shrink-0 truncate text-muted-foreground">{repo.name}</span>
              )}
            </li>
          ))}
        </ul>
      </ReadingPopoverContent>
    </Popover>
  )
}
