import * as React from "react"
import { ArrowUp, Mic, RotateCw, Square } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { ActivityIndicator, ComposerPlan, ContextIndicator } from "@/components/composer-status"
import { TranscriptSkeleton } from "@/components/ui/skeletons"
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
import { useStore, emptyThread, type ThreadState } from "@/lib/store"
import { cn } from "@/lib/utils"
import { SessionConfigPopover } from "./session-config"
import { InlineToolApproval } from "./tool-approval"
import { ThreadItemView } from "./thread-items"

export function ThreadView({ sessionId, actions }: { sessionId: string; actions: Actions }) {
  const { state } = useStore()
  const thread = state.threads[sessionId] ?? emptyThread
  const loading =
    thread.status === "connecting" ||
    (thread.status === "idle" && thread.items.length === 0)

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
              {loading && (
                <MessageScrollerItem messageId="connecting">
                  <div className="py-2">
                    <TranscriptSkeleton />
                  </div>
                </MessageScrollerItem>
              )}
              {!loading && thread.items.length === 0 && (
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
              {thread.items
                .filter((item) => item.kind !== "plan")
                .map((item) => (
                  // A new anchor gets scrolled to the top of the viewport, so the
                  // anchor is the user's message — the turn then streams below it.
                <MessageScrollerItem
                  key={item.id}
                  messageId={item.id}
                  scrollAnchor={item.kind === "user"}
                >
                  <ThreadItemView item={item} />
                </MessageScrollerItem>
                ))}
              {thread.turnActive && (
                <MessageScrollerItem messageId="working">
                  <div className="py-0.5">
                    <ActivityIndicator step={thread.items.length} />
                  </div>
                </MessageScrollerItem>
              )}
              {thread.permission && (
                <MessageScrollerItem messageId="permission">
                  <div className="py-1">
                    <InlineToolApproval permission={thread.permission} />
                  </div>
                </MessageScrollerItem>
              )}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>
      <Composer sessionId={sessionId} actions={actions} thread={thread} />
    </div>
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
          <Button size="lg" variant="outline" onClick={revive} disabled={reviving}>
            <RotateCw className={cn("size-4", reviving && "animate-spin")} />
            {reviving ? "Reviving…" : "Revive"}
          </Button>
        </div>
      )}
      <div className="mx-auto w-full max-w-[var(--harness-composer-width)] rounded-2xl border bg-card p-2 shadow-glass focus-within:ring-1 focus-within:ring-ring">
        <ComposerPlan thread={thread} />
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // ponytail: Enter = newline; Cmd/Ctrl+Enter sends
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
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
            <SessionConfigPopover sessionId={sessionId} actions={actions} thread={thread} />
          </div>
          <ContextIndicator thread={thread} />
          {voice.supported && (
            <Button
              variant={voice.listening ? "destructive" : "ghost"}
              size="icon-lg"
              className={cn("shrink-0 rounded-full", voice.listening && "animate-pulse")}
              onClick={() => (voice.listening ? voice.stop() : voice.start())}
              disabled={disabled}
              title="Voice input"
            >
              <Mic />
            </Button>
          )}
          {thread.turnActive && (
            <Button
              variant="outline"
              size="icon-lg"
              className="shrink-0 rounded-full"
              onClick={() => actions.stop(sessionId).catch(() => {})}
              title="Stop"
            >
              <Square />
            </Button>
          )}
          <Button
            size="icon-lg"
            className="shrink-0 rounded-full"
            onClick={send}
            disabled={disabled || !text.trim()}
            title={thread.turnActive ? "Send steering message" : "Send"}
          >
            <ArrowUp />
          </Button>
        </div>
      </div>
    </div>
  )
}
