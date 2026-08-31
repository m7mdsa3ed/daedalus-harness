/* ── The Studio ── /studio
 *
 * A project in this harness is a *row*, not a place it made: `createProject`
 * records a name and a cwd and never creates the directory, so every project
 * here was assembled by hand somewhere else first — and the first turn of the
 * first thread is spent re-explaining a stack the last five projects also had.
 *
 * The Studio is the missing front door. A template is a repo, a kit (MCP
 * servers, skills, commands) and an instruction, all of it data. Picking one
 * creates the directory, records the project, and opens a **draft** thread
 * whose composer is already prefilled with that instruction — which the agent
 * carries out in its first turn. Nothing is sent: the draft model already means
 * no session row and no agent process exist until the first message, so the
 * prompt opens editable and "…and make it a CLI, not a server" is something you
 * can add before anything runs. The harness clones nothing and installs
 * nothing; the transcript is the progress view, because it is where a failure
 * would be readable anyway.
 *
 * Built like `project-page.tsx`: a header, a filter, and cards, over one fetch
 * that is not on a timer.
 */
import * as React from "react"
import {
  AlertTriangleIcon,
  BlocksIcon,
  BookOpenIcon,
  FolderPlusIcon,
  GitBranchIcon,
  Loader2,
  PlugZapIcon,
  RefreshCwIcon,
  SearchIcon,
  SlashIcon,
  SparklesIcon,
} from "lucide-react"
import { useNavigate } from "react-router"
import { AgentIcon, EntityIcon, ProfileIcon } from "@/components/entity-icon"
import { ErrorNote } from "@/components/error-note"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { PathInput } from "@/components/ui/suggesting-input"
import type { Actions } from "@/lib/actions"
import { saveDraft } from "@/lib/drafts"
import { captureError, type InlineError } from "@/lib/errors"
import { threadPath } from "@/lib/router"
import { loadSettings, profileSupports, type Profile } from "@/lib/settings"
import { useStore } from "@/lib/store"
import {
  createProjectFromTemplate,
  listTemplates,
  repoHost,
  slugifyName,
  type Template,
} from "@/lib/templates"
import {
  defaultToolPicks,
  loadThreadDefaults,
  resolveThreadStart,
  saveThreadDefaults,
} from "@/lib/thread-defaults"
import { cn } from "@/lib/utils"

/* "Any runtime" is a sentinel, not an empty string. Base UI reads a value the
   list does not offer as unselected, and the one Select in this app that
   already needed an all-of-them row (`settings/knowledge.tsx`) spells it the
   same way — an empty `SelectItem` value is a row that cannot be chosen back
   to once you have left it. */
const ANY_RUNTIME = "__any__"

export function StudioPage({ actions }: { actions: Actions }) {
  const { templates, error, loading, refresh } = useTemplates()
  const [query, setQuery] = React.useState("")
  const [runtime, setRuntime] = React.useState(ANY_RUNTIME)
  const [tag, setTag] = React.useState("")
  const [picked, setPicked] = React.useState<Template | null>(null)

  const runtimes = React.useMemo(
    () => [...new Set(templates.map((t) => t.runtime.trim()).filter(Boolean))].sort(),
    [templates]
  )
  const tags = React.useMemo(
    () => [...new Set(templates.flatMap((t) => t.tags).map((t) => t.trim()).filter(Boolean))].sort(),
    [templates]
  )

  const shown = React.useMemo(() => {
    const needle = query.trim().toLowerCase()
    return templates.filter((template) => {
      if (runtime !== ANY_RUNTIME && template.runtime !== runtime) return false
      if (tag && !template.tags.includes(tag)) return false
      if (!needle) return true
      const haystack = [
        template.name,
        template.description,
        template.runtime,
        template.repoUrl,
        ...template.tags,
      ]
        .join(" ")
        .toLowerCase()
      return haystack.includes(needle)
    })
  }, [templates, query, runtime, tag])

  /* A tag or runtime that has been filtered out of existence is a dead
     control: clear it rather than leave a chip selected over an empty grid. */
  React.useEffect(() => {
    if (runtime !== ANY_RUNTIME && !runtimes.includes(runtime)) setRuntime(ANY_RUNTIME)
    if (tag && !tags.includes(tag)) setTag("")
  }, [runtime, runtimes, tag, tags])

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl px-4 pt-6 pb-16 sm:px-8">
        <div className="flex flex-wrap items-start gap-4">
          <span className="grid size-11 shrink-0 place-items-center rounded-full bg-primary/10 text-primary ring-1 ring-border/40">
            <SparklesIcon className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-semibold tracking-tight">Studio</h1>
            <p className="mt-1 max-w-prose text-sm text-pretty text-muted-foreground">
              Start a project from a template. The harness creates the directory and records
              the project; the agent clones, installs and reports in the first turn — which
              opens prefilled and unsent, so you can change it first.
            </p>
          </div>
          <Button variant="ghost" size="icon" title="Refresh" onClick={refresh}>
            <RefreshCwIcon className={cn(loading && "animate-spin")} />
            <span className="sr-only">Refresh</span>
          </Button>
        </div>

        {error && (
          <p className="mt-4 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            <AlertTriangleIcon className="mt-px size-3.5 shrink-0" />
            <span className="text-pretty">
              {error}{" "}
              <button type="button" className="underline" onClick={refresh}>
                Try again
              </button>
            </span>
          </p>
        )}

        <div className="mt-6 flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-48 flex-1">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter templates…"
                className="pl-8"
              />
            </div>
            {runtimes.length > 1 && (
              <Select value={runtime} onValueChange={(value) => setRuntime(value ?? ANY_RUNTIME)}>
                <SelectTrigger className="w-full sm:w-44">
                  <SelectValue>{runtime === ANY_RUNTIME ? "Any runtime" : runtime}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY_RUNTIME}>Any runtime</SelectItem>
                  {runtimes.map((entry) => (
                    <SelectItem key={entry} value={entry}>
                      {entry}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {tags.map((entry) => (
                <button
                  key={entry}
                  type="button"
                  onClick={() => setTag((current) => (current === entry ? "" : entry))}
                  className={cn(
                    "rounded-pill border px-2 py-0.5 text-xs transition-colors",
                    tag === entry
                      ? "border-primary bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-accent/40"
                  )}
                >
                  {entry}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {loading && templates.length === 0
            ? Array.from({ length: 4 }, (_, i) => <CardSkeleton key={i} />)
            : shown.map((template) => (
                <TemplateCard
                  key={template.id}
                  template={template}
                  onUse={() => setPicked(template)}
                />
              ))}
        </div>

        {!loading && shown.length === 0 && (
          <p className="mt-8 text-center text-xs text-muted-foreground">
            {templates.length === 0
              ? "No templates yet — add one in Settings › Templates."
              : "Nothing matches that filter."}
          </p>
        )}
      </div>

      <UseTemplateDialog
        template={picked}
        onOpenChange={(open) => {
          if (!open) setPicked(null)
        }}
        actions={actions}
      />
    </div>
  )
}

export default StudioPage

/* ── Data ── */

function useTemplates() {
  const [templates, setTemplates] = React.useState<Template[]>([])
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(true)
  /* A counter rather than a callback that fetches, so the one effect owns the
     abort and a Refresh landing mid-flight cancels the request it replaces. */
  const [nonce, setNonce] = React.useState(0)

  React.useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    listTemplates(controller.signal)
      .then((next) => {
        setTemplates(next)
        setError(null)
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        const info = captureError(err, "Couldn't load the templates")
        setError(info ? [info.title, info.detail].filter(Boolean).join(" — ") : null)
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [nonce])

  return { templates, error, loading, refresh: () => setNonce((n) => n + 1) }
}

/* ── The card ── */

function TemplateCard({ template, onUse }: { template: Template; onUse: () => void }) {
  const host = repoHost(template.repoUrl)
  return (
    <section className="flex flex-col rounded-xl border bg-card p-4">
      <div className="flex items-start gap-3">
        <EntityIcon
          src={template.logoUrl}
          className="size-9"
          fallback={
            <span
              aria-hidden="true"
              className="grid size-9 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground ring-1 ring-border/40"
            >
              <BlocksIcon className="size-4" />
            </span>
          }
        />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-medium">{template.name}</h2>
          <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <GitBranchIcon className="size-3 shrink-0" />
            <span className="truncate font-mono" title={template.repoUrl}>
              {host ?? template.repoUrl}
              {template.repoRef ? ` · ${template.repoRef}` : ""}
            </span>
          </p>
        </div>
        {template.runtime && (
          <Badge variant="secondary" className="shrink-0">
            {template.runtime}
          </Badge>
        )}
      </div>

      {template.description && (
        <p className="mt-3 line-clamp-3 text-xs text-pretty text-muted-foreground">
          {template.description}
        </p>
      )}

      {template.tags.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1">
          {template.tags.map((tag) => (
            <span
              key={tag}
              className="rounded-pill border px-1.5 py-px text-[11px] text-muted-foreground"
            >
              {tag}
            </span>
          ))}
        </div>
      )}

      <TemplateKit template={template} />

      <div className="mt-4 flex justify-end">
        <Button size="sm" onClick={onUse}>
          <FolderPlusIcon /> Use this template
        </Button>
      </div>
    </section>
  )
}

/** What the template brings on top of the profile's own links. Resolved to
    names from the store, because a count of three says nothing about which
    three — and a linked row since deleted simply is not there, which is the
    standing rule for a link id that names nothing. */
function TemplateKit({ template }: { template: Template }) {
  const { state } = useStore()
  const entries: { icon: React.ReactNode; label: string }[] = []
  for (const id of template.mcpServerIds) {
    const server = state.mcpServers.find((row) => row.id === id)
    if (server) entries.push({ icon: <PlugZapIcon className="size-3" />, label: server.name })
  }
  for (const id of template.skillIds) {
    const skill = state.skills.find((row) => row.id === id)
    if (skill) entries.push({ icon: <BookOpenIcon className="size-3" />, label: skill.name })
  }
  for (const id of template.commandIds) {
    const command = state.commands.find((row) => row.id === id)
    if (command) entries.push({ icon: <SlashIcon className="size-3" />, label: `/${command.name}` })
  }
  if (entries.length === 0) return null

  return (
    <div className="mt-3 border-t pt-3">
      <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        Comes with
      </p>
      <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
        {entries.map((entry, i) => (
          <li key={i} className="flex items-center gap-1 text-xs text-muted-foreground">
            {entry.icon}
            <span className="truncate">{entry.label}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function CardSkeleton() {
  return (
    <div className="space-y-3 rounded-xl border bg-card p-4">
      <div className="flex items-center gap-3">
        <Skeleton className="size-9 rounded-full" />
        <Skeleton className="h-4 w-32" />
      </div>
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-2/3" />
    </div>
  )
}

/* ── The dialog ── */

/**
 * Name it, say where it goes, and pick who works on it.
 *
 * The confirm is the plan's flow, in order and with nothing extra: create the
 * directory and the project row, re-read the projects (the store is what
 * `newDraftThread` puts the thread in), mint a draft on the chosen pair, put
 * the rendered prompt in that draft's composer, and go there. **Nothing is
 * sent** — the draft is client-side until its first message, so the server has
 * no session row and no process yet.
 *
 * Failures stay in here as an `ErrorNote` rather than a toast: this dialog
 * covers the corner a toast appears in, and the half-filled form the user is
 * looking at gives no other sign anything went wrong.
 */
function UseTemplateDialog({
  template,
  onOpenChange,
  actions,
}: {
  template: Template | null
  onOpenChange: (open: boolean) => void
  actions: Actions
}) {
  const { state } = useStore()
  const navigate = useNavigate()
  const settings = loadSettings()

  const [name, setName] = React.useState("")
  const [parentDir, setParentDir] = React.useState("")
  const [folder, setFolder] = React.useState("")
  /* The folder tracks the name until it is typed in, and then stops — an
     edited folder that silently reverts on the next keystroke of the name is
     the field arguing with the user. */
  const [folderEdited, setFolderEdited] = React.useState(false)
  const [agentId, setAgentId] = React.useState("")
  const [profileId, setProfileId] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<InlineError | null>(null)

  const profilesFor = React.useCallback(
    (id: string) => state.profiles.filter((p) => profileSupports(p, id)),
    [state.profiles]
  )

  /* Opening is the reset: the dialog is about one template and reopening it on
     another must not inherit the last one's name. The pair comes from the same
     remembered defaults every other new thread starts from, so a Studio thread
     is configured like any other; the parent directory defaults to where the
     projects that already exist live, which is the answer nine times in ten. */
  const open = template !== null
  React.useEffect(() => {
    if (!template) return
    setName(template.name)
    setFolder("")
    setFolderEdited(false)
    setError(null)
    setBusy(false)
    setParentDir(defaultParentDir(state.projects.map((p) => p.cwd)))
    const start = resolveThreadStart(loadThreadDefaults(), state.profiles)
    setAgentId(start?.agentId ?? "")
    setProfileId(start?.profile.id ?? "")
    // Only when the dialog opens on a template — not on every store change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template])

  const pickAgent = (next: string) => {
    setAgentId(next)
    const serving = profilesFor(next)
    setProfileId((current) =>
      serving.some((p) => p.id === current) ? current : (serving[0]?.id ?? "")
    )
  }

  const agents = state.agents.filter((agent) => profilesFor(agent.id).length > 0)
  const profiles = profilesFor(agentId)
  const profile: Profile | undefined = profiles.find((p) => p.id === profileId)
  const slug = folderEdited ? folder.trim() : slugifyName(name)
  const parent = parentDir.trim().replace(/\/+$/, "")
  const ready = Boolean(template && name.trim() && parent && slug && profile && !busy)

  const create = async () => {
    if (!template || !profile || !ready) return
    setBusy(true)
    setError(null)
    try {
      const created = await createProjectFromTemplate({
        templateId: template.id,
        name: name.trim(),
        parentDir: parent,
        folderName: slug,
      })
      /* The store is what `newDraftThread` files the draft under, so the
         project has to be in it before the draft names it. */
      await actions.refreshProjects()
      /* The kit rides the draft's own tool picks — the same localStorage habit
         store the composer strip writes, which is where `newDraftThread` reads
         them from — so the template's servers, skills and commands are what
         `POST /api/sessions` gets when the first message is finally sent. */
      const picks = defaultToolPicks(loadThreadDefaults())
      saveThreadDefaults({
        mcpServerIds: [...new Set([...picks.mcpServerIds, ...created.links.mcpServerIds])],
        skillIds: [...new Set([...picks.skillIds, ...created.links.skillIds])],
        commandIds: [...new Set([...picks.commandIds, ...created.links.commandIds])],
      })
      const id = actions.newDraftThread({ project: created.project, profile, agentId })
      // Prefilled and unsent: the composer opens with it and it is editable.
      saveDraft(id, created.prompt)
      onOpenChange(false)
      void navigate(threadPath(id))
    } catch (err) {
      setError(captureError(err, "Couldn't create the project"))
      setBusy(false)
    }
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="sm:max-w-lg">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>{template ? template.name : "Use template"}</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            The directory is created empty and the project recorded. The clone and the install
            are the agent's first turn — which opens in the composer, unsent.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        <div className="flex flex-col gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="studio-name">Project name</Label>
            <Input
              id="studio-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My service"
              autoFocus
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="studio-parent">Parent directory</Label>
            {settings ? (
              <PathInput
                id="studio-parent"
                value={parentDir}
                onValueChange={setParentDir}
                settings={settings}
                placeholder="/home/you/code"
              />
            ) : (
              <Input
                id="studio-parent"
                value={parentDir}
                onChange={(e) => setParentDir(e.target.value)}
                className="font-mono text-xs"
                placeholder="/home/you/code"
              />
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="studio-folder">Folder name</Label>
            <Input
              id="studio-folder"
              value={folderEdited ? folder : slugifyName(name)}
              onChange={(e) => {
                setFolderEdited(true)
                setFolder(e.target.value)
              }}
              className="font-mono text-xs"
              placeholder={slugifyName(name) || "my-service"}
            />
            <p className="truncate text-[11px] text-muted-foreground" title={`${parent}/${slug}`}>
              {parent && slug ? `${parent}/${slug}` : "Pick a directory to create it in."}
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <Select value={agentId} onValueChange={(value) => value && pickAgent(value)}>
              <SelectTrigger className="min-w-40 flex-1">
                <SelectValue>
                  <span className="flex items-center gap-2">
                    <AgentIcon agentId={agentId} className="size-4" />
                    {state.agents.find((a) => a.id === agentId)?.name ?? (agentId || "Agent")}
                  </span>
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {agents.map((agent) => (
                  <SelectItem key={agent.id} value={agent.id}>
                    <span className="flex items-center gap-2">
                      <AgentIcon agentId={agent.id} className="size-4" />
                      {agent.name}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={profileId} onValueChange={(value) => value && setProfileId(value)}>
              <SelectTrigger className="min-w-40 flex-1">
                <SelectValue>
                  <span className="flex items-center gap-2">
                    <ProfileIcon profile={profile} agentId={agentId} className="size-4" />
                    {profile?.name ?? "Profile"}
                  </span>
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {profiles.map((entry) => (
                  <SelectItem key={entry.id} value={entry.id}>
                    <span className="flex items-center gap-2">
                      <ProfileIcon profile={entry} agentId={agentId} className="size-4" />
                      {entry.name}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <ErrorNote error={error} />

        <ResponsiveDialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button disabled={!ready} onClick={() => void create()}>
            {busy ? <Loader2 className="animate-spin" /> : <FolderPlusIcon />}
            Create project
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

/** Where the projects that already exist live — the commonest parent of their
    working directories. A guess, and an editable one, but it beats an empty
    field that lists the server's home directory. */
function defaultParentDir(cwds: readonly string[]): string {
  const counts = new Map<string, number>()
  for (const cwd of cwds) {
    const at = cwd.replace(/\/+$/, "").lastIndexOf("/")
    if (at <= 0) continue
    const parent = cwd.slice(0, at)
    counts.set(parent, (counts.get(parent) ?? 0) + 1)
  }
  let best = ""
  let seen = 0
  for (const [parent, count] of counts) {
    if (count > seen) {
      best = parent
      seen = count
    }
  }
  return best
}
