/* ── One branch switcher for the whole app ──
 *
 * Switching and creating are the same verb to git — `checkout`, with and
 * without `-b` — so they are one control here and not a menu row plus a form:
 * you type, and what you typed is either something that exists (switch to it),
 * something that exists on a remote (check it out as a local branch tracking
 * it), or nothing at all (create it). A separate "New branch…" row asked you to
 * decide which of those you meant *before* you had typed the name that decides
 * it.
 *
 * It is one component because there are two surfaces that need it — the
 * composer's branch popover and the source-control panel's header — and a
 * second copy is how one of them quietly ends up without remotes, without
 * filtering, or refusing a name the other accepts.
 *
 * Branches are read when the picker opens, never with the status: a repository
 * with two thousand refs would otherwise pay for them on every watch burst, to
 * draw one name.
 */
import * as React from "react"
import { CheckIcon, CloudDownloadIcon, GitBranchIcon, PlusIcon, SparklesIcon } from "lucide-react"

import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxGroup,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  ComboboxSeparator,
  ComboboxTrigger,
} from "@/components/ui/combobox"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { canUseAi, gitPick } from "@/lib/ai-picks"
import { describeError } from "@/lib/errors"
import { usePinnedBranches } from "@/lib/pinned-branches"
import { useProfiles } from "@/lib/queries/catalog"
import { useGitBranches } from "@/lib/queries/surfaces"
import { useServer } from "@/lib/server-context"
import { cn } from "@/lib/utils"
import { draftCommitMessage } from "@/lib/workspace/git-api"

/** What a pick means. `track` is a remote ref being made local; `create` is a
    name that exists nowhere yet. Neither is inferred by the caller — the picker
    knows which list the value came out of. */
export interface BranchChoice {
  branch: string
  create?: boolean
  track?: boolean
}

/** Rows drawn per group before the rest wait for the filter. */
const SHOWN = 50

export function BranchPicker({
  projectId,
  repo,
  branch,
  unborn,
  disabled,
  onPick,
  children,
  className,
}: {
  projectId: string
  /** Project-relative repository, `""` for the project's own. */
  repo: string
  /** The branch checked out now — ticked in the list, and never "created". */
  branch: string | null
  /** Before the first commit there is no ref to switch to; creating still works. */
  unborn?: boolean
  disabled?: boolean
  onPick: (choice: BranchChoice) => void
  /** The trigger. Rendered inside the combobox's own trigger button. */
  children: React.ReactNode
  className?: string
}) {
  const [open, setOpen] = React.useState(false)
  const [typed, setTyped] = React.useState("")
  /* Read on open, and only then: the two surfaces that draw this both already
     hold a status, and neither should be paying for a ref walk to print one
     name. */
  const { data } = useGitBranches(projectId, repo, open)
  const pinned = usePinnedBranches(projectId, repo)

  /* Sets, built once per fetch: with thousands of refs the old
     `locals.includes` inside a filter over the remotes was quadratic, and it
     ran again on every keystroke. */
  const { locals, remotes, known } = React.useMemo(() => {
    const all = data?.branches ?? []
    // The checked-out branch, then the pinned ones, first, so the cap below never hides them.
    const front = [branch, ...pinned.filter((b) => b !== branch)].filter((b): b is string => !!b && all.includes(b))
    const locals = front.length ? [...front, ...all.filter((b) => !front.includes(b))] : all
    const localSet = new Set(locals)
    const known = new Set(locals)
    /* A remote whose local branch already exists is not an offer — switching to
       `main` is what the local row above already does, and `checkout -b main
       --track origin/main` would just fail. */
    const remotes = (data?.remotes ?? []).filter((name) => {
      const local = name.split("/").slice(1).join("/")
      known.add(local)
      return !localSet.has(local)
    })
    return { locals, remotes, known }
  }, [data, branch, pinned])

  const needle = typed.trim().toLowerCase()
  const match = (name: string) => !needle || name.toLowerCase().includes(needle)
  const matchedLocals = unborn ? [] : locals.filter(match)
  const matchedRemotes = unborn ? [] : remotes.filter(match)
  /* ponytail: a cap, not a virtualized list — nobody scrolls past fifty
     branches, they type. Mounting every row is what made opening slow. */
  const shownLocals = matchedLocals.slice(0, SHOWN)
  const shownRemotes = matchedRemotes.slice(0, SHOWN)
  const hidden = matchedLocals.length + matchedRemotes.length - shownLocals.length - shownRemotes.length

  /* The create row, which is the whole point of this being a combobox: it
     appears exactly when what you typed is not already a branch — local or
     remote — so the same keystrokes that filter a list are the ones that name a
     new branch when the list runs out. */
  const typedName = typed.trim()
  const exists = known.has(typedName)
  const offerCreate = typedName.length > 0 && !exists && !typedName.startsWith("-")

  const pick = (choice: BranchChoice) => {
    setOpen(false)
    setTyped("")
    if (choice.branch !== branch) onPick(choice)
  }

  /* ── Naming a branch from the work ──
     The same diff the commit box asks about, asked a different question
     (`kind: "branch"` — the server has held the house style for this all
     along and nothing was calling it). It fills the box rather than checking
     anything out: the create row below is still the gesture that acts, so a
     name nobody liked costs a keystroke rather than a branch.

     Its own profile pick, the same one source control's commit draft uses —
     see `lib/ai-picks.ts`. */
  const settings = useServer()
  const profiles = useProfiles()
  gitPick.useProfileId()
  gitPick.useModelId()
  const namer = React.useMemo(() => {
    const picked = gitPick.resolveProfile(profiles)
    return canUseAi(picked) ? picked : null
  }, [profiles])

  const [naming, setNaming] = React.useState(false)
  const [nameError, setNameError] = React.useState<string | null>(null)
  const nameAbort = React.useRef<AbortController | null>(null)
  React.useEffect(() => () => nameAbort.current?.abort(), [projectId, repo])
  /* The popover closing is an abort: the answer had one place to land. */
  React.useEffect(() => {
    if (open) return
    nameAbort.current?.abort()
    nameAbort.current = null
    setNaming(false)
    setNameError(null)
  }, [open])

  const suggestName = async () => {
    if (!namer || naming) return
    nameAbort.current?.abort()
    const controller = new AbortController()
    nameAbort.current = controller
    setNaming(true)
    setNameError(null)
    try {
      const { message } = await draftCommitMessage(
        settings,
        projectId,
        {
          profileId: namer.id,
          model: gitPick.resolveModelId(namer) || undefined,
          repo: repo || undefined,
          kind: "branch",
        },
        controller.signal
      )
      if (controller.signal.aborted) return
      setTyped(message)
    } catch (err) {
      if (controller.signal.aborted) return
      /* Inside the popover, beside the row that asked — a toast would land
         behind it, and closing the popover is how you dismiss this. */
      setNameError(describeError(err).title)
    } finally {
      if (nameAbort.current === controller) {
        nameAbort.current = null
        setNaming(false)
      }
    }
  }

  return (
    <Combobox
      open={open}
      onOpenChange={(next: boolean) => {
        setOpen(next)
        if (!next) setTyped("")
      }}
      items={[...shownLocals, ...shownRemotes]}
      /* Ours already filtered by the same needle; Base UI's pass was a second
         walk over the same list. */
      filter={null}
      inputValue={typed}
      onInputValueChange={(value: unknown) => setTyped(typeof value === "string" ? value : "")}
      disabled={disabled}
    >
      {/* The trigger is the caller's control — the panel header's branch
          button, the composer's row — so nothing is styled here beyond letting
          it shrink. */}
      <ComboboxTrigger className={cn("min-w-0", className)}>{children}</ComboboxTrigger>
      <ComboboxContent align="start" className="w-64">
        <ComboboxInput
          placeholder={unborn ? "Name a branch" : "Switch or create…"}
          showTrigger={false}
          /* Filtering is ours alone (`filter={null}` on the root) — and the
             create row, which is not an item, is ours to decide about. */
          className="w-full"
        />
        <ComboboxList>
          {/* Every label is inside its own Group: `Combobox.GroupLabel` reads a
              group context, and one on its own throws (Base UI error 18). */}
          {shownLocals.length > 0 && (
            <ComboboxGroup>
              <ComboboxLabel>Branches</ComboboxLabel>
              {shownLocals.map((name) => (
                <ComboboxItem key={name} value={name} onClick={() => pick({ branch: name })}>
                  {name === branch ? (
                    <CheckIcon className="text-foreground" />
                  ) : (
                    <GitBranchIcon className="text-muted-foreground" />
                  )}
                  <span className="min-w-0 truncate font-mono text-sm">{name}</span>
                </ComboboxItem>
              ))}
            </ComboboxGroup>
          )}

          {shownRemotes.length > 0 && (
            <ComboboxGroup>
              {shownLocals.length > 0 && <ComboboxSeparator />}
              <ComboboxLabel>Remote — checked out as a tracking branch</ComboboxLabel>
              {shownRemotes.map((name) => (
                <ComboboxItem
                  key={name}
                  value={name}
                  onClick={() => pick({ branch: name, track: true })}
                >
                  <CloudDownloadIcon className="text-muted-foreground" />
                  <span className="min-w-0 truncate font-mono text-sm">{name}</span>
                </ComboboxItem>
              ))}
            </ComboboxGroup>
          )}

          {hidden > 0 && (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              {hidden} more — type to narrow
            </p>
          )}

          {offerCreate && (
            <>
              {(shownLocals.length > 0 || shownRemotes.length > 0) && <ComboboxSeparator />}
              <ComboboxItem
                value={typedName}
                onClick={() => pick({ branch: typedName, create: true })}
              >
                <PlusIcon className="text-muted-foreground" />
                <span className="min-w-0 truncate">
                  Create <span className="font-mono text-sm">{typedName}</span>
                </span>
              </ComboboxItem>
            </>
          )}
        </ComboboxList>

        {/* Outside the list, because it is not a branch: it is the one row that
            writes into the box instead of picking out of it. Kept visible with
            something typed, since "name this properly" is most wanted once you
            have tried and not liked what you wrote. */}
        {namer && (
          <div className="border-t p-1">
            <Button
              variant="ghost"
              size="sm"
              disabled={naming}
              onClick={() => void suggestName()}
              className="w-full justify-start text-muted-foreground"
            >
              {naming ? <Spinner /> : <SparklesIcon />}
              <span className="min-w-0 truncate">
                {naming ? "Reading the changes…" : "Name it from the changes"}
              </span>
            </Button>
            {nameError && <p className="px-2 py-1 text-xs text-destructive">{nameError}</p>}
          </div>
        )}

        {/* Only reachable with an empty box: with anything typed the create row
            above is what "no matches" looks like. */}
        <ComboboxEmpty>
          {unborn ? "No commits yet — type a name to start a branch." : "No branches."}
        </ComboboxEmpty>
      </ComboboxContent>
    </Combobox>
  )
}
