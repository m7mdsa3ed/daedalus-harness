import * as React from "react"
import { ChevronLeftIcon, ChevronRightIcon, DownloadIcon, ImageOffIcon } from "lucide-react"

import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
} from "@/components/ui/attachment"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { fileExtension, fileGlyph, useAttachmentBlob } from "@/components/composer-attachments"
import { downloadAttachment, formatBytes } from "@/lib/attachments"
import { reportError } from "@/lib/errors"
import { useServer } from "@/lib/server-context"
import { ApiError } from "@/lib/settings"
import type { TextItem } from "@/lib/store"
import { cn } from "@/lib/utils"

type Ref = NonNullable<TextItem["attachments"]>[number]

/** Tiles drawn before the rest fold into a "+N" on the last one. */
const MAX_TILES = 6
/** Files listed before the rest fold behind "Show N more". */
const MAX_FILES = 4

/**
 * What a user message carried, drawn above its prose inside the same bubble.
 *
 * The refs are journaled on `turn_started`, so this is identical live and on
 * replay — the one code path rule, unchanged. Pictures and files are two
 * shapes because they are read two ways: a picture is looked at (one is drawn
 * at its own aspect, several as a mosaic, all of them one lightbox you can page
 * through), a file is named (a list, with its type, size and a download — no
 * attempt to render a PDF inline).
 *
 * A 404 is a real state and is drawn as one: attachment rows are deliberately
 * excluded from a backup bundle (the bytes would be the install's disk in a
 * JSON document), so a restored transcript's chips resolve to nothing. Saying
 * "missing" is honest; drawing no chip at all would make the transcript lie
 * about what the user sent.
 */
export function MessageAttachments({ attachments }: { attachments: Ref[] }) {
  /* An oversized image was never kept — it has no pixels to tile, so it is
     listed with the files and says why. */
  const images = attachments.filter((ref) => ref.mimeType.startsWith("image/") && !ref.oversized)
  const files = attachments.filter((ref) => !images.includes(ref))
  const [viewing, setViewing] = React.useState<number | null>(null)
  /* The tiles have already fetched their bytes; the lightbox reuses them. */
  const [urls, setUrls] = React.useState<Record<string, string>>({})
  const onUrl = React.useCallback(
    (id: string, url: string) => setUrls((prev) => (prev[id] === url ? prev : { ...prev, [id]: url })),
    []
  )
  if (attachments.length === 0) return null
  return (
    <div className="flex max-w-full flex-col items-end gap-2 pb-2">
      {images.length > 0 && <ImageMosaic images={images} onOpen={setViewing} onUrl={onUrl} />}
      {files.length > 0 && <FileList files={files} />}
      {images.length > 0 && (
        <Lightbox images={images} urls={urls} index={viewing} onIndex={setViewing} />
      )}
    </div>
  )
}

function ImageMosaic({
  images,
  onOpen,
  onUrl,
}: {
  images: Ref[]
  onOpen: (index: number) => void
  onUrl: (id: string, url: string) => void
}) {
  if (images.length === 1) {
    return <ImageTile image={images[0]} single onOpen={() => onOpen(0)} onUrl={onUrl} />
  }
  const shown = images.slice(0, MAX_TILES)
  const hidden = images.length - shown.length
  // Two and four make even rows of two; anything else reads best in threes.
  const cols = images.length === 2 || images.length === 4 ? "grid-cols-2" : "grid-cols-3"
  return (
    <div className={cn("grid max-w-full gap-1 overflow-hidden rounded-xl", cols)}>
      {shown.map((image, index) => (
        <ImageTile
          key={image.id}
          image={image}
          more={index === shown.length - 1 ? hidden : 0}
          onOpen={() => onOpen(index)}
          onUrl={onUrl}
        />
      ))}
    </div>
  )
}

function ImageTile({
  image,
  single = false,
  more = 0,
  onOpen,
  onUrl,
}: {
  image: Ref
  single?: boolean
  /** Images past the mosaic's cap, counted on this tile. */
  more?: number
  onOpen: () => void
  onUrl: (id: string, url: string) => void
}) {
  /* `inlineData` is the agent's own copy, handed back by a `session/load`
     replay with no harness row behind it — there is nothing to fetch. */
  const fetched = useAttachmentBlob(image.inlineData ? null : image.id)
  const src = image.inlineData ?? fetched.url
  React.useEffect(() => {
    if (src) onUrl(image.id, src)
  }, [src, image.id, onUrl])

  const box = single
    ? "max-h-72 max-w-full min-h-24 min-w-24 rounded-xl border"
    : "size-24 @panel-sm:size-28"

  if (!src) {
    return (
      <div
        title={fetched.failed ? `${image.name} — the harness no longer has this file` : image.name}
        className={cn(
          box,
          "flex items-center justify-center bg-muted text-muted-foreground",
          single && "size-24",
          !fetched.failed && "animate-pulse"
        )}
      >
        {fetched.failed && <ImageOffIcon className="size-5" />}
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      title={image.name}
      aria-label={more > 0 ? `Open ${image.name} and ${more} more` : `Open ${image.name}`}
      className={cn(box, "relative shrink-0 overflow-hidden transition-opacity hover:opacity-90")}
    >
      <img
        src={src}
        alt={image.name}
        className={single ? "max-h-72 w-auto max-w-full object-contain" : "size-full object-cover"}
      />
      {more > 0 && (
        <span className="absolute inset-0 flex items-center justify-center bg-black/55 text-lg font-medium text-white">
          +{more}
        </span>
      )}
    </button>
  )
}

/**
 * Every image in the message, one at a time, with the arrows (and the arrow
 * keys) walking between them. One dialog for the message rather than one per
 * tile, so paging is a state change and not a close-and-reopen.
 */
function Lightbox({
  images,
  urls,
  index,
  onIndex,
}: {
  images: Ref[]
  urls: Record<string, string>
  index: number | null
  onIndex: (index: number | null) => void
}) {
  const settings = useServer()
  const image = index === null ? undefined : images[index]
  const many = images.length > 1
  const step = (by: number) =>
    index !== null && onIndex((index + by + images.length) % images.length)
  return (
    <Dialog open={image !== undefined} onOpenChange={(open) => !open && onIndex(null)}>
      <DialogContent
        className="w-auto max-w-[min(64rem,calc(var(--float-w)-2rem))] gap-2 p-2"
        onKeyDown={(event) => {
          if (!many) return
          if (event.key === "ArrowLeft") step(-1)
          else if (event.key === "ArrowRight") step(1)
          else return
          event.preventDefault()
        }}
      >
        {image && (
          <>
            <DialogTitle className="sr-only">{image.name}</DialogTitle>
            <div className="relative flex items-center justify-center">
              <LightboxImage key={image.id} image={image} known={urls[image.id]} />
              {many && (
                <>
                  <Button
                    variant="secondary"
                    size="icon"
                    aria-label="Previous image"
                    onClick={() => step(-1)}
                    className="absolute left-2 rounded-full opacity-80 hover:opacity-100"
                  >
                    <ChevronLeftIcon />
                  </Button>
                  <Button
                    variant="secondary"
                    size="icon"
                    aria-label="Next image"
                    onClick={() => step(1)}
                    className="absolute right-2 rounded-full opacity-80 hover:opacity-100"
                  >
                    <ChevronRightIcon />
                  </Button>
                </>
              )}
            </div>
            <div className="flex min-w-0 items-center gap-2 px-1 text-sm text-muted-foreground">
              <span className="min-w-0 flex-1 truncate" title={image.name}>
                <span className="font-medium text-foreground">{image.name}</span> ·{" "}
                {formatBytes(image.size)}
              </span>
              {many && (
                <span className="tabular-nums">
                  {(index ?? 0) + 1} / {images.length}
                </span>
              )}
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Download ${image.name}`}
                onClick={() =>
                  void downloadAttachment(settings, image).catch((err) =>
                    reportError(err, `Couldn't download ${image.name}`)
                  )
                }
              >
                <DownloadIcon />
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** An image the mosaic folded away has not been fetched yet — this is its
    one fetch. One the mosaic drew is reused as it is. */
function LightboxImage({ image, known }: { image: Ref; known?: string }) {
  const fetched = useAttachmentBlob(image.inlineData || known ? null : image.id)
  const src = image.inlineData ?? known ?? fetched.url
  if (!src) {
    return (
      <div className="flex size-64 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        {fetched.failed ? <ImageOffIcon className="size-6" /> : null}
      </div>
    )
  }
  return (
    <img
      src={src}
      alt={image.name}
      className="max-h-[calc(var(--float-h)-5rem)] w-auto rounded-lg object-contain"
    />
  )
}

function FileList({ files }: { files: Ref[] }) {
  const [expanded, setExpanded] = React.useState(false)
  /* Folding three away to save one row is not worth the click: fold only
     when it hides at least two. */
  const folded = !expanded && files.length > MAX_FILES
  const shown = folded ? files.slice(0, MAX_FILES - 1) : files
  return (
    <div className="flex w-72 max-w-full flex-col gap-1.5">
      {shown.map((file) => (
        <FileRow key={file.id} file={file} />
      ))}
      {folded && (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => setExpanded(true)}
          className="self-end text-muted-foreground"
        >
          Show {files.length - shown.length} more files
        </Button>
      )}
    </div>
  )
}

function FileRow({ file }: { file: Ref }) {
  const settings = useServer()
  const [failed, setFailed] = React.useState(false)
  const Icon = failed ? ImageOffIcon : fileGlyph(file.mimeType, file.name)
  const ext = fileExtension(file.name)
  return (
    <Attachment size="sm" state={failed ? "error" : "done"} className="w-full min-w-0" title={file.name}>
      <AttachmentMedia>
        <Icon />
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>{file.name}</AttachmentTitle>
        <AttachmentDescription>
          {failed
            ? "the harness no longer has this file"
            : file.oversized
              ? "large image — not kept"
              : [ext, formatBytes(file.size)].filter(Boolean).join(" · ")}
        </AttachmentDescription>
      </AttachmentContent>
      {!failed && !file.oversized && (
        <AttachmentActions>
          <AttachmentAction
            aria-label={`Download ${file.name}`}
            onClick={() =>
              void downloadAttachment(settings, file).catch((err) => {
                // Only a 404 is "gone"; a dropped connection is worth a retry.
                if (err instanceof ApiError && err.status === 404) setFailed(true)
                reportError(err, `Couldn't download ${file.name}`)
              })
            }
          >
            <DownloadIcon />
          </AttachmentAction>
        </AttachmentActions>
      )}
    </Attachment>
  )
}
