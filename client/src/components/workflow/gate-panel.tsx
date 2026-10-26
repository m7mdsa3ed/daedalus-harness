/* A run's gates: the places it is parked on something that is not a step —
   a person's answer (approval), a clock (timer) or an outside event (signal).
   Drawn from the run's REST view; a waiting gate is acted on here, through the
   same doors the inbox and the `signal_workflow` tool use, so a lost race (it
   was answered elsewhere first) is the server's 409 and nothing is assumed. */
import * as React from "react"
import { BellRingIcon, HourglassIcon, MoonIcon, SendIcon, ShieldQuestionIcon } from "lucide-react"

import { useElapsed } from "@/components/step-row"
import { Button } from "@/components/ui/busy-button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover"
import { Textarea } from "@/components/ui/textarea"
import { Field, INSET } from "@/components/settings/primitives"
import { reportError } from "@/lib/errors"
import {
  useApproveWorkflowGate,
  useSignalWorkflowRun,
  type WorkflowGateView,
} from "@/lib/queries/workflows"
import { cn } from "@/lib/utils"
import { clockLabel, remainingLabel } from "./step-status"

interface RunRef {
  sessionId: string
  runId: string
}

export function GatePanel({ gates, run, live }: { gates: WorkflowGateView[]; run: RunRef; live: boolean }) {
  const waiting = gates.filter((gate) => gate.status === "waiting")
  const settled = gates.filter((gate) => gate.status !== "waiting")
  /* One clock for every countdown in the panel, ticking only while one shows. */
  const timed = live && waiting.some((gate) => gate.fireAt !== undefined || gate.expiresAt !== undefined)
  const now = useElapsed(0, timed)
  if (gates.length === 0) return null
  return (
    <section aria-label="Gates" className={cn(INSET, "divide-y overflow-hidden")}>
      {waiting.map((gate) => (
        <WaitingGate key={gate.key} gate={gate} run={run} now={now} live={live} />
      ))}
      {settled.length > 0 && (
        <details className="group/settled px-2 py-1.5 text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none">
            {settled.length} resolved {settled.length === 1 ? "gate" : "gates"}
          </summary>
          <ul className="mt-1 space-y-0.5">
            {settled.map((gate) => (
              <li key={gate.key} className="flex min-w-0 items-baseline gap-2">
                <span className="min-w-0 flex-1 truncate">{gateTitle(gate)}</span>
                <span className="shrink-0">{settledLabel(gate)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}

function gateTitle(gate: WorkflowGateView): string {
  if (gate.kind === "signal") return `Signal “${gate.signal ?? ""}”`
  if (gate.kind === "timer") return gate.text || "Timer"
  return gate.text || "Approval"
}

function settledLabel(gate: WorkflowGateView): string {
  if (gate.status === "timed_out") return "timed out"
  if (gate.kind === "approval") return gate.choice ? `chose ${gate.choice}` : "answered"
  if (gate.kind === "timer") return "fired"
  return "received"
}

function WaitingGate({
  gate,
  run,
  now,
  live,
}: {
  gate: WorkflowGateView
  run: RunRef
  now: number | null
  live: boolean
}) {
  const Icon = gate.kind === "approval" ? ShieldQuestionIcon : gate.kind === "timer" ? MoonIcon : BellRingIcon
  const until = gate.fireAt ?? gate.expiresAt
  const left = until !== undefined && now !== null ? until - Date.now() : null
  return (
    <div className="flex min-w-0 flex-col gap-2 p-2">
      <div className="flex min-w-0 items-start gap-2">
        <Icon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warning" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium break-words">
            {gate.kind === "timer" && gate.fireAt !== undefined
              ? `Sleeping until ${clockLabel(gate.fireAt)}`
              : gate.kind === "signal"
                ? `Waiting for signal “${gate.signal ?? ""}”`
                : gateTitle(gate)}
          </p>
          {gate.kind === "timer" && gate.text && (
            <p className="text-xs break-words text-muted-foreground">{gate.text}</p>
          )}
        </div>
        {until !== undefined && (
          <span className="flex shrink-0 items-center gap-1 text-xs tabular-nums text-muted-foreground">
            <HourglassIcon aria-hidden className="size-3" />
            {left === null ? "…" : remainingLabel(left)}
          </span>
        )}
      </div>
      {gate.kind === "approval" && <ApprovalOptions gate={gate} run={run} disabled={!live} />}
      {gate.kind === "signal" && gate.signal && <SignalSender name={gate.signal} run={run} disabled={!live} />}
    </div>
  )
}

function ApprovalOptions({ gate, run, disabled }: { gate: WorkflowGateView; run: RunRef; disabled: boolean }) {
  const approve = useApproveWorkflowGate()
  const [picked, setPicked] = React.useState<string | null>(null)
  const options = gate.options?.length ? gate.options : ["Approve", "Reject"]
  const answer = (choice: string) => {
    setPicked(choice)
    approve.mutate(
      { ...run, gateKey: gate.key, choice },
      {
        onError: (error) => reportError(error, "Couldn't answer the approval"),
        onSettled: () => setPicked(null),
      }
    )
  }
  return (
    <div className="flex flex-wrap gap-1.5 ps-5">
      {options.map((option, i) => (
        <Button
          key={option}
          type="button"
          size="sm"
          variant={i === 0 ? "default" : "outline"}
          disabled={disabled || approve.isPending}
          loading={picked === option}
          onClick={() => answer(option)}
        >
          {option}
        </Button>
      ))}
    </div>
  )
}

/** Send a signal: the name is preset to the one being waited on, the value is
    JSON (empty sends null). */
function SignalSender({ name: preset, run, disabled }: { name: string; run: RunRef; disabled: boolean }) {
  const signal = useSignalWorkflowRun()
  const [open, setOpen] = React.useState(false)
  const [name, setName] = React.useState(preset)
  const [raw, setRaw] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const send = () => {
    let value: unknown = null
    if (raw.trim()) {
      try {
        value = JSON.parse(raw)
      } catch {
        setError("That is not valid JSON.")
        return
      }
    }
    setError(null)
    signal.mutate(
      { ...run, name: name.trim(), value },
      {
        onSuccess: () => setOpen(false),
        onError: (err) => reportError(err, "Couldn't send the signal"),
      }
    )
  }
  return (
    <div className="ps-5">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={<Button type="button" size="sm" variant="outline" disabled={disabled} />}
        >
          <SendIcon aria-hidden />
          Send signal
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80">
          <PopoverHeader>
            <PopoverTitle className="text-sm">Send a signal</PopoverTitle>
            <PopoverDescription className="text-xs">
              Wakes the run waiting on this name. The value reaches it as JSON.
            </PopoverDescription>
          </PopoverHeader>
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} />
          </Field>
          <Field label="Value" hint="JSON — leave empty to send null.">
            <Textarea
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              placeholder='{"ok": true}'
              spellCheck={false}
              className="font-mono text-xs"
              aria-invalid={error !== null}
            />
            {error && <p className="text-xs text-destructive">{error}</p>}
          </Field>
          <Button
            type="button"
            size="sm"
            disabled={!name.trim()}
            loading={signal.isPending}
            onClick={send}
          >
            Send
          </Button>
        </PopoverContent>
      </Popover>
    </div>
  )
}
