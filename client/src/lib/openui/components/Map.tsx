/**
 * A map. A rendered Google map is a *billed* load, so the closed state is a
 * sketch of the plotting — points and routes on a dotted ground — and the map
 * itself waits behind a click. The location list is drawn either way, because
 * the coordinates are the part of a map that a reader can act on.
 *
 * The sketch is not a placeholder: it is the shape of the answer, and it costs
 * nothing. What it cannot say is where the roads go, which is what the click
 * buys.
 */
import { lazy, Suspense, useCallback, useMemo, useState } from "react"
import { z } from "zod/v4"
import { ChevronRight, MapPin } from "lucide-react"
import { defineComponent } from "@openuidev/react-lang"
import { cn } from "@/lib/utils"
import { buttonVariants } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { BODY, Box, chartColor, META, PAD, PAD_ROW, TITLE } from "@/lib/openui/kit"

const GoogleMap = lazy(() => import("@/lib/openui/google-map"))
export const MAP_COLORS = [0, 1, 2, 3, 4].map(chartColor)

const routesSchema = z.array(
  z.object({ name: z.string(), stops: z.array(z.string()), mode: z.enum(["drive", "bike", "walk", "line"]).optional() })
)

export type MapLocation = { label: string; latitude: number; longitude: number; detail?: string }
export type MapRoute = z.infer<typeof routesSchema>[number]

/** An offline sketch of the map: points and routes on a dotted ground, so the
    closed state says where things are without a map load. */
export function MapSketch({ locations, routes }: { locations: MapLocation[]; routes: { stops: string[] }[] }) {
  if (locations.length === 0) return null
  const W = 100
  const H = 36
  const lats = locations.map((l) => l.latitude)
  const lons = locations.map((l) => l.longitude)
  const cLat = (Math.min(...lats) + Math.max(...lats)) / 2
  const cLon = (Math.min(...lons) + Math.max(...lons)) / 2
  const k = Math.cos((cLat * Math.PI) / 180)
  const spanX = Math.max((Math.max(...lons) - Math.min(...lons)) * k, 1e-6)
  const spanY = Math.max(Math.max(...lats) - Math.min(...lats), 1e-6)
  const scale = Math.min((W - 16) / spanX, (H - 10) / spanY)
  const at = (l: { latitude: number; longitude: number }) => ({
    x: W / 2 + (l.longitude - cLon) * k * scale,
    y: H / 2 - (l.latitude - cLat) * scale,
  })
  const pos = new globalThis.Map(locations.map((l) => [l.label, at(l)]))
  return (
    <svg viewBox={`0 0 ${W} ${H}`} aria-hidden preserveAspectRatio="xMidYMid slice" className="block h-20 w-full bg-muted/40 text-muted-foreground">
      <defs>
        <pattern id="map-dots" width="4" height="4" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="0.25" fill="currentColor" />
        </pattern>
      </defs>
      <rect width={W} height={H} fill="url(#map-dots)" />
      {routes.flatMap((r, ri) =>
        r.stops.slice(1).map((stop, i) => {
          const a = pos.get(r.stops[i])
          const b = pos.get(stop)
          return a && b ? (
            <line key={`${ri}-${i}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={chartColor(ri)} strokeWidth="0.5" strokeDasharray="1.5 1" opacity="0.8" />
          ) : null
        })
      )}
      {locations.map((l, i) => {
        const p = at(l)
        return <circle key={i} cx={p.x} cy={p.y} r="1.6" fill={chartColor(i)} stroke="var(--card)" strokeWidth="0.6" />
      })}
    </svg>
  )
}

/** The list of places: the map's legend, and the thing a reader scrolls when
    the map is too far away to read. Clicking one opens the map on it. */
export function PlaceList({ locations, onFocus }: { locations: MapLocation[]; onFocus?: (index: number) => void }) {
  if (locations.length === 0) return <div className={cn(META, PAD)}>No locations to plot.</div>
  return (
    <ul className={cn("grid grid-cols-1 divide-y divide-border/70 @panel-sm:grid-cols-2 @panel-sm:divide-y-0", PAD_ROW)}>
      {locations.map((location, index) => (
        <li key={`${location.label}-${index}`} className="min-w-0 @panel-sm:[&:nth-child(n+3)]:border-t @panel-sm:[&:nth-child(n+3)]:border-border/70">
          <button
            type="button"
            onClick={() => onFocus?.(index)}
            className="flex w-full min-w-0 items-start gap-2 rounded-md py-1.5 text-start outline-none hover:bg-muted/60 focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <span className="mt-1 size-2 shrink-0 rounded-full" style={{ backgroundColor: chartColor(index) }} />
            <span className="min-w-0 flex-1">
              <span className={cn(BODY, "block font-medium")}>{location.label}</span>
              <span className={META}>
                {location.latitude.toFixed(2)}, {location.longitude.toFixed(2)}
                {location.detail ? ` · ${location.detail}` : ""}
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}

export function MapView(props: { locations: MapLocation[]; title?: string; routes?: MapRoute[]; focus?: number | null }) {
  const [focus, setFocus] = useState<number | null>(props.focus ?? null)
  // The parser hands back fresh arrays while a fence streams; a map rebuilt per chunk would lose its zoom.
  const key = JSON.stringify([props.locations, props.routes])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const locations = useMemo(() => props.locations, [key])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const routes = useMemo(() => props.routes ?? [], [key])
  const onFocus = useCallback((index: number) => setFocus(index), [])
  // A rendered Google map is a billed load, so it waits behind a click.
  const [open, setOpen] = useState(false)
  return (
    <Box className="w-full overflow-hidden">
      {open ? (
        <Suspense fallback={<Skeleton aria-busy="true" className="h-24 w-full rounded-none" />}>
          <GoogleMap locations={locations} routes={routes} colors={MAP_COLORS} focus={focus} onFocus={onFocus} label={props.title}>
            <PlaceList locations={props.locations} onFocus={onFocus} />
          </GoogleMap>
        </Suspense>
      ) : (
        <>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="group block w-full border-b border-border/70 text-start outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset"
          >
            <MapSketch locations={props.locations} routes={routes} />
            <span className={cn("flex items-center gap-2.5", PAD)}>
              <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                <MapPin aria-hidden className="size-3.5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className={cn(TITLE, "block")}>{props.title ?? "Map"}</span>
                <span className={META}>
                  {props.locations.length} places{routes.length > 0 ? ` · ${routes.length} routes with directions` : ""}
                </span>
              </span>
              {/* Drawn as the stock button; the whole row is the one control. */}
              <span className={cn(buttonVariants({ size: "sm", variant: "outline" }), "group-hover:bg-muted")}>
                Show map <ChevronRight aria-hidden data-icon="inline-end" />
              </span>
            </span>
          </button>
          <PlaceList locations={props.locations} onFocus={onFocus} />
        </>
      )}
    </Box>
  )
}

export const Map = defineComponent({
  name: "Map",
  description:
    "A world map with labeled markers and optional routes between them. Give each location a label, latitude and longitude in degrees, and an optional detail. A route names its stops by location label: mode drive, bike or walk is routed on real roads that the reader can re-plan; line (the default) is a straight dashed line.",
  props: z.object({
    locations: z.array(
      z.object({
        label: z.string(),
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
        detail: z.string().optional(),
      })
    ),
    title: z.string().optional(),
    routes: routesSchema.optional(),
  }),
  component: ({ props }) => <MapView {...props} />,
})
