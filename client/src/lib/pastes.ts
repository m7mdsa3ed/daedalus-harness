/* ── Long pastes ──
   A four-thousand-line stack trace pasted into the composer is still exactly
   the prompt the user means to send. It just must not fill the screen while
   they type the sentence around it.

   So this is a *composer* affordance and nothing else: the body is parked in a
   device-local sidecar, a token (`[pasted text #1]`) goes into the text at the
   caret, and `expandPastes` puts the body back in place of the token on the way
   to `actions.send`. Everything downstream — the wire command, the queue row,
   the journal, the transcript, Retry, the prompt-history walk — sees the same
   string it always did. That is the point: the transcript says what was sent,
   including the pasted body, and a reload of a sent turn has nothing new to
   reconstruct.

   It sits BESIDE drafts.ts rather than inside it. `drafts.ts` persists a
   *string* and every one of its callers depends on that, so this is a second
   key (`ui.draft-pastes.<sessionId>`) with the same debounce, the same
   pagehide/visibilitychange flush and the same place in `refreshSessions`'s
   prune. */

/* Keyed by the session id the composer is already holding — see lib/drafts,
   whose storage half this is a copy of on purpose. */
const PREFIX = "ui.draft-pastes."

const storageKey = (sessionId: string): string => PREFIX + sessionId

const SAVE_DEBOUNCE_MS = 300

/** One parked paste. `n` is its number within this draft — monotonic, never
    reused, because renumbering would silently repoint a token the user has
    already moved somewhere in their sentence. */
export interface Paste {
  n: number
  text: string
  lines: number
  chars: number
}

/* The threshold is either/or, and both halves earn their place. A 40-line YAML
   file is under 1200 characters and is still the thing that must not eat the
   composer; a single 3,000-character minified line has no newlines at all.
   Below both, paste behaves as it always has and no chip appears — the feature
   has to be invisible for the pastes people actually make most often (a URL, an
   error message, a name). */
export const PASTE_MIN_CHARS = 1200
export const PASTE_MIN_LINES = 12

export const pasteToken = (n: number): string => `[pasted text #${n}]`

/** True when a pasted string is long enough to be worth parking. */
export function isLongPaste(text: string): boolean {
  return text.length >= PASTE_MIN_CHARS || countLines(text) >= PASTE_MIN_LINES
}

const countLines = (text: string): number => text.split("\n").length

/** Build the `Paste` for a body, numbered after everything already parked. */
export function mintPaste(existing: Paste[], text: string): Paste {
  const n = existing.reduce((max, paste) => Math.max(max, paste.n), 0) + 1
  return { n, text, lines: countLines(text), chars: text.length }
}

/* Markdown's own rule: a fence has to be longer than the longest run of
   backticks inside what it wraps. Pasted content is very often itself code
   containing triple backticks, and a fence that closes early turns the rest of
   the prompt into prose the agent reads as narration. */
function fenceFor(body: string): string {
  let longest = 0
  for (const run of body.matchAll(/`+/g)) longest = Math.max(longest, run[0].length)
  return "`".repeat(Math.max(3, longest + 1))
}

/**
 * Put every parked body back where its token sits.
 *
 * A paste whose token the user deleted is simply dropped — the chip is a view
 * of a token, and a body with no token is a claim the composer cannot honour.
 * Nothing is prepended to the block: a `<pasted text>` pseudo-tag is a shape
 * the agent has to be taught, where a fence is one it already knows.
 */
export function expandPastes(text: string, pastes: Paste[]): string {
  let out = text
  for (const paste of pastes) {
    const token = pasteToken(paste.n)
    if (!out.includes(token)) continue
    const fence = fenceFor(paste.text)
    out = out.split(token).join(`\n${fence}pasted-text #${paste.n}\n${paste.text}\n${fence}\n`)
  }
  return out
}

/** The pastes whose tokens are still in the text — what the chip row draws. */
export function livePastes(text: string, pastes: Paste[]): Paste[] {
  return pastes.filter((paste) => text.includes(pasteToken(paste.n)))
}

/** Remove a paste and its token in one move: the two are one thing. */
export function dropPaste(text: string, pastes: Paste[], n: number): { text: string; pastes: Paste[] } {
  return {
    text: text.split(pasteToken(n)).join(""),
    pastes: pastes.filter((paste) => paste.n !== n),
  }
}

// ---- storage ----

/* Read-through buffer and debounce, exactly as drafts.ts: the composer writes
   on every keystroke and a localStorage write is synchronous on the main
   thread, while a load or a clear inside the window must see what was just
   typed rather than what last reached disk. */
const pending = new Map<string, Paste[]>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()

function write(key: string, pastes: Paste[]): void {
  try {
    if (pastes.length > 0) localStorage.setItem(storageKey(key), JSON.stringify(pastes))
    else localStorage.removeItem(storageKey(key))
  } catch {
    // A full or blocked storage costs the sidecar, never the message: the token
    // stays in the text, and an unresolved token expands to nothing.
  }
}

function flushPastes(): void {
  for (const timer of timers.values()) clearTimeout(timer)
  timers.clear()
  for (const [key, pastes] of pending) write(key, pastes)
  pending.clear()
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushPastes)
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushPastes()
  })
}

const isPaste = (value: unknown): value is Paste =>
  !!value &&
  typeof value === "object" &&
  typeof (value as Paste).n === "number" &&
  typeof (value as Paste).text === "string"

export function loadPastes(key: string): Paste[] {
  const buffered = pending.get(key)
  if (buffered !== undefined) return buffered
  try {
    const raw = localStorage.getItem(storageKey(key))
    if (raw === null) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isPaste).map((paste) => ({
      n: paste.n,
      text: paste.text,
      lines: paste.lines ?? countLines(paste.text),
      chars: paste.chars ?? paste.text.length,
    }))
  } catch {
    return []
  }
}

export function savePastes(key: string, pastes: Paste[]): void {
  pending.set(key, pastes)
  const timer = timers.get(key)
  if (timer) clearTimeout(timer)
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key)
      const buffered = pending.get(key)
      pending.delete(key)
      if (buffered !== undefined) write(key, buffered)
    }, SAVE_DEBOUNCE_MS)
  )
}

/** Immediate, not debounced — it rides a send, exactly as `clearDraft` does. */
export function clearPastes(key: string): void {
  const timer = timers.get(key)
  if (timer) {
    clearTimeout(timer)
    timers.delete(key)
  }
  pending.delete(key)
  write(key, [])
}

/** Drop sidecars for sessions the server no longer lists — same contract as
    `pruneDrafts`. */
export function prunePastes(sessionIds: Iterable<string>): void {
  const live = new Set(sessionIds)
  for (const key of [...pending.keys()]) {
    if (live.has(key)) continue
    pending.delete(key)
    const timer = timers.get(key)
    if (timer) {
      clearTimeout(timer)
      timers.delete(key)
    }
  }
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(PREFIX) && !live.has(key.slice(PREFIX.length))) {
        localStorage.removeItem(key)
      }
    }
  } catch {
    // Nothing to prune if storage is unavailable.
  }
}
