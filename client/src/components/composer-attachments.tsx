import * as React from "react"
import {
  ClipboardListIcon,
  FileArchiveIcon,
  FileAudioIcon,
  FileCodeIcon,
  FileIcon,
  FileJsonIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FileVideoIcon,
  ImageIcon,
  LinkIcon,
  MessageSquareQuoteIcon,
  PaperclipIcon,
  RotateCwIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react"
import type * as acp from "@daedalus/acp"

import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
  AttachmentTrigger,
} from "@/components/ui/attachment"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Spinner } from "@/components/ui/spinner"
import { resolveDelivery } from "@daedalus/delivery"
import { attachmentObjectUrl, formatBytes } from "@/lib/attachments"
import { useServer } from "@/lib/server-context"
import type { DraftAttachment } from "@/lib/draft-attachments"
import { optionKey, usePromptCapabilities } from "@/lib/agent-options"
import { pasteToken, type Paste } from "@/lib/pastes"
import { useProfiles } from "@/lib/queries/catalog"
import type { SessionMeta } from "@/lib/settings"
import type { ThreadState } from "@/lib/store"
import { cn } from "@/lib/utils"
import { ComposerStripItem, SHELF_PAD } from "./composer-strip"

/* ── The chip row ──
   What is riding along with the message but is not in the box: a long paste
   parked out of the way, and a file that has been uploaded and will travel with
   the next prompt.

   It is a row on the composer strip rather than a band of its own, for the
   reason everything else on that shelf is: it is state you consult while
   typing, and the shelf already owns the collapse behaviour that keeps one line
   from becoming five.

   Per the container rule, the layout here is `@panel-*`, never `sm:` — a chat
   panel docked beside a terminal is 320px wide inside a 1600px window, and a
   chip row is exactly the kind of thing that would otherwise draw the desktop
   layout there. */

export interface AttachmentDelivery {
  /** The agent's half — from the live session, else the option probe. */
  caps: acp.PromptCapabilities | undefined
  /** The model's half — `ModelDef.modalities` for the thread's current model. */
  modalities: string[] | undefined
  /** Whether the thread's profile carries a catalog at all (the carve-out). */
  hasCatalog: boolean
}

/**
 * What will happen to an attachment on this thread — the agent's half and the
 * model's, ready for `resolveDelivery`.
 *
 * Every piece of it is absolute state that already fans out, so a chip's note
 * re-renders the moment the model changes on a live thread and nothing new is
 * carried for it. The agent's half prefers what THIS session advertised and
 * falls back to what the option probe learned for the (profile, agent) pair —
 * which is what lets a draft, with no process by construction, say whether the
 * screenshot it is holding will reach the model as an image.
 */
export function useAttachmentDelivery(
  meta: SessionMeta | undefined,
  thread: ThreadState
): AttachmentDelivery {
  const profiles = useProfiles()
  const probed = usePromptCapabilities(
    meta ? optionKey(meta.profileId, meta.agentId) : "",
    meta ? [optionKey(`default:${meta.agentId}`, meta.agentId)] : []
  )
  const profileId = meta?.profileId
  const model = meta?.model
  const caps = thread.promptCapabilities ?? probed
  return React.useMemo(() => {
    const profile = profiles.find((entry) => entry.id === profileId)
    const models = profile?.models ?? []
    const entry = models.find((candidate) => candidate.id === model)
    return {
      caps,
      modalities: entry?.modalities,
      /* A profile with no catalog is a different silence from a catalog that
         lists no modalities: it defers to the agent by construction, which is
         exactly where the runtime's own answer is authoritative. */
      hasCatalog: models.length > 0,
    }
  }, [profiles, profileId, model, caps])
}

/** True when something on this failed turn would have been put in the frame —
    which is the only case where re-sending it as paths changes anything. */
export function wentInline(
  item: { retryAttachments?: { mimeType: string; size: number }[] },
  delivery: AttachmentDelivery
): boolean {
  return (item.retryAttachments ?? []).some(
    (ref) =>
      resolveDelivery(ref.mimeType, ref.size, {
        caps: delivery.caps,
        modalities: delivery.modalities,
        hasCatalog: delivery.hasCatalog,
        inlineBudgetLeft: Number.POSITIVE_INFINITY,
      }).delivery !== "link"
  )
}

export function ComposerAttachments({
  attachments,
  delivery,
  onRemoveAttachment,
  onRetryAttachment,
}: {
  attachments: DraftAttachment[]
  delivery: AttachmentDelivery
  onRemoveAttachment: (id: string) => void
  onRetryAttachment: (id: string) => void
}) {
  if (attachments.length === 0) return null
  const label = `${attachments.length} file${attachments.length === 1 ? "" : "s"}`
  const total = attachments.reduce((sum, entry) => sum + entry.size, 0)
  return (
    <ComposerStripItem
      summary={{
        id: "attachments",
        icon: PaperclipIcon,
        label,
        badge: attachments.length,
      }}
      className={cn(SHELF_PAD, "py-1.5")}
    >
      {attachments.length > 1 && (
        <div className="mb-1.5 flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span className="tabular-nums">
            {label} · {formatBytes(total)}
          </span>
          <button
            type="button"
            onClick={() => attachments.forEach((entry) => onRemoveAttachment(entry.id))}
            className="rounded-pill px-1.5 py-0.5 hover:bg-muted hover:text-foreground pointer-coarse:py-1.5"
          >
            Remove all
          </button>
        </div>
      )}
      {/* Wrapped, not a sideways scroller: fifteen chips in one row hid all but
          three of them. The cap keeps a full pile from pushing the box off the
          screen; past it the pile scrolls on its own. */}
      <div className="flex max-h-36 flex-wrap items-center gap-2 overflow-y-auto overscroll-contain">
        {attachments.map((entry) =>
          entry.mimeType.startsWith("image/") ? (
            <ImageTile
              key={entry.id}
              attachment={entry}
              delivery={delivery}
              onRemove={() => onRemoveAttachment(entry.id)}
              onRetry={() => onRetryAttachment(entry.id)}
            />
          ) : (
            <FileChip
              key={entry.id}
              attachment={entry}
              delivery={delivery}
              onRemove={() => onRemoveAttachment(entry.id)}
              onRetry={() => onRetryAttachment(entry.id)}
            />
          )
        )}
      </div>
    </ComposerStripItem>
  )
}

/** The forecast for a ready attachment, from the same `resolveDelivery` the
    bridge calls. */
function forecast(attachment: DraftAttachment, delivery: AttachmentDelivery) {
  if (attachment.status !== "ready") return null
  return resolveDelivery(attachment.mimeType, attachment.size, {
    caps: delivery.caps,
    modalities: delivery.modalities,
    hasCatalog: delivery.hasCatalog,
    /* A forecast, so the budget is the whole of it: what the *other* chips
       will have spent by the time this one is packed is the bridge's to know,
       and guessing it here would make a chip's note change as its neighbours
       came and went. */
    inlineBudgetLeft: Number.POSITIVE_INFINITY,
  })
}

/** A lucide glyph per broad file type — the mime type first, the extension
    where a browser handed over `application/octet-stream`. */
export function fileGlyph(mimeType: string, name: string): LucideIcon {
  const type = mimeType.toLowerCase()
  const ext = fileExtension(name).toLowerCase()
  if (type.startsWith("image/")) return ImageIcon
  if (type.startsWith("audio/")) return FileAudioIcon
  if (type.startsWith("video/")) return FileVideoIcon
  if (type.includes("json") || ext === "json") return FileJsonIcon
  if (/zip|tar|gzip|7z|rar|compressed/.test(type) || ["zip", "tar", "gz", "tgz", "7z", "rar"].includes(ext))
    return FileArchiveIcon
  if (/csv|spreadsheet|excel/.test(type) || ["csv", "tsv", "xls", "xlsx", "ods"].includes(ext))
    return FileSpreadsheetIcon
  if (
    /javascript|typescript|x-python|x-sh|xml|yaml|toml/.test(type) ||
    ["js", "jsx", "ts", "tsx", "py", "rs", "go", "sh", "rb", "java", "c", "cpp", "h", "css", "html", "yml", "yaml", "toml", "sql"].includes(ext)
  )
    return FileCodeIcon
  if (type.startsWith("text/") || type === "application/pdf" || ["md", "txt", "pdf", "doc", "docx"].includes(ext))
    return FileTextIcon
  return FileIcon
}

/** `PDF` for `report.pdf`; empty for a name with no extension. */
export function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".")
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toUpperCase() : ""
}

/**
 * An uploaded file, and — the part that is not decoration — **what will happen
 * to it**.
 *
 * The affordance never changes: you can attach anything to any thread. But the
 * outcome is stated, because a thumbnail the model never saw looks identical to
 * one it did, and the user's only other evidence that the model read their
 * screenshot is that nothing went wrong. The line comes from the same
 * `resolveDelivery` the bridge calls, so the forecast and the decision cannot
 * drift — and it re-renders on a model change for free, since everything it
 * reads is absolute state that already fans out.
 */
function FileChip({
  attachment,
  delivery,
  onRemove,
  onRetry,
}: {
  attachment: DraftAttachment
  delivery: AttachmentDelivery
  onRemove: () => void
  onRetry: () => void
}) {
  const note = forecast(attachment, delivery)?.reason
  const Icon = fileGlyph(attachment.mimeType, attachment.name)
  const ext = fileExtension(attachment.name)
  return (
    <Attachment
      size="sm"
      state={attachment.status === "ready" ? "done" : attachment.status}
      className="max-w-full min-w-0 @panel-sm:max-w-64"
      title={note ? `${attachment.name} — ${note}` : attachment.name}
    >
      <AttachmentMedia>{attachment.status === "uploading" ? <Spinner /> : <Icon />}</AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>{attachment.name}</AttachmentTitle>
        <AttachmentDescription className={cn(attachment.status === "error" && "text-destructive")}>
          {attachment.status === "uploading"
            ? "Uploading…"
            : attachment.status === "error"
              ? (attachment.error ?? "Upload failed") + " — tap to retry"
              : [ext, formatBytes(attachment.size), note].filter(Boolean).join(" · ")}
        </AttachmentDescription>
      </AttachmentContent>
      {attachment.status === "error" && (
        <AttachmentTrigger aria-label={`Retry uploading ${attachment.name}`} onClick={onRetry} />
      )}
      <AttachmentActions>
        <AttachmentAction aria-label={`Remove ${attachment.name}`} onClick={onRemove}>
          <XIcon />
        </AttachmentAction>
      </AttachmentActions>
    </Attachment>
  )
}

/**
 * An image is its own picture, not a chip with a postage stamp in it. The
 * forecast still has to be said, so the tile carries it as its tooltip, and
 * when the model will *not* see the pixels (sent as a path instead) a mark on
 * the corner says so without a hover — that is the case the note exists for.
 */
function ImageTile({
  attachment,
  delivery,
  onRemove,
  onRetry,
}: {
  attachment: DraftAttachment
  delivery: AttachmentDelivery
  onRemove: () => void
  onRetry: () => void
}) {
  const thumb = useAttachmentUrl(attachment.status === "ready" ? attachment.id : null)
  const outcome = forecast(attachment, delivery)
  const failed = attachment.status === "error"
  const title = failed
    ? `${attachment.error ?? "Upload failed"} — click to retry`
    : outcome
      ? `${attachment.name} · ${formatBytes(attachment.size)} — ${outcome.reason}`
      : attachment.name
  return (
    <div
      data-slot="attachment"
      title={title}
      className={cn(
        "group/tile relative size-14 shrink-0 overflow-hidden rounded-xl border bg-muted",
        failed && "border-destructive/40 bg-destructive/10 text-destructive"
      )}
    >
      {thumb ? (
        <img src={thumb} alt={attachment.name} className="size-full object-cover" />
      ) : (
        <div className="flex size-full items-center justify-center text-muted-foreground">
          {attachment.status === "uploading" ? <Spinner /> : <ImageIcon className="size-5" />}
        </div>
      )}
      {failed && (
        <button
          type="button"
          onClick={onRetry}
          aria-label={`Retry uploading ${attachment.name}`}
          className="absolute inset-0 flex items-center justify-center bg-destructive/10 text-destructive"
        >
          <RotateCwIcon className="size-4" />
        </button>
      )}
      {outcome && outcome.delivery === "link" && (
        <span className="absolute bottom-1 left-1 flex size-4 items-center justify-center rounded-full bg-background/90 text-muted-foreground shadow-sm">
          <LinkIcon className="size-2.5" />
        </span>
      )}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${attachment.name}`}
        className="absolute top-1 right-1 flex size-5 items-center justify-center rounded-full bg-background/90 text-foreground opacity-0 shadow-sm transition-opacity group-hover/tile:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
      >
        <XIcon className="size-3" />
      </button>
    </div>
  )
}

/**
 * A blob URL for an attachment, revoked when it goes.
 *
 * A bearer-header `fetch` rather than an `<img src>`: an `<img>` cannot carry
 * the header, and a `?token=` in a `src` puts the credential in every referrer
 * and cache key. Same reasoning, and the same shape, as `readFileObjectUrl`.
 *
 * The server comes from the scope this transcript is drawn inside rather than
 * from a prop: a chip is rendered several layers down inside a message, and
 * every one of those layers would have to carry an id it has no other use for.
 * `useServer()` is "the server this subtree is about", which for a transcript
 * is the thread's own — the chat panel is what mounts that scope, and until
 * the panel is converted this is the connection the rest of the panel is
 * already reading from, so the two cannot disagree.
 */
export function useAttachmentUrl(id: string | null): string | undefined {
  return useAttachmentBlob(id).url
}

/** `useAttachmentUrl`, plus whether the fetch failed — so a caller can tell
    "still loading" from "the harness no longer has this file" instead of
    drawing every image as missing until its bytes arrive. */
export function useAttachmentBlob(id: string | null): { url?: string; failed: boolean } {
  const settings = useServer()
  const [state, setState] = React.useState<{ url?: string; failed: boolean }>({ failed: false })
  React.useEffect(() => {
    setState({ failed: false })
    if (!id) return
    const controller = new AbortController()
    let created: string | undefined
    attachmentObjectUrl(settings, id, controller.signal)
      .then((next) => {
        created = next
        setState({ url: next, failed: false })
      })
      .catch(() => {
        // A 404 is the "missing" state (a restored backup carries no bytes) and
        // is drawn by the caller's fallback, not reported: the transcript is
        // full of them at once or not at all.
        if (!controller.signal.aborted) setState({ failed: true })
      })
    return () => {
      controller.abort()
      if (created) URL.revokeObjectURL(created)
    }
  }, [id, settings])
  return state
}
