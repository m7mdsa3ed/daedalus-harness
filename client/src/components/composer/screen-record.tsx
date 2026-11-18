import * as React from "react"

import { ScreenShare } from "lucide-react"

import { ComposerStripItem, SHELF_PAD } from "@/components/composer-strip"
import { Button } from "@/components/ui/button"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { formatBytes } from "@/lib/attachments"
import { useComposerPrefs } from "@/lib/composer-prefs"
import { canEditRecording, editRecording, settledDuration } from "@/lib/edit-recording"
import { qualityBits } from "@/lib/screen-record-options"
import { toast } from "@/lib/toast"
import { cn } from "@/lib/utils"

function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`
}

/* While a recording runs, the shelf says so: the browser's own "sharing" bar
   is easy to miss (and absent on some surfaces), and the only other sign was
   the key's pulse. Elapsed time and the share of the attachment cap used tell
   the reader how long they have before it stops itself. */
export function ScreenRecordingRow({
  startedAt,
  bytes,
  budget,
  onStop,
}: {
  startedAt: number | null
  bytes: number
  budget: number
  onStop: () => void
}) {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    if (startedAt === null) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(timer)
  }, [startedAt])
  if (startedAt === null) return null
  const used = Math.min(100, Math.round((bytes / budget) * 100))
  return (
    <ComposerStripItem
      summary={{ id: "screen-recording", icon: ScreenShare, label: "Recording screen", urgent: true }}
      className={cn(SHELF_PAD, "py-2")}
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center gap-3 text-xs">
        <span className="relative flex size-2.5 shrink-0" aria-hidden>
          <span className="absolute inset-0 animate-ping rounded-full bg-destructive/60 motion-reduce:animate-none" />
          <span className="relative size-2.5 rounded-full bg-destructive" />
        </span>
        <span className="font-medium">Recording screen</span>
        <span className="tabular-nums text-muted-foreground">{clock(now - startedAt)}</span>
        <span
          className="hidden h-1 w-20 overflow-hidden rounded-full bg-muted @panel-sm:block"
          title={`${formatBytes(bytes)} of ${formatBytes(budget)}`}
          aria-hidden
        >
          <span className="block h-full bg-destructive/70 transition-[width]" style={{ width: `${used}%` }} />
        </span>
        <Button variant="ghost" size="xs" className="ms-auto pointer-coarse:h-8" onClick={onStop}>
          Stop
        </Button>
      </div>
    </ComposerStripItem>
  )
}

/* A finished screen recording is watched before it is attached
   (`hooks/use-screen-record.ts` holds it as `review`). Closing the dialog any
   other way than Attach discards it: a recording nobody approved never reaches
   the message. It can also be edited here — trimmed to a range and muted
   (`lib/edit-recording.ts`) — and an edit replaces the take under review, still
   unattached, so the reader watches the result before it goes. */
export function ScreenRecordReview({
  file,
  onAccept,
  onDiscard,
  onRetake,
  onEdited,
}: {
  file: File | null
  onAccept: () => void
  onDiscard: () => void
  onRetake?: () => void
  onEdited?: (file: File) => void
}) {
  return (
    <ResponsiveDialog open={file !== null} onOpenChange={(open) => !open && onDiscard()}>
      <ResponsiveDialogContent className="sm:max-w-2xl">
        {/* Keyed on the file: a new take starts with a clean range. */}
        {file && (
          <ReviewBody
            key={`${file.name}:${file.size}:${file.lastModified}`}
            file={file}
            onAccept={onAccept}
            onDiscard={onDiscard}
            onRetake={onRetake}
            onEdited={onEdited}
          />
        )}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

function ReviewBody({
  file,
  onAccept,
  onDiscard,
  onRetake,
  onEdited,
}: {
  file: File
  onAccept: () => void
  onDiscard: () => void
  onRetake?: () => void
  onEdited?: (file: File) => void
}) {
  const prefs = useComposerPrefs()
  const url = React.useMemo(() => URL.createObjectURL(file), [file])
  React.useEffect(() => () => URL.revokeObjectURL(url), [url])

  const videoRef = React.useRef<HTMLVideoElement>(null)
  const abortRef = React.useRef<AbortController | null>(null)
  const [duration, setDuration] = React.useState<number | null>(null)
  const [range, setRange] = React.useState<[number, number]>([0, 0])
  const [mute, setMute] = React.useState(false)
  const [progress, setProgress] = React.useState<number | null>(null)
  const editable = Boolean(onEdited) && canEditRecording()
  const busy = progress !== null

  React.useEffect(() => () => abortRef.current?.abort(), [])

  const onMeta = async () => {
    const video = videoRef.current
    if (!video || !editable) return
    const found = await settledDuration(video)
    if (!Number.isFinite(found) || found <= 0) return
    setDuration(found)
    setRange([0, found])
  }

  // The preview plays only the kept part, so what is watched is what is made.
  const onTime = () => {
    const video = videoRef.current
    if (!video || duration === null) return
    if (video.currentTime >= range[1] - 0.05 && !video.paused) {
      video.pause()
      video.currentTime = range[0]
    }
  }
  const onPlay = () => {
    const video = videoRef.current
    if (!video || duration === null) return
    if (video.currentTime < range[0] || video.currentTime >= range[1] - 0.05) video.currentTime = range[0]
  }
  const seekTo = (seconds: number) => {
    const video = videoRef.current
    if (video) video.currentTime = seconds
  }

  const trimmed = duration !== null && (range[0] > 0.05 || range[1] < duration - 0.05)
  const changed = trimmed || mute
  const kept = duration === null ? null : range[1] - range[0]

  const apply = async () => {
    if (!onEdited || duration === null) return
    videoRef.current?.pause()
    const controller = new AbortController()
    abortRef.current = controller
    setProgress(0)
    try {
      const edited = await editRecording(
        file,
        { start: range[0], end: range[1], mute },
        { bitsPerSecond: qualityBits(prefs.screenQuality), signal: controller.signal, onProgress: setProgress }
      )
      onEdited(edited)
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        toast.error(error instanceof Error ? error.message : "Editing failed")
      }
    } finally {
      abortRef.current = null
      setProgress(null)
    }
  }

  return (
    <>
      <ResponsiveDialogHeader>
        <ResponsiveDialogTitle>Review screen recording</ResponsiveDialogTitle>
        <ResponsiveDialogDescription>
          {`${formatBytes(file.size)} \u00b7 attached only if you choose Attach`}
        </ResponsiveDialogDescription>
      </ResponsiveDialogHeader>
      <video
        ref={videoRef}
        key={url}
        src={url}
        controls
        autoPlay
        playsInline
        muted={mute}
        onLoadedMetadata={onMeta}
        onTimeUpdate={onTime}
        onPlay={onPlay}
        className="max-h-[60svh] w-full rounded-md bg-black"
      />
      {editable && duration !== null && (
        <div className="flex flex-col gap-3 text-xs">
          <div className="flex items-center justify-between gap-3">
            <span className="font-medium">Trim</span>
            <span className="tabular-nums text-muted-foreground">
              {clock(range[0] * 1000)} to {clock(range[1] * 1000)} ({clock((kept ?? 0) * 1000)} kept)
            </span>
          </div>
          <Slider
            min={0}
            max={duration}
            step={0.1}
            minStepsBetweenValues={1}
            value={range}
            disabled={busy}
            aria-label="Trim range"
            onValueChange={(value) => {
              const next = value as number[]
              if (next.length !== 2) return
              // Show the edge being dragged, so the cut point can be judged.
              seekTo(next[0] !== range[0] ? next[0] : next[1])
              setRange([next[0], next[1]])
            }}
          />
          <label className="flex items-center justify-between gap-3">
            <span>
              <span className="font-medium">Mute audio</span>
              <span className="ms-2 text-muted-foreground">Drop the sound from the clip</span>
            </span>
            <Switch size="sm" checked={mute} onCheckedChange={setMute} disabled={busy} />
          </label>
          {busy && (
            <div className="h-1 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={Math.round((progress ?? 0) * 100)}>
              <span className="block h-full bg-primary transition-[width]" style={{ width: `${(progress ?? 0) * 100}%` }} />
            </div>
          )}
          <div className="flex items-center justify-between gap-3 text-muted-foreground">
            <span>Editing re-records the clip, so it takes as long as the part you keep.</span>
            {busy ? (
              <Button variant="ghost" size="xs" onClick={() => abortRef.current?.abort()}>
                Cancel
              </Button>
            ) : (
              <Button variant="secondary" size="xs" disabled={!changed || (kept ?? 0) < 0.2} onClick={() => void apply()}>
                Apply edit
              </Button>
            )}
          </div>
        </div>
      )}
      <ResponsiveDialogFooter>
        <Button variant="ghost" onClick={onDiscard} disabled={busy}>
          Discard
        </Button>
        {onRetake && (
          <Button variant="secondary" onClick={onRetake} disabled={busy}>
            Record again
          </Button>
        )}
        <Button onClick={onAccept} disabled={busy || (changed && editable)}>
          {changed && editable ? "Apply edit first" : "Attach"}
        </Button>
      </ResponsiveDialogFooter>
    </>
  )
}
