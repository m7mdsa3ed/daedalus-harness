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
 * name, "Runs on X · Y", chevron) whose tap opens a bottom sheet holding the
 * same two pickers — a select in a 320px row has no room to be a target.
 */
import * as React from "react"
import { ChevronRight, FileJson2, GitBranchIcon, Sparkles, type LucideIcon } from "lucide-react"

import { ProfileIcon } from "@/components/entity-icon"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { DataTable, TitleCell } from "@/components/ui/data-table"
import { Notice } from "@/components/notice"
import { aiCapable, enhancePick, formBuilderPick, gitPick, modelPickLabel, type AiPick } from "@/lib/ai-picks"
import { useProfiles } from "@/lib/queries/catalog"
import type { ColumnDef } from "@/lib/table"
import { cn } from "@/lib/utils"
import { DetailSheet, PageHeader, StatusBadge } from "./primitives"
import { sectionMeta } from "./sections"

/** One helper: where it shows up, what it does, and the pick that decides what
    it runs on. Every helper asks the same two questions — which profile, which
    of its models — so there is one table and not one block per helper; what
    differs is only the words. */
interface Helper {
  id: string
  label: string
  icon: LucideIcon
  pick: AiPick
  name: string
  subtitle: string
  modelTitle: string
}

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

function ProfileSelect({ helper, className }: { helper: Helper; className?: string }) {
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

function ModelSelect({ helper, className }: { helper: Helper; className?: string }) {
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

function HelperStatus({ helper }: { helper: Helper }) {
  const { picked } = useResolved(helper.pick)
  return picked ? <StatusBadge tone="ok">Ready</StatusBadge> : <StatusBadge tone="warn">No profile</StatusBadge>
}

/** "Runs on X · Y" — the narrow row's status line. */
function RunsOn({ helper }: { helper: Helper }) {
  const { picked, modelId } = useResolved(helper.pick)
  return picked ? (
    <span className="text-foreground/80">Runs on {picked.name} · {modelPickLabel(picked, modelId)}</span>
  ) : (
    <span>No profile picked</span>
  )
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
  /* `editing` outlives `open` so the sheet keeps its words while it slides away. */
  const [editing, setEditing] = React.useState<Helper | null>(null)
  const [open, setOpen] = React.useState(false)

  const mobile = React.useMemo(
    () => ({
      renderRow: (helper: Helper) => (
        <button
          type="button"
          onClick={() => {
            setEditing(helper)
            setOpen(true)
          }}
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
    [],
  )

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
            data={HELPERS}
            getRowId={(helper) => helper.id}
            mark={mark}
            mobile={mobile}
            viewToggle={false}
            pageSize={25}
            emptyIcon={<meta.icon />}
          />
          <p className="mt-3 text-xs/relaxed text-muted-foreground">
            Picks are remembered on this device. The API key never leaves the server.
          </p>
          <DetailSheet
            open={open}
            onOpenChange={setOpen}
            title={editing?.name}
            description={editing?.subtitle}
          >
            {editing && (
              <>
                <PickField label="Profile">
                  <ProfileSelect helper={editing} className="h-11" />
                </PickField>
                <PickField label="Model" hint="Or the profile's own default when nothing is picked.">
                  <ModelSelect helper={editing} className="h-11" />
                </PickField>
              </>
            )}
          </DetailSheet>
        </>
      )}
    </>
  )
}

function PickField({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-muted-foreground">{hint}</span>}
    </div>
  )
}
