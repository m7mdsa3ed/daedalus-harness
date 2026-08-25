import * as React from "react"
import { ArrowUp, Loader2, Mic, RotateCw, Square } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller"
import { useVoice } from "@/hooks/use-voice"
import type { Actions } from "@/lib/actions"
import { useStore, emptyThread, type PendingPermission, type ThreadState } from "@/lib/store"
import { cn } from "@/lib/utils"
import { SessionConfigPopover } from "./session-config"
import { isStepItem, ThreadItemView } from "./thread-items"

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

/** input / output / cache-hit rate / TTFT / context occupancy, header-sized. */
export function UsageStats({ thread }: { thread: ThreadState }) {
  const { usage, context, ttftMs } = thread
  if (!usage && !context && ttftMs === null) return null
  const cached = usage?.cachedReadTokens ?? 0
  const cacheRate = usage && usage.inputTokens + cached > 0
    ? Math.round((cached / (usage.inputTokens + cached)) * 100)
    : null
  return (
    <div className="flex items-center gap-2 font-mono text-[11px] whitespace-nowrap text-muted-foreground">
      {usage && (
        <span title="Input / output tokens">
          ↑{formatTokens(usage.inputTokens)} ↓{formatTokens(usage.outputTokens)}
        </span>
      )}
      {cacheRate !== null && <span title="Cache hit rate">cache {cacheRate}%</span>}
      {ttftMs !== null && <span title="Time to first token">ttft {ttftMs}ms</span>}
      {context && (
        <span title="Context window">
          ctx {formatTokens(context.used)}/{formatTokens(context.size)}
        </span>
      )}
    </div>
  )
}

export function ThreadView({ sessionId, actions }: { sessionId: string; actions: Actions }) {
  const { state } = useStore()
  const thread = state.threads[sessionId] ?? emptyThread

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* `autoScroll` defaults to FALSE — without it the transcript never follows
          the stream. Every direct child of Content must be an Item with a
          `messageId`: the visibility/preservation scanner skips elements without
          one, so unkeyed items are invisible to the scroller. */}
      <MessageScrollerProvider autoScroll>
        <MessageScroller className="min-h-0 flex-1">
          <MessageScrollerViewport>
            <MessageScrollerContent className="mx-auto w-full max-w-[var(--harness-chat-width)] gap-0.5 px-4 py-4">
              {thread.status === "connecting" && (
                <MessageScrollerItem messageId="connecting">
                  <div className="flex items-center gap-2 py-1 text-xs text-muted-foreground">
                    <Loader2 className="size-3 animate-spin" /> Connecting…
                  </div>
                </MessageScrollerItem>
              )}
              {thread.items.length === 0 && thread.status !== "connecting" && (
                <MessageScrollerItem messageId="empty">
                  <div className="flex flex-col items-center gap-1.5 py-16 text-center">
                    <p className="text-sm font-medium">Thread ready</p>
                    <p className="max-w-xs text-xs text-balance text-muted-foreground">
                      Send the first message — tool calls, plans and thinking stream in here as
                      steps.
                    </p>
                  </div>
                </MessageScrollerItem>
              )}
              {thread.items.map((item) => (
                // A new anchor gets scrolled to the top of the viewport, so the
                // anchor is the user's message — the turn then streams below it.
                <MessageScrollerItem
                  key={item.id}
                  messageId={item.id}
                  scrollAnchor={item.kind === "user"}
                  data-step={isStepItem(item) ? "" : undefined}
                >
                  <ThreadItemView item={item} />
                </MessageScrollerItem>
              ))}
              {thread.turnActive && (
                <MessageScrollerItem messageId="working">
                  <div className="flex items-center px-1.5 py-1 text-sm text-primary">
                    <span className="harness-shimmer font-medium">Working</span>
                    <span className="harness-dots">
                      <i />
                      <i />
                      <i />
                    </span>
                  </div>
                </MessageScrollerItem>
              )}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>
      <Composer sessionId={sessionId} actions={actions} thread={thread} />
      <PermissionDialog permission={thread.permission} />
    </div>
  )
}

/** Permission mode select + the compact session-config popover. */
function SessionControls({
  sessionId,
  actions,
  thread,
}: {
  sessionId: string
  actions: Actions
  thread: ThreadState
}) {
  const selectClass =
    "h-7 gap-1 rounded-md border-0 bg-transparent px-2 text-xs text-muted-foreground shadow-none hover:bg-accent hover:text-foreground data-[size=default]:h-7"
  return (
    <>
      {thread.modes && thread.modes.availableModes.length > 1 && (
        <Select
          value={thread.modes.currentModeId}
          onValueChange={(modeId) =>
            modeId && actions.setMode(sessionId, modeId).catch((err) => toast.error(String(err)))
          }
        >
          <SelectTrigger className={selectClass} title="Permission mode">
            {/* Base UI's Value renders the raw id unless items are registered — show the label. */}
            <SelectValue>
              {thread.modes.availableModes.find((m) => m.id === thread.modes?.currentModeId)?.name}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {thread.modes.availableModes.map((mode) => (
              <SelectItem key={mode.id} value={mode.id}>
                {mode.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <SessionConfigPopover sessionId={sessionId} actions={actions} thread={thread} />
    </>
  )
}

function Composer({
  sessionId,
  actions,
  thread,
}: {
  sessionId: string
  actions: Actions
  thread: ThreadState
}) {
  const [text, setText] = React.useState("")
  const [reviving, setReviving] = React.useState(false)
  const voice = useVoice((transcript) => setText((t) => (t ? t + " " : "") + transcript))
  const disabled = thread.status === "closed"

  /* The process is gone, not the conversation: respawning restores it through
     ACP session/load. Until that happens the composer has nothing to talk to. */
  const revive = () => {
    setReviving(true)
    actions
      .reviveThread(sessionId)
      .catch((err) => toast.error(String(err)))
      .finally(() => setReviving(false))
  }

  const send = () => {
    const value = text.trim()
    if (!value) return
    setText("")
    actions.send(sessionId, value).catch((err) => toast.error(String(err)))
  }

  return (
    <div className="px-4 pt-1 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      {disabled && (
        <div className="mx-auto mb-1.5 flex w-full max-w-[var(--harness-composer-width)] flex-wrap items-center justify-center gap-x-2 gap-y-1 rounded-lg border border-dashed px-3 py-1.5 text-center text-xs text-muted-foreground">
          <span>The agent process exited — the conversation is restored on revive.</span>
          <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={revive} disabled={reviving}>
            <RotateCw className={cn("size-3", reviving && "animate-spin")} />
            {reviving ? "Reviving…" : "Revive"}
          </Button>
        </div>
      )}
      <div className="mx-auto w-full max-w-[var(--harness-composer-width)] rounded-2xl border bg-card p-2 shadow-glass focus-within:ring-1 focus-within:ring-ring">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
          placeholder={
            disabled ? "Session ended" : thread.turnActive ? "Steer the agent…" : "Message the agent…"
          }
          disabled={disabled}
          rows={1}
          className="max-h-40 min-h-9 w-full resize-none border-0 bg-transparent shadow-none focus-visible:ring-0 dark:bg-transparent"
        />
        <div className="flex items-center gap-1 pt-1">
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <SessionControls sessionId={sessionId} actions={actions} thread={thread} />
          </div>
          {voice.supported && (
            <Button
              variant={voice.listening ? "destructive" : "ghost"}
              size="icon"
              className={cn("size-8 shrink-0 rounded-full", voice.listening && "animate-pulse")}
              onClick={() => (voice.listening ? voice.stop() : voice.start())}
              disabled={disabled}
              title="Voice input"
            >
              <Mic className="size-4" />
            </Button>
          )}
          {thread.turnActive && (
            <Button
              variant="outline"
              size="icon"
              className="size-8 shrink-0 rounded-full"
              onClick={() => actions.stop(sessionId).catch(() => {})}
              title="Stop"
            >
              <Square className="size-3.5" />
            </Button>
          )}
          <Button
            size="icon"
            className="size-8 shrink-0 rounded-full"
            onClick={send}
            disabled={disabled || !text.trim()}
            title={thread.turnActive ? "Send steering message" : "Send"}
          >
            <ArrowUp className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  )
}

function PermissionDialog({ permission }: { permission: PendingPermission | null }) {
  if (!permission) return null
  const { request, resolve } = permission
  return (
    <ResponsiveDialog
      open
      onOpenChange={(open) => !open && resolve({ outcome: { outcome: "cancelled" } })}
    >
      <ResponsiveDialogContent className="sm:max-w-md">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle className="text-base">Permission requested</ResponsiveDialogTitle>
          <ResponsiveDialogDescription className="font-mono text-xs break-all">
            {request.toolCall.title}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <ResponsiveDialogFooter className="flex-col gap-2 sm:flex-col">
          {request.options.map((option) => (
            <Button
              key={option.optionId}
              variant={option.kind.startsWith("allow") ? "default" : "outline"}
              className="w-full"
              onClick={() => resolve({ outcome: { outcome: "selected", optionId: option.optionId } })}
            >
              {option.name}
            </Button>
          ))}
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
