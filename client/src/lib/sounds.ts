/* ── Thread event cues ──
   A short synthesized tone per thread event: Web Audio oscillators, so there is
   no asset to ship. Called from `notifyThreadEvent`, which owns whether an
   event is announced at all; this module only knows how each one sounds.

   Browsers keep an AudioContext suspended until a user gesture, so the context
   is created lazily and resumed on the first pointer or key press. A cue that
   arrives before any gesture is silently dropped — the toast still says it. */
import type { ThreadEvent } from "./notifications"

/** Step-level cues: quieter and shorter than the event ones, because a turn can
    run dozens of tool calls. */
export type Cue = ThreadEvent | "toolStarted" | "toolFailed"

/** Notes as [frequency Hz, start offset s]. Rising = done, falling = failed,
    a repeated high ping = the agent is waiting on you. */
const CUES: Record<Cue, [number, number][]> = {
  turnFinished: [[660, 0], [880, 0.09]],
  turnFailed: [[330, 0], [220, 0.14]],
  permissionNeeded: [[988, 0], [988, 0.16]],
  questionAsked: [[784, 0], [988, 0.1]],
  toolStarted: [[1320, 0]],
  toolFailed: [[262, 0]],
}

const QUIET: Partial<Record<Cue, number>> = { toolStarted: 0.035, toolFailed: 0.07 }

const NOTE_S = 0.18
const VOLUME = 0.12

let ctx: AudioContext | null = null
// ponytail: one global gap, so a burst of parallel tool calls is one tick, not a buzz.
const MIN_GAP_S = 0.08
let lastAt = -Infinity

function context(): AudioContext | null {
  if (typeof AudioContext === "undefined") return null
  ctx ??= new AudioContext()
  return ctx
}

/** Unlock audio on the first gesture. Called once from main.tsx. */
export function installSoundUnlock(): void {
  const unlock = () => void context()?.resume()
  window.addEventListener("pointerdown", unlock, { once: true, capture: true })
  window.addEventListener("keydown", unlock, { once: true, capture: true })
}

export function playCue(cue: Cue): void {
  const audio = context()
  if (!audio || audio.state !== "running") return
  const now = audio.currentTime
  const step = cue in QUIET
  if (step) {
    if (now - lastAt < MIN_GAP_S) return
    lastAt = now
  }
  const volume = QUIET[cue] ?? VOLUME
  const length = step ? 0.07 : NOTE_S
  for (const [freq, offset] of CUES[cue]) {
    const osc = audio.createOscillator()
    const gain = audio.createGain()
    osc.type = "sine"
    osc.frequency.value = freq
    // A quick attack and exponential decay, so the note is a chime, not a click.
    const t = now + offset
    gain.gain.setValueAtTime(0.0001, t)
    gain.gain.exponentialRampToValueAtTime(volume, t + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + length)
    osc.connect(gain).connect(audio.destination)
    osc.start(t)
    osc.stop(t + length + 0.02)
  }
}
