/* ── Paced reveal ──
   Smooth the transcript's streaming prose out of the shape the wire delivers it
   in.

   A turn's text does not arrive at a human rate. `agent_message_chunk`s land in
   bursts — a gateway buffering a second of tokens, a `session/load` replay, a
   reasoning model going quiet and then emitting a paragraph at once — and the
   reducer appends each one whole, so the tail item's markdown re-renders with a
   step change in it. What that reads as on screen is a stutter: nothing, then a
   sentence, then nothing, with the scroll pin (`use-follow-stream`) jumping the
   same distance in one frame.

   So the *arrival* rate and the *reveal* rate are separated. Chunks keep landing
   in the store the moment they arrive — nothing here touches the transcript, the
   journal, copy, search or the sources strip, all of which still read the whole
   text — and only what is painted is drained out of that buffer on a rAF at a
   rate the eye can follow.

   Three rules make it safe to put in front of a live transcript:

   • **Only the streaming tail is paced.** Settled text, replayed history and any
     row that is not the one being written snap to their full text with no
     animation frame ever scheduled — a paced replay would redraw yesterday's
     thread as a typewriter.
   • **It can lag, but only a little.** The drain is exponential (a fixed
     fraction of the backlog per frame), so a big burst empties fast and a
     trickle stays smooth, and anything past `SNAP_CHARS` behind is not a stream
     at all — a whole message arriving at once — and is shown immediately.
     Combined with the floor of one character per frame, the buffer is
     guaranteed to reach the end rather than asymptotically approach it.
   • **The cut lands on a boundary.** Revealing markdown mid-token means
     `**bo` renders as literal asterisks and then reflows into bold a frame
     later, which is a worse flicker than the stutter this replaces. The visible
     slice is therefore backed off to the last whitespace unless the text ends
     there anyway, so a word — and with it `**bold**`, `` `code` `` and a bare
     URL — appears whole or not at all. Monotonic by construction: the revealed
     length never goes backwards while the text keeps growing. */
import * as React from "react"

/** Fraction of the remaining backlog drained per frame at 60fps. Low enough to
 *  read as motion rather than as a jump, high enough that a paragraph-sized
 *  burst is gone in a few hundred milliseconds. */
const DRAIN_PER_FRAME = 0.14

/** Never slower than this, whatever the backlog — what makes the tail finish. */
const MIN_CHARS_PER_FRAME = 1

/** Past this far behind, it is not a stream: show it. A `session/load` replay
 *  and a buffered gateway both deliver a whole answer in one update, and pacing
 *  that is a typewriter nobody asked for. */
const SNAP_CHARS = 1200

/** Assumed frame budget, used to keep the drain frame-rate independent. */
const FRAME_MS = 16.7

/** Back the cut off to the last whitespace, so a token is never split. Returns
 *  `n` unchanged when the text ends there — the last word of a settled message
 *  must not be withheld forever — or when there is no boundary to back off to. */
function boundary(text: string, n: number): number {
  if (n >= text.length) return text.length
  if (/\s/.test(text[n]!)) return n
  const cut = text.lastIndexOf(" ", n)
  const line = text.lastIndexOf("\n", n)
  return Math.max(cut, line, 0)
}

/**
 * The portion of `text` that should be painted this frame.
 *
 * `streaming` is the row's own flag (thread-view sets it on the transcript's
 * tail while the turn is active) — false means "this is finished or is
 * history", and the full text is returned with no scheduling at all.
 */
export function useStreamedText(text: string, streaming: boolean): string {
  const [shown, setShown] = React.useState(text)
  /* The loop reads these: it runs per frame, far more often than React renders,
     and a stale closure would pace a message the row has already moved past. */
  const textRef = React.useRef(text)
  const lenRef = React.useRef(text.length)
  textRef.current = text

  React.useEffect(() => {
    if (!streaming) {
      lenRef.current = text.length
      setShown(text)
      return
    }
    /* A row that was replaced rather than appended to — a new message, a
       re-fold, an edited draft — has nothing in common with what is on screen,
       so there is no reveal to continue. */
    if (!text.startsWith(shown)) {
      lenRef.current = text.length
      setShown(text)
      return
    }

    let frame = 0
    let last = performance.now()
    const step = (now: number) => {
      frame = 0
      const full = textRef.current
      const remaining = full.length - lenRef.current
      if (remaining <= 0) return
      if (remaining > SNAP_CHARS) {
        lenRef.current = full.length
        setShown(full)
        return
      }
      /* Scaled by elapsed time so a background tab or a 120Hz display drains at
         the same rate per second as a 60Hz one. */
      const frames = Math.max(1, Math.min(8, (now - last) / FRAME_MS))
      last = now
      const advance = Math.max(
        MIN_CHARS_PER_FRAME * frames,
        remaining * DRAIN_PER_FRAME * frames
      )
      lenRef.current = Math.min(full.length, lenRef.current + Math.ceil(advance))
      const next = full.slice(0, boundary(full, lenRef.current))
      // Only a whole word crossed is a render: mid-word frames change nothing
      // on screen, and the tail item is the one component that runs a real
      // markdown parse.
      setShown((prev) => (next.length > prev.length ? next : prev))
      frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
    // `shown` is deliberately not a dependency beyond the identity test above:
    // the loop advances it, and re-running per revealed word would restart the
    // frame clock on every one of them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming, text])

  return streaming ? shown : text
}
