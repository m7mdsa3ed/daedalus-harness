/* ── Composer ──
   The box, the strip above it and the toolbar beneath. One component for every
   surface that takes a prompt. Nothing on it opens a popover or a menu:

   — **The strip** (`ComposerStrip`) is one tinted shelf tucked under the card.
     Its foot is the scope bar (`scope.tsx`): the project, its worktree, the
     tools, and every reading of the thread (a settings change in flight, the
     checklist, running subagents, the last turn's changes, the branch, the
     window) as tinted segments. Picking one expands its detail in flow above
     the bar — the panel — and pushes the card down. Above that sits the pile:
     what is about the message being typed (attachments, the "Earlier prompt"
     notice, the `/` `!` `@` completers).
   — **The card**: the box, then one toolbar that reads *what goes in → who
     answers → what happens*: a button per way of adding to the message
     (`add-buttons.tsx`), the model pill (which opens the panel's Model
     section), then the length reading, the enhancer, the mic, pause, Stop and
     a filled Send.

   ── Where the logic lives ──
   `use-draft-text.ts` (the words and parked pastes, persisted per device),
   `use-send.ts` (every rule about what a send is), `keys.ts` (the one ordering
   of Enter and the completers), `prompt-history.ts` (the Up walk),
   `text-insertions.ts` (what the add buttons type), `enhance-button.tsx`. This
   file only puts them together. */
import * as React from "react"
import { useLocation } from "react-router"
import { ArrowUp, History, Mic, Pause, Play, Square } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Shortcut } from "@/components/shortcut"
import { ComposerAttachments, type AttachmentDelivery } from "@/components/composer-attachments"
import { ComposerHistoryDialog } from "@/components/composer-history-dialog"
import { ComposerStrip, ComposerStripItem } from "@/components/composer-strip"
import { DraftConfigFace, useDraftConfigLabel } from "@/components/draft-config"
import { FileMentionMenu, useFileMentions } from "@/components/file-mentions"
import { ProjectCommandMenu, useProjectCommands } from "@/components/project-commands"
import { SessionConfigFace, useSessionConfigLabel } from "@/components/session-config"
import { HARNESS_COMMANDS, SlashCommandMenu, useSlashCommands } from "@/components/slash-commands"
import { ComposerAddButtons } from "@/components/composer/add-buttons"
import { ComposerEditor, type TextSurface } from "@/components/composer/composer-editor"
import { connectionTone } from "@/components/composer/connection-indicator"
import { quoteLines } from "@/components/composer/editor-text"
import { EnhanceButton } from "@/components/composer/enhance-button"
import { composerKeyDown } from "@/components/composer/keys"
import { usePromptHistory } from "@/components/composer/prompt-history"
import { ScopeBar, ScopePanel, type ScopeTab } from "@/components/composer/scope"
import { selectionOf, textInsertions } from "@/components/composer/text-insertions"
import { useDraftText } from "@/components/composer/use-draft-text"
import { useComposerSend } from "@/components/composer/use-send"
import { useComposerAttachments } from "@/hooks/use-composer-attachments"
import { useCoarsePointer, useIsMobile } from "@/hooks/use-device"
import { useVoice } from "@/hooks/use-voice"
import type { Actions } from "@/lib/actions"
import { useComposerPrefs } from "@/lib/composer-prefs"
import { consumeComposerFocusRequest, useComposerFocusRequest } from "@/lib/composer-focus"
import { reportError } from "@/lib/errors"
import { useChords } from "@/lib/keybindings"
import { mcpPromptCommands, readMcpResourceFile } from "@/lib/mcp-composer"
import { isLongPaste, mintPaste, pasteToken } from "@/lib/pastes"
import {
  useComposerHistory,
  useProjectScripts,
  useProjects,
  useShellHistory,
  useThreadMcp,
} from "@/lib/queries"
import { currentThreadId } from "@/lib/router"
import { useServer } from "@/lib/server-context"
import type { SessionMeta } from "@/lib/settings"
import { formatChord } from "@/lib/shortcuts"
import type { ThreadState } from "@/lib/store"
import { holdOf } from "@/lib/thread/hold"
import { composerLock } from "@/lib/thread/phase"
import { formatTokens } from "@/lib/tokens"
import type { TurnChanges } from "@/lib/workspace/git-api"
import { cn } from "@/lib/utils"

/* Past this a prompt is long enough that its size is worth a reading. */
const LONG_PROMPT_CHARS = 240
const LONG_PROMPT_LINES = 3

/** What the transcript's suggestion card can ask the composer to do. Imperative
    because filling is a moment, not a mode. */
export interface ComposerHandle {
  /** Fill the box like a history recall: replaced, unsent, caret at the end. */
  fill(prompt: string): void
  /** Whether a `fill` would replace anything. Escape's take-back asks first. */
  isEmpty(): boolean
  /** Add an excerpt under what is typed as `> ` lines. "Ask about this". */
  quote(excerpt: string): void
}

export function Composer({
  sessionId,
  actions,
  thread,
  meta,
  delivery,
  changes,
  beforeSend,
  placeholder,
  autoFocus,
  ref,
}: {
  sessionId: string
  actions: Actions
  thread: ThreadState
  meta?: SessionMeta
  /** Resolved by ThreadView: the transcript's error rows read the same answer. */
  delivery: AttachmentDelivery
  /** The newest turn that wrote to the worktree, already gated by the transcript. */
  changes?: TurnChanges
  /** Awaited between "the words have been taken" and the send; `false` (or a
      throw) puts them back and sends nothing. The build page scaffolds here. */
  beforeSend?: (text: string) => Promise<boolean>
  /** Overrides the idle placeholder only; the lock and queue notes still win. */
  placeholder?: string
  /** Take the caret without being the routed thread — the landing console. */
  autoFocus?: boolean
  ref?: React.Ref<ComposerHandle>
}) {
  const location = useLocation()
  const server = useServer()
  const box = useDraftText(sessionId)
  const { text, setText, pastes, setPastes, shownPastes } = box
  const composerRef = React.useRef<TextSurface>(null)
  const files = useComposerAttachments(sessionId)
  const isMobile = useIsMobile()
  const coarse = useCoarsePointer()
  const prefs = useComposerPrefs()
  const steerChords = useChords("steer")
  const voice = useVoice((transcript) => setText((t) => (t ? t + " " : "") + transcript))

  /* A draft has no connection, so it stays typable whatever else is true;
     `submittable` is what goes false while a thread is opening. */
  const draft = meta?.draft === true
  const lock = composerLock(thread.phase, draft)
  const disabled = !lock.typable
  const hold = holdOf(thread)
  const mcpServers = useThreadMcp(sessionId, !draft)
  const { send, gated } = useComposerSend({
    sessionId,
    actions,
    thread,
    meta,
    draft,
    lock,
    hold,
    box,
    files,
    mcpServers,
    beforeSend,
  })

  /* Which section of the strip's panel is open. The bar's segments and the
     model pill are its doors; nothing else is. */
  const [panel, setPanel] = React.useState<ScopeTab | null>(null)

  /* ── The completers ── whichever is open owns the arrows (keys.ts). */
  const composerHistory = useComposerHistory()
  const [historyOpen, setHistoryOpen] = React.useState(false)
  const history = usePromptHistory(composerHistory.items, setText, composerRef)
  /* A draft has no process, so it is offered no harness commands; `/compact`
     only where the runtime takes the request. */
  const harnessCommands = React.useMemo(
    () =>
      draft
        ? []
        : [
            ...HARNESS_COMMANDS.filter((c) => c.name !== "compact" || thread.canCompact),
            ...mcpPromptCommands(mcpServers),
          ],
    [draft, thread.canCompact, mcpServers]
  )
  const slash = useSlashCommands(text, thread.availableCommands, setText, harnessCommands)
  const hasCommands = thread.availableCommands.length > 0 || harnessCommands.length > 0
  /* `!` suggests the project's helpers, its package scripts and what has been
     run here before — only on a started thread, which has a journal to write
     the result to. */
  const projects = useProjects()
  const project = meta?.projectId ? projects.find((p) => p.id === meta.projectId) : undefined
  const helpers = draft ? [] : (project?.helpers ?? [])
  const shellEnabled = !draft && Boolean(meta?.projectId)
  const scripts = useProjectScripts(meta?.projectId ?? "", shellEnabled).data ?? []
  const shellHistory = useShellHistory(meta?.projectId ?? "", shellEnabled).data ?? []
  const commands = useProjectCommands({ text, helpers, scripts, history: shellHistory, setText })
  const mentions = useFileMentions({
    text,
    setText,
    projectId: meta?.projectId,
    inputRef: composerRef,
    mcpServers,
    draft,
    linkedMcpServerIds: meta?.mcpServerIds,
    currentPersonaId: meta?.personaId,
    onResource: (resource) => {
      readMcpResourceFile(server, sessionId, resource.serverId, resource.uri, resource.name)
        .then((file) => files.add([file]))
        .catch((err) => reportError(err, `Couldn't read ${resource.uri}`))
    },
    onMcpServer: (picked) => {
      if (!meta?.draft) return
      const selected = new Set(meta.mcpServerIds ?? [])
      selected.add(picked.id)
      actions.configureDraft(meta.id, { mcpServerIds: [...selected] })
    },
    onPersona: (persona) => {
      if (!meta) return
      if (meta.draft) {
        actions.configureDraft(meta.id, {
          personaId: persona.id,
          ...(persona.effort ? { effort: persona.effort } : {}),
        })
      } else {
        actions.changeThreadPersona(meta, persona.id)
      }
    },
  })
  const { insertMention, insertCommand, insertProjectCommand, insertCodeBlock } = textInsertions({
    text,
    setText,
    requestCaret: mentions.requestCaret,
    inputRef: composerRef,
  })

  /* ── Focus ── A draft takes the caret when it is the routed thread (or the
     caller says so — the landing console, whose route is `/`), and an explicit
     palette request can take it for a started thread. Never on touch, where it
     raises the keyboard over the screen just arrived at. After a frame, because
     dockview moves focus itself as it activates a panel. */
  const routed = currentThreadId(location.pathname, location.search) === sessionId
  const focusRequest = useComposerFocusRequest(sessionId)
  React.useEffect(() => {
    if (!(routed || autoFocus)) return
    if (focusRequest !== 0 && isMobile) {
      consumeComposerFocusRequest(sessionId, focusRequest)
      return
    }
    if (isMobile || (!draft && focusRequest === 0)) return
    const frame = requestAnimationFrame(() => {
      if (focusRequest !== 0) consumeComposerFocusRequest(sessionId, focusRequest)
      composerRef.current?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [sessionId, draft, routed, autoFocus, isMobile, focusRequest])

  const clearAll = () => {
    box.reset()
    files.clear()
    requestAnimationFrame(() => composerRef.current?.focus())
  }
  /* Replaced, unsent, caret at the end — a suggestion, a rewrite, a reclaim.
     The caret goes through the mention hook's slot: rewriting `text` is a
     render, and the position has to be re-applied after it. */
  const fill = React.useCallback(
    (prompt: string) => {
      setText(prompt)
      mentions.requestCaret(prompt.length)
      requestAnimationFrame(() => composerRef.current?.focus())
    },
    [mentions.requestCaret, setText]
  )
  React.useImperativeHandle(
    ref,
    () => ({
      fill,
      isEmpty: () => text.trim() === "",
      quote: (excerpt) => {
        const typed = text.replace(/\s+$/, "")
        fill(`${typed ? `${typed}\n\n` : ""}${quoteLines(excerpt.trim())}\n\n`)
      },
    }),
    [fill, text]
  )

  /* Files before text: a screenshot usually carries a text/plain fallback too.
     A long paste is parked as a token; below the threshold nothing happens. */
  const onPaste = (event: ClipboardEvent): boolean => {
    const pasted = [...(event.clipboardData?.files ?? [])]
    if (pasted.length > 0) {
      event.preventDefault()
      files.add(pasted)
      return true
    }
    const plain = event.clipboardData?.getData("text/plain")
    if (!plain || !isLongPaste(plain)) return false
    event.preventDefault()
    const [start, end] = selectionOf(composerRef.current, text.length)
    const paste = mintPaste(pastes, plain)
    const token = pasteToken(paste.n)
    setPastes([...pastes, paste])
    mentions.requestCaret(start + token.length)
    setText(text.slice(0, start) + token + text.slice(end))
    return true
  }

  /* ── Drop ── the whole card is the target. `dragCounter` keeps the overlay
     steady: `dragleave` fires as the pointer crosses into a child. */
  const [dragging, setDragging] = React.useState(false)
  const dragCounter = React.useRef(0)
  const isFileDrag = (e: React.DragEvent) => e.dataTransfer.types.includes("Files")

  /* ── What the toolbar reads ── */
  const chars = text.length
  const lines = chars === 0 ? 0 : text.split("\n").length
  const long = chars >= LONG_PROMPT_CHARS || lines >= LONG_PROMPT_LINES
  const hasContent = text.trim().length > 0 || files.attachments.length > 0 || shownPastes.length > 0
  const canSend =
    !disabled && !gated && lock.submittable && !files.uploading && (text.trim().length > 0 || files.ready.length > 0)
  const iconSize = coarse ? "icon-sm" : "icon-xs"
  const steerChord = formatChord(steerChords[0] ?? "")
  const sendTitle = gated
    ? "Working…"
    : hold.paused
      ? hold.sendHint
      : thread.turnActive
        ? `Queue (${steerChord} steers the running turn instead)`
        : "Send"

  return (
    <div className="pointer-events-auto px-4 pt-1 pb-[max(0.75rem,var(--safe-bottom))]">
      <ComposerStrip
        tone={connectionTone(thread) ?? "neutral"}
        bar={
          meta && (
            <ScopeBar
              meta={meta}
              thread={thread}
              changes={changes}
              actions={actions}
              draft={draft}
              open={panel}
              onOpen={setPanel}
            />
          )
        }
        panel={
          meta &&
          panel && (
            <ScopePanel
              tab={panel}
              onClose={() => setPanel(null)}
              sessionId={sessionId}
              meta={meta}
              thread={thread}
              actions={actions}
              changes={changes}
              draft={draft}
            />
          )
        }
      >
        <ComposerAttachments
          attachments={files.attachments}
          delivery={delivery}
          onRemoveAttachment={files.remove}
          onRetryAttachment={files.retry}
        />
        {/* Says what the box is showing and how to get back out of it. */}
        {history.browsing && (
          <ComposerStripItem className="flex items-center gap-2 px-2 py-1.5 text-[11px] text-muted-foreground">
            <History className="size-3" />
            <span>Earlier prompt</span>
            <span className="ms-auto hidden items-center gap-1.5 sm:flex">
              <Shortcut chord="esc" />
              to go back
            </span>
          </ComposerStripItem>
        )}
        <SlashCommandMenu state={slash} />
        <ProjectCommandMenu state={commands} />
        <FileMentionMenu state={mentions} />
      </ComposerStrip>
      <div
        data-slot="composer-card"
        className={cn(
          "relative z-10 mx-auto w-full max-w-[var(--harness-composer-width)] rounded-2xl bg-composer/70 p-2 shadow-glass-lg backdrop-blur-xl backdrop-saturate-150",
          "transition-[ring-color] duration-200",
          voice.listening && "ring-1 ring-destructive/40"
        )}
        onDragOver={(e) => {
          if (!isFileDrag(e)) return
          e.preventDefault()
          e.dataTransfer.dropEffect = "copy"
        }}
        onDragEnter={(e) => {
          if (!isFileDrag(e)) return
          dragCounter.current += 1
          setDragging(true)
        }}
        onDragLeave={(e) => {
          if (!isFileDrag(e)) return
          dragCounter.current -= 1
          if (dragCounter.current <= 0) setDragging(false)
        }}
        onDrop={(e) => {
          if (!isFileDrag(e)) return
          e.preventDefault()
          dragCounter.current = 0
          setDragging(false)
          files.add(e.dataTransfer.files)
        }}
      >
        {dragging && (
          <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center rounded-2xl border-2 border-dashed border-primary bg-composer/80 text-xs font-medium text-primary">
            Drop to attach
          </div>
        )}
        <ComposerEditor
          ref={composerRef}
          value={text}
          onChange={setText}
          onSelect={mentions.onSelect}
          onPaste={onPaste}
          pastes={shownPastes}
          onKeyDown={composerKeyDown({
            slash,
            commands,
            mentions,
            history,
            isMobile,
            enterSends: prefs.enterSends,
            steerChords,
            send,
          })}
          ariaLabel="Message the agent"
          placeholder={
            lock.note ??
            (voice.listening && !text
              ? "Listening…"
              : hold.paused
                ? `${hold.sendHint}…`
                : thread.turnActive
                  ? "Queue a message for when the agent finishes…"
                  : (placeholder ?? "Message the agent…"))
          }
          disabled={disabled || gated}
          className={cn(
            /* The card carries the transcript's `--text-xs` bump, so typing
               matches what is being answered. Ten lines, then it scrolls. */
            "w-full text-xs md:text-xs",
            "max-h-40",
            coarse && "[&_.tiptap]:min-h-11"
          )}
        />
        <div data-slot="composer-toolbar" className={cn("flex items-center gap-1 pt-1", coarse && "gap-1.5 pt-1.5")}>
          {/* What goes in, then who answers — one scroller, so a narrow panel
              slides the row rather than wrapping it. */}
          <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <ComposerAddButtons
              disabled={disabled || gated}
              size={iconSize}
              coarse={coarse}
              onFiles={files.add}
              canMention={Boolean(meta?.projectId)}
              hasCommands={hasCommands}
              hasProjectCommands={helpers.length > 0 || scripts.length > 0}
              hasHistory={composerHistory.items.length > 0}
              hasContent={hasContent}
              onMention={insertMention}
              onCommand={insertCommand}
              onProjectCommand={insertProjectCommand}
              onCodeBlock={insertCodeBlock}
              onHistory={() => setHistoryOpen(true)}
              onClear={clearAll}
            />
            {meta && (
              <ModelPill
                meta={meta}
                sessionId={sessionId}
                thread={thread}
                actions={actions}
                draft={draft}
                open={panel === "model"}
                onToggle={() => setPanel(panel === "model" ? null : "model")}
              />
            )}
          </div>
          {long && (
            <span
              className="hidden shrink-0 px-1 text-[10px] tabular-nums text-muted-foreground @panel-sm:inline"
              title={`${chars.toLocaleString()} characters, ${lines} lines — roughly ${formatTokens(Math.ceil(chars / 4))} tokens`}
            >
              {formatTokens(chars)} · ~{formatTokens(Math.ceil(chars / 4))} tok
            </span>
          )}
          <EnhanceButton
            sessionId={sessionId}
            meta={meta}
            draft={draft}
            text={text}
            disabled={disabled}
            gated={gated}
            hasContent={hasContent}
            size={iconSize}
            onEnhanced={fill}
          />
          {voice.supported && (voice.listening || (!hasContent && !gated)) && (
            <Button
              variant="ghost"
              size={iconSize}
              className={cn(
                "shrink-0 rounded-pill text-muted-foreground hover:text-foreground [&_svg]:size-3.5",
                voice.listening && "animate-pulse text-destructive hover:text-destructive"
              )}
              onClick={() => (voice.listening ? voice.stop() : voice.start())}
              disabled={disabled}
              title={voice.listening ? "Stop listening" : "Voice input"}
              aria-pressed={voice.listening}
            >
              <Mic />
            </Button>
          )}
          {/* Pause is the harness's own hold at the next step boundary; the same
              control releases a turn the runtime held on a failure. */}
          {thread.canPause && (thread.turnActive || thread.paused) && (
            <Button
              variant="ghost"
              size={iconSize}
              className={cn(
                "shrink-0 rounded-pill text-muted-foreground hover:text-foreground [&_svg]:size-3.5",
                thread.paused && "text-primary hover:text-primary"
              )}
              onClick={() =>
                (thread.paused ? actions.resume(sessionId) : actions.pause(sessionId)).catch((err) =>
                  reportError(err, thread.paused ? "Couldn't resume the turn" : "Couldn't pause the turn")
                )
              }
              title={
                hold.byError
                  ? "Continue — change the model first if the same one will fail again"
                  : hold.paused
                    ? "Resume"
                    : "Pause at the next step"
              }
            >
              {thread.paused ? <Play /> : <Pause />}
            </Button>
          )}
          {thread.turnActive && (
            <Button
              variant="destructive"
              size={iconSize}
              className="shrink-0 rounded-pill shadow-sm"
              /* Stop and Escape answer the same way: a message that has not
                 landed comes back into the box — only into an empty one. */
              onClick={() =>
                actions.stop(sessionId, text.trim() === "" ? { onReclaim: fill } : {}).catch(() => {})
              }
              title="Stop"
            >
              <Square className="size-3.5 fill-current" />
            </Button>
          )}
          {/* Always drawn, so the thing you aim at does not move when you type:
              a muted chip while there is nothing to send, primary once there is. */}
          <Button
            variant="default"
            size={iconSize}
            className="shrink-0 rounded-pill disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100"
            onClick={() => void send()}
            disabled={!canSend}
            title={sendTitle}
            aria-label={sendTitle}
          >
            {gated ? <Spinner className="size-3.5" /> : <ArrowUp className="size-3.5" strokeWidth={2.5} />}
          </Button>
        </div>
      </div>
      {/* Outside the card so the dialog is not inside the element it writes
          into. Picking replaces the box — the same act Up performs. */}
      <ComposerHistoryDialog
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        onPick={(picked) => {
          setText(picked)
          requestAnimationFrame(() => {
            const el = composerRef.current
            if (!el) return
            el.focus()
            el.setSelectionRange(el.value.length, el.value.length)
          })
        }}
      />
    </div>
  )
}

/* Who answers: the model and its settings, read out as the pill the dropdown
   used to hang off. It opens the strip's Model section instead — the same body,
   drawn inline. Its own component so the label hooks only ever see a real row. */
function ModelPill({
  meta,
  sessionId,
  thread,
  actions,
  draft,
  open,
  onToggle,
}: {
  meta: SessionMeta
  sessionId: string
  thread: ThreadState
  actions: Actions
  draft: boolean
  open: boolean
  onToggle: () => void
}) {
  const sessionLabel = useSessionConfigLabel(sessionId, thread, actions)
  const draftLabel = useDraftConfigLabel(meta, actions)
  const label = (draft ? draftLabel : sessionLabel) || "Model"
  return (
    <button
      type="button"
      aria-pressed={open}
      aria-expanded={open}
      onClick={onToggle}
      title={label}
      className={cn(
        "ms-1 flex h-6 min-w-0 shrink-0 items-center gap-1 rounded-pill px-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
        open && "bg-muted text-foreground"
      )}
    >
      {draft ? (
        <DraftConfigFace meta={meta} actions={actions} />
      ) : (
        <SessionConfigFace sessionId={sessionId} thread={thread} actions={actions} />
      )}
    </button>
  )
}
