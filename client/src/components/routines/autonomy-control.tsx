/* ── Autonomy ──
   The one control on this page that can hand an agent a standing grant, and the
   only reason the rest of the form is careful.

   Three rules are built into it and none of them is decoration:

   1. **Per kind first, blanket last.** The rows are ACP tool *kinds* — a
      protocol field, so nothing here knows a vendor tool name — and the blanket
      `default` sits at the BOTTOM. That ordering is the whole argument for
      drawing ten rows instead of one switch: `{read: allow, fetch: allow,
      default: ask}` is a sentence a person can check, and it is what almost
      every routine actually wants. A single Autonomous toggle at the top would
      be read as the intended answer and the ten rows as fine print.
   2. **A blanket grant is confirmed by naming the directory.** Allowing
      `execute` — or widening `default` — is permission to run any command the
      agent decides on, in that project's working directory, on this machine,
      with no person in the loop. There is no sandbox and no network allowlist
      under us, so this is strictly more than the same word means in a hosted
      product, and the dialog says so in those words with the cwd printed.
   3. **A grant is not given before a run.** `default: "allow"` is refused until
      the routine has completed one run (`dryRunCompleted`, set by the engine and
      not patchable). The difference between an informed grant and a dismissed
      dialog is having watched the thing work once.

   Two exports, one policy object: `AutonomyPermissions` is the grant and
   `AutonomyLimits` the guard rails around it (what an unanswered Ask falls
   through to, and the three ceilings a run spends against). They are two
   sections of the form because ten selects and six number fields read as one
   wall was how the guard rails went unread — but they stay in one file,
   because the shape they both write should have one owner. */
import * as React from "react"
import { AlertTriangleIcon, ShieldCheckIcon } from "lucide-react"
import type * as acp from "@daedalus/acp"

import { useConfirm } from "@/components/confirm-dialog"
import { Field } from "@/components/settings/primitives"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { AutonomyPolicy, Stance } from "@/lib/settings"
import { cn } from "@/lib/utils"

/** The ACP tool kinds, in the order the rows are drawn: what the agent reads
    and thinks about first, then what it changes, then what it runs. Verbatim
    `acp.ToolKind` — a kind a later ACP release adds simply falls through to
    `default` server-side, which is why nothing here is exhaustive-checked. */
const KINDS: { kind: acp.ToolKind; label: string; blurb: string; grave?: boolean }[] = [
  { kind: "read", label: "Read files", blurb: "Open files in the project directory." },
  { kind: "think", label: "Think and plan", blurb: "Reasoning steps and checklists. Changes nothing." },
  { kind: "search", label: "Search", blurb: "Grep the project, search the web." },
  { kind: "fetch", label: "Fetch pages", blurb: "Retrieve a URL and read it." },
  { kind: "edit", label: "Write files", blurb: "Create and edit files in the project directory.", grave: true },
  { kind: "move", label: "Move files", blurb: "Rename and relocate files." },
  { kind: "delete", label: "Delete files", blurb: "Remove files from the project directory.", grave: true },
  {
    kind: "execute",
    label: "Run commands",
    blurb: "Shell commands in the project directory — builds, tests, installs, anything.",
    grave: true,
  },
  { kind: "switch_mode", label: "Change its own mode", blurb: "Move itself between the agent's permission modes." },
  { kind: "other", label: "Other tools", blurb: "MCP tools and anything the agent does not classify." },
]

const STANCES: { value: Stance; label: string }[] = [
  { value: "allow", label: "Allow" },
  { value: "ask", label: "Ask" },
  { value: "deny", label: "Deny" },
]

/** Which widenings are a standing grant rather than a convenience. Reading a
    file unattended is what a routine is *for*; running a command it chose,
    deleting a file, or answering "yes" to everything is the thing the confirm
    exists to make deliberate. */
const GRAVE_GRANT = new Set<string>(["default", "execute", "delete"])

/** The policy as one sentence, live under the rows. This is what the per-kind
    design buys and it is worth spending a line to actually print: a table of
    ten selects is something you audit, a sentence is something you read. */
function policySentence(policy: AutonomyPolicy): string {
  const allowed = KINDS.filter((k) => policy.permissions[k.kind] === "allow")
  const denied = KINDS.filter((k) => policy.permissions[k.kind] === "deny")
  const rest =
    policy.permissions.default === "allow"
      ? "does everything else without asking"
      : policy.permissions.default === "deny"
        ? "is refused everything else"
        : "asks about everything else"
  const list = (items: typeof KINDS) => items.map((k) => k.label.toLowerCase()).join(", ")
  const parts: string[] = []
  if (allowed.length > 0) parts.push(`may ${list(allowed)} freely`)
  if (denied.length > 0) parts.push(`is refused ${list(denied)}`)
  parts.push(rest)
  return `This routine's agent ${parts.join("; ")}.`
}

export function AutonomyPermissions({
  policy,
  onChange,
  /** The directory a grant applies to, printed verbatim in the confirm dialog.
      Empty when the form has no project picked yet, which is why the grave
      grants are refused outright until one is — a grant with no named cwd is a
      grant nobody could have checked. */
  cwd,
  projectName,
  /** From the routine row. False disables the blanket `allow` and says why. */
  dryRunCompleted,
}: {
  policy: AutonomyPolicy
  onChange: (next: AutonomyPolicy) => void
  cwd: string
  projectName: string
  dryRunCompleted: boolean
}) {
  const confirm = useConfirm()

  const setStance = async (key: string, next: Stance) => {
    if (next === policy.permissions[key]) return
    if (next === "allow" && GRAVE_GRANT.has(key)) {
      if (!cwd) return
      const what =
        key === "default"
          ? "every tool it has not been given a narrower answer for — including running commands"
          : key === "execute"
            ? "any shell command it decides to run"
            : "deleting files"
      const ok = await confirm({
        title: `Let this routine's agent do this with no person watching?`,
        description:
          `It will be allowed ${what}, in ${projectName}'s working directory:\n\n${cwd}\n\n` +
          `That directory is on this machine, and the harness runs the agent directly — there is no ` +
          `sandbox and no network allowlist between it and the rest of the system. A run fires on a ` +
          `schedule, a webhook or a commit, so there may be nobody at the keyboard when it does. You ` +
          `can watch what it does in each run's own thread, but not stop it before it acts.`,
        destructive: true,
        confirmLabel: "Grant it",
      })
      if (!ok) return
    }
    onChange({ ...policy, permissions: { ...policy.permissions, [key]: next } as AutonomyPolicy["permissions"] })
  }

  /* The gate is on the blanket answer alone. A per-kind `execute: allow` is
     confirmed but not gated: it is a grant a person spelled out kind by kind,
     where `default: allow` is the one that also covers every kind ACP has not
     invented yet. */
  const blanketBlocked = !dryRunCompleted

  const row = (
    key: string,
    label: string,
    blurb: string,
    opts: { grave?: boolean; disabled?: string } = {}
  ) => {
    const value = policy.permissions[key] ?? policy.permissions.default
    return (
      <div
        key={key}
        className={cn(
          "flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5 sm:flex-nowrap",
          value === "allow" && opts.grave && "bg-destructive/5"
        )}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-sm font-medium">
            {label}
            {value === "allow" && opts.grave && (
              <AlertTriangleIcon className="size-3.5 shrink-0 text-destructive" />
            )}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {opts.disabled ?? blurb}
          </p>
        </div>
        <StanceSelect
          value={value}
          label={label}
          disabledAllow={opts.disabled}
          onChange={(next) => void setStance(key, next)}
        />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2.5 rounded-lg border bg-muted/30 px-3 py-2.5 text-xs text-muted-foreground">
        <ShieldCheckIcon className="mt-0.5 size-4 shrink-0" />
        <p>
          A run fires with nobody watching, so every question the agent would have asked you has to
          have an answer written down here first. <strong className="font-medium text-foreground">Ask</strong>{" "}
          is what an ordinary thread does — the run waits for a person, and gives up after the
          timeout below.
        </p>
      </div>

      <div className="divide-y overflow-hidden rounded-xl border">
        {KINDS.map((k) => row(k.kind, k.label, k.blurb, { grave: k.grave }))}
        {/* Last, and visually apart: the blanket answer is the fallback for the
            rows above and for every kind ACP has not shipped yet, which is the
            opposite of a headline switch. */}
        <div className="bg-muted/40">
          {row("default", "Everything else", "Anything not answered above, and any tool kind a future agent adds.", {
            grave: true,
            disabled: blanketBlocked
              ? "Run this routine once first — “Run now, forced to ask” — before granting it everything. A grant made before you have seen it work is a dismissed dialog, not a decision."
              : !cwd
                ? "Pick a project first: a grant is about a specific working directory."
                : undefined,
          })}
        </div>
      </div>

      <p className="px-1 text-xs text-pretty text-muted-foreground">{policySentence(policy)}</p>
    </div>
  )
}

/** The other half of the policy: what happens when an `Ask` above goes
    unanswered, and the three ceilings a run spends against. Split from the
    rows so the two live in their own sections of the form — the rows are the
    grant, and these are the guard rails around it, and reading ten selects and
    six number fields as one wall was how the guard rails went unread. Same
    file, because the policy is one object and its shape should have one owner. */
export function AutonomyLimits({
  policy,
  onChange,
}: {
  policy: AutonomyPolicy
  onChange: (next: AutonomyPolicy) => void
}) {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Questions the agent asks outright"
          hint="Not a permission — a form the agent puts up mid-turn. Declining is a real answer: the turn carries on and says it was skipped."
        >
          <Select
            value={policy.elicitations}
            onValueChange={(value) =>
              value && onChange({ ...policy, elicitations: value as AutonomyPolicy["elicitations"] })
            }
          >
            <SelectTrigger className="w-full">
              <SelectValue>
                {policy.elicitations === "decline" ? "Decline and carry on" : "Wait for a person"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ask">Wait for a person</SelectItem>
              <SelectItem value="decline">Decline and carry on</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field
          label="Give up waiting after"
          hint="Seconds an “Ask” waits for a person. 0 waits forever — which for an unattended run means until a ceiling below stops it."
        >
          <Input
            type="number"
            min={0}
            value={policy.askTimeoutSeconds}
            onChange={(e) => onChange({ ...policy, askTimeoutSeconds: numeric(e.target.value) })}
          />
        </Field>
        <Field
          label="When nobody answers"
          hint="Deny lets the agent carry on refused, and say so; Cancel aborts the tool call outright."
        >
          <Select
            value={policy.askFallback}
            onValueChange={(value) =>
              value && onChange({ ...policy, askFallback: value as AutonomyPolicy["askFallback"] })
            }
          >
            <SelectTrigger className="w-full">
              <SelectValue>{policy.askFallback === "deny" ? "Deny it" : "Cancel the tool call"}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="deny">Deny it</SelectItem>
              <SelectItem value="cancel">Cancel the tool call</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Run time limit (seconds)" hint="Whole run, not one turn. 0 = none.">
          <Input
            type="number"
            min={0}
            value={policy.maxRunSeconds}
            onChange={(e) => onChange({ ...policy, maxRunSeconds: numeric(e.target.value) })}
          />
        </Field>
        <Field label="Token ceiling" hint="Summed across the run's turns. Blank = none.">
          <Input
            type="number"
            min={0}
            value={policy.maxRunTokens ?? ""}
            onChange={(e) => onChange({ ...policy, maxRunTokens: optionalNumeric(e.target.value) })}
          />
        </Field>
        <Field
          label="Minimum plan left (%)"
          hint="Skip the fire when the profile's plan is nearly spent. Not applied to a profile with no windows — an API key reports none, and that is an answer, not 0%."
        >
          <Input
            type="number"
            min={0}
            max={100}
            value={policy.minQuotaPercent ?? ""}
            onChange={(e) => onChange({ ...policy, minQuotaPercent: optionalNumeric(e.target.value) })}
          />
        </Field>
      </div>
    </div>
  )
}

/** Three buttons rather than a select: the choice is one of three words, it is
    made ten times down the page, and a select would hide two thirds of it
    behind a click each time. */
function StanceSelect({
  value,
  label,
  disabledAllow,
  onChange,
}: {
  value: Stance
  label: string
  /** Non-empty means Allow is refused, and the string says why (drawn as the
      row's blurb — a control that is off without saying so is a bug report). */
  disabledAllow?: string
  onChange: (next: Stance) => void
}) {
  return (
    <div
      role="radiogroup"
      aria-label={`${label} — what the harness answers`}
      className="flex shrink-0 rounded-lg border bg-background p-0.5"
    >
      {STANCES.map((stance) => {
        const on = value === stance.value
        const off = stance.value === "allow" && Boolean(disabledAllow) && !on
        return (
          <button
            key={stance.value}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={off}
            title={off ? disabledAllow : undefined}
            onClick={() => !off && onChange(stance.value)}
            className={cn(
              "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
              on
                ? stance.value === "allow"
                  ? "bg-destructive/15 text-destructive"
                  : "bg-accent text-foreground"
                : "text-muted-foreground hover:text-foreground",
              off && "cursor-not-allowed opacity-40 hover:text-muted-foreground"
            )}
          >
            {stance.label}
          </button>
        )
      })}
    </div>
  )
}

/** An empty or unparseable number input is 0, never NaN — NaN serializes to
    `null` and the server would read it as "absent" rather than "none". */
const numeric = (value: string): number => {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0
}

/** The optional ceilings differ: blank genuinely means "no ceiling", which is
    `undefined` and not 0 — 0 would be a ceiling of zero tokens. */
const optionalNumeric = (value: string): number | undefined => {
  if (value.trim() === "") return undefined
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined
}
