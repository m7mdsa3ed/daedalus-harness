/* ── Triggers ──
   One routine, several front doors: a clock, a webhook, a commit. They share a
   row server-side because everything after the fire is identical whichever door
   was used, and they share this panel for the same reason — the list is one
   list, and only the middle of each card differs.

   This panel talks to the server directly rather than through the store. A
   routine's triggers are read on exactly one screen, so a slice for them would
   be a cache with one reader; the cost is that this component owns its own
   loading, its own errors and its own re-reads. Which is also why the empty
   state is gated on `loaded`: a failed GET must not draw as "no triggers", and
   an error and an emptiness are two different screens. */
import * as React from "react"
import {
  CalendarClockIcon,
  CheckIcon,
  CopyIcon,
  GitBranchIcon,
  KeyRoundIcon,
  PlusIcon,
  Trash2Icon,
  WebhookIcon,
} from "lucide-react"

import { useConfirm } from "@/components/confirm-dialog"
import { ErrorNote } from "@/components/error-note"
import { Field, lines } from "@/components/settings/primitives"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { Skeleton } from "@/components/ui/skeleton"
import { captureError, type InlineError } from "@/lib/errors"
import type { RoutineTrigger, RoutineTriggerKind, RoutineTriggerPatch } from "@/lib/settings"
import {
  useCreateRoutineTrigger,
  useDeleteRoutineTrigger,
  useMintRoutineTriggerToken,
  useRevokeRoutineTriggerToken,
  useRoutineTriggers,
  useUpdateRoutineTrigger,
} from "@/lib/queries/routines"
import { useServer } from "@/lib/server-context"

const KIND_META: Record<RoutineTriggerKind, { label: string; icon: typeof CalendarClockIcon; blurb: string }> = {
  schedule: { label: "On a schedule", icon: CalendarClockIcon, blurb: "A clock the server keeps, browser or no browser." },
  api: { label: "On a webhook", icon: WebhookIcon, blurb: "A POST to a URL, with a token only you hold." },
  git: { label: "On a commit", icon: GitBranchIcon, blurb: "The project's HEAD moving, debounced." },
}

/* ── Schedule presets ──
   The presets WRITE cron and nothing else: there is one representation of a
   schedule on the row and it is the cron string, so a preset is a way of
   spelling one rather than a second field that could disagree with it. Which
   also means an existing trigger's preset is *read back* out of its cron, and a
   cron that matches no preset simply reads as Custom. */
type Preset = "hourly" | "daily" | "weekdays" | "weekly" | "custom"

const PRESET_LABEL: Record<Preset, string> = {
  hourly: "Every hour",
  daily: "Every day",
  weekdays: "Every weekday",
  weekly: "Every week (Monday)",
  custom: "Custom cron",
}

const cronFor = (preset: Preset, hour: number): string =>
  preset === "hourly"
    ? "0 * * * *"
    : preset === "daily"
      ? `0 ${hour} * * *`
      : preset === "weekdays"
        ? `0 ${hour} * * 1-5`
        : `0 ${hour} * * 1`

/** Which preset, if any, a cron string spells. Anything else reads as Custom,
    which is not a failure: a quarter-hourly cron is one a person meant. */
function readPreset(cron: string | null): { preset: Preset; hour: number } {
  if (!cron) return { preset: "daily", hour: 9 }
  if (cron.trim() === "0 * * * *") return { preset: "hourly", hour: 9 }
  const match = /^0 (\d{1,2}) \* \* (\*|1-5|1)$/.exec(cron.trim())
  if (!match) return { preset: "custom", hour: 9 }
  const hour = Number(match[1])
  const preset = match[2] === "*" ? "daily" : match[2] === "1-5" ? "weekdays" : "weekly"
  return { preset, hour }
}

export function TriggersPanel({ routineId }: { routineId: string }) {
  const confirm = useConfirm()
  /* The query cache owns the read; the mutations invalidate it, which is the
     re-read. The optimistic part stays here and stays local: these are
     switches and a cron field being typed into, and a full re-read per
     keystroke would fight the caret. */
  const { data: cached, refetch } = useRoutineTriggers(routineId)
  const addTrigger = useCreateRoutineTrigger(routineId)
  const patchTrigger = useUpdateRoutineTrigger(routineId)
  const removeTrigger = useDeleteRoutineTrigger(routineId)
  const mintToken = useMintRoutineTriggerToken(routineId)
  const revokeToken = useRevokeRoutineTriggerToken(routineId)
  /** The optimistic overlay, on top of the cache — a patch shows locally the
      moment it is typed and the server's answer replaces the row, so a
      rejected patch snaps back with the note below. */
  const [overlay, setOverlay] = React.useState<Record<string, Partial<RoutineTrigger>>>({})
  const [error, setError] = React.useState<InlineError | null>(null)
  /** The token from the most recent mint, keyed by trigger. It is in that one
      response and nowhere else, so it lives in a ref-like state here until the
      user navigates away — never in the store, where a credential would end up
      in a state dump long after the dialog that showed it. */
  const [minted, setMinted] = React.useState<Record<string, string>>({})

  const triggers: RoutineTrigger[] | null = cached
    ? cached.map((t) => (overlay[t.id] ? ({ ...t, ...overlay[t.id] } as RoutineTrigger) : t))
    : null

  const add = async (kind: RoutineTriggerKind) => {
    setError(null)
    try {
      /* A new schedule arrives with a null clock on purpose — the sweep arms
         `nextFireAt`. So the cron is written on creation and the row comes back
         inert for a few seconds rather than never firing. */
      await addTrigger.mutateAsync({
        kind,
        ...(kind === "schedule" ? { cron: cronFor("daily", 9), tz: localZone() } : {}),
      })
    } catch (err) {
      setError(captureError(err, "Couldn't add the trigger"))
    }
  }

  const patch = async (id: string, next: RoutineTriggerPatch) => {
    setError(null)
    setOverlay((prev) => ({ ...prev, [id]: { ...prev[id], ...next } }))
    try {
      await patchTrigger.mutateAsync({ id, patch: next })
      setOverlay((prev) => {
        const nextOverlay = { ...prev }
        delete nextOverlay[id]
        return nextOverlay
      })
    } catch (err) {
      setError(captureError(err, "Couldn't save the trigger"))
      setOverlay((prev) => {
        const nextOverlay = { ...prev }
        delete nextOverlay[id]
        return nextOverlay
      })
      void refetch()
    }
  }

  const remove = async (trigger: RoutineTrigger) => {
    if (
      !(await confirm({
        title: `Remove this ${KIND_META[trigger.kind].label.toLowerCase()} trigger?`,
        description:
          trigger.hasToken
            ? "Its token stops working immediately and cannot be recovered. The routine and its run history are untouched."
            : "The routine and its run history are untouched — it just stops firing this way.",
        destructive: true,
        confirmLabel: "Remove trigger",
      }))
    )
      return
    setError(null)
    try {
      await removeTrigger.mutateAsync(trigger.id)
    } catch (err) {
      setError(captureError(err, "Couldn't remove the trigger"))
    }
  }

  const mint = async (trigger: RoutineTrigger) => {
    if (
      trigger.hasToken &&
      !(await confirm({
        title: "Replace this trigger's token?",
        description:
          "The current one stops working the moment the new one exists. Anything using it — a webhook, a CI step — has to be updated.",
        destructive: true,
        confirmLabel: "Rotate it",
      }))
    )
      return
    setError(null)
    try {
      const token = await mintToken.mutateAsync(trigger.id)
      setMinted((prev) => ({ ...prev, [trigger.id]: token }))
    } catch (err) {
      setError(captureError(err, "Couldn't mint the token"))
    }
  }

  const revoke = async (trigger: RoutineTrigger) => {
    setError(null)
    try {
      await revokeToken.mutateAsync(trigger.id)
      setMinted((prev) => {
        const next = { ...prev }
        delete next[trigger.id]
        return next
      })
    } catch (err) {
      setError(captureError(err, "Couldn't revoke the token"))
    }
  }

  const addMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button type="button" size="sm" variant="outline">
            <PlusIcon data-icon="inline-start" />
            Add a trigger
          </Button>
        }
      />
      <DropdownMenuContent align="start" className="w-64">
        {(Object.keys(KIND_META) as RoutineTriggerKind[]).map((kind) => {
          const Icon = KIND_META[kind].icon
          return (
            <DropdownMenuItem key={kind} onClick={() => void add(kind)}>
              <Icon className="size-4 text-muted-foreground" />
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{KIND_META[kind].label}</span>
                <span className="truncate text-[10px] text-muted-foreground">{KIND_META[kind].blurb}</span>
              </span>
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )

  return (
    <div className="space-y-3">
      <ErrorNote error={error} onRetry={() => void refetch()} />
      {/* Null is "not read yet", which is not the same screen as "none" — see
          the header comment. A failed read leaves it null and the note above
          is what the user sees, rather than a confident empty state. */}
      {triggers === null ? (
        error ? null : (
          <div className="space-y-2">
            <Skeleton className="h-20 w-full rounded-xl" />
          </div>
        )
      ) : triggers.length === 0 ? (
        <p className="rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
          No triggers — this routine only fires when you run it by hand.
        </p>
      ) : (
        triggers.map((trigger) => (
          <TriggerCard
            key={trigger.id}
            trigger={trigger}
            token={minted[trigger.id]}
            onPatch={(next) => void patch(trigger.id, next)}
            onRemove={() => void remove(trigger)}
            onMint={() => void mint(trigger)}
            onRevoke={() => void revoke(trigger)}
          />
        ))
      )}
      {addMenu}
    </div>
  )
}

function TriggerCard({
  trigger,
  token,
  onPatch,
  onRemove,
  onMint,
  onRevoke,
}: {
  trigger: RoutineTrigger
  token?: string
  onPatch: (next: RoutineTriggerPatch) => void
  onRemove: () => void
  onMint: () => void
  onRevoke: () => void
}) {
  const meta = KIND_META[trigger.kind]
  const Icon = meta.icon

  return (
    <div className="rounded-xl border p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 sm:flex-nowrap">
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{meta.label}</div>
          <p className="truncate text-xs text-muted-foreground">
            {trigger.lastFiredAt
              ? `Last fired ${new Date(trigger.lastFiredAt).toLocaleString()}`
              : "Has never fired"}
            {trigger.nextFireAt && ` · next ${new Date(trigger.nextFireAt).toLocaleString()}`}
          </p>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <Switch
            checked={trigger.enabled}
            onCheckedChange={(checked) => onPatch({ enabled: checked })}
            aria-label={trigger.enabled ? "Disable this trigger" : "Enable this trigger"}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground hover:text-destructive"
            onClick={onRemove}
          >
            <Trash2Icon />
            <span className="sr-only">Remove this trigger</span>
          </Button>
        </div>
      </div>

      {trigger.lastError && (
        <p className="mt-2 rounded-lg bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
          Last evaluation: {trigger.lastError}
        </p>
      )}

      <div className="mt-3">
        {trigger.kind === "schedule" && <ScheduleFields trigger={trigger} onPatch={onPatch} />}
        {trigger.kind === "api" && (
          <ApiFields trigger={trigger} token={token} onMint={onMint} onRevoke={onRevoke} />
        )}
        {trigger.kind === "git" && <GitFields trigger={trigger} onPatch={onPatch} />}
      </div>
    </div>
  )
}

function ScheduleFields({
  trigger,
  onPatch,
}: {
  trigger: RoutineTrigger
  onPatch: (next: RoutineTriggerPatch) => void
}) {
  const read = readPreset(trigger.cron)
  const [preset, setPreset] = React.useState<Preset>(read.preset)
  const [hour, setHour] = React.useState(read.hour)

  const write = (nextPreset: Preset, nextHour: number) => {
    setPreset(nextPreset)
    setHour(nextHour)
    // Custom leaves the cron alone: switching to it is a request to type one,
    // not a request to overwrite whatever is there with a preset's spelling.
    if (nextPreset !== "custom") onPatch({ cron: cronFor(nextPreset, nextHour) })
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Repeat">
          <Select value={preset} onValueChange={(v) => v && write(v as Preset, hour)}>
            <SelectTrigger className="w-full">
              <SelectValue>{PRESET_LABEL[preset]}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(PRESET_LABEL) as Preset[]).map((key) => (
                <SelectItem key={key} value={key}>
                  {PRESET_LABEL[key]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {preset !== "hourly" && preset !== "custom" && (
          <Field label="At (hour)">
            <Input
              type="number"
              min={0}
              max={23}
              value={hour}
              onChange={(e) => write(preset, Math.min(23, Math.max(0, Number(e.target.value) || 0)))}
            />
          </Field>
        )}
        <Field label="Time zone" hint="IANA name. Blank reads the cron in the server's own zone.">
          <Input
            placeholder={localZone()}
            value={trigger.tz ?? ""}
            onChange={(e) => onPatch({ tz: e.target.value || null })}
          />
        </Field>
      </div>
      <Field
        label="Cron"
        hint="Five fields, minute first. The presets above are ways of spelling this — there is no second representation."
      >
        <Input
          className="font-mono text-xs"
          value={trigger.cron ?? ""}
          onChange={(e) => {
            setPreset("custom")
            onPatch({ cron: e.target.value || null })
          }}
        />
      </Field>
      {/* The condition is checked at fire time, never here: a nightly review
          that reports on yesterday and one that says "nothing happened" thirty
          times in a row are the same routine with and without this switch. */}
      <label className="flex items-start gap-2.5 rounded-lg border bg-muted/30 px-3 py-2.5">
        <Switch
          className="mt-0.5"
          checked={trigger.condition?.gitChangedSince === "lastRun"}
          onCheckedChange={(checked) =>
            onPatch({ condition: checked ? { gitChangedSince: "lastRun" } : null })
          }
        />
        <span className="min-w-0 text-xs">
          <span className="block font-medium text-foreground">Only if the code has changed</span>
          <span className="text-muted-foreground">
            Compare the project's HEAD against what the last run saw, and write a skipped run
            instead of firing when it has not moved.
          </span>
        </span>
      </label>
    </div>
  )
}

function ApiFields({
  trigger,
  token,
  onMint,
  onRevoke,
}: {
  trigger: RoutineTrigger
  token?: string
  onMint: () => void
  onRevoke: () => void
}) {
  /* The path shape is the server's own (`/rt/<key>/<routineId>/fire`), with the
     trigger's token standing in for the per-boot key — which is the only form a
     webhook field can express, and the reason the credential is in the URL at
     all. The server will also read it from an `Authorization: Bearer` header,
     which is the safer place for it (a URL ends up in proxy logs), but that is
     not printed here: the path segment is required either way, so offering the
     header as an alternative would be offering to put the same secret in two
     places instead of one. */
  const settings = useServer()
  const url = `${settings.url.replace(/\/$/, "")}/rt/${token ?? "<token>"}/${trigger.routineId}/fire`

  return (
    <div className="space-y-3">
      {token ? (
        <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
          <p className="text-xs font-medium text-amber-700 dark:text-amber-400">
            Copy this now — it is shown once. Only its hash is stored, so it cannot be shown again.
          </p>
          <CopyLine value={token} mono />
          <p className="pt-1 text-xs text-muted-foreground">Fire it with:</p>
          <CopyLine value={`curl -X POST ${url}`} mono />
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          {trigger.hasToken
            ? `A token exists${trigger.secretCreatedAt ? `, minted ${new Date(trigger.secretCreatedAt).toLocaleDateString()}` : ""}. It cannot be shown again — rotate it to get a new one.`
            : "No token yet. This trigger cannot fire until one is minted."}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" onClick={onMint}>
          <KeyRoundIcon data-icon="inline-start" />
          {trigger.hasToken ? "Rotate token" : "Mint token"}
        </Button>
        {trigger.hasToken && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="text-muted-foreground hover:text-destructive"
            onClick={onRevoke}
          >
            Revoke
          </Button>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground">
        A POST body of <code className="font-mono">{`{"text": "…"}`}</code> reaches the agent as the
        caller's words, quoted and never interpreted as instructions.
      </p>
    </div>
  )
}

function GitFields({
  trigger,
  onPatch,
}: {
  trigger: RoutineTrigger
  onPatch: (next: RoutineTriggerPatch) => void
}) {
  const [paths, setPaths] = React.useState(trigger.paths.join("\n"))
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Branch" hint="Blank fires on any branch's HEAD moving.">
          <Input
            placeholder="any branch"
            value={trigger.branch ?? ""}
            onChange={(e) => onPatch({ branch: e.target.value || null })}
          />
        </Field>
        <Field label="Debounce (ms)" hint="A rebase is hundreds of events and one intent.">
          <Input
            type="number"
            min={0}
            value={trigger.debounceMs}
            onChange={(e) => onPatch({ debounceMs: Math.max(0, Number(e.target.value) || 0) })}
          />
        </Field>
      </div>
      <Field label="Paths" hint="One glob per line. Empty means any path in the project.">
        <Textarea
          className="font-mono text-xs"
          rows={3}
          placeholder={"src/**\ndocs/*.md"}
          value={paths}
          onChange={(e) => setPaths(e.target.value)}
          onBlur={() => onPatch({ paths: lines(paths) })}
        />
      </Field>
    </div>
  )
}

function CopyLine({ value, mono }: { value: string; mono?: boolean }) {
  const [copied, setCopied] = React.useState(false)
  return (
    <div className="flex items-center gap-2">
      <code
        className={`min-w-0 flex-1 truncate rounded-md bg-background px-2 py-1.5 text-xs ${mono ? "font-mono" : ""}`}
      >
        {value}
      </code>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        onClick={() => {
          void writeClipboard(value)
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1500)
        }}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
        <span className="sr-only">Copy</span>
      </Button>
    </div>
  )
}

/** The browser's own zone, offered as the placeholder — a person setting "every
    day at 9" means 9 where they are, and the server's zone is rarely it. */
const localZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || ""
  } catch {
    return ""
  }
}
import { writeClipboard } from "@/lib/clipboard"
