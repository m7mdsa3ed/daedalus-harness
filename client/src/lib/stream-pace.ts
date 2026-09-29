/* ── The pace of the reveal ──
   `lib/stream-words` decides what a word's arrival *looks* like;
   `hooks/use-streamed-text` decides *when* it arrives. This is the one knob on
   the second of those, split out so both the pacer and the view-option store
   can name it without either importing the other's file.

   It exists because the picker used to say "the pacing is the same either way",
   which was true and was also the complaint: how fast an answer is revealed is
   a reading preference and nothing else. A reader who skims wants the words the
   moment they land; a reader who follows along wants them at the rate they read
   at. Neither is a default the app can pick for them.

   The values are a fraction of the remaining backlog drained per frame, which
   is what makes the reveal exponential rather than a typewriter: a burst empties
   fast and a trickle stays smooth at every setting (see the hook for why that
   shape, and for the floor that guarantees the tail finishes).

   `instant` is not a slow speed, it is the absence of one — the buffer is
   bypassed and the painted text is the arrived text. It is deliberately a speed
   and not a switch: "no pacing" and calm motion's plain reveal are different
   answers to different questions. */

/** Fraction of the remaining backlog drained per frame at 60fps, per speed.
 *  `null` means no pacing at all. */
export const STREAM_SPEEDS: {
  id: StreamSpeed
  label: string
  /** The pacer's drain fraction, or `null` to bypass the buffer entirely. */
  drain: number | null
  description: string
}[] = [
  {
    id: "gentle",
    label: "Gentle",
    drain: 0.07,
    description: "Words land at about the rate they are read at. The calmest of these to follow.",
  },
  {
    id: "natural",
    label: "Natural",
    drain: 0.14,
    description: "The default: fast enough to keep up with a model, slow enough to read along.",
  },
  {
    id: "quick",
    label: "Quick",
    drain: 0.3,
    description: "Barely behind the wire. A burst is gone in a couple of frames.",
  },
  {
    id: "instant",
    label: "Instant",
    drain: null,
    description:
      "No pacing at all — text is painted the moment it arrives, in whatever shape the wire delivered it. The reveal still marks what is new.",
  },
]

export type StreamSpeed = "gentle" | "natural" | "quick" | "instant"

const IDS = new Set<string>(STREAM_SPEEDS.map((speed) => speed.id))

export function isStreamSpeed(value: unknown): value is StreamSpeed {
  return typeof value === "string" && IDS.has(value)
}

/** The drain fraction for a speed, or `null` when it is `instant`. Falls back to
 *  the default's rather than throwing: this is read every frame, and a stored
 *  value that survived a rename must not stop the transcript painting. */
export function drainFor(speed: StreamSpeed): number | null {
  const found = STREAM_SPEEDS.find((entry) => entry.id === speed)
  return found ? found.drain : 0.14
}
