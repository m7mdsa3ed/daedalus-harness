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
import { AudioLines, Mic, MicOff, PhoneOff } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ErrorNote } from "@/components/error-note"
import type { Actions } from "@/lib/actions"
import { captureError, type InlineError } from "@/lib/errors"
import { api, type ServerSettings } from "@/lib/settings"
import type { ThreadState } from "@/lib/store"
import type { VoiceProvider } from "@/lib/queries/voice"
import { endVoiceCall } from "@/lib/voice-call"

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

/** Where the agent stands, as the voice model is told it. */
function describe(thread: ThreadState, from: number) {
  const permission = thread.permissions[0]
  if (permission) {
    return { state: "needs_permission", request: permission.request.toolCall.title ?? "a tool call" }
  }
  const elicitation = thread.elicitations[0]
  if (elicitation) {
    return { state: "asking_a_question", question: elicitation.request.message, note: "It must be answered on screen." }
  }
  if (thread.turnActive || thread.queue.length > 0) return { state: "working" }
  return { state: "idle", answer: answerSince(thread, from) || "(no answer text)" }
}

export function VoiceCall({
  sessionId,
  thread,
  actions,
  settings,
  provider,
}: {
  sessionId: string
  thread: ThreadState
  actions: Actions
  settings: ServerSettings
  provider: VoiceProvider
}) {
  const [error, setError] = React.useState<InlineError | null>(null)
  const [caption, setCaption] = React.useState("")
  const [waiting, setWaiting] = React.useState(false)

  /* The tools run long after the render they were made in; they read these. */
  const threadRef = React.useRef(thread)
  threadRef.current = thread
  const sentFrom = React.useRef(thread.items.length)
  const sawTurn = React.useRef(false)
  const waitCall = React.useRef<string | null>(null)

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
    return { token: url.toString() }
  }, [settings.url, settings.token, provider.provider])

  const saveLine = React.useCallback(
    (voiceId: string, role: "user" | "assistant", text: string) => {
      if (!text.trim()) return
      api(settings, `/api/sessions/${sessionId}/voice`, {
        method: "POST",
        body: JSON.stringify({ voiceId, role, text }),
      }).catch((err) => setError(captureError(err, "Couldn't save a voice line")))
    },
    [settings, sessionId]
  )

  const onToolCall = React.useCallback(
    async ({ toolCall }: { toolCall: { toolCallId: string; toolName: string; args: unknown } }) => {
      const now = threadRef.current
      const args = (toolCall.args ?? {}) as { text?: string; allow?: boolean }
      switch (toolCall.toolName) {
        case "send_to_agent": {
          if (!args.text?.trim()) return { error: "Nothing to send." }
          sentFrom.current = now.items.length
          sawTurn.current = false
          try {
            await actions.send(sessionId, args.text)
            return { sent: true }
          } catch (err) {
            return { error: captureError(err, "Voice send failed")?.text ?? "The send failed." }
          }
        }
        case "wait_for_agent": {
          const status = describe(now, sentFrom.current)
          if (status.state !== "working" && (sawTurn.current || status.state !== "idle")) return status
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
        case "stop_agent":
          await actions.stop(sessionId)
          return { stopped: true }
        case "agent_status":
          return describe(now, sentFrom.current)
      }
      return { error: `Unknown tool ${toolCall.toolName}` }
    },
    [actions, sessionId]
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

  /* Answer a parked `wait_for_agent` the moment there is something to say. */
  const { addToolOutput } = realtime
  React.useEffect(() => {
    if (thread.turnActive) sawTurn.current = true
    const callId = waitCall.current
    if (!callId) return
    const status = describe(thread, sentFrom.current)
    if (status.state === "working" || (status.state === "idle" && !sawTurn.current)) return
    waitCall.current = null
    setWaiting(false)
    addToolOutput(callId, status)
  }, [thread, addToolOutput])

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
        <AudioLines className={realtime.isPlaying || realtime.isCapturing ? "size-4 animate-pulse text-primary" : "size-4 text-muted-foreground"} />
        <span className="font-medium">Voice</span>
        <span className="text-muted-foreground">
          {provider.provider === "openai" ? "OpenAI" : "Gemini"} · {label}
        </span>
        <div className="ms-auto flex gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={realtime.status !== "connected"}
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
      {caption && <p className="text-muted-foreground">{caption}</p>}
      <ErrorNote error={error} />
    </div>
  )
}

export default VoiceCall
