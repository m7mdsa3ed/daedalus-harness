/* ── How fast a live answer is written out ──
   The pace half of the streaming reveal (`streamSpeed`, `lib/stream-pace`).
   What arriving looks like is not a choice: it is the sweep
   (`lib/stream-words`), and calm motion is its only off switch. Calm motion
   leaves the pace alone — pacing is when a word appears, not whether
   something animates. */
import { STREAM_SPEEDS, type StreamSpeed } from "@/lib/stream-pace"
import { cn } from "@/lib/utils"

/** Four points on one axis, so a segmented control. */
function SpeedRow({
  value,
  onChange,
}: {
  value: StreamSpeed
  onChange: (speed: StreamSpeed) => void
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Reveal speed"
      className="flex gap-0.5 rounded-lg bg-muted/50 p-0.5"
    >
      {STREAM_SPEEDS.map((speed) => {
        const selected = speed.id === value
        return (
          <button
            key={speed.id}
            type="button"
            role="radio"
            aria-checked={selected}
            title={speed.description}
            onClick={() => onChange(speed.id)}
            className={cn(
              "flex-1 rounded-[7px] px-2 py-1 text-[11px] font-medium transition-colors",
              selected
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {speed.label}
          </button>
        )
      })}
    </div>
  )
}

export function StreamSpeedPicker({
  speed,
  onSpeedChange,
}: {
  speed: StreamSpeed
  onSpeedChange: (speed: StreamSpeed) => void
}) {
  const active = STREAM_SPEEDS.find((entry) => entry.id === speed)
  return (
    <div className="flex flex-col gap-2.5 px-3 py-2.5">
      <div className="flex flex-col gap-0.5">
        <span className="text-xs leading-5 font-medium">Streaming speed</span>
        <span className="text-[11px] leading-4 text-balance text-muted-foreground">
          How fast a live answer is written out.
        </span>
      </div>
      <SpeedRow value={speed} onChange={onSpeedChange} />
      {active && (
        <p className="px-0.5 text-[11px] leading-4 text-balance text-muted-foreground/80">
          {active.description}
        </p>
      )}
    </div>
  )
}
