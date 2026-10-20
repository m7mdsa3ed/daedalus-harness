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
import { Hand, Mic, MicOff } from "lucide-react"
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
import { voiceCallLost } from "@/lib/voice-call"
import { useShortcut } from "@/hooks/use-hotkey"
import { useChords } from "@/lib/keybindings"
import { formatChord } from "@/lib/shortcuts"

const MAX_ANSWER = 4000

/* The browser captures at 24 kHz, but Gemini's mapper labels every chunk
   `rate=16000` unless the session says otherwise — so Gemini heard the person
   at two-thirds speed, transcribed noise, and the call sat on "Listening".
   Saying the real rate is the whole fix. OpenAI is left alone: its token
   already carries its format, and a partial `session.update` touching
   `audio.input` is not worth the risk. Module-level, because the hook rebuilds
   its session whenever `sessionConfig` changes identity. */
const GOOGLE_SESSION = { inputAudioFormat: { type: "audio/pcm", rate: 24000 } } as const

/* What a call has cost so far, as an estimate: published USD per million
   tokens, which the providers change — a stale row skews the figure and
   nothing else. OpenAI reports every response's usage, cached context
   included, so its figure follows the bill; Gemini reports none to the
   browser, so its audio is counted by the clock at the rate Google documents
   (32 tokens/s heard, 25 tokens/s spoken). Input transcription is billed
   apart by the provider and is not in either. */
const OPENAI_RATES = { audioIn: 32, audioOut: 64, textIn: 4, textOut: 24, cachedAudio: 0.4, cachedText: 0.4 }
const OPENAI_MINI_RATES = { audioIn: 10, audioOut: 20, textIn: 0.6, textOut: 2.4, cachedAudio: 0.3, cachedText: 0.06 }
const GOOGLE_RATES = { audioIn: 3, audioOut: 12, inPerSecond: 32, outPerSecond: 25 }

type TokenDetail = { audio_tokens?: number; text_tokens?: number }
type OpenAiUsage = {
  input_token_details?: TokenDetail & { cached_tokens_details?: TokenDetail }
  output_token_details?: TokenDetail
}

/** One OpenAI response's cost, from its `response.done` usage. */
function openAiCost(usage: OpenAiUsage, mini: boolean): number {
  const r = mini ? OPENAI_MINI_RATES : OPENAI_RATES
  const input = usage.input_token_details ?? {}
  const cached = input.cached_tokens_details ?? {}
  const out = usage.output_token_details ?? {}
  const cachedAudio = cached.audio_tokens ?? 0
  const cachedText = cached.text_tokens ?? 0
  return (
    (((input.audio_tokens ?? 0) - cachedAudio) * r.audioIn +
      ((input.text_tokens ?? 0) - cachedText) * r.textIn +
      cachedAudio * r.cachedAudio +
      cachedText * r.cachedText +
      (out.audio_tokens ?? 0) * r.audioOut +
      (out.text_tokens ?? 0) * r.textOut) /
    1e6
  )
}

const formatCost = (usd: number) => `≈ $${usd < 0.1 ? usd.toFixed(3) : usd.toFixed(2)}`

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
  /* What the person is saying, as it is heard: OpenAI streams it as deltas
     (a `custom` event), Gemini re-sends the running text. Kept until the voice
     model starts to answer, so the last thing said stays readable. */
  const [heard, setHeard] = React.useState("")
  const heardText = React.useRef(new Map<string, string>())
  /* Cost so far: OpenAI's is summed from each response's usage, Gemini's from
     seconds of audio heard and spoken (`tick`, below). */
  const [spent, setSpent] = React.useState(0)
  const [audioSeconds, setAudioSeconds] = React.useState({ heard: 0, spoken: 0 })
  const [waiting, setWaiting] = React.useState(false)
  const [ptt, setPtt] = React.useState(false)
  const pttTimer = React.useRef<ReturnType<typeof setTimeout>>(undefined)

  /* The tools run long after the render they were made in; they read these. */
  const threadRef = React.useRef(thread)
  threadRef.current = thread
  /* Mounted mid-turn — the console handing a first spoken message to its
     thread view remounts the call — the turn is still owed to the person. */
  const midTurn = thread.turnActive
  const sentFrom = React.useRef(
    midTurn ? thread.items.reduce((last, item, i) => (item.kind === "user" ? i : last), 0) : thread.items.length
  )
  const sawTurn = React.useRef(midTurn)
  const waitCall = React.useRef<string | null>(null)
  /* The voice sent something and has not been told how it ended; the asks
     already put to the person (a permission or question is told once). */
  const owed = React.useRef(midTurn)
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
      if (toolCall.toolName.startsWith("mcp__")) {
        try {
          const result = await api(settings, "/api/voice/mcp/call", {
            method: "POST",
            body: JSON.stringify({ key: toolCall.toolName, args: toolCall.args }),
          })
          return result
        } catch (err) {
          return { error: captureError(err, "MCP tool call failed")?.text ?? "The MCP tool call failed." }
        }
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
          setHeard(event.transcript)
          saveLine(event.itemId, "user", event.transcript)
          break
        case "response-done": {
          if (provider.provider !== "openai") break
          const usage = (event.raw as { response?: { usage?: OpenAiUsage } })?.response?.usage
          if (usage) setSpent((n) => n + openAiCost(usage, provider.model.includes("mini")))
          break
        }
        case "speech-started":
          heardText.current.clear()
          setHeard("")
          break
        case "custom": {
          if (event.rawType !== "conversation.item.input_audio_transcription.delta") break
          const raw = event.raw as { item_id?: string; delta?: string }
          const id = raw.item_id ?? ""
          const next = (heardText.current.get(id) ?? "") + (raw.delta ?? "")
          heardText.current.set(id, next)
          setHeard(next)
          break
        }
        case "audio-transcript-delta": {
          const next = (assistantText.current.get(event.itemId) ?? "") + event.delta
          assistantText.current.set(event.itemId, next)
          setHeard("")
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
    [saveLine, provider.provider, provider.model]
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

  /* Mute and unmute from the keyboard. A press is the person's own say, so it
     also settles whatever the wait closed: the mic is not opened behind them
     when the agent answers. */
  const muteChord = formatChord(useChords("voiceMute")[0] ?? "")
  useShortcut(
    "voiceMute",
    () => {
      autoMuted.current = false
      void (live.current.capturing ? stopAudioCapture() : resumeAudioCapture())
    },
    { enabled: realtime.status === "connected" && !ptt }
  )

  /* Gemini's clock: a second the mic is open is a second heard, a second of
     playback a second spoken. Read through refs so the interval is set once. */
  const live = React.useRef({ capturing: false, playing: false })
  live.current = { capturing: realtime.isCapturing, playing: realtime.isPlaying }
  React.useEffect(() => {
    if (provider.provider !== "google" || realtime.status !== "connected") return
    const id = setInterval(() => {
      const { capturing, playing } = live.current
      if (capturing || playing)
        setAudioSeconds((s) => ({ heard: s.heard + (capturing ? 1 : 0), spoken: s.spoken + (playing ? 1 : 0) }))
    }, 1000)
    return () => clearInterval(id)
  }, [provider.provider, realtime.status])
  const cost =
    provider.provider === "google"
      ? (audioSeconds.heard * GOOGLE_RATES.inPerSecond * GOOGLE_RATES.audioIn +
          audioSeconds.spoken * GOOGLE_RATES.outPerSecond * GOOGLE_RATES.audioOut) /
        1e6
      : spent

  /* The mic is shut while the voice model waits on the agent: nothing the
     person says can be acted on then, and a provider that bills the audio it
     is streamed (Gemini) would charge for the silence. It opens again when the
     wait is answered, but only if this closed it — a mute or push-to-talk the
     person chose stays as it was. */
  const autoMuted = React.useRef(false)
  React.useEffect(() => {
    if (waiting) {
      if (!ptt && realtime.isCapturing) {
        autoMuted.current = true
        void stopAudioCapture()
      }
    } else if (autoMuted.current) {
      autoMuted.current = false
      if (!ptt) resumeAudioCapture().catch((err: unknown) => setError(captureError(err, "Couldn't open the microphone")))
    }
    // Only the wait starting or ending is a reason to move the mic.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting])

  /* A call opens with the mic on. The SDK's client-secret WebSocket path (our
     `api.token`) never requests capture on connect — only its WebRTC and PCM
     paths do — so without this every call started "Muted". */
  React.useEffect(() => {
    if (realtime.status !== "connected") return
    resumeAudioCapture().catch((err: unknown) => setError(captureError(err, "Couldn't open the microphone")))
  }, [realtime.status, resumeAudioCapture])

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

  /* A bar of the composer's own pill material, drawn beside the pill that ends
     the call (the composer places it): the box is away for the whole call, so
     this is the whole of the call's chrome. The caption is the label while the
     voice model speaks; the failure sits over the bar, where it is read. */
  const btn = "size-7 shrink-0 [&_svg]:size-3.5"
  return (
    <div className="flex flex-col items-end gap-2">
      <ErrorNote error={error} className="w-[min(24rem,calc(100vw-2rem))] text-left" />
      {(heard || caption) && (
        <p
          dir="auto"
          className={cn(
            "line-clamp-3 w-fit max-w-[min(24rem,calc(100vw-2rem))] rounded-3xl px-3.5 py-2.5 text-start text-sm",
            caption ? "bg-muted" : "bg-primary/10"
          )}
        >
          {caption || heard}
        </p>
      )}
      <div className="flex h-(--composer-pill) items-center gap-1 rounded-pill bg-composer-glass-hi ps-3 pe-0.5 text-sm ring-1 ring-foreground/10">
        <Wave mode={realtime.status !== "connected" ? "idle" : realtime.isPlaying ? "speaking" : realtime.isCapturing && !waiting ? "listening" : "idle"} />
        <span className="hidden text-muted-foreground @panel-sm:inline">{label}</span>
        {realtime.status === "connected" && (
          <span
            className="tabular-nums text-muted-foreground"
            title="Estimated cost of this call so far, at the provider's published rates. Input transcription is billed separately."
          >
            {formatCost(cost)}
          </span>
        )}
        <Button
          variant={ptt ? "secondary" : "ghost"}
          size="icon-xs"
          className={btn}
          disabled={realtime.status !== "connected"}
          onClick={togglePtt}
          title={ptt ? "Push-to-talk on (click for open mic)" : "Push-to-talk"}
          aria-pressed={ptt}
        >
          <Hand />
        </Button>
        {ptt && realtime.status === "connected" ? (
          <Button
            variant={realtime.isCapturing ? "default" : "outline"}
            size="xs"
            className="h-7 touch-none select-none"
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId)
              talkDown()
            }}
            onPointerUp={talkUp}
            onPointerCancel={talkUp}
          >
            {realtime.isCapturing ? "Release" : "Hold to talk"}
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="icon-xs"
            className={btn}
            disabled={realtime.status !== "connected"}
            onClick={() => void (realtime.isCapturing ? realtime.stopAudioCapture() : realtime.resumeAudioCapture())}
            title={`${realtime.isCapturing ? "Mute" : "Unmute"}${muteChord ? ` (${muteChord})` : ""}`}
            aria-pressed={!realtime.isCapturing}
          >
            {realtime.isCapturing ? <Mic /> : <MicOff />}
          </Button>
        )}
      </div>
    </div>
  )
}

export default VoiceCall
