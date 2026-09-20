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
import { CheckIcon, CloudDownloadIcon, GitBranchIcon, PlusIcon } from "lucide-react"

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
import { useGitBranches } from "@/lib/queries/surfaces"
import { cn } from "@/lib/utils"

/** What a pick means. `track` is a remote ref being made local; `create` is a
    name that exists nowhere yet. Neither is inferred by the caller — the picker
    knows which list the value came out of. */
export interface BranchChoice {
  branch: string
  create?: boolean
  track?: boolean
}

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

  const locals = data?.branches ?? []
  /* A remote whose local branch already exists is not an offer — switching to
     `main` is what the local row above already does, and `checkout -b main
     --track origin/main` would just fail. */
  const remotes = (data?.remotes ?? []).filter(
    (name) => !locals.includes(name.split("/").slice(1).join("/"))
  )

  const needle = typed.trim().toLowerCase()
  const match = (name: string) => !needle || name.toLowerCase().includes(needle)
  const shownLocals = unborn ? [] : locals.filter(match)
  const shownRemotes = unborn ? [] : remotes.filter(match)

  /* The create row, which is the whole point of this being a combobox: it
     appears exactly when what you typed is not already a branch — local or
     remote — so the same keystrokes that filter a list are the ones that name a
     new branch when the list runs out. */
  const typedName = typed.trim()
  const exists =
    locals.includes(typedName) || remotes.some((r) => r.split("/").slice(1).join("/") === typedName)
  const offerCreate = typedName.length > 0 && !exists && !typedName.startsWith("-")

  const pick = (choice: BranchChoice) => {
    setOpen(false)
    setTyped("")
    if (choice.branch !== branch) onPick(choice)
  }

  return (
    <Combobox
      open={open}
      onOpenChange={(next: boolean) => {
        setOpen(next)
        if (!next) setTyped("")
      }}
      items={[...shownLocals, ...shownRemotes]}
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
          /* Base UI filters its own `items`; the lists below are already
             filtered by the same needle, so the two agree — and the create row,
             which is not an item, is ours to decide about. */
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
                  <span className="min-w-0 truncate font-mono text-xs">{name}</span>
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
                  <span className="min-w-0 truncate font-mono text-xs">{name}</span>
                </ComboboxItem>
              ))}
            </ComboboxGroup>
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
                  Create <span className="font-mono text-xs">{typedName}</span>
                </span>
              </ComboboxItem>
            </>
          )}
        </ComboboxList>
        {/* Only reachable with an empty box: with anything typed the create row
            above is what "no matches" looks like. */}
        <ComboboxEmpty>
          {unborn ? "No commits yet — type a name to start a branch." : "No branches."}
        </ComboboxEmpty>
      </ComboboxContent>
    </Combobox>
  )
}
