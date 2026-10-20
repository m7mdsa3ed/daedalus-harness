/* ── AI helpers ──
 *
 * The model calls the harness makes *for you* rather than *as a thread*: the
 * composer's Enhance button, and source control's two drafts. They were one
 * group buried at the top of General, between the servers this device knows and
 * the browser's idea of the page's security — which is where the first one
 * landed when it was the only one, and no longer says what it is.
 *
 * They get a section because they are now a family with a rule: each of these
 * is a habit of the hand typing, not a property of a thread, so each keeps its
 * own device-local pick (`lib/ai-picks.ts`) and every one of them is one
 * side-effect-free completion on the server (`server/src/ai.ts`) rather than a
 * turn on a thread's agent. Nothing here is journaled, queued or billed to a
 * thread; the API key never leaves the server.
 *
 * Layout: ONE DataTable of helpers. Desktop: helper | Profile | Model | Status,
 * the two pickers inline in the row. A narrow panel: a row per helper (mark,
 * name, "Runs on X · Y", chevron) whose tap opens the helper's own page
 * (`AiHelperPage`) holding the same two pickers — a select in a 320px row has
 * no room to be a target.
 */
import * as React from "react"
import { Navigate, useNavigate, useParams } from "react-router"
import { ChevronRight, FileJson2, GitBranchIcon, Scale, Sparkles, SquareTerminal, type LucideIcon } from "lucide-react"

import { ProfileIcon } from "@/components/entity-icon"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { DataTable, TitleCell } from "@/components/ui/data-table"
import { useTableFilter } from "@/lib/use-table-filter"
import { Notice } from "@/components/notice"
import { aiCapable, enhancePick, formBuilderPick, gitPick, modelPickLabel, type AiPick } from "@/lib/ai-picks"
import { useSetSideModel, useSideModel, type SideLane } from "@/lib/queries/side-models"
import { useProfiles } from "@/lib/queries/catalog"
import type { ColumnDef } from "@/lib/table"
import { cn } from "@/lib/utils"
import { settingsFormPath, settingsPath } from "@/lib/router"
import { Field, FormActions, FormPageHeader, FormSection, PageForm, PageHeader, StatusBadge } from "./primitives"
import { sectionMeta } from "./sections"

/** One helper: where it shows up, what it does, and the pick that decides what
    it runs on. Every helper asks the same two questions — which profile, which
    of its models — so there is one table and not one block per helper; what
    differs is only the words. */
/** A helper's pick is one of two kinds, and the difference is not cosmetic: a
    device pick is a habit of the hand and lives in local storage, while a lane's
    pair is a row inside a profile — so it belongs to the install and lives on
    the server. The union is what stops one being drawn with the other's pickers. */
type HelperBase = {
  id: string
  label: string
  icon: LucideIcon
  name: string
  subtitle: string
  modelTitle: string
}
type DeviceHelper = HelperBase & { pick: AiPick }
type LaneHelper = HelperBase & { lane: SideLane }
type Helper = DeviceHelper | LaneHelper

const HELPERS: Helper[] = [
  {
    id: "enhance",
    label: "Composer",
    icon: Sparkles,
    pick: enhancePick,
    name: "Enhance prompts",
    subtitle: "The profile whose endpoint rewrites the composer's drafts. The box is replaced, unsent — sending is still yours.",
    modelTitle: "Enhance model",
  },
  {
    id: "forms",
    label: "Forms",
    icon: FileJson2,
    pick: formBuilderPick,
    name: "Build forms",
    subtitle: "The model that chats through schema-backed forms and drafts values for review. Applied values remain an unsaved draft until you save the form.",
    modelTitle: "Form builder model",
  },
  {
    id: "completion",
    label: "Composer",
    icon: SquareTerminal,
    lane: "completion",
    name: "Complete what you type",
    subtitle:
      "The fill-in-the-middle model that finishes the line in the composer — a prompt, or a `!` command — drawn as ghost text at the caret, accepted with Tab. One request per pause, never a turn and never journaled.",
    modelTitle: "Completion model",
  },
  {
    id: "decision",
    label: "Decisions",
    icon: Scale,
    lane: "decision",
    name: "Answer typed questions",
    subtitle:
      "The System One model a decision runs on: a state and a map of noul, choice and score questions, answered with probabilities instead of text. Nothing asks one yet — this names the model that will.",
    modelTitle: "Decision model",
  },
  {
    id: "git",
    label: "Source control",
    icon: GitBranchIcon,
    pick: gitPick,
    name: "Draft commits and branch names",
    subtitle: "The profile that reads a repository's diff to write a commit message or name a branch — in the composer's branch popover and the source-control panel. The diff is read on the server; nothing is sent to the thread.",
    modelTitle: "Source control model",
  },
]

/** What a helper will actually run on. The picks live in module stores, so the
    hooks here are the re-render: without them a pick made in one cell would not
    move its siblings. The answer is the resolved one, not the stored pick — a
    remembered profile that no longer exists reads as what actually runs. */
function useResolved(pick: AiPick) {
  const profiles = useProfiles()
  pick.useProfileId()
  pick.useModelId()
  const picked = pick.resolveProfile(profiles)
  const modelId = pick.resolveModelId(picked)
  return { profiles, picked, modelId, capable: aiCapable(profiles) }
}

function DeviceProfileSelect({ helper, className }: { helper: DeviceHelper; className?: string }) {
  const { picked, capable } = useResolved(helper.pick)
  return (
    <Select value={picked?.id} onValueChange={(id) => helper.pick.setProfileId(id)}>
      <SelectTrigger className={cn("w-full", className)} aria-label={`Profile for ${helper.name}`}>
        <SelectValue>{picked?.name ?? "Pick a profile"}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {capable.map((p) => (
          <SelectItem key={p.id} value={p.id}>
            <span className="flex min-w-0 items-center gap-2">
              <ProfileIcon profile={p} className="size-4 shrink-0" />
              <span className="truncate">{p.name}</span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function DeviceModelSelect({ helper, className }: { helper: DeviceHelper; className?: string }) {
  const { picked, modelId } = useResolved(helper.pick)
  /* A profile that serves no models has nothing to pick: say what runs. */
  if (!picked || picked.models.length === 0) {
    return <span className="text-xs text-muted-foreground">Profile default</span>
  }
  return (
    <Select
      value={modelId || "__default__"}
      onValueChange={(id) => helper.pick.setModelId(!id || id === "__default__" ? "" : id)}
    >
      <SelectTrigger className={cn("w-full", className)} aria-label={helper.modelTitle}>
        <SelectValue>{modelPickLabel(picked, modelId)}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__default__">Profile default</SelectItem>
        {picked.models.map((m) => (
          <SelectItem key={m.id} value={m.id}>
            <span className="truncate">{m.label}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function DeviceStatus({ helper }: { helper: DeviceHelper }) {
  const { picked } = useResolved(helper.pick)
  return picked ? <StatusBadge tone="ok">Ready</StatusBadge> : <StatusBadge tone="warn">No profile</StatusBadge>
}

/** "Runs on X · Y" — the narrow row's status line. */
function DeviceRunsOn({ helper }: { helper: DeviceHelper }) {
  const { picked, modelId } = useResolved(helper.pick)
  return picked ? (
    <span className="text-foreground/80">Runs on {picked.name} · {modelPickLabel(picked, modelId)}</span>
  ) : (
    <span>No profile picked</span>
  )
}

/* ── A lane's pickers ──
   The same two questions, answered on the server. The candidates are the pairs
   the catalogue already proves (a completion model with its wire, a decision
   model with its own), so the profile list is the distinct profiles among them
   and the model list is that profile's — no catalogue read, and nothing offered
   that the lane could not call. */

function LaneProfileSelect({ helper, className }: { helper: LaneHelper; className?: string }) {
  const lane = helper.lane
  const model = useSideModel(lane)
  const set = useSetSideModel(lane)
  const profiles = React.useMemo(() => {
    const seen = new Map<string, string>()
    for (const candidate of model.candidates) {
      if (!seen.has(candidate.profileId)) seen.set(candidate.profileId, candidate.profileName)
    }
    return [...seen].map(([id, name]) => ({ id, name }))
  }, [model.candidates])

  if (profiles.length === 0) {
    return <span className="text-xs text-muted-foreground">No {lane} model in any profile</span>
  }
  return (
    <Select
      value={model.default?.profileId}
      onValueChange={(id: string | null) => {
        /* A profile's first callable model is the pair a profile pick means;
           the model row below narrows it when the profile serves more than one. */
        const first = model.candidates.find((candidate) => candidate.profileId === id)
        if (first) set.mutate({ profileId: first.profileId, model: first.model })
      }}
    >
      <SelectTrigger className={cn("w-full", className)} aria-label={`Profile for ${helper.name}`}>
        <SelectValue>{model.default?.profileName ?? "Pick a profile"}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {profiles.map((profile) => (
          <SelectItem key={profile.id} value={profile.id}>
            <span className="truncate">{profile.name}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function LaneModelSelect({ helper, className }: { helper: LaneHelper; className?: string }) {
  const lane = helper.lane
  const model = useSideModel(lane)
  const set = useSetSideModel(lane)
  const mine = model.candidates.filter((candidate) => candidate.profileId === model.default?.profileId)
  if (mine.length === 0) {
    return <span className="text-xs text-muted-foreground">{model.default?.label ?? "No model"}</span>
  }
  return (
    <Select
      value={model.default?.model}
      onValueChange={(id: string | null) => {
        const hit = mine.find((candidate) => candidate.model === id)
        if (hit) set.mutate({ profileId: hit.profileId, model: hit.model })
      }}
    >
      <SelectTrigger className={cn("w-full", className)} aria-label={helper.modelTitle}>
        <SelectValue>{model.default?.label ?? "Pick a model"}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {mine.map((candidate) => (
          <SelectItem key={candidate.model} value={candidate.model}>
            <span className="truncate">{candidate.label}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function LaneStatus({ helper }: { helper: LaneHelper }) {
  const model = useSideModel(helper.lane)
  if (!model.default) return <StatusBadge tone="warn">No model</StatusBadge>
  /* It runs either way; the word says whether a person decided or the server
     fell back to the first candidate in the catalogue. */
  return model.source === "explicit" ? (
    <StatusBadge tone="ok">Ready</StatusBadge>
  ) : (
    <StatusBadge tone="neutral">Fallback</StatusBadge>
  )
}

function LaneRunsOn({ helper }: { helper: LaneHelper }) {
  const model = useSideModel(helper.lane)
  return model.default ? (
    <span className="text-foreground/80">Runs on {model.default.profileName} · {model.default.label}</span>
  ) : (
    <span>No model picked</span>
  )
}

/* One name per cell, two implementations: a lane helper never reaches the
   device pickers, and the union on `Helper` is what says so. */
function ProfileSelect({ helper, className }: { helper: Helper; className?: string }) {
  return "lane" in helper ? (
    <LaneProfileSelect helper={helper} className={className} />
  ) : (
    <DeviceProfileSelect helper={helper} className={className} />
  )
}

function ModelSelect({ helper, className }: { helper: Helper; className?: string }) {
  return "lane" in helper ? (
    <LaneModelSelect helper={helper} className={className} />
  ) : (
    <DeviceModelSelect helper={helper} className={className} />
  )
}

function HelperStatus({ helper }: { helper: Helper }) {
  return "lane" in helper ? <LaneStatus helper={helper} /> : <DeviceStatus helper={helper} />
}

function RunsOn({ helper }: { helper: Helper }) {
  return "lane" in helper ? <LaneRunsOn helper={helper} /> : <DeviceRunsOn helper={helper} />
}

const COLUMNS: ColumnDef<Helper, unknown>[] = [
  {
    id: "helper",
    header: "Helper",
    cell: ({ row }) => <TitleCell title={row.original.name} subtitle={row.original.label} />,
    meta: { title: true, className: "w-[26%]" },
  },
  {
    id: "what",
    header: "What it does",
    cell: ({ row }) => (
      <span className="line-clamp-2 text-xs/relaxed text-muted-foreground" title={row.original.subtitle}>
        {row.original.subtitle}
      </span>
    ),
    meta: { className: "hidden @panel-lg:table-cell" },
  },
  {
    id: "profile",
    header: "Profile",
    cell: ({ row }) => <ProfileSelect helper={row.original} className="h-9 pointer-coarse:h-11" />,
    meta: { className: "w-52" },
  },
  {
    id: "model",
    header: "Model",
    cell: ({ row }) => <ModelSelect helper={row.original} className="h-9 pointer-coarse:h-11" />,
    meta: { className: "w-52" },
  },
  {
    id: "status",
    header: "Status",
    cell: ({ row }) => <HelperStatus helper={row.original} />,
    meta: { align: "end", className: "w-24" },
  },
]

const mark = (helper: Helper) => <helper.icon />

export function AiPage() {
  const meta = sectionMeta("ai")
  const profiles = useProfiles()
  const capable = aiCapable(profiles)
  const navigate = useNavigate()

  const mobile = React.useMemo(
    () => ({
      renderRow: (helper: Helper) => (
        <button
          type="button"
          onClick={() => void navigate(settingsFormPath("ai", helper.id))}
          className="flex min-h-16 w-full min-w-0 items-center gap-3 text-start"
          aria-label={`Change what ${helper.name.toLowerCase()} runs on`}
        >
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground [&_svg]:size-4">
            <helper.icon />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{helper.name}</span>
            <span className="block truncate text-xs text-muted-foreground">
              <RunsOn helper={helper} />
            </span>
          </span>
          <ChevronRight className="size-4 shrink-0 text-muted-foreground/60 rtl:rotate-180" />
        </button>
      ),
    }),
    [navigate],
  )

  const f = useTableFilter(HELPERS, {
    text: (h) => `${h.name} ${h.label} ${h.subtitle}`,
    placeholder: "Search helpers…",
    fields: [{ id: "area", label: "Area", of: (h) => h.label }],
  })

  return (
    <>
      <PageHeader meta={meta} />
      {capable.length === 0 ? (
        /* Absence with a reason, not an empty page: these need a profile with a
           real endpoint behind them, and a virtual Default has none — which is
           also why the buttons themselves stay hidden until one exists. */
        <Notice tone="neutral" title="No profile can run these yet">
          They run against a stored profile's own OpenAI-compatible endpoint. Add one under
          Settings › Profiles and it will be offered here.
        </Notice>
      ) : (
        <>
          <DataTable
            columns={COLUMNS}
            data={f.rows}
            getRowId={(helper) => helper.id}
            mark={mark}
            mobile={mobile}
            pageSize={25}
            emptyIcon={<meta.icon />}
            emptyMessage="No helper matches."
            filtering={f.filtering}
          />
          <p className="mt-3 text-xs/relaxed text-muted-foreground">
            Device picks are remembered on this device; the composer and decision models are stored
            on the server, so every device uses the same pair. The API key never leaves the server.
          </p>
        </>
      )}
    </>
  )
}

/** One helper's pickers on a page of its own — the narrow row's destination. */
export function AiHelperPage() {
  const { entryId } = useParams()
  const navigate = useNavigate()
  const helper = HELPERS.find((h) => h.id === entryId)
  if (!helper) return <Navigate to={settingsPath("ai")} replace />
  const back = () => void navigate(settingsPath("ai"))
  /* The picks are written as they are chosen (device-local stores), so there is
     nothing to submit: the form's only exit is back. */
  return (
    <>
      <FormPageHeader title={helper.name} description={helper.subtitle} onBack={back} />
      <PageForm onSubmit={(e) => { e.preventDefault(); back() }}>
        <FormSection
          id="runs-on"
          label="Runs on"
          hint={
            "lane" in helper
              ? "Stored on the server, so every device uses the same profile and model. The API key never leaves the server."
              : "Picks are remembered on this device. The API key never leaves the server."
          }
        >
          <Field label="Profile">
            <ProfileSelect helper={helper} className="h-11 @panel-sm:h-9" />
          </Field>
          <Field
            label="Model"
            hint={
              "lane" in helper
                ? "The models of this kind the profile holds."
                : "Or the profile's own default when nothing is picked."
            }
          >
            <ModelSelect helper={helper} className="h-11 @panel-sm:h-9" />
          </Field>
        </FormSection>
        <FormActions busy={false} />
      </PageForm>
    </>
  )
}
