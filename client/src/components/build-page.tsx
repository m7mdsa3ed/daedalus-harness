/* ── Build an app ── /build
 *
 * The front door for making something: say what it is, and the harness
 * scaffolds a project on this host, opens a thread on it with the App builder
 * persona, frames the running app beside the thread and sends the words as
 * the first message. One gesture; the page exists so that the project, the
 * thread and the preview are set up in the right order before anyone types a
 * second thing.
 *
 * **The stack is sensed, not asked for.** `lib/stack-sense.ts` reads the
 * prompt on every keystroke against the starters' own `signals` and a table
 * of stacks no starter ships: a brief that says "login" and "save" lands on
 * React + Hono, "landing page" on the static site, and "Flask" or "Next.js"
 * on *from scratch* — an empty repository with a rules file, where the agent
 * sets the stack up itself and the harness senses the dev command off the
 * directory when that first turn ends. The cards are still there and a click
 * on one is an explicit pick that sensing never overrides; "auto" is the way
 * back. Before sensing existed the first card was silently the answer for
 * every prompt, and a Python brief became a React app.
 *
 * **The box is the real composer on a real draft.** Not a lookalike: the page
 * mints a draft thread on mount (`newDraftThread`) and mounts `Composer` on
 * it, so the agent/profile scope row, the config popover (model, effort,
 * persona, the agent's own options), the tool picks, attachments, long pastes
 * and every key behave exactly as in a thread. What the page adds is the
 * starter picker in the scope row's project slot — the project does not exist
 * yet — and `beforeSend`, which is where it comes to exist: POST the template,
 * point the draft at the new project, queue the preview beside the thread the
 * shell is about to open, navigate, and hand back to the composer's own send,
 * which materialises the draft with everything the user set on it.
 *
 * The draft's project until then is the remembered default (or the first);
 * the project half is hidden and replaced at Build. A synthetic project id
 * would have cost more than it saved — the option probe, the `@` file search
 * and the sidebar's folders all resolve a draft's project against the
 * catalog, and each of them would have had a failure to swallow.
 *
 * Leaving without building drops the draft if nothing was typed; a draft with
 * words in it survives the navigation like any other.
 */
import * as React from "react"
import { ChevronDownIcon, HammerIcon, LayoutTemplateIcon, SettingsIcon, SparklesIcon } from "lucide-react"
import { useNavigate } from "react-router"

import { useAttachmentDelivery } from "@/components/composer-attachments"
import { PickerMenu } from "@/components/draft-config"
import { ErrorNote } from "@/components/error-note"
import { Composer } from "@/components/composer"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { PathInput } from "@/components/ui/suggesting-input"
import type { Actions } from "@/lib/actions"
import { loadDraft, watchDraft } from "@/lib/drafts"
import { captureError, inlineFromQuery, type InlineError } from "@/lib/errors"
import { useInvalidateCatalog, useProfiles, useProjects } from "@/lib/queries/catalog"
import { useCreateFromTemplate, useTemplates } from "@/lib/queries/templates"
import { settingsPath, threadPath } from "@/lib/router"
import { useServer } from "@/lib/server-context"
import { SCRATCH_TEMPLATE_ID, type Project, type Template } from "@/lib/settings"
import { senseStack, type StackSense } from "@/lib/stack-sense"
import { useSessionMeta, useThread } from "@/lib/store"
import {
  defaultsForProfile,
  loadThreadDefaults,
  resolveThreadStart,
  saveThreadDefaults,
} from "@/lib/thread-defaults"
import { cn } from "@/lib/utils"
import { queuePanel } from "@/lib/workspace/pending-panels"
import { previewPanel } from "@/lib/workspace/preview-bridge"

/** The persona every built app is worked on with (seeded server-side). */
const APP_BUILDER_PERSONA = "builtin:app-builder"

/** Stands in for a project only when the server has none at all — a draft
    needs one to exist, and `beforeSend` replaces it before anything is sent. */
const PLACEHOLDER_PROJECT: Project = { id: "__build__", name: "New app", cwd: "", description: null }

const NAME_MAX = 40
const STOPWORDS = new Set([
  "a", "an", "the", "i", "id", "i'd", "we", "me", "my", "our", "want", "need", "would", "like",
  "to", "please", "build", "make", "create", "write", "design", "develop", "code", "app",
  "application", "website", "site", "page", "simple", "small", "basic", "new", "for", "with",
  "that", "which", "of", "and", "let's", "lets", "can", "you", "could", "some", "kind",
])

/** A project name out of the first words of the prompt: the leading "build
    me a" is dropped, three content words are kept, Title Cased. Only a
    suggestion — the field is editable and stops following once touched. */
export function deriveProjectName(prompt: string): string {
  const words = prompt
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
  const kept: string[] = []
  for (const word of words) {
    if (STOPWORDS.has(word)) continue
    kept.push(word.replace(/^'+|'+$/g, ""))
    if (kept.length === 3) break
  }
  return kept
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")
    .slice(0, NAME_MAX)
    .trim()
}

export function BuildPage({ actions }: { actions: Actions }) {
  const navigate = useNavigate()
  const settings = useServer()
  const profiles = useProfiles()
  const projects = useProjects()
  const invalidate = useInvalidateCatalog()
  const { templates, isPending: templatesPending, error: templatesError, refetch } = useTemplates()
  const create = useCreateFromTemplate()

  /* The user's explicit pick: a starter's id, `SCRATCH_TEMPLATE_ID`, or null
     for "follow the prompt". Sensing is a suggestion; a click is a decision. */
  const [picked, setPicked] = React.useState<string | null>(null)
  const [name, setName] = React.useState("")
  const [nameTouched, setNameTouched] = React.useState(false)
  const [parent, setParent] = React.useState("")
  const [advanced, setAdvanced] = React.useState(false)
  const [error, setError] = React.useState<InlineError | null>(null)

  /* The draft this page composes on. Minted once profiles are known (a draft
     is a (profile, agent) pair) and dropped on the way out unless something
     was typed into it — see the cleanup. `built` is what tells the cleanup a
     departure is the Build itself: the draft is mid-send and belongs to the
     thread route now. */
  const [draftId, setDraftId] = React.useState<string | null>(null)
  const built = React.useRef(false)
  const canDraft = profiles.length > 0
  React.useEffect(() => {
    if (!canDraft) return
    const defaults = loadThreadDefaults()
    const start = resolveThreadStart(defaults, profiles)
    if (!start) return
    const project =
      projects.find((p) => p.id === defaults.projectId) ?? projects[0] ?? PLACEHOLDER_PROJECT
    const id = actions.newDraftThread({
      project,
      ...start,
      ...defaultsForProfile(defaults, start.profile.id),
    })
    actions.configureDraft(id, { personaId: APP_BUILDER_PERSONA })
    setDraftId(id)
    return () => {
      setDraftId(null)
      if (built.current) return
      if (loadDraft(id).trim()) return
      void actions.deleteThread(id).catch(() => {})
    }
    /* Once: the catalog settling later must not mint a second draft. `canDraft`
       flipping true is the one re-run wanted. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canDraft, actions])

  const meta = useSessionMeta(draftId ?? "")
  const thread = useThread(draftId ?? "")
  const delivery = useAttachmentDelivery(meta, thread)

  /* The name and the stack both follow the box until edited. Read from the
     draft store rather than from composer state: the composer owns its text,
     and the draft is the one channel it already writes on every keystroke. */
  const [prompt, setPrompt] = React.useState("")
  React.useEffect(() => {
    if (!draftId) return
    setPrompt(loadDraft(draftId))
    return watchDraft(draftId, setPrompt)
  }, [draftId])
  const derived = React.useMemo(() => deriveProjectName(prompt), [prompt])
  const shownName = nameTouched ? name : derived

  const sensed = React.useMemo(() => senseStack(prompt, templates), [prompt, templates])
  /* What Build will use: the pick when there is one, else what was sensed. */
  const choice: StackSense | null = React.useMemo(() => {
    if (picked === SCRATCH_TEMPLATE_ID)
      return { kind: "scratch", stack: null, matched: [], reason: "your pick" }
    const explicit = picked ? templates.find((t) => t.id === picked) : undefined
    if (explicit) return { kind: "template", template: explicit, matched: [], reason: "your pick" }
    return sensed
  }, [picked, sensed, templates])
  const chosenId = choice?.kind === "template" ? choice.template.id : choice ? SCRATCH_TEMPLATE_ID : ""

  /* What Build does, between the composer taking the words and sending them.
     Everything the user set on the draft — persona, model, effort, tool picks,
     attachments — goes out with the composer's own send; this only supplies
     the project. */
  const build = async (text: string): Promise<boolean> => {
    if (!draftId) return false
    /* Sense once more against the text being sent — the draft store and the
       composer agree on every keystroke, but this is the copy that goes out. */
    const final = picked ? choice : senseStack(text, templates)
    if (!final) return false
    setError(null)
    const projectName = (shownName || deriveProjectName(text) || "New app").trim()
    try {
      const { project } = await create.mutateAsync({
        templateId: final.kind === "template" ? final.template.id : null,
        ...(final.kind === "scratch" && final.stack ? { stack: final.stack } : {}),
        name: projectName,
        ...(parent.trim() ? { parent: parent.trim().replace(/\/+$/, "") || "/" } : {}),
      })
      /* `createSession` looks the project up in the catalog cache, so the
         list has to have it before the first message goes out. */
      await invalidate("projects")
      actions.configureDraft(draftId, { projectId: project.id })
      if (meta) saveThreadDefaults({ projectId: project.id, profileId: meta.profileId, agentId: meta.agentId })
      built.current = true
      /* A from-scratch project has no dev command yet, so no preview to
         queue: the shell opens it on its own once the first turn has earned
         one (`project_changed` → catalog refetch → the templateId gate). */
      if (project.devCommand) queuePanel(previewPanel(project.id), { direction: "right" })
      void navigate(threadPath(draftId))
      return true
    } catch (err) {
      setError(captureError(err, "Couldn't create the project"))
      return false
    }
  }

  const choiceLabel = !choice
    ? templatesPending
      ? "Sensing…"
      : "From scratch"
    : choice.kind === "template"
      ? choice.template.name
      : choice.stack
        ? `From scratch · ${choice.stack}`
        : "From scratch"
  const starterPicker = (
    <PickerMenu
      icon={picked ? <LayoutTemplateIcon className="size-3.5" /> : <SparklesIcon className="size-3.5" />}
      label={picked ? choiceLabel : `Auto · ${choiceLabel}`}
      title={picked ? "Stack (your pick)" : `Stack, sensed from the prompt — ${choice?.reason ?? ""}`}
      value={picked ?? ""}
      options={[
        { value: "", name: "Auto", hint: "sensed from the prompt" },
        ...templates.map((t) => ({ value: t.id, name: t.name, hint: t.dev })),
        { value: SCRATCH_TEMPLATE_ID, name: "From scratch", hint: "the agent sets the stack up" },
      ]}
      onSelect={(value) => setPicked(value || null)}
    />
  )

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="relative mx-auto w-full max-w-3xl px-4 pt-10 pb-24 sm:px-8 sm:pt-16">
        <header className="mb-8">
          <p className="mb-3 flex items-center gap-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
            <HammerIcon className="size-3.5" aria-hidden />
            Build an app
          </p>
          <h1 className="font-heading text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            What do you want to build?
          </h1>
          <p className="mt-3 max-w-prose text-sm text-pretty text-muted-foreground">
            Describe it the way you would to a colleague. The stack is read off your words — a
            starter when one fits, an empty repository the agent sets up when none does — the
            project is created on the server, the agent builds it, and the running app shows up
            beside the thread — errors and all, one click from a fix.
          </p>
        </header>

        <section aria-label="Stack" className="mb-6">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 className="flex items-baseline gap-2 text-sm font-medium">
              Stack
              {picked ? (
                <button
                  type="button"
                  onClick={() => setPicked(null)}
                  title="Sense it from the prompt again"
                  className="text-[11px] font-normal text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                >
                  auto
                </button>
              ) : (
                <span className="text-[11px] font-normal text-muted-foreground">
                  sensed from the prompt{choice ? ` — ${choice.reason}` : ""}
                </span>
              )}
            </h2>
            <ProjectNameField
              value={shownName}
              derived={!nameTouched}
              onChange={(next) => {
                setNameTouched(true)
                setName(next)
              }}
              onReset={() => {
                setNameTouched(false)
                setName("")
              }}
            />
          </div>
          {templatesError ? (
            <ErrorNote
              error={inlineFromQuery(templatesError, "Couldn't load the starters")}
              onRetry={() => void refetch()}
            />
          ) : templatesPending ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Skeleton className="h-24 rounded-xl" />
              <Skeleton className="h-24 rounded-xl" />
            </div>
          ) : (
            <div role="radiogroup" aria-label="Stack" className="grid gap-3 sm:grid-cols-2">
              {templates.map((entry) => (
                <TemplateCard
                  key={entry.id}
                  template={entry}
                  selected={chosenId === entry.id}
                  sensed={!picked && chosenId === entry.id}
                  onSelect={() => setPicked(entry.id)}
                />
              ))}
              <ScratchCard
                selected={chosenId === SCRATCH_TEMPLATE_ID}
                sensed={!picked && chosenId === SCRATCH_TEMPLATE_ID}
                stack={choice?.kind === "scratch" ? choice.stack : null}
                onSelect={() => setPicked(SCRATCH_TEMPLATE_ID)}
              />
            </div>
          )}
        </section>

        <ErrorNote error={error} className="mb-3" />

        {/* The composer is drawn against the page's own ground; its card has
            the depth. `-mx-4` lets the strip and card use the full measure the
            composer variable expects, as they do under a transcript. */}
        {draftId && meta ? (
          <div className="-mx-4 sm:-mx-8">
            <Composer
              sessionId={draftId}
              actions={actions}
              thread={thread}
              meta={meta}
              delivery={delivery}
              placeholder="What do you want to build?"
              scope={{ hideProject: true, leading: starterPicker }}
              beforeSend={build}
            />
          </div>
        ) : canDraft ? (
          <Skeleton className="h-24 rounded-2xl" />
        ) : (
          <p className="rounded-xl border border-dashed px-4 py-3 text-sm text-muted-foreground">
            A thread needs a profile before it can run.{" "}
            <button
              type="button"
              className="text-foreground underline underline-offset-2"
              onClick={() => void navigate(settingsPath("profiles"))}
            >
              Add one in Settings › Profiles
            </button>
            , then come back here.
          </p>
        )}

        <Collapsible open={advanced} onOpenChange={setAdvanced} className="mt-8">
          <CollapsibleTrigger
            render={
              <button
                type="button"
                className="flex items-center gap-1.5 rounded-sm text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            }
          >
            <SettingsIcon className="size-3.5" aria-hidden />
            Advanced
            <ChevronDownIcon
              className={cn("size-3.5 transition-transform", advanced && "rotate-180")}
              aria-hidden
            />
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-3">
            <div className="rounded-xl border bg-card/60 p-4">
              <label className="block text-xs font-medium" htmlFor="build-parent">
                Parent directory
              </label>
              <p className="mt-0.5 mb-2 text-xs text-muted-foreground">
                On the server. The project is created as a folder named after it, inside this one.
                Empty uses the server's default apps directory.
              </p>
              <PathInput
                id="build-parent"
                value={parent}
                onValueChange={setParent}
                settings={settings}
                placeholder="~/daedalus-apps"
                className="font-mono text-xs"
              />
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>
    </div>
  )
}

/** The project's name, following the prompt until edited. The reset appears
    only once it has been — it is the way back to following. */
function ProjectNameField({
  value,
  derived,
  onChange,
  onReset,
}: {
  value: string
  derived: boolean
  onChange: (next: string) => void
  onReset: () => void
}) {
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <label htmlFor="build-name" className="shrink-0 text-xs text-muted-foreground">
        Project name
      </label>
      <Input
        id="build-name"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="From the prompt"
        maxLength={NAME_MAX}
        aria-label="Project name"
        className={cn("h-7 w-44 text-xs", derived && value && "text-muted-foreground")}
      />
      {!derived && (
        <button
          type="button"
          onClick={onReset}
          title="Follow the prompt again"
          className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          auto
        </button>
      )}
    </div>
  )
}

/** One card of the stack grid. `sensed` is the selected state the prompt
    produced rather than a click — drawn with a sparkle so the user knows the
    highlight will move as they type. */
function StackCard({
  name,
  description,
  tags,
  selected,
  sensed,
  onSelect,
}: {
  name: string
  description: string
  tags: string[]
  selected: boolean
  sensed: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        "group relative flex flex-col items-start rounded-xl border bg-card p-4 text-left transition-[border-color,box-shadow,background-color]",
        "hover:border-ring/50 hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected && "border-primary/60 bg-primary/[0.04] shadow-glass"
      )}
    >
      <span aria-hidden className="absolute top-4 right-4 flex items-center">
        {sensed ? (
          <SparklesIcon className="size-3.5 text-primary" />
        ) : (
          <span
            className={cn(
              "size-2 rounded-full transition-colors",
              selected ? "bg-primary" : "bg-border group-hover:bg-muted-foreground/40"
            )}
          />
        )}
      </span>
      <span className="pr-6 text-sm font-medium">{name}</span>
      <span className="mt-1 text-xs text-pretty text-muted-foreground">{description}</span>
      {tags.length > 0 && (
        <span className="mt-3 flex flex-wrap gap-1">
          {tags.map((tag) => (
            <span
              key={tag}
              className="rounded-pill bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
            >
              {tag}
            </span>
          ))}
        </span>
      )}
    </button>
  )
}

function TemplateCard({
  template,
  selected,
  sensed,
  onSelect,
}: {
  template: Template
  selected: boolean
  sensed: boolean
  onSelect: () => void
}) {
  return (
    <StackCard
      name={template.name}
      description={template.description}
      tags={template.tags}
      selected={selected}
      sensed={sensed}
      onSelect={onSelect}
    />
  )
}

/** The card for no starter at all: an empty repository the agent sets up on
    the stack the prompt named. Always offered, last. */
function ScratchCard({
  selected,
  sensed,
  stack,
  onSelect,
}: {
  selected: boolean
  sensed: boolean
  stack: string | null
  onSelect: () => void
}) {
  return (
    <StackCard
      name={stack ? `From scratch · ${stack}` : "From scratch"}
      description={
        stack
          ? `No starter ships ${stack}. The agent scaffolds it with its own tooling, and the preview appears once the project says how it runs.`
          : "An empty repository. The agent picks the stack from your brief and sets it up; the preview appears once the project says how it runs."
      }
      tags={["any stack", "agent-scaffolded"]}
      selected={selected}
      sensed={sensed}
      onSelect={onSelect}
    />
  )
}
