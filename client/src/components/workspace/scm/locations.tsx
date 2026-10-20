/* ── Locations ──
   Sublime Merge's left pane: the repository's named places - local branches,
   remote branches, tags and stashes. A click finds the place in the commit
   table; the checkout button beside it goes there. Branches and tags come from
   the one `branches` read the picker uses, so opening both costs one request. */
import * as React from "react"
import { useInfiniteQuery } from "@tanstack/react-query"
import { ArchiveIcon, ChevronDownIcon, ChevronRightIcon, CheckIcon, LogInIcon, PinIcon, PinOffIcon, SearchIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu"
import { Input } from "@/components/ui/input"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { useConfirm } from "@/components/confirm-dialog"
import { Empty } from "@/components/empty"
import { Notice } from "@/components/notice"
import { Count } from "@/components/settings/primitives"
import { PanelRowsSkeleton } from "@/components/ui/skeletons"
import { errorText } from "@/lib/errors"
import { usePrompt } from "@/components/prompt-dialog"
import { StashSection } from "@/components/workspace/scm-log"
import { setBranchPinned, usePinnedBranches } from "@/lib/pinned-branches"
import { projectGitRefsKey } from "@/lib/queries/keys"
import { useServer } from "@/lib/server-context"
import { cn } from "@/lib/utils"
import { gitRefs, type GitAction, type GitStatus, type RefKind } from "@/lib/workspace/git-api"

const PAGE = 30

/* A group of refs that loads as it is scrolled: collapsed groups ask for
   nothing, an open one asks for a page, and the sentinel at its foot asks for
   the next when it comes into view. Counts are the server's `total`. */
function RefGroup({
  title,
  kind,
  projectId,
  repo,
  q,
  children,
}: {
  title: string
  kind: RefKind
  projectId: string
  repo: string
  q: string
  children: (name: string) => React.ReactNode
}) {
  const settings = useServer()
  const [open, setOpen] = React.useState(kind === "local")
  const query = useInfiniteQuery({
    queryKey: projectGitRefsKey(settings, projectId, repo).concat([kind, q]),
    queryFn: ({ pageParam, signal }) => gitRefs(settings, projectId, { kind, offset: pageParam, limit: PAGE, q: q || undefined, repo: repo || undefined }, signal),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((sum, page) => sum + page.items.length, 0)
      return loaded < last.total ? loaded : undefined
    },
    enabled: open,
    staleTime: 30_000,
  })
  const names = query.data?.pages.flatMap((page) => page.items) ?? []
  const total = query.data?.pages[0]?.total

  const sentinel = React.useRef<HTMLLIElement>(null)
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query
  React.useEffect(() => {
    const node = sentinel.current
    if (!node || !hasNextPage) return
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting && !isFetchingNextPage) void fetchNextPage()
    }, { rootMargin: "120px" })
    observer.observe(node)
    return () => observer.disconnect()
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, names.length])

  return (
    <section>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex h-7 w-full items-center gap-1 bg-muted/50 px-2 text-left text-xs font-medium text-muted-foreground outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset">
        {open ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
        <span className="flex-1 truncate">{title}</span>
        {total !== undefined && <Count>{total}</Count>}
      </button>
      {open && (
        <ul className="pb-1">
          {names.map((name) => <React.Fragment key={name}>{children(name)}</React.Fragment>)}
          {query.isError ? (
            <li className="p-1">
              <Notice size="sm" tone="error" copy={errorText(query.error, `Could not load ${title.toLowerCase()}`)}>
                Could not load {title.toLowerCase()}.
              </Notice>
            </li>
          ) : query.isPending ? (
            <li><PanelRowsSkeleton rows={3} className="space-y-1.5 p-1" /></li>
          ) : names.length === 0 ? (
            <li><Empty className="m-1">{q ? "No match" : "None"}</Empty></li>
          ) : null}
          {hasNextPage && <li ref={sentinel} className="min-h-2">{isFetchingNextPage && <PanelRowsSkeleton rows={1} className="p-1" />}</li>}
        </ul>
      )}
    </section>
  )
}

interface MenuItem {
  label: string
  run: () => void
  destructive?: boolean
  /** A rule above this item. */
  rule?: boolean
}

/** A tick for the bulk delete; `selecting` keeps every tick drawn once one is on. */
interface Tick {
  on: boolean
  selecting: boolean
  toggle: () => void
}

function Place({ name, current, onReveal, onCheckout, coarse, menu = [], tick, pin }: { name: string; current?: boolean; onReveal: () => void; onCheckout?: () => void; coarse: boolean; menu?: MenuItem[]; tick?: Tick; pin?: { pinned: boolean; toggle: () => void } }) {
  const row = (
    <li className={cn("group flex items-center pr-1 hover:bg-muted/50", coarse ? "min-h-10" : "min-h-6")}>
      {tick && (
        <Checkbox
          aria-label={`Select ${name}`}
          className={cn("ml-2", !(tick.on || tick.selecting || coarse) && "opacity-0 group-hover:opacity-100 focus-visible:opacity-100")}
          checked={tick.on}
          onClick={tick.toggle}
        />
      )}
      <button type="button" onClick={onReveal} onDoubleClick={onCheckout} title={name} className={cn("flex min-w-0 flex-1 items-center gap-1.5 text-left text-sm", tick ? "pl-1.5" : "pl-6", current && "font-medium")}>
        {current && <CheckIcon className="-ml-4 size-3 shrink-0 text-success" />}
        <span className="truncate">{name}</span>
      </button>
      {pin && (
        <Button variant="ghost" size="icon-xs" onClick={pin.toggle} title={pin.pinned ? `Unpin ${name}` : `Pin ${name}`} aria-label={pin.pinned ? `Unpin ${name}` : `Pin ${name}`} className={cn("shrink-0 text-muted-foreground", !coarse && !pin.pinned && "opacity-0 group-hover:opacity-100 focus-visible:opacity-100")}>
          {pin.pinned ? <PinOffIcon /> : <PinIcon />}
        </Button>
      )}
      {onCheckout && !current && (
        <Button variant="ghost" size="icon-xs" onClick={onCheckout} title={`Check out ${name}`} aria-label={`Check out ${name}`} className={cn("shrink-0 text-muted-foreground", !coarse && "opacity-0 group-hover:opacity-100 focus-visible:opacity-100")}>
          <LogInIcon />
        </Button>
      )}
    </li>
  )
  if (menu.length === 0) return row
  return (
    <ContextMenu>
      <ContextMenuTrigger render={row} />
      <ContextMenuContent>
        {menu.map((item) => (
          <React.Fragment key={item.label}>
            {item.rule && <ContextMenuSeparator />}
            <ContextMenuItem variant={item.destructive ? "destructive" : "default"} onClick={item.run}>{item.label}</ContextMenuItem>
          </React.Fragment>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  )
}

export function Locations({
  projectId,
  repo,
  head,
  coarse,
  busy,
  canStash,
  stashGeneration,
  onReveal,
  onCheckout,
  onAction: runAction,
  onStash,
  onStatus,
}: {
  projectId: string
  repo: string
  /** The checked-out branch, from the status - the lists never load whole to find it. */
  head: string | null
  coarse: boolean
  busy: boolean
  canStash: boolean
  stashGeneration: number
  /** A ref name (`main`, `origin/main`, `tag: v1`) to find in the table. */
  onReveal: (ref: string) => void
  onCheckout: (branch: string, remote: boolean) => void
  /** A branch-menu verb; the panel owns the write, its notice and its error. */
  onAction: (action: GitAction) => Promise<boolean>
  onStash: (message: string) => void
  onStatus: (status: GitStatus) => void
}) {
  /* Ticked local branches (`branch\0name`) and tags (`tag\0name`) for the bulk delete.
     The checked-out branch and remote refs have no tick: one cannot be deleted
     here and the other is not this repository's to delete. */
  const [ticks, setTicks] = React.useState<ReadonlySet<string>>(() => new Set())
  const flip = (key: string) => () => setTicks((current) => {
    const next = new Set(current)
    if (!next.delete(key)) next.add(key)
    return next
  })
  const tickFor = (key: string): Tick => ({ on: ticks.has(key), selecting: ticks.size > 0, toggle: flip(key) })
  const [deleting, setDeleting] = React.useState(false)
  const [message, setMessage] = React.useState("")
  const [filter, setFilter] = React.useState("")
  const [q, setQ] = React.useState("")
  React.useEffect(() => {
    const timer = setTimeout(() => setQ(filter.trim()), 250)
    return () => clearTimeout(timer)
  }, [filter])
  const confirm = useConfirm()
  const deleteTicked = async () => {
    const keys = [...ticks]
    const ok = await confirm({
      title: `Delete ${keys.length} ${keys.length === 1 ? "ref" : "refs"}?`,
      description: `${keys.map((key) => key.split("\0")[1]).slice(0, 8).join(", ")}${keys.length > 8 ? ` and ${keys.length - 8} more` : ""}. Branches git considers unmerged are refused; tags are local only.`,
      confirmLabel: "Delete",
      destructive: true,
    })
    if (!ok) return
    setDeleting(true)
    /* One at a time, and the first refusal stops the run: the panel says why,
       and the refs already gone stay gone. */
    for (const key of keys) {
      const [kind, name] = key.split("\0") as ["branch" | "tag", string]
      if (!(await onAction(kind === "tag" ? { action: "delete-tag", branch: name } : { action: "delete-branch", branch: name }))) break
      setTicks((current) => {
        const next = new Set(current)
        next.delete(key)
        return next
      })
    }
    setDeleting(false)
  }
  const prompt = usePrompt()

  /* A pin follows its branch: gone with a delete, moved with a rename. */
  const pinned = usePinnedBranches(projectId, repo)
  const pinTo = (name: string, on: boolean) => setBranchPinned(projectId, repo, name, on)
  const onAction = async (action: GitAction) => {
    const ok = await runAction(action)
    if (ok && action.action === "delete-branch") pinTo(action.branch, false)
    if (ok && action.action === "rename-branch" && pinned.includes(action.branch)) {
      pinTo(action.branch, false)
      pinTo(action.to, true)
    }
    return ok
  }
  const shownPins = pinned.filter((name) => name.toLowerCase().includes(filter.trim().toLowerCase()))

  /* Right-click (long-press on touch) on a place. Merge and rebase name both
     branches in the label, because "into what" is the question the menu is for. */
  const menuFor = (name: string, kind: "local" | "remote" | "tag"): MenuItem[] => {
    if (kind === "tag")
      return [{ label: `Delete tag ${name}…`, destructive: true, run: () => void confirm({ title: `Delete tag ${name}?`, description: "Only the local tag is deleted.", confirmLabel: "Delete", destructive: true }).then((ok) => ok && onAction({ action: "delete-tag", branch: name })) }]
    const items: MenuItem[] = []
    if (name !== head) {
      items.push({ label: kind === "remote" ? "Check out as tracking branch" : "Check out", run: () => onCheckout(name, kind === "remote") })
      if (head) {
        items.push({ label: `Merge ${name} into ${head}`, rule: true, run: () => onAction({ action: "merge", branch: name }) })
        items.push({ label: `Rebase ${head} onto ${name}…`, run: () => void confirm({ title: `Rebase ${head} onto ${name}?`, description: "Rewrites the commits of the current branch. If it conflicts, the rebase is aborted and nothing changes.", confirmLabel: "Rebase" }).then((ok) => ok && onAction({ action: "rebase", branch: name })) })
      }
    }
    if (kind === "local") {
      items.push({ label: pinned.includes(name) ? "Unpin" : "Pin to top", rule: items.length > 0, run: () => pinTo(name, !pinned.includes(name)) })
      items.push({ label: "Rename…", run: () => void prompt({ title: `Rename ${name}`, value: name, confirmLabel: "Rename" }).then((to) => { if (to && to !== name) void onAction({ action: "rename-branch", branch: name, to }) }) })
      if (name !== head)
        items.push({ label: "Delete…", destructive: true, run: () => void confirm({ title: `Delete branch ${name}?`, description: "Git refuses if it has commits that are not merged anywhere else.", confirmLabel: "Delete", destructive: true }).then((ok) => ok && onAction({ action: "delete-branch", branch: name })) })
    }
    return items
  }

  const localRow = (name: string) => (
    <Place name={name} current={name === head} coarse={coarse} onReveal={() => onReveal(name)} onCheckout={() => onCheckout(name, false)} menu={menuFor(name, "local")} tick={name === head ? undefined : tickFor(`branch\0${name}`)} pin={{ pinned: pinned.includes(name), toggle: () => pinTo(name, !pinned.includes(name)) }} />
  )

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="sticky top-0 z-10 border-b bg-background p-1.5">
        <InputGroup className="h-8">
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter branches and tags" aria-label="Filter branches and tags" />
        </InputGroup>
        {ticks.size > 0 && (
          <div role="toolbar" aria-label="Bulk actions" className="mt-1.5 flex items-center gap-1 text-xs">
            <span className="mr-auto font-medium tabular-nums">{ticks.size} selected</span>
            <Button size="xs" variant="destructive" disabled={busy || deleting} onClick={() => void deleteTicked()}>Delete</Button>
            <Button size="xs" variant="ghost" disabled={deleting} onClick={() => setTicks(new Set())}>Clear</Button>
          </div>
        )}
      </div>
      {shownPins.length > 0 && (
        <section>
          <div className="flex h-7 items-center gap-1 bg-muted/50 px-2 text-xs font-medium text-muted-foreground">
            <PinIcon className="size-3" />
            <span className="flex-1 truncate">Pinned</span>
          </div>
          <ul className="pb-1">
            {shownPins.map((name) => <React.Fragment key={name}>{localRow(name)}</React.Fragment>)}
          </ul>
        </section>
      )}
      <RefGroup title="Local branches" kind="local" projectId={projectId} repo={repo} q={q}>
        {localRow}
      </RefGroup>
      <RefGroup title="Remote branches" kind="remote" projectId={projectId} repo={repo} q={q}>
        {(name) => <Place name={name} coarse={coarse} onReveal={() => onReveal(name)} onCheckout={() => onCheckout(name, true)} menu={menuFor(name, "remote")} />}
      </RefGroup>
      <RefGroup title="Tags" kind="tag" projectId={projectId} repo={repo} q={q}>
        {(name) => <Place name={name} coarse={coarse} onReveal={() => onReveal(`tag: ${name}`)} menu={menuFor(name, "tag")} tick={tickFor(`tag\0${name}`)} />}
      </RefGroup>
      <div className="border-t">
        <form className="flex items-center gap-1 px-2 py-1.5" onSubmit={(event) => { event.preventDefault(); onStash(message.trim()); setMessage("") }}>
          <Input value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Stash message" aria-label="Stash message" className="h-8 min-w-0 flex-1" />
          <Button type="submit" size="icon-sm" variant="outline" disabled={busy || !canStash} title="Stash the working directory" aria-label="Stash the working directory"><ArchiveIcon /></Button>
        </form>
        <StashSection key={stashGeneration} projectId={projectId} repo={repo} open fixed onToggle={() => {}} onStatus={onStatus} coarse={coarse} />
      </div>
    </div>
  )
}
