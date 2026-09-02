import * as React from "react"
import { ClipboardListIcon, FileIcon, FileTextIcon, ImageIcon, PaperclipIcon, XIcon } from "lucide-react"
import type * as acp from "@agentclientprotocol/sdk"

import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
  AttachmentTrigger,
} from "@/components/ui/attachment"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Spinner } from "@/components/ui/spinner"
import { resolveDelivery } from "@daedalus/delivery"
import { attachmentObjectUrl } from "@/lib/attachments"
import { useServer } from "@/lib/server-context"
import type { DraftAttachment } from "@/lib/draft-attachments"
import { optionKey, usePromptCapabilities } from "@/lib/agent-options"
import { pasteToken, type Paste } from "@/lib/pastes"
import { useProfiles } from "@/lib/queries/catalog"
import type { SessionMeta } from "@/lib/settings"
import type { ThreadState } from "@/lib/store"
import { cn } from "@/lib/utils"
import { ComposerStripItem } from "./composer-strip"

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
  pastes,
  attachments,
  delivery,
  onRemovePaste,
  onRemoveAttachment,
  onRetryAttachment,
}: {
  pastes: Paste[]
  attachments: DraftAttachment[]
  delivery: AttachmentDelivery
  onRemovePaste: (n: number) => void
  onRemoveAttachment: (id: string) => void
  onRetryAttachment: (id: string) => void
}) {
  if (pastes.length === 0 && attachments.length === 0) return null
  const parts = [
    attachments.length > 0
      ? `${attachments.length} file${attachments.length === 1 ? "" : "s"}`
      : null,
    pastes.length > 0
      ? `${pastes.length} pasted block${pastes.length === 1 ? "" : "s"}`
      : null,
  ].filter(Boolean)
  return (
    <ComposerStripItem
      summary={{
        id: "attachments",
        icon: attachments.length > 0 ? PaperclipIcon : ClipboardListIcon,
        label: parts.join(" · "),
      }}
      className="px-2 py-1.5"
    >
      <AttachmentGroup className="gap-2 py-0">
        {attachments.map((entry) => (
          <FileChip
            key={entry.id}
            attachment={entry}
            delivery={delivery}
            onRemove={() => onRemoveAttachment(entry.id)}
            onRetry={() => onRetryAttachment(entry.id)}
          />
        ))}
        {pastes.map((paste) => (
          <PasteChip key={paste.n} paste={paste} onRemove={() => onRemovePaste(paste.n)} />
        ))}
      </AttachmentGroup>
    </ComposerStripItem>
  )
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
  const image = attachment.mimeType.startsWith("image/")
  const thumb = useAttachmentUrl(attachment.status === "ready" && image ? attachment.id : null)
  const note =
    attachment.status === "ready"
      ? resolveDelivery(attachment.mimeType, attachment.size, {
          caps: delivery.caps,
          modalities: delivery.modalities,
          hasCatalog: delivery.hasCatalog,
          /* A forecast, so the budget is the whole of it: what the *other*
             chips will have spent by the time this one is packed is the
             bridge's to know, and guessing it here would make a chip's note
             change as its neighbours came and went. */
          inlineBudgetLeft: Number.POSITIVE_INFINITY,
        }).reason
      : null
  const Icon = image ? ImageIcon : attachment.mimeType.startsWith("text/") ? FileTextIcon : FileIcon
  return (
    <Attachment
      size="sm"
      state={attachment.status === "ready" ? "done" : attachment.status}
      className="min-w-0 @panel-sm:min-w-40"
    >
      <AttachmentMedia variant={thumb ? "image" : "icon"}>
        {attachment.status === "uploading" ? (
          <Spinner />
        ) : thumb ? (
          <img src={thumb} alt="" />
        ) : (
          <Icon />
        )}
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>{attachment.name}</AttachmentTitle>
        <AttachmentDescription className={cn(attachment.status === "error" && "text-destructive")}>
          {attachment.status === "uploading"
            ? "Uploading…"
            : attachment.status === "error"
              ? (attachment.error ?? "Upload failed") + " — tap to retry"
              : note}
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

/** The token's face. Clicking it shows what is parked behind it; the ✕ takes
    both the chip and its token, because a chip is a *view* of a token and one
    without the other is a claim the composer cannot honour. */
function PasteChip({ paste, onRemove }: { paste: Paste; onRemove: () => void }) {
  const [open, setOpen] = React.useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Attachment size="sm" className="min-w-0 @panel-sm:min-w-40">
        <AttachmentMedia>
          <ClipboardListIcon />
        </AttachmentMedia>
        <AttachmentContent>
          <AttachmentTitle>Pasted text #{paste.n}</AttachmentTitle>
          <AttachmentDescription>
            {paste.lines.toLocaleString()} line{paste.lines === 1 ? "" : "s"} ·{" "}
            {paste.chars.toLocaleString()} chars
          </AttachmentDescription>
        </AttachmentContent>
        {/* The whole card opens the preview; the ✕ sits above it (`z-20` on
            AttachmentActions) so the two do not fight over one click. */}
        <PopoverTrigger render={<AttachmentTrigger aria-label={`Preview ${pasteToken(paste.n)}`} />} />
        <AttachmentActions>
          <AttachmentAction aria-label={`Remove ${pasteToken(paste.n)}`} onClick={onRemove}>
            <XIcon />
          </AttachmentAction>
        </AttachmentActions>
      </Attachment>
      <PopoverContent className="w-[min(32rem,calc(100vw-2rem))] p-0">
        <div className="border-b px-3 py-2 text-xs text-muted-foreground">
          {pasteToken(paste.n)} — sent in place of the token, fenced.
        </div>
        <pre className="max-h-72 overflow-auto p-3 text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">
          {paste.text}
        </pre>
      </PopoverContent>
    </Popover>
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
  const settings = useServer()
  const [url, setUrl] = React.useState<string>()
  React.useEffect(() => {
    setUrl(undefined)
    if (!id) return
    const controller = new AbortController()
    let created: string | undefined
    attachmentObjectUrl(settings, id, controller.signal)
      .then((next) => {
        created = next
        setUrl(next)
      })
      .catch(() => {
        // A 404 is the "missing" state (a restored backup carries no bytes) and
        // is drawn by the caller's fallback, not reported: the transcript is
        // full of them at once or not at all.
      })
    return () => {
      controller.abort()
      if (created) URL.revokeObjectURL(created)
    }
  }, [id, settings])
  return url
}
