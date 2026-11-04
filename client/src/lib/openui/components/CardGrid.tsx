/* ── CardGrid ──
   Places, products, options. A card is a banner (the photo, else a colour wash
   with the name's initial), a number, a meta chip, text and tags.

   A photo keeps `Image`'s rule: a remote one loads on a click naming its host,
   and one consent covers the whole set. A card with coordinates has a "Show on
   map" button, and the map is ONE panel under the whole grid, never inside a
   card — picking another card re-points it, and it is not mounted (a billed
   load) until the first pick.

   Text is clamped and the footer pinned, so a row of cards is one height at
   any width. */
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react"
import { z } from "zod/v4"
import { ChevronDown, ChevronRight, Image as ImageIcon, MapPin, Navigation, Star, X } from "lucide-react"
import { defineComponent } from "@openuidev/react-lang"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button as UiButton } from "@/components/ui/button"
import { Carousel, CarouselContent, CarouselItem, CarouselNext, CarouselPrevious } from "@/components/ui/carousel"
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item"
import { Skeleton } from "@/components/ui/skeleton"
import { BODY, Box, FLOW, META, PAD, TITLE, WELL_PAD } from "@/lib/openui/kit"
import { imageSource } from "@/lib/openui/components/Image"
import { MAP_COLORS } from "@/lib/openui/components/Map"
import { usePlacePhoto, type PlacePhoto } from "@/lib/openui/place-photo"

const GoogleMap = lazy(() => import("@/lib/openui/google-map"))

type GridOrigin = { label: string; latitude: number; longitude: number }
type GridItem = {
  title: string; text?: string; meta?: string; image?: string; alt?: string; tags?: string[]
  rating?: number; price?: string; facts?: { label: string; value: string }[]
  latitude?: number; longitude?: number
}

export const CardGrid = defineComponent({
  name: "CardGrid",
  description:
    "A grid of rich cards, each with a title, optional photo (https or data: URL) with alt, short text, meta line (distance or time), tags, a 0-5 rating, a price line, up to four facts (label and value, e.g. Best time, Stay) and optional latitude/longitude that adds a Show on map button. The map opens in one panel at the bottom of the grid, only when a card is picked. Optional origin (label, latitude, longitude) adds driving directions from there to the picked card. Set carousel to true to swipe through the cards in a row instead of a grid (for more than four). Good for places, hotels or products.",
  props: z.object({
    items: z.array(
      z.object({
        title: z.string(),
        text: z.string().optional(),
        meta: z.string().optional(),
        image: z.string().optional(),
        alt: z.string().optional(),
        tags: z.array(z.string()).optional(),
        rating: z.number().min(0).max(5).optional(),
        price: z.string().optional(),
        facts: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
        latitude: z.number().min(-90).max(90).optional(),
        longitude: z.number().min(-180).max(180).optional(),
      })
    ),
    origin: z.object({ label: z.string(), latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) }).optional(),
    carousel: z.boolean().optional(),
  }),
  component: ({ props }) => <CardGridView {...props} />,
})

function CardGridView({ items, origin, carousel }: { items: GridItem[]; origin?: GridOrigin; carousel?: boolean }) {
  const [picked, setPicked] = useState<number | null>(null)
  // One consent for every photo in the set: the hosts it names, and the server looking places up.
  const [photos, setPhotos] = useState(false)
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (picked !== null) panel.current?.scrollIntoView({ block: "nearest", behavior: "smooth" })
  }, [picked])
  // The parser hands back fresh arrays while a fence streams; keep the map's inputs stable.
  const key = JSON.stringify([items.map((i) => [i.title, i.latitude, i.longitude]), origin])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const places = useMemo(
    () => items.map((item, index) => ({ item, index })).filter(({ item }) => item.latitude !== undefined && item.longitude !== undefined),
    [key]
  )
  const locations = useMemo(
    () => [
      ...(origin ? [{ label: origin.label, latitude: origin.latitude, longitude: origin.longitude }] : []),
      ...places.map(({ item }) => ({ label: item.title, latitude: item.latitude!, longitude: item.longitude! })),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key]
  )
  const hosts = [...new Set(items.map((i) => imageSource(i.image ?? "").host).filter((h): h is string => Boolean(h)))]
  const lookups = items.some((i) => !i.image && i.latitude !== undefined && i.longitude !== undefined)
  const photoSources = [...hosts, ...(lookups ? ["Google Places"] : [])]
  const pick = picked === null ? null : items[picked]
  const routes = useMemo(
    () =>
      pick && origin
        ? [{ name: `${origin.label} to ${pick.title}`, stops: [origin.label, pick.title], mode: "drive" as const }]
        : [],
    [pick, origin]
  )
  // The origin is the first marker, so a card's own index moves by one when one is given.
  const focus = pick ? locations.findIndex((l) => l.label === pick.title) : -1
  return (
    <div className={FLOW}>
      {!photos && photoSources.length > 0 && (
        <Item
          variant="outline"
          size="xs"
          className="flex-nowrap rounded-md text-start hover:bg-wash-strong"
          render={<button type="button" onClick={() => setPhotos(true)} />}
        >
          <ItemMedia variant="icon">
            <ImageIcon aria-hidden className="text-muted-foreground" />
          </ItemMedia>
          <ItemContent className="min-w-0">
            <ItemTitle>Show photos</ItemTitle>
            <ItemDescription className="text-[0.75rem]">Loads from {photoSources.join(", ")}</ItemDescription>
          </ItemContent>
          <ItemActions>
            <ChevronRight aria-hidden className="size-4 text-muted-foreground" />
          </ItemActions>
        </Item>
      )}
      {carousel ? (
        <Carousel opts={{ align: "start" }} className="w-full min-w-0">
          <CarouselContent>
            {items.map((item, index) => (
              <CarouselItem key={index} className="basis-[92%] @panel-sm:basis-[62%] @panel-md:basis-[48%]">
                <GridCard index={index} item={item} photos={photos} selected={picked === index} onPick={() => setPicked(picked === index ? null : index)} />
              </CarouselItem>
            ))}
          </CarouselContent>
          {items.length > 1 && (
            <>
              <CarouselPrevious className="left-2" />
              <CarouselNext className="right-2" />
            </>
          )}
        </Carousel>
      ) : (
        <div className="grid w-full min-w-0 grid-cols-1 gap-2.5 @panel-sm:grid-cols-[repeat(auto-fill,minmax(min(100%,18rem),1fr))] @panel-sm:gap-3">
          {items.map((item, index) => (
            <GridCard key={index} index={index} item={item} photos={photos} selected={picked === index} onPick={() => setPicked(picked === index ? null : index)} />
          ))}
        </div>
      )}
      {pick && (
        <div ref={panel} className="scroll-mb-4">
          <Box>
            <div className={cn("flex items-center gap-2.5 border-b border-rule", WELL_PAD)}>
              <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-foreground">
                <MapPin aria-hidden className="size-3.5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className={cn(TITLE, "block")}>{pick.title}</span>
                <span className={META}>{origin ? `Driving from ${origin.label}` : "On the map"}</span>
              </span>
              <UiButton type="button" variant="ghost" size="icon-sm" title="Hide map" onClick={() => setPicked(null)}>
                <X aria-hidden />
              </UiButton>
            </div>
            <Suspense fallback={<Skeleton aria-busy="true" className="h-24 w-full rounded-none" />}>
              <GoogleMap
                locations={locations}
                routes={routes}
                colors={MAP_COLORS}
                focus={focus >= 0 ? focus : null}
                onFocus={noop}
                label={pick.title}
              />
            </Suspense>
          </Box>
        </div>
      )}
    </div>
  )
}

function GridCard({
  index,
  item,
  photos,
  selected,
  onPick,
}: {
  index: number
  item: GridItem
  photos: boolean
  selected: boolean
  onPick: () => void
}) {
  const { title, text, meta, image, alt, tags } = item
  const { inline, host } = imageSource(image ?? "")
  const [failed, setFailed] = useState(false)
  const hasPlace = item.latitude !== undefined && item.longitude !== undefined
  // A given URL wins; with none, a place is looked up by name once the reader has asked for photos.
  const looked = usePlacePhoto(photos && !image && hasPlace ? title : null, hasPlace ? [item.latitude!, item.longitude!] : undefined)
  const photo: PlacePhoto | null = !failed && (inline || (photos && host)) && image ? { url: image } : (looked ?? null)
  // The card is its own container: stacked (photo on top) while narrow, photo on the side once it has room.
  return (
    <Box className={cn("@container flex h-full flex-col @min-[26rem]:flex-row", selected && "ring-2 ring-primary")}>
      <div className="relative h-32 w-full shrink-0 overflow-hidden border-b border-rule bg-muted @min-[26rem]:h-auto @min-[26rem]:w-32 @min-[26rem]:self-stretch @min-[26rem]:border-e @min-[26rem]:border-b-0">
        {photo ? (
          <img
            src={photo.url}
            alt={alt ?? title}
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setFailed(true)}
            className="absolute inset-0 size-full object-cover"
          />
        ) : (
          <MapPin aria-hidden className="absolute top-1/2 left-1/2 size-7 -translate-x-1/2 -translate-y-1/2 text-muted-foreground" />
        )}
        {photo?.attribution && (
          <span className="absolute inset-x-0 bottom-0 truncate bg-background/80 px-2 py-0.5 text-[0.625rem] text-muted-foreground">
            Photo: {photo.attribution}
          </span>
        )}
      </div>
      <div className={cn("flex min-w-0 flex-1 flex-col gap-1.5", PAD)}>
        <div className="space-y-0.5">
          <div className="flex min-w-0 items-start justify-between gap-2">
            <div className={cn(TITLE, "text-[length:calc(var(--text-sm,0.875rem)-0.0625rem)]")}>
              <span className="text-muted-foreground tabular-nums">{index + 1}. </span>
              {title}
            </div>
            {item.rating !== undefined && (
              <span className="inline-flex shrink-0 items-center gap-0.5 text-[0.75rem] font-medium tabular-nums">
                <Star aria-hidden className="size-3 fill-warning text-warning" />
                {item.rating.toFixed(1)}
              </span>
            )}
          </div>
          {meta && (
            <div className={cn(META, "flex items-center gap-1")}>
              <Navigation aria-hidden className="size-2.5 shrink-0" />
              <span className="min-w-0 truncate">{meta}</span>
            </div>
          )}
        </div>
        {text && <p className={cn(BODY, "line-clamp-2 text-pretty")}>{text}</p>}
        {item.facts && item.facts.length > 0 && (
          <dl className="divide-y divide-rule border-y border-rule">
            {item.facts.slice(0, 4).map((fact, i) => (
              <div key={i} className="flex min-w-0 items-baseline justify-between gap-3 py-1">
                <dt className="min-w-0 text-[0.75rem] text-muted-foreground">{fact.label}</dt>
                <dd className="min-w-0 text-end text-[0.75rem] font-medium break-words text-foreground">{fact.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {tags && tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {tags.slice(0, 3).map((tag, i) => (
              <Badge key={i} variant="secondary" className="h-auto max-w-full rounded-md px-1.5 text-[0.6875rem] whitespace-normal break-words">
                {tag}
              </Badge>
            ))}
          </div>
        )}
        <div className="mt-auto flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1.5 pt-1">
          {item.price ? <span className={cn(TITLE, "text-[length:calc(var(--text-sm,0.875rem)-0.0625rem)] tabular-nums")}>{item.price}</span> : <span />}
          {hasPlace && (
            <UiButton type="button" size="sm" variant={selected ? "default" : "outline"} aria-pressed={selected} onClick={onPick}>
              {selected ? <ChevronDown aria-hidden data-icon="inline-start" /> : <MapPin aria-hidden data-icon="inline-start" />}
              {selected ? "On map" : "Show on map"}
            </UiButton>
          )}
        </div>
      </div>
    </Box>
  )
}

const noop = () => {}
