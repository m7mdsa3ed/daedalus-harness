/* ── The project browser's tools ──
   Calls into the harness's `browser` MCP server, read in `lib/tools/browser.ts`
   (matched on the leaf name and the server, never here). A browser step is
   about a page, so the view leads with the page: an `act` or `navigate` is one
   line — verb, element, where the page ended up — a `snapshot` folds to its
   first lines, and a `screenshot` is the image it already carries. The rest
   keep the page line and draw their answer as text. */
import * as React from "react"
import { GlobeIcon } from "lucide-react"
import { ToolCallSkeleton } from "@/components/ui/skeletons"
import { CodeBlock, DetailSection, PANE_PAD, SmartBlock } from "@/components/tool-parts"
import {
  browserElementName,
  browserInput,
  browserVerb,
  displayUrl,
  extractBrowserCall,
  type BrowserCall,
} from "@/lib/tools"
import type { ToolItem } from "@/lib/store"
import { useStoreSelect } from "@/lib/store"
import { useThreadId } from "@/lib/thread-id-context"
import { cn } from "@/lib/utils"

/** Snapshot lines drawn before the fold. */
const SNAPSHOT_PEEK = 12

export function BrowserDetail({ item, active }: { item: ToolItem; active: boolean }) {
  const call = extractBrowserCall(item)
  if (!call) return null
  const answer = call.snapshot.length || call.image || call.page ? null : call.text.trim()
  return (
    <div className="space-y-2">
      {call.tool === "act" || call.tool === "navigate" ? (
        <ActLine item={item} call={call} />
      ) : (
        call.page && <PageLine call={call} />
      )}
      {call.failed && call.head && !call.page && <SmartBlock text={call.text} tone="error" />}
      {call.image && (
        <img
          src={`data:${call.image.mimeType};base64,${call.image.data}`}
          alt={call.page ? `Screenshot of ${call.page.url}` : "Screenshot"}
          className="max-h-96 w-fit max-w-full rounded-lg border object-contain"
        />
      )}
      {call.snapshot.length > 0 && <SnapshotFold lines={call.snapshot} />}
      {answer && !call.failed && <SmartBlock text={answer} />}
      {active && !call.text.trim() && !call.image && <ToolCallSkeleton className="py-1" />}
    </div>
  )
}

/** `Click button "Sign in" → example.com/account`. The element is named from
    the snapshot that issued the uid, which is an earlier step's answer. */
function ActLine({ item, call }: { item: ToolItem; call: BrowserCall }) {
  const threadId = useThreadId()
  const uid = typeof call.args.uid === "string" ? call.args.uid : null
  const element = useStoreSelect((state) =>
    uid && threadId ? browserElementName(state.threads[threadId]?.items ?? [], item.id, uid) : null
  )
  const input = browserInput(call)
  const asked = call.tool === "navigate" && typeof call.args.url === "string" ? call.args.url : null
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-sm leading-5">
      <GlobeIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="text-foreground">{browserVerb(call)}</span>
      {(element ?? uid) && <span className="min-w-0 truncate font-mono text-foreground">{element ?? `[${uid}]`}</span>}
      {input && <span className="min-w-0 truncate font-mono text-muted-foreground">{input}</span>}
      {call.page ? (
        <>
          <span className="text-muted-foreground">→</span>
          <PageLink url={call.page.url} title={call.page.title} />
        </>
      ) : (
        asked && <PageLink url={asked} />
      )}
      {call.head && !/ done$|^navigated$|^status 2\d\d$/.test(call.head) && (
        <span className={cn("shrink-0", call.failed ? "text-destructive" : "text-muted-foreground")}>{call.head}</span>
      )}
    </div>
  )
}

function PageLine({ call }: { call: BrowserCall }) {
  if (!call.page) return null
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-sm leading-5">
      <GlobeIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <PageLink url={call.page.url} title={call.page.title} />
      {call.page.title && <span className="min-w-0 truncate text-muted-foreground">{call.page.title}</span>}
    </div>
  )
}

function PageLink({ url, title }: { url: string; title?: string }) {
  const http = /^https?:\/\//i.test(url)
  return (
    <a
      href={http ? url : undefined}
      target="_blank"
      rel="noreferrer"
      title={title ? `${title}\n${url}` : url}
      className={cn("min-w-0 truncate font-mono", http ? "text-primary hover:underline" : "text-muted-foreground")}
    >
      {displayUrl(url)}
    </a>
  )
}

/** The accessibility tree, folded to its first lines: the top of a page says
    what it is, and the whole tree is one click behind. */
function SnapshotFold({ lines }: { lines: string[] }) {
  const [open, setOpen] = React.useState(false)
  const over = lines.length > SNAPSHOT_PEEK
  const shown = open || !over ? lines : lines.slice(0, SNAPSHOT_PEEK)
  return (
    <DetailSection label={`Snapshot · ${lines.length} ${lines.length === 1 ? "node" : "nodes"}`}>
      <CodeBlock>{shown.join("\n")}</CodeBlock>
      {over && (
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className={cn(PANE_PAD, "block w-full py-1 text-start text-xs text-muted-foreground hover:text-foreground")}
        >
          {open ? "Fold the snapshot" : `Show ${lines.length - SNAPSHOT_PEEK} more lines`}
        </button>
      )}
    </DetailSection>
  )
}
