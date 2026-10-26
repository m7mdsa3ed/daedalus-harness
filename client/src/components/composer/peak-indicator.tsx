/* ── What this prompt costs, given the hour ──
   Some providers bill by the clock: DeepSeek doubles two weekday UTC windows,
   Z.AI's coding plan charges more between 14:00 and 18:00 Singapore time, and
   Alibaba halves a Beijing night. The schedule is a field on the model
   (`ModelDef.peak`), read by one parser at both ends (`@daedalus/peak`), and
   this is the reading that acts on it.

   **Both phases are drawn.** A thread on a model with a schedule wears a badge
   whichever side of it you are on: `Peak` while the windows are in force and
   `Off-peak` while they are not. Drawing only the dear one was the first
   version and it answered half the question — the reader wants to know which
   side of the line they are on, and "no badge" is indistinguishable from "this
   model has no schedule at all". The tone is what carries the difference (warn
   above the listed price, muted below it, success for a real discount), so a
   cluster of readings still does not shout.

   **The schedule is written in the provider's clock and read on the reader's.**
   The words on the face lead with their own clock and the fetching fact — what
   is coming and how far off it is (`Peak in 40m`, `1h 12m left`) — because that
   is the one number a person can act on: whether to send now or wait. The
   popover answers "when" in their time first (`Mon 09:00`), keeps the provider's
   spelling (`04:00 UTC`) one step below it to check against the rate card, names
   the next rise when it is not the next change at all (a weekday card seen on a
   Saturday is three days out), and draws the next day as a strip with its
   colours labelled. Nothing here asks the reader to convert a zone in their
   head — that is the whole reading.

   A reading, in the same sense as the ring beside it: one fact about the
   thread right now, drawn in the footer's cluster. It draws on a draft too —
   the moment a person is about to spend money is before they press send. */
import * as React from "react"
import { MoonIcon, TrendingDownIcon, TrendingUpIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Popover, PopoverTrigger } from "@/components/ui/popover"
import {
  READING_MARK,
  READING_TRIGGER,
  ReadingBubble,
  ReadingFace,
  ReadingPopoverContent,
} from "@/components/composer/indicator"
import { useProfiles } from "@/lib/queries/catalog"
import type { SessionMeta } from "@/lib/settings"
import { cn } from "@/lib/utils"
import {
  bandLabel,
  clockLabel,
  daysLabel,
  parsePeak,
  peakSpans,
  peakState,
  upcomingTransitions,
  windowInForce,
  windowLabel,
  windowRun,
  zoneLabel,
  type PeakBand,
  type PeakPlan,
  type PeakTransition,
} from "@daedalus/peak"

/** How often a drawn reading re-asks the clock while nothing is scheduled to
    change. A minute is finer than any published window and cheap enough to
    spend on a thread that has a schedule at all. */
const TICK_MS = 60_000

/** How much of the day the strip draws: far enough to always contain the next
    opening of a window, which is the thing the reader came for. */
const STRIP_MS = 24 * 60 * 60_000

/** "2h 15m", "40m", "3d 4h" — a duration without the tense, so it can follow a
    verb of either direction ("ends in …", "starts in …"). */
function durationLabel(at: number, now: number): string {
  const minutes = Math.max(0, Math.round((at - now) / 60_000))
  if (minutes < 1) return "now"
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours < 24) return rest ? `${hours}h ${rest}m` : `${hours}h`
  const days = Math.floor(hours / 24)
  const spare = hours % 24
  return spare ? `${days}d ${spare}h` : `${days}d`
}

/** The zone this device is set to, in the browser's own canonical spelling. */
const DEVICE_ZONE = ((): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "local time"
  } catch {
    return "local time"
  }
})()

/** `"GMT+2"` / `"GMT-5"` / `""` — the device's offset, which is what makes a
    local time comparable to the offset a schedule like `+08:00` names. A
    runtime that does not know `shortOffset` says nothing rather than
    formatting an hour in the wrong zone. */
function deviceOffset(at: number): string {
  try {
    const parts = new Intl.DateTimeFormat(undefined, { timeZoneName: "shortOffset" }).formatToParts(
      new Date(at),
    )
    return parts.find((p) => p.type === "timeZoneName")?.value ?? ""
  } catch {
    return ""
  }
}

/** `"09:00"` on the reader's own clock. */
const localTime = (at: number): string =>
  new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })

/** `"Mon 09:00"` — a boundary on the reader's own clock. The weekday is not
    decoration: a 01:00 UTC window opens on the *previous* evening for anyone
    west of Greenwich, and a time without its day reads as a contradiction. */
const localStamp = (at: number): string =>
  new Date(at).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })

/**
 * `"Mon 09:00-04:00"` — the stretch between two instants on this device's
 * clock. The end carries its weekday only when it falls on another day, which
 * is the one case where the hours alone would read backwards (a window that
 * opens at 22:00 here and closes at 02:00 the next morning).
 */
function localSpan(start: number, end: number): string {
  const endLabel = localTime(end)
  const sameDay = new Date(start).toDateString() === new Date(end).toDateString()
  return sameDay ? `${localStamp(start)}-${endLabel}` : `${localStamp(start)}-${localStamp(end)}`
}

/** One row of the popover's list: a caption, and a value that drops to its own
    line when the two do not fit. A row here can carry two clocks and a
    duration, so the first version's `flex-1` caption painted over the value. */
function Row({
  label,
  children,
  muted,
}: {
  label: string
  children: React.ReactNode
  muted?: boolean
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2">
      <dt className="shrink-0 whitespace-nowrap text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "ml-auto text-right tabular-nums",
          muted ? "text-muted-foreground" : "font-medium",
        )}
      >
        {children}
      </dd>
    </div>
  )
}

/** The multiple as a percentage, phrased by which side of the listed price it
    lands on: 2 → "2× listed", 0.5 → "half price". */
function multiplierLabel(multiplier: number): string {
  if (multiplier === 1) return "listed price"
  if (multiplier === 0.5) return "half price"
  if (multiplier === 0.25) return "quarter price"
  return `${Number(multiplier.toFixed(2))}× listed`
}

const price = (n: number): string => String(Number(n.toFixed(2)))

/** Re-renders the badge when the clock crosses the schedule's next boundary —
    and on a slow tick besides, so a schedule whose boundary cannot be computed
    still recovers rather than freezing on a stale reading. */
function usePeakClock(plan: PeakPlan | null): number {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    if (!plan) return
    const state = peakState(plan, Date.now())
    const delay =
      state.until === null ? TICK_MS : Math.min(TICK_MS, Math.max(1_000, state.until - Date.now() + 500))
    const timer = setTimeout(() => setNow(Date.now()), delay)
    return () => clearTimeout(timer)
    // `now` is the dependency that makes this a loop: each tick re-arms for the
    // boundary after it, so a badge never sits on a state the clock has left.
  }, [plan, now])
  return now
}

/** What the coming boundary does, in the words the countdown sits under. Read
    from the band it opens rather than from the edge's direction, so an
    `off-peak` card — where a window *closing* is the hour getting dearer —
    names the change the right way round. */
function changeVerb(from: PeakBand, next: PeakTransition): string {
  if (next.band === "premium") return "Peak starts"
  if (next.band === "discount") return "Off-peak starts"
  return from === "discount" ? "Off-peak ends" : "Peak ends"
}

/** The same fact in the pill's few words.
 *
 * The rule is one line: **a discount has nothing left to name, so it counts
 * down** (`1h 12m left` — the badge already says Off-peak, and "Off-peak in 0m"
 * says nothing); every other phase names what is arriving (`Peak in 40m`,
 * `Listed price in 3h`), because that is the fact the badge does not carry. */
function nextPhrase(
  plan: PeakPlan,
  from: PeakBand,
  next: PeakTransition | null,
  remaining: string | null,
): string | null {
  if (!next || !remaining) return null
  const label = bandLabel(next.band, plan)
  if (remaining === "now") return from === "discount" ? "ending now" : `${label} now`
  return from === "discount" ? `${remaining} left` : `${label} in ${remaining}`
}

const BAND_TONE: Record<PeakBand, string> = {
  premium: "bg-warning/70",
  discount: "bg-success/70",
  standard: "bg-muted-foreground/20",
}

/** The band's swatch, for the strip's legend. */
function Swatch({ band, label }: { band: PeakBand; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className={cn("size-1.5 rounded-full", BAND_TONE[band])} />
      {label}
    </span>
  )
}

/**
 * The next 24 hours as one bar on the reader's own clock — where the dear and
 * cheap stretches actually fall, without a table to read.
 *
 * Cut from the schedule's boundaries (`peakSpans`) rather than sampled, so a
 * window that opens at 09:30 is drawn at 09:30 and not in the 09:00 cell. The
 * bar starts at *now*, which is the reader's frame of reference — "six hours
 * from here" is what they are deciding about.
 */
function DayStrip({ plan, now }: { plan: PeakPlan; now: number }) {
  const end = now + STRIP_MS
  const spans = React.useMemo(() => peakSpans(plan, now, end), [plan, now, end])
  const ticks = [now, now + STRIP_MS / 4, now + STRIP_MS / 2, now + (STRIP_MS * 3) / 4, end]

  /* The bar's own words for its own colours. A strip with no legend asked the
     reader to infer which tone was which — and on an `off-peak` card the dear
     half is the *unshaded* one, which no amount of guessing gets right. */
  const legend: { band: PeakBand; label: string }[] =
    plan.when === "off-peak"
      ? [
          { band: "standard", label: "Listed price" },
          { band: "discount", label: "Off-peak" },
        ]
      : [
          { band: "premium", label: "Peak" },
          { band: "standard", label: "Off-peak" },
        ]

  return (
    <div className="space-y-1">
      <div className="flex h-2 w-full overflow-hidden rounded-full">
        {spans.map((span, i) => (
          <div
            key={i}
            className={cn("h-full", BAND_TONE[span.band])}
            style={{ width: `${((span.to - span.from) / STRIP_MS) * 100}%` }}
            title={`${localTime(span.from)}-${localTime(span.to)}`}
          />
        ))}
      </div>
      <div className="flex justify-between text-[10px] leading-none tabular-nums text-muted-foreground">
        {ticks.map((t, i) => (
          <span key={i}>{localTime(t)}</span>
        ))}
      </div>
      <div className="flex gap-3 pt-0.5 text-[10px] leading-none text-muted-foreground">
        {legend.map((entry) => (
          <Swatch key={entry.band} band={entry.band} label={entry.label} />
        ))}
      </div>
    </div>
  )
}

/**
 * The badge: what the listed price is doing at this hour, how far off the next
 * change is, and when the dear one next arrives.
 *
 * Drawn for the model the thread will actually prompt — the draft's pick, the
 * profile's default, and a started thread's `meta.model` are the same lookup
 * the config menu makes, so the two cannot disagree. A model with no `peak` at
 * all draws nothing: no schedule is not a schedule that is always cheap.
 */
export function PeakIndicator({ meta }: { meta?: SessionMeta }) {
  const profiles = useProfiles()
  const profile = meta ? profiles.find((p) => p.id === meta.profileId) : undefined
  const model = React.useMemo(() => {
    if (!profile) return undefined
    const id = meta?.model || profile.defaultModel
    return profile.models?.find((m) => m.id === id)
  }, [profile, meta?.model])

  const plan = React.useMemo(() => parsePeak(model?.peak), [model?.peak])
  const now = usePeakClock(plan)
  const [open, setOpen] = React.useState(false)

  if (!plan) return null
  const state = peakState(plan, now)

  /* The word the badge prints is **what the price is doing**, not which side of
     the schedule's windows the clock is on — those part company on an
     `off-peak` card, where the hours inside the window are the cheap ones and
     the badge used to call them Peak. `bandLabel` is that one decision. */
  const phase = bandLabel(state.band, plan)
  /* Tone: dear is a caution, a real discount is good news, and the ordinary
     side of a peak schedule is simply quiet — it does not deserve a colour for
     being what the row already says. */
  const tone =
    state.band === "premium"
      ? "text-warning"
      : state.band === "discount"
        ? "text-success"
        : "text-muted-foreground"
  const Icon =
    state.band === "premium" ? TrendingUpIcon : state.band === "discount" ? TrendingDownIcon : MoonIcon
  const effectiveLabel = multiplierLabel(state.multiplier)

  const listed = model?.pricing
  const effective = listed
    ? { input: listed.input * state.multiplier, output: listed.output * state.multiplier }
    : null

  /* The boundaries still ahead, in order: the next *change* (whatever it does)
     and the next time the price **rises** — the two questions a person about to
     spend money is asking. On a peak card the rise is a window opening; on an
     `off-peak` card it is one closing, so both are read off the band each edge
     opens rather than off its direction. */
  const transitions = upcomingTransitions(plan, now)
  const next = transitions[0] ?? null
  const rise = transitions.find((t) => t.dearer) ?? null
  /* What that rise is, in the reader's terms: on a peak card it is the dear hour
     arriving, and on an `off-peak` card it is the discount going away. */
  const riseVerb = rise ? (rise.band === "premium" ? "Next peak" : "Discount ends") : "Next peak"

  /* The distance to the next boundary — the one number that turns a reading
     into a decision, so it rides the face rather than being folded away. The
     verb comes with it: "1h 12m" alone left the reader guessing which way the
     schedule was about to bend, and the two directions call for opposite
     decisions. */
  const remaining = next ? durationLabel(next.at, now) : null
  const phrase = nextPhrase(plan, state.band, next, remaining)
  const verb = next ? changeVerb(state.band, next) : null
  /* `Peak pricing` and `Off-peak pricing` are the phases a card sells;
     `Listed price pricing` is not a sentence, so that one stands alone. */
  const heading = phase === "Listed price" ? "Listed price now" : `${phase} pricing now`

  /* The reader's own offset at the boundary, not at this instant: a schedule
     that changes at 04:00 UTC is read in whatever offset the reader will be in
     then, which is the whole point on the two days a year it differs. */
  const deviceClock = next ? localStamp(next.at) : null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            className={cn(READING_TRIGGER, tone)}
            title={`${heading} — ${effectiveLabel}${
              verb && remaining
                ? remaining === "now"
                  ? `, ${verb.toLowerCase()} now`
                  : `, ${verb.toLowerCase()} in ${remaining}`
                : ""
            }${rise && rise !== next ? ` · ${riseVerb.toLowerCase()} ${localStamp(rise.at)}` : ""}`}
          >
            <ReadingFace
              icon={<Icon className={READING_MARK} />}
              label={
                <>
                  {phase}
                  {phrase && (
                    <span className="ml-1 font-normal text-muted-foreground tabular-nums">
                      {phrase}
                    </span>
                  )}
                </>
              }
              /* A word for the bubble dress, not a number: the badge means
                 "which side of the schedule", and "+"/"−" alone read as a
                 price change rather than the phase. */
              after={
                <ReadingBubble>
                  {state.band === "premium" ? "P" : state.band === "discount" ? "O" : "L"}
                </ReadingBubble>
              }
            />
          </Button>
        }
      />
      <ReadingPopoverContent
        heading={heading}
        meta={effectiveLabel}
        side="top"
        className="w-80"
      >
        <p className="text-sm text-muted-foreground">
          {model?.label || model?.id}{" "}
          {state.multiplier === 1 ? (
            <>is billed at its listed price at this hour.</>
          ) : (
            <>
              bills at <span className={cn("font-medium", tone)}>{effectiveLabel}</span> at this hour.
            </>
          )}
        </p>

        {/* The question the badge raises is "when", so it is answered first and
            in the reader's own clock: the change that comes next, how far off it
            is, and the boundary it lands on here — with the schedule's own
            `04:00 UTC` folded one step below, to check against the provider's
            page. The cheap hour is what people are actually waiting for, so when
            the next change is *not* it, the next rise is named too — on a
            weekday-only card that is Monday morning, three days out. */}
        {next && remaining && verb ? (
          <div className="space-y-1 rounded-lg bg-muted/50 px-2.5 py-2 text-sm">
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-medium">{verb}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {remaining === "now" ? "now" : `in ${remaining}`}
              </span>
            </div>
            <div className="flex items-baseline justify-between gap-2 text-xs tabular-nums">
              <span className="font-medium text-foreground">{deviceClock}</span>
              <span className="text-muted-foreground">{clockLabel(next.at, plan.zone)}</span>
            </div>
            {rise && rise.at > next.at && (
              <div className="flex items-baseline justify-between gap-2 border-t border-border/60 pt-1 text-xs">
                <span className="text-muted-foreground">{riseVerb}</span>
                <span className="tabular-nums text-foreground">
                  {localStamp(rise.at)}
                  <span className="ml-1 text-muted-foreground">
                    in {durationLabel(rise.at, now)}
                  </span>
                </span>
              </div>
            )}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">No further change on this schedule.</p>
        )}

        {/* The shape of the next day, on the reader's clock, with its colours
            named. */}
        <div className="space-y-1.5 pt-1">
          <div className="flex items-baseline justify-between gap-2 text-xs text-muted-foreground">
            <span className="font-medium">Next 24 hours</span>
            <span className="truncate">{DEVICE_ZONE}</span>
          </div>
          <DayStrip plan={plan} now={now} />
        </div>

        <dl className="space-y-1 text-sm">
          {/* The zone the windows below are written in, said once above them
              rather than repeated in every label — the labels are the schedule's
              own words and the values are what those words are on this clock. */}
          <Row label="Schedule zone" muted>
            {zoneLabel(plan.zone)}
          </Row>
          {/* One row per window: the schedule's own words on the left, because
              that is the page it came from and the one thing worth checking it
              against — and **the hours it actually falls on here** on the right,
              which is the value the reader came for. Resolved from the window's
              own next run rather than shifted by a fixed offset, so a zone that
              keeps DST moves with the calendar and a window crossing local
              midnight says its weekday. A window in force now is the one bold
              row, marked `now` so the list cannot be read as all-future. */}
          {plan.windows.slice(0, 4).map((window, i) => {
            const run = windowRun(window, plan.zone, now)
            const active = windowInForce(window, plan.zone, now)
            return (
              <Row key={i} label={`${daysLabel(window.days)} ${windowLabel(window)}`} muted>
                {run ? (
                  <>
                    <span className={cn(active && "font-medium text-foreground")}>
                      {localSpan(run.start, run.end)}
                    </span>
                    {active && (
                      <span className="ml-1 text-xs font-normal text-muted-foreground">now</span>
                    )}
                  </>
                ) : (
                  "—"
                )}
              </Row>
            )
          })}
          <Row label="Your clock" muted>
            {DEVICE_ZONE}
            {deviceOffset(now) ? ` (${deviceOffset(now)})` : ""}
          </Row>
          {listed && effective && (
            <Row label="Per Mtok now">
              ${price(effective.input)} / ${price(effective.output)}
              <span className="ml-1 font-normal whitespace-nowrap text-muted-foreground">
                (listed ${price(listed.input)} / ${price(listed.output)})
              </span>
            </Row>
          )}
        </dl>
        <p className="text-xs text-muted-foreground">
          Billing follows when the request is processed, so a job started at the boundary can land
          either side of it.
        </p>
      </ReadingPopoverContent>
    </Popover>
  )
}
