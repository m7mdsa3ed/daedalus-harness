/* ── A voice call with one thread ──
   The realtime model (OpenAI Realtime or Gemini Live) talks with the person and
   reaches the thread only through the composer's own doors: `actions.send`,
   `actions.stop`, and the pending permission's `resolve`. Its tools are declared
   and bound into the token server-side (`server/src/voice.ts`); they run here.

   `wait_for_agent` is the long one: it returns nothing, which leaves the call
   open, and the effect below answers it with `addToolOutput` when the turn ends
   or the agent stops to ask — so a permission reaches the person instead of
   waiting behind the turn it blocks.

   Lazy: the provider packages ride this chunk, so a thread with no call never
   pays for them. Finished lines are journaled as `_daedalus/voice` rows; the
   live caption is this card's alone. */
import * as React from "react"
import { experimental_useRealtime as useRealtime } from "@ai-sdk/react"
import { openai } from "@ai-sdk/openai"
import { google } from "@ai-sdk/google"
import { Hand, Mic, MicOff, PhoneOff } from "lucide-react"
import type * as acp from "@daedalus/acp"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { ErrorNote } from "@/components/error-note"
import type { Actions } from "@/lib/actions"
import { elicitationFields, isFormElicitation } from "@/lib/elicitation"
import { captureError, type InlineError } from "@/lib/errors"
import { api, type ServerSettings } from "@/lib/settings"
import type { ThreadState } from "@/lib/store"
import type { VoiceProvider } from "@/lib/queries/voice"
import { endVoiceCall, voiceCallLost } from "@/lib/voice-call"

const MAX_ANSWER = 4000

/* The browser captures at 24 kHz, but Gemini's mapper labels every chunk
   `rate=16000` unless the session says otherwise — so Gemini heard the person
   at two-thirds speed, transcribed noise, and the call sat on "Listening".
   Saying the real rate is the whole fix. OpenAI is left alone: its token
   already carries its format, and a partial `session.update` touching
   `audio.input` is not worth the risk. Module-level, because the hook rebuilds
   its session whenever `sessionConfig` changes identity. */
const GOOGLE_SESSION = { inputAudioFormat: { type: "audio/pcm", rate: 24000 } } as const

/** What the agent said since `from`, fences folded — the voice model is told
    never to read code aloud, and a fence it never receives it cannot read. */
function answerSince(thread: ThreadState, from: number): string {
  const text = thread.items
    .slice(from)
    .filter((i) => i.kind === "agent" && !i.parentId)
    .map((i) => ("text" in i ? i.text : ""))
    .join("\n\n")
    .replace(/```[\s\S]*?(```|$)/g, "[a block of code or a drawn view]")
  return text.length > MAX_ANSWER ? `${text.slice(0, MAX_ANSWER)}…` : text
}

/** The last path segment — a long path read aloud is noise. */
const base = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path
const short = (text: string, max = 80) => (text.length > max ? `${text.slice(0, max)}…` : text)

/** What a permission is about, short enough to say: the tool, and its file or command. */
function permissionTarget(call: acp.ToolCallUpdate): { tool: string; target?: string } {
  const input = (call.rawInput ?? {}) as Record<string, unknown>
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : undefined)
  const path = str("file_path") ?? str("path") ?? call.locations?.[0]?.path
  const target = path ? base(path) : (str("command") ?? str("url") ?? str("pattern"))
  return { tool: call.title ?? call.kind ?? "a tool call", ...(target ? { target: short(target) } : {}) }
}

/** An elicitation answered by voice: one field, said in words. Anything else
    (several questions, a link) stays on screen. */
function elicitationReply(
  request: acp.CreateElicitationRequest,
  answer: string
): { content: Record<string, acp.ElicitationContentValue> } | { error: string } {
  const screen = { error: "That question needs the screen; ask the user to answer it there." }
  if (!isFormElicitation(request)) return screen
  const fields = elicitationFields(request.requestedSchema)
  if (fields.length !== 1) return screen
  const field = fields[0]
  const said = answer.trim()
  if (!said) return { error: "No answer given." }
  const pick = (text: string) => {
    const t = text.trim().toLowerCase()
    return field.options.find((o) => o.value.toLowerCase() === t || o.label.toLowerCase() === t)
  }
  const choices = `Pick one of: ${field.options.map((o) => o.label).join(", ")}.`
  switch (field.kind) {
    case "select": {
      const option = pick(said)
      if (option) return { content: { [field.key]: option.value } }
      return field.customKey ? { content: { [field.customKey]: said } } : { error: choices }
    }
    case "multiselect": {
      const parts = said.split(/,|\band\b/i).map((p) => p.trim()).filter(Boolean)
      const picked = parts.map(pick)
      if (picked.every(Boolean)) return { content: { [field.key]: picked.map((o) => o!.value) } }
      return field.customKey ? { content: { [field.customKey]: said } } : { error: choices }
    }
    case "boolean":
      return { content: { [field.key]: /^(y|yes|yeah|true|ok|sure|allow)/i.test(said) } }
    case "number": {
      const n = Number(said)
      return Number.isFinite(n) ? { content: { [field.key]: n } } : { error: "That is not a number." }
    }
    default:
      return { content: { [field.key]: said } }
  }
}

/** Where the agent stands, as the voice model is told it. */
function describe(thread: ThreadState, from: number) {
  const permission = thread.permissions[0]
  if (permission) return { state: "needs_permission", ...permissionTarget(permission.request.toolCall) }
  const elicitation = thread.elicitations[0]
  if (elicitation) {
    return {
      state: "asking_a_question",
      question: elicitation.request.message,
      note: "Put it to the user, then call answer_question with their words. If that says it needs the screen, tell them to answer on screen.",
    }
  }
  if (thread.turnActive || thread.queue.length > 0) return { state: "working" }
  return { state: "idle", answer: answerSince(thread, from) || "(no answer text)" }
}

/** Identifies the pending ask, so a proactive update says it once. */
const askKey = (thread: ThreadState) => thread.permissions[0]?.requestId ?? thread.elicitations[0]?.requestId

/** Five bars; the speed says what the call is doing, and nothing moves when it
    is idle or the reader prefers reduced motion (`.voice-bar`, index.css). */
function Wave({ mode }: { mode: "speaking" | "listening" | "idle" }) {
  return (
    <div className="flex h-6 items-center gap-0.5" aria-hidden>
      {[0, 1, 2, 3, 4].map((i) => (
        <span
          key={i}
          className={cn("voice-bar h-full w-1 origin-center rounded-full", mode === "idle" ? "bg-muted-foreground/40" : "bg-primary")}
          style={{
            transform: "scaleY(0.2)",
            ...(mode === "idle"
              ? { animation: "none" }
              : { "--d": mode === "speaking" ? "0.55s" : "1.6s", animationDelay: `${i * (mode === "speaking" ? 0.09 : 0.25)}s` }),
          } as React.CSSProperties}
        />
      ))}
    </div>
  )
}

export function VoiceCall({
  sessionId,
  thread,
  actions,
  settings,
  provider,
  draft = false,
}: {
  sessionId: string
  thread: ThreadState
  actions: Actions
  settings: ServerSettings
  provider: VoiceProvider
  /** The thread is still an unsent draft with no server row. Lines are held
      and posted, in order, once it is sent (the first `send_to_agent`). */
  draft?: boolean
}) {
  const [error, setError] = React.useState<InlineError | null>(null)
  const [caption, setCaption] = React.useState("")
  const [waiting, setWaiting] = React.useState(false)
  const [ptt, setPtt] = React.useState(false)
  const pttTimer = React.useRef<ReturnType<typeof setTimeout>>(undefined)

  /* The tools run long after the render they were made in; they read these. */
  const threadRef = React.useRef(thread)
  threadRef.current = thread
  const sentFrom = React.useRef(thread.items.length)
  const sawTurn = React.useRef(false)
  const waitCall = React.useRef<string | null>(null)
  /* The voice sent something and has not been told how it ended; the asks
     already put to the person (a permission or question is told once). */
  const owed = React.useRef(false)
  const told = React.useRef(new Set<string>())
  const held = React.useRef<{ voiceId: string; role: "user" | "assistant"; text: string }[]>([])

  const model = React.useMemo(
    () =>
      provider.provider === "openai"
        ? openai.experimental_realtime(provider.model)
        : google.experimental_realtime(provider.model),
    [provider.provider, provider.model]
  )
  /* The hook fetches this itself with no Authorization header, so the bearer
     rides `?token=` the way a socket's does. */
  const apiConfig = React.useMemo(() => {
    const url = new URL("/api/voice/setup", settings.url)
    url.searchParams.set("token", settings.token)
    url.searchParams.set("provider", provider.provider)
    url.searchParams.set("sessionId", sessionId)
    return { token: url.toString() }
  }, [settings.url, settings.token, provider.provider, sessionId])

  const postLine = React.useCallback(
    (line: { voiceId: string; role: "user" | "assistant"; text: string }) => {
      api(settings, `/api/sessions/${sessionId}/voice`, { method: "POST", body: JSON.stringify(line) }).catch((err) =>
        setError(captureError(err, "Couldn't save a voice line"))
      )
    },
    [settings, sessionId]
  )
  /* A draft has no row, so its lines would 404: hold them until it is sent. */
  const saveLine = React.useCallback(
    (voiceId: string, role: "user" | "assistant", text: string) => {
      if (!text.trim()) return
      if (draft) held.current.push({ voiceId, role, text })
      else postLine({ voiceId, role, text })
    },
    [draft, postLine]
  )
  React.useEffect(() => {
    if (draft) return
    for (const line of held.current.splice(0)) postLine(line)
  }, [draft, postLine])

  /* A status handed to the model (by a tool or the parked wait) is told: the
     result is no longer owed, and its ask is not announced again. */
  const settleTold = React.useCallback((thread: ThreadState, state: string) => {
    if (state === "idle") owed.current = false
    const key = askKey(thread)
    if (key) told.current.add(key)
  }, [])

  const onToolCall = React.useCallback(
    async ({ toolCall }: { toolCall: { toolCallId: string; toolName: string; args: unknown } }) => {
      const now = threadRef.current
      const args = (toolCall.args ?? {}) as { text?: string; allow?: boolean; answer?: string }
      switch (toolCall.toolName) {
        case "send_to_agent": {
          if (!args.text?.trim()) return { error: "Nothing to send." }
          sentFrom.current = now.items.length
          sawTurn.current = false
          owed.current = true
          try {
            await actions.send(sessionId, args.text)
            return { sent: true }
          } catch (err) {
            return { error: captureError(err, "Voice send failed")?.text ?? "The send failed." }
          }
        }
        case "wait_for_agent": {
          const status = describe(now, sentFrom.current)
          if (status.state !== "working" && (sawTurn.current || status.state !== "idle")) {
            settleTold(now, status.state)
            return status
          }
          if (status.state === "idle" && !sawTurn.current && now.items.length === sentFrom.current) {
            return { state: "idle", answer: "Nothing has been sent to the agent yet." }
          }
          waitCall.current = toolCall.toolCallId
          setWaiting(true)
          return undefined
        }
        case "answer_request": {
          const permission = now.permissions[0]
          if (!permission) return { error: "Nothing is waiting for an answer." }
          const options = permission.request.options
          const option =
            options.find((o) => o.kind === (args.allow ? "allow_once" : "reject_once")) ??
            options.find((o) => o.kind.startsWith(args.allow ? "allow" : "reject"))
          if (!option) return { error: `The agent offered no way to ${args.allow ? "allow" : "deny"} it.` }
          permission.resolve({ outcome: { outcome: "selected", optionId: option.optionId } })
          return { answered: args.allow ? "allowed once" : "denied" }
        }
        case "answer_question": {
          const elicitation = now.elicitations[0]
          if (!elicitation) return { error: "No question is waiting for an answer." }
          const reply = elicitationReply(elicitation.request, args.answer ?? "")
          if ("error" in reply) return reply
          elicitation.resolve({ action: "accept", content: reply.content })
          return { answered: true }
        }
        case "stop_agent":
          await actions.stop(sessionId)
          return { stopped: true }
        case "agent_status":
          return describe(now, sentFrom.current)
      }
      return { error: `Unknown tool ${toolCall.toolName}` }
    },
    [actions, sessionId, settleTold]
  )

  const assistantText = React.useRef(new Map<string, string>())
  const onEvent = React.useCallback(
    (event: Parameters<NonNullable<Parameters<typeof useRealtime>[0]["onEvent"]>>[0]) => {
      switch (event.type) {
        case "input-transcription-completed":
          saveLine(event.itemId, "user", event.transcript)
          break
        case "audio-transcript-delta": {
          const next = (assistantText.current.get(event.itemId) ?? "") + event.delta
          assistantText.current.set(event.itemId, next)
          setCaption(next)
          break
        }
        case "audio-transcript-done": {
          const text = event.transcript ?? assistantText.current.get(event.itemId) ?? ""
          assistantText.current.delete(event.itemId)
          saveLine(event.itemId, "assistant", text)
          setCaption("")
          break
        }
      }
    },
    [saveLine]
  )

  const realtime = useRealtime({
    model,
    api: apiConfig,
    sessionConfig: provider.provider === "google" ? GOOGLE_SESSION : undefined,
    onToolCall,
    onEvent,
    onError: (err) => setError(captureError(err, "Voice call failed")),
  })

  /* One call per mount: the composer's button mounts this card, End unmounts
     it, and unmounting is the hook's own disconnect. */
  const { connect } = realtime
  React.useEffect(() => {
    connect().catch((err: unknown) => setError(captureError(err, "Couldn't start the voice call")))
  }, [connect])

  /* Answer a parked `wait_for_agent` the moment there is something to say. When
     none is parked, say it unprompted: the turn this call started finished, or
     the agent stopped to ask. `sendTextMessage` (a user item + a response) is
     the realtime hook's nearest door — it throws on a continuous session, and
     waits for the model to stop talking so it never cuts in on itself. */
  const { addToolOutput, sendTextMessage, isPlaying } = realtime
  React.useEffect(() => {
    if (thread.turnActive) sawTurn.current = true
    const status = describe(thread, sentFrom.current)
    if (status.state === "working" || (status.state === "idle" && !sawTurn.current)) return
    const callId = waitCall.current
    if (callId) {
      waitCall.current = null
      setWaiting(false)
      settleTold(thread, status.state)
      addToolOutput(callId, status)
      return
    }
    if (isPlaying) return
    const key = askKey(thread)
    if (status.state === "idle" ? !owed.current : !key || told.current.has(key)) return
    settleTold(thread, status.state)
    try {
      sendTextMessage(`[Update from the agent thread, tell the person briefly] ${JSON.stringify(status)}`)
    } catch {
      /* continuous session: no text door, the next tool call carries it */
    }
  }, [thread, addToolOutput, sendTextMessage, isPlaying, settleTold])

  /* Push-to-talk: the mic is open only while the button is held. Capture is
     kept a beat after release so the model's VAD hears the trailing silence
     and ends the turn. Barge-in itself is the hook's: on `speech-started` it
     stops playback and truncates the reply (OpenAI); pressing also does it. */
  const { stopAudioCapture, resumeAudioCapture, stopPlayback, cancelResponse } = realtime
  const talkDown = () => {
    clearTimeout(pttTimer.current)
    if (isPlaying) {
      stopPlayback()
      cancelResponse()
    }
    void resumeAudioCapture()
  }
  const talkUp = () => {
    pttTimer.current = setTimeout(stopAudioCapture, 600)
  }
  const togglePtt = () => {
    clearTimeout(pttTimer.current)
    if (!ptt) stopAudioCapture()
    else void resumeAudioCapture()
    setPtt(!ptt)
  }
  React.useEffect(() => () => clearTimeout(pttTimer.current), [])

  /* A call that was up and is not, without End being pressed: say so. (End
     clears the active call first, so `voiceCallLost` ignores it.) */
  const prevStatus = React.useRef(realtime.status)
  React.useEffect(() => {
    const was = prevStatus.current
    prevStatus.current = realtime.status
    if (was === "connected" && (realtime.status === "disconnected" || realtime.status === "error")) {
      voiceCallLost(sessionId)
    }
  }, [realtime.status, sessionId])

  const connecting = realtime.status === "connecting"
  const label = connecting
    ? "Connecting…"
    : realtime.status !== "connected"
      ? "Not connected"
      : realtime.isPlaying
        ? "Speaking"
        : waiting
          ? "Waiting on the agent"
          : realtime.isCapturing
            ? "Listening"
            : "Muted"

  return (
    <div className="flex flex-col gap-2 rounded-xl border bg-card p-3 text-sm shadow-sm">
      <div className="flex items-center gap-2">
        <Wave mode={realtime.status !== "connected" ? "idle" : realtime.isPlaying ? "speaking" : realtime.isCapturing && !waiting ? "listening" : "idle"} />
        <span className="font-medium">Voice</span>
        <span className="text-muted-foreground">
          {provider.provider === "openai" ? "OpenAI" : "Gemini"} · {label}
        </span>
        <div className="ms-auto flex gap-1">
          <Button
            variant={ptt ? "secondary" : "ghost"}
            size="icon-sm"
            disabled={realtime.status !== "connected"}
            onClick={togglePtt}
            title={ptt ? "Push-to-talk on (click for open mic)" : "Push-to-talk"}
            aria-pressed={ptt}
          >
            <Hand />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={realtime.status !== "connected" || ptt}
            onClick={() => void (realtime.isCapturing ? realtime.stopAudioCapture() : realtime.resumeAudioCapture())}
            title={realtime.isCapturing ? "Mute" : "Unmute"}
            aria-pressed={!realtime.isCapturing}
          >
            {realtime.isCapturing ? <Mic /> : <MicOff />}
          </Button>
          <Button variant="ghost" size="icon-sm" className="text-destructive" onClick={() => endVoiceCall(sessionId)} title="End call">
            <PhoneOff />
          </Button>
        </div>
      </div>
      {ptt && realtime.status === "connected" && (
        <Button
          variant={realtime.isCapturing ? "default" : "outline"}
          className="touch-none select-none"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId)
            talkDown()
          }}
          onPointerUp={talkUp}
          onPointerCancel={talkUp}
        >
          {realtime.isCapturing ? "Release to send" : "Hold to talk"}
        </Button>
      )}
      {caption && <p className="text-muted-foreground">{caption}</p>}
      <ErrorNote error={error} />
    </div>
  )
}

export default VoiceCall
