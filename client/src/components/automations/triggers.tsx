/* ── Triggers ──
   One automation, several front doors: a clock, a webhook, a commit, or just a button. They share a
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
  HandIcon,
  KeyRoundIcon,
  PlusIcon,
  Trash2Icon,
  WebhookIcon,
} from "lucide-react"

import { useConfirm } from "@/components/confirm-dialog"
import { ErrorNote } from "@/components/error-note"
import { Notice } from "@/components/notice"
import { Empty } from "@/components/empty"
import { Field, FormSection, INSET, lines, Toolbar } from "@/components/settings/primitives"
import { GroupRowsSkeleton } from "@/components/ui/skeletons"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { captureError, type InlineError } from "@/lib/errors"
import type { RoutineTrigger, RoutineTriggerKind, RoutineTriggerPatch } from "@/lib/settings"
import {
  useCreateAutomationTrigger,
  useDeleteAutomationTrigger,
  useMintAutomationTriggerToken,
  useRevokeAutomationTriggerToken,
  useAutomationTriggers,
  useUpdateAutomationTrigger,
} from "@/lib/queries/automations"
import { useServer } from "@/lib/server-context"
import { defaultPlan, planProblem, planToPatch, planToTrigger, readPlan, type SchedulePlan } from "@/lib/automation-schedule"
import { SchedulePicker } from "./schedule-picker"

const KIND_META: Record<RoutineTriggerKind, { label: string; icon: typeof CalendarClockIcon; blurb: string }> = {
  manual: { label: "Manual", icon: HandIcon, blurb: "Only when you press Run now." },
  schedule: { label: "On a schedule", icon: CalendarClockIcon, blurb: "A clock the server keeps, browser or no browser." },
  api: { label: "On a webhook", icon: WebhookIcon, blurb: "A POST to a URL, with a token only you hold." },
  git: { label: "On a commit", icon: GitBranchIcon, blurb: "The project's HEAD moving, debounced." },
}

export function TriggersPanel({ routineId }: { routineId: string }) {
  const confirm = useConfirm()
  /* The query cache owns the read; the mutations invalidate it, which is the
     re-read. The optimistic part stays here and stays local: these are
     switches and a cron field being typed into, and a full re-read per
     keystroke would fight the caret. */
  const { data: cached, refetch } = useAutomationTriggers(routineId)
  const addTrigger = useCreateAutomationTrigger(routineId)
  const patchTrigger = useUpdateAutomationTrigger(routineId)
  const removeTrigger = useDeleteAutomationTrigger(routineId)
  const mintToken = useMintAutomationTriggerToken(routineId)
  const revokeToken = useRevokeAutomationTriggerToken(routineId)
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
      await addTrigger.mutateAsync(kind === "schedule" ? planToTrigger(defaultPlan()) : { kind })
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
            ? "Its token stops working immediately and cannot be recovered. The automation and its run history are untouched."
            : "The automation and its run history are untouched — it just stops firing this way.",
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
                <span className="truncate text-xs text-muted-foreground">{KIND_META[kind].blurb}</span>
              </span>
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )

  return (
    <div>
      <ErrorNote error={error} onRetry={() => void refetch()} />
      {/* Null is "not read yet", which is not the same screen as "none" — see
          the header comment. A failed read leaves it null and the note above
          is what the user sees, rather than a confident empty state. */}
      {triggers === null ? (
        error ? null : (
          <GroupRowsSkeleton rows={2} />
        )
      ) : triggers.length === 0 ? (
        <Empty size="lg" icon={CalendarClockIcon} action={addMenu}>
          No triggers — this automation only fires when you run it by hand.
        </Empty>
      ) : (
        <>
          <Toolbar>{addMenu}</Toolbar>
          {triggers.map((trigger) => (
            <TriggerCard
              key={trigger.id}
              trigger={trigger}
              token={minted[trigger.id]}
              onPatch={(next) => void patch(trigger.id, next)}
              onRemove={() => void remove(trigger)}
              onMint={() => void mint(trigger)}
              onRevoke={() => void revoke(trigger)}
            />
          ))}
        </>
      )}
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
  return (
    <FormSection
      label={meta.label}
      hint={
        <>
          {trigger.lastFiredAt
            ? `Last fired ${new Date(trigger.lastFiredAt).toLocaleString()}`
            : "Has never fired"}
          {trigger.nextFireAt && ` · next ${new Date(trigger.nextFireAt).toLocaleString()}`}
        </>
      }
      action={
        <>
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
        </>
      }
    >
      {trigger.lastError && (
        <Notice tone="error" copy={trigger.lastError}>
          Last evaluation: {trigger.lastError}
        </Notice>
      )}

      {trigger.kind === "schedule" && <ScheduleFields trigger={trigger} onPatch={onPatch} />}
      {trigger.kind === "api" && (
        <ApiFields trigger={trigger} token={token} onMint={onMint} onRevoke={onRevoke} />
      )}
      {trigger.kind === "git" && <GitFields trigger={trigger} onPatch={onPatch} />}
      {trigger.kind === "manual" && <p className="text-xs text-muted-foreground">{KIND_META.manual.blurb}</p>}
    </FormSection>
  )
}

function ScheduleFields({
  trigger,
  onPatch,
}: {
  trigger: RoutineTrigger
  onPatch: (next: RoutineTriggerPatch) => void
}) {
  /* The picker is controlled by a local plan so a half-typed value (a cron
     being written) is not read back through the stored trigger and snapped to
     something else; only a plan that validates is written. */
  const [plan, setPlan] = React.useState<SchedulePlan>(() => readPlan(trigger))
  const change = (next: SchedulePlan) => {
    setPlan(next)
    const patch = planProblem(next) === null ? planToPatch(next) : null
    if (patch) onPatch(patch)
  }
  return (
    <div className="space-y-3">
      <SchedulePicker plan={plan} onChange={change} allowManual={false} />
      {/* The condition is checked at fire time, never here: a nightly review
          that reports on yesterday and one that says "nothing happened" thirty
          times in a row are the same automation with and without this switch. */}
      <label className={`flex items-start gap-2.5 px-3 py-2.5 ${INSET}`}>
        <Switch
          className="mt-0.5"
          checked={trigger.condition?.gitChangedSince === "lastRun"}
          onCheckedChange={(checked) => onPatch({ condition: checked ? { gitChangedSince: "lastRun" } : null })}
        />
        <span className="min-w-0 text-sm">
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
        <Notice
          tone="warn"
          title="Copy this now — it is shown once. Only its hash is stored, so it cannot be shown again."
        >
          <div className="space-y-2 pt-0.5">
            <CopyLine value={token} mono />
            <p className="text-xs text-muted-foreground">Fire it with:</p>
            <CopyLine value={`curl -X POST ${url}`} mono />
          </div>
        </Notice>
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
      <p className="text-xs text-muted-foreground">
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
      <div className="grid gap-3 @lg:grid-cols-2">
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
          className="font-mono"
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
        className={`min-w-0 flex-1 truncate rounded-md bg-background px-2 py-1.5 text-sm ${mono ? "font-mono" : ""}`}
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

import { writeClipboard } from "@/lib/clipboard"
