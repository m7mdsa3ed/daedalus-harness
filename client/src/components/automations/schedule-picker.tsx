/* ── The "When" picker ──
   A preset, the one or two inputs it needs, and a preview that never leaves
   the picker: the sentence the schedule will read as and the next three times
   it fires. Controlled over a `SchedulePlan` (lib/automation-schedule.ts), so
   the create form holds one in its draft and the Triggers tab holds one per
   schedule trigger and writes it back as a patch. */
import { Field, INSET, Segmented } from "@/components/settings/primitives"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  DAY_LABEL,
  PRESET_LABEL,
  describePlan,
  localZone,
  nextFires,
  offPeak,
  onTheHour,
  planProblem,
  type Preset,
  type SchedulePlan,
} from "@/lib/automation-schedule"
import { cn } from "@/lib/utils"

const PRESETS = Object.keys(PRESET_LABEL) as Preset[]
const CLOCK_PRESETS = new Set<Preset>(["hourly", "daily", "weekdays", "weekly", "monthly", "custom"])
const TIMED = new Set<Preset>(["daily", "weekdays", "weekly", "monthly"])

const when = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })

export function SchedulePicker({
  plan,
  onChange,
  /** Omit the `Manual` preset where a clock is required (an existing schedule trigger). */
  allowManual = true,
}: {
  plan: SchedulePlan
  onChange: (next: SchedulePlan) => void
  allowManual?: boolean
}) {
  const patch = (next: Partial<SchedulePlan>) => onChange({ ...plan, ...next })
  const problem = planProblem(plan)
  const fires = problem ? [] : nextFires(plan)
  const presets = allowManual ? PRESETS : PRESETS.filter((p) => p !== "manual")

  return (
    <div className="space-y-4">
      <div className="grid gap-3 @panel-sm:grid-cols-2">
        <Field label="Repeats">
          <Select value={plan.preset} onValueChange={(v) => v && patch({ preset: v as Preset })}>
            <SelectTrigger className="w-full">
              <SelectValue>{PRESET_LABEL[plan.preset]}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {presets.map((key) => (
                <SelectItem key={key} value={key}>
                  {PRESET_LABEL[key]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        {plan.preset === "every" && (
          <Field label="Every">
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={1}
                className="w-24"
                value={plan.every}
                onChange={(e) => patch({ every: Math.max(1, Math.floor(Number(e.target.value) || 1)) })}
              />
              <Segmented
                label="Unit"
                value={plan.unit}
                onChange={(unit) => patch({ unit })}
                options={[
                  { value: "minutes", label: "Minutes" },
                  { value: "hours", label: "Hours" },
                ]}
              />
            </div>
          </Field>
        )}
        {plan.preset === "hourly" && (
          <Field label="Minute past the hour">
            <Input
              type="number"
              min={0}
              max={59}
              className="w-24"
              value={plan.minute}
              onChange={(e) => patch({ minute: Math.min(59, Math.max(0, Math.floor(Number(e.target.value) || 0))) })}
            />
          </Field>
        )}
        {TIMED.has(plan.preset) && (
          <Field label="At">
            <Input type="time" className="w-36" value={plan.time} onChange={(e) => patch({ time: e.target.value || plan.time })} />
          </Field>
        )}
        {plan.preset === "monthly" && (
          <Field label="Day of the month" hint="Months without that day are skipped.">
            <Input
              type="number"
              min={1}
              max={31}
              className="w-24"
              value={plan.dayOfMonth}
              onChange={(e) => patch({ dayOfMonth: Math.min(31, Math.max(1, Math.floor(Number(e.target.value) || 1))) })}
            />
          </Field>
        )}
        {plan.preset === "once" && (
          <Field label="At" hint="Runs once, then switches itself off.">
            <Input type="datetime-local" value={plan.at} onChange={(e) => patch({ at: e.target.value })} />
          </Field>
        )}
        {plan.preset === "custom" && (
          <Field label="Cron" hint="Five fields, minute first.">
            <Input className="font-mono text-xs" value={plan.cron} onChange={(e) => patch({ cron: e.target.value })} />
          </Field>
        )}
      </div>

      {plan.preset === "weekly" && (
        <Field label="On">
          <div role="group" aria-label="Days of the week" className="flex flex-wrap gap-1.5">
            {DAY_LABEL.map((label, day) => {
              const on = plan.days.includes(day)
              return (
                <button
                  key={label}
                  type="button"
                  aria-pressed={on}
                  onClick={() => patch({ days: on ? plan.days.filter((d) => d !== day) : [...plan.days, day] })}
                  className={cn(
                    "h-10 min-w-11 rounded-lg border px-3 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none @panel-sm:h-8",
                    on
                      ? "border-primary/60 bg-primary/5 text-foreground"
                      : "border-border/60 text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                  )}
                >
                  {label}
                </button>
              )
            })}
          </div>
        </Field>
      )}

      {CLOCK_PRESETS.has(plan.preset) && (
        <Field label="Time zone" hint="IANA name. Blank reads the schedule in the server's own zone.">
          <Input placeholder={localZone()} value={plan.tz} onChange={(e) => patch({ tz: e.target.value })} />
        </Field>
      )}

      <div className={cn("space-y-1.5 px-3 py-2.5 text-xs", INSET)} aria-live="polite">
        <p className="text-sm font-medium text-foreground">{describePlan(plan)}</p>
        {problem ? (
          <p className="text-destructive">{problem}</p>
        ) : fires.length > 0 ? (
          <p className="text-muted-foreground">
            Next: {fires.map(when).join(" · ")}
            {plan.preset !== "once" && plan.preset !== "every" && " (give or take a few minutes of stagger)"}
          </p>
        ) : plan.preset === "manual" ? (
          <p className="text-muted-foreground">It runs when you press Run now, or when a webhook or a commit fires it.</p>
        ) : null}
        {!problem && onTheHour(plan) && (
          <p className="flex flex-wrap items-center gap-1.5 text-muted-foreground">
            The top of the hour is where everything fires at once.
            <Button type="button" variant="link" size="xs" className="h-auto p-0" onClick={() => onChange(offPeak(plan))}>
              Use :07 instead
            </Button>
          </p>
        )}
      </div>
    </div>
  )
}
