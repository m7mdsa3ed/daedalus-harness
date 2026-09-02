import * as React from "react"
import { DownloadIcon, FileIcon, FileTextIcon, ImageIcon, ImageOffIcon } from "lucide-react"

import {
  Attachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
  AttachmentTrigger,
} from "@/components/ui/attachment"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { useAttachmentUrl } from "@/components/composer-attachments"
import { formatBytes } from "@/lib/attachments"
import type { TextItem } from "@/lib/store"

type Ref = NonNullable<TextItem["attachments"]>[number]

/**
 * What a user message carried, drawn above its prose inside the same bubble.
 *
 * The refs are journaled on `turn_started`, so this is identical live and on
 * replay — the one code path rule, unchanged. An image is a thumbnail that
 * opens a lightbox; everything else is a name and a size with a download,
 * because there is no attempt to render a PDF inline.
 *
 * A 404 is a real state and is drawn as one: attachment rows are deliberately
 * excluded from a backup bundle (the bytes would be the install's disk in a
 * JSON document), so a restored transcript's chips resolve to nothing. Saying
 * "missing" is honest; drawing no chip at all would make the transcript lie
 * about what the user sent.
 */
export function MessageAttachments({ attachments }: { attachments: Ref[] }) {
  if (attachments.length === 0) return null
  return (
    <AttachmentGroup className="max-w-full justify-end gap-2 pb-1.5">
      {attachments.map((ref) => (
        <MessageAttachment key={ref.id} attachment={ref} />
      ))}
    </AttachmentGroup>
  )
}

function MessageAttachment({ attachment }: { attachment: Ref }) {
  const image = attachment.mimeType.startsWith("image/")
  /* `inlineData` is the agent's own copy, handed back by a `session/load`
     replay with no harness row behind it — there is nothing to fetch. An
     oversized one carries neither, and says so. */
  const fetched = useAttachmentUrl(
    image && !attachment.inlineData && !attachment.oversized ? attachment.id : null
  )
  const src = attachment.inlineData ?? fetched
  const missing = image && !attachment.oversized && !src
  const [open, setOpen] = React.useState(false)

  if (image && src) {
    return (
      <Dialog open={open} onOpenChange={setOpen}>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="max-w-48 shrink-0 overflow-hidden rounded-xl border transition-opacity hover:opacity-90"
        >
          <img src={src} alt={attachment.name} className="max-h-48 w-full object-cover" />
        </button>
        <DialogContent className="w-auto max-w-[min(64rem,calc(100vw-2rem))] p-2">
          <DialogTitle className="sr-only">{attachment.name}</DialogTitle>
          <img
            src={src}
            alt={attachment.name}
            className="max-h-[80vh] w-auto rounded-lg object-contain"
          />
        </DialogContent>
      </Dialog>
    )
  }

  const Icon = missing
    ? ImageOffIcon
    : image
      ? ImageIcon
      : attachment.mimeType.startsWith("text/")
        ? FileTextIcon
        : FileIcon
  return (
    <Attachment size="sm" state={missing ? "error" : "done"} className="min-w-0 @panel-sm:min-w-40">
      <AttachmentMedia>
        <Icon />
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>{attachment.name}</AttachmentTitle>
        <AttachmentDescription>
          {missing
            ? "the harness no longer has this file"
            : attachment.oversized
              ? "large image — not kept"
              : formatBytes(attachment.size)}
        </AttachmentDescription>
      </AttachmentContent>
      {!missing && !attachment.oversized && !attachment.inlineData && (
        <AttachmentTrigger
          render={<DownloadLink attachment={attachment} />}
          aria-label={`Download ${attachment.name}`}
        />
      )}
    </Attachment>
  )
}

/** Downloading is the same bearer-header fetch a thumbnail is — an `<a href>`
    to the route would carry no token, and a `?token=` in one puts the
    credential in the browser's history. */
function DownloadLink({ attachment, ...props }: { attachment: Ref } & React.ComponentProps<"button">) {
  const url = useAttachmentUrl(attachment.id)
  return (
    <button
      type="button"
      {...props}
      onClick={() => {
        if (!url) return
        const link = document.createElement("a")
        link.href = url
        link.download = attachment.name
        link.click()
      }}
    >
      <DownloadIcon className="sr-only" />
    </button>
  )
}
