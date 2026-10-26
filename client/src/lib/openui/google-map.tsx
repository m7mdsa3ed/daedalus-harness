/// <reference types="google.maps" />
/* The openui `Map`: Google Maps, with a directions panel. Its own module so `library.tsx` can
   `lazy()` it - a transcript with no map never loads it, and the Maps script itself is only
   injected when one mounts.

   Two keys, two doors. The Maps JavaScript key is public by design (referrer-restricted) and
   comes from `GET /api/geo/config`; routing, search and places are the harness server's
   (`/api/geo/*`, `server/src/geo.ts`) under a key that never leaves it. With no key configured
   the map says how to set one rather than drawing nothing.

   The model's routes are presets: a routable one (drive/bike/walk) opens in the panel, where the
   reader can change the mode, drag the waypoints, search an address or click the map; a `line`
   route (a flight, a ferry) is drawn dashed and never routed. */
import {
  ArrowDownUp, BedDouble, Bike, Car, ChevronRight, Crosshair, ExternalLink, Footprints, Fuel, LocateFixed, MapPin, Search, Utensils, X,
} from "lucide-react"
import { useEffect, useRef, useState, type ReactNode } from "react"
import { Notice } from "@/components/notice"
import { Button } from "@/components/ui/busy-button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import { Item, ItemActions, ItemContent, ItemMedia } from "@/components/ui/item"
import { Spinner } from "@/components/ui/spinner"
import { Skeleton } from "@/components/ui/skeleton"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { errorText } from "@/lib/errors"
import { useServer } from "@/lib/server-context"
import { api } from "@/lib/settings"
import { colorToHex, useTheme } from "@/lib/theme"
import { cn } from "@/lib/utils"

export type MapLocation = { label: string; latitude: number; longitude: number; detail?: string }
export type MapRoute = { name: string; stops: string[]; mode?: "drive" | "bike" | "walk" | "line" }
type Profile = "car" | "bike" | "foot"
type Category = "fuel" | "lodging" | "food"
type LatLng = [number, number]
type Waypoint = { label: string; point: LatLng | null }
type Road = { path: LatLng[]; encoded: string; meters: number; seconds: number }
type Place = { label: string; latitude: number; longitude: number }
type Found = {
  id: string
  category: Category
  name: string
  address?: string
  kind?: string
  latitude: number
  longitude: number
  rating?: number
  ratings?: number
  openNow?: boolean
  uri?: string
}

const PROFILE_OF = { drive: "car", bike: "bike", walk: "foot" } as const
const PROFILES: { id: Profile; label: string; icon: ReactNode }[] = [
  { id: "car", label: "Car", icon: <Car className="size-3.5" /> },
  { id: "bike", label: "Bike", icon: <Bike className="size-3.5" /> },
  { id: "foot", label: "Walk", icon: <Footprints className="size-3.5" /> },
]
const CATEGORIES: { id: Category; label: string; letter: string; color: string; icon: ReactNode }[] = [
  { id: "fuel", label: "Gas", letter: "G", color: "var(--chart-4)", icon: <Fuel className="size-3.5" /> },
  { id: "lodging", label: "Hotels", letter: "H", color: "var(--chart-2)", icon: <BedDouble className="size-3.5" /> },
  { id: "food", label: "Food", letter: "R", color: "var(--chart-5)", icon: <Utensils className="size-3.5" /> },
]
const EMPTY: Waypoint[] = [
  { label: "", point: null },
  { label: "", point: null },
]

const km = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} km` : `${Math.round(m)} m`)
const clock = (s: number) => {
  const m = Math.max(1, Math.round(s / 60))
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`
}
const coordLabel = ([lat, lng]: LatLng) => `${lat.toFixed(5)}, ${lng.toFixed(5)}`
const googleMapsUrl = (points: LatLng[], profile: Profile) => {
  const at = (p: LatLng) => p.join(",")
  const url = new URL("https://www.google.com/maps/dir/")
  url.searchParams.set("api", "1")
  url.searchParams.set("origin", at(points[0]))
  url.searchParams.set("destination", at(points[points.length - 1]))
  if (points.length > 2) url.searchParams.set("waypoints", points.slice(1, -1).map(at).join("|"))
  url.searchParams.set("travelmode", { car: "driving", bike: "bicycling", foot: "walking" }[profile])
  return url.href
}
const metersBetween = ([la, lo]: LatLng, [lb, lob]: LatLng) => {
  const r = Math.PI / 180
  const a = Math.sin(((lb - la) * r) / 2) ** 2 + Math.cos(la * r) * Math.cos(lb * r) * Math.sin(((lob - lo) * r) / 2) ** 2
  return 12_742_000 * Math.asin(Math.sqrt(a))
}
/** The Maps polylines want a concrete colour, not `var(--x)`; the DOM markers take the var as is. */
const concrete = (color: string) => {
  const name = /^var\((--[\w-]+)\)$/.exec(color)?.[1]
  return name ? (colorToHex(getComputedStyle(document.documentElement).getPropertyValue(name).trim()) ?? "#3b82f6") : color
}
const toLatLng = (pos: google.maps.LatLng | google.maps.LatLngLiteral | google.maps.LatLngAltitude | null | undefined): LatLng => {
  const p = pos as { lat: number | (() => number); lng: number | (() => number) }
  return [typeof p.lat === "function" ? p.lat() : p.lat, typeof p.lng === "function" ? p.lng() : p.lng]
}
const dashed = { strokeOpacity: 0, icons: [{ icon: { path: "M 0,-1 0,1", strokeOpacity: 1, scale: 3 }, offset: "0", repeat: "14px" }] }

function dot(color: string, size: number, text = ""): HTMLElement {
  const el = document.createElement("div")
  el.style.cssText = `display:flex;align-items:center;justify-content:center;width:${size}px;height:${size}px;border-radius:9999px;background:${color};border:3px solid var(--card);box-shadow:0 1px 4px rgb(0 0 0/.45);color:var(--primary-foreground);font:600 10px/1 system-ui;transform:translateY(50%)`
  el.textContent = text
  return el
}

/** A popup body built from text nodes only: place names and addresses are other people's strings. */
function popup(title: string, lines: string[], actions: { text: string; run?: () => void; href?: string }[]): HTMLElement {
  const root = document.createElement("div")
  root.style.cssText = "max-width:240px;font:13px/1.35 system-ui"
  const head = document.createElement("strong")
  head.textContent = title
  root.append(head)
  for (const line of lines.filter(Boolean)) {
    const row = document.createElement("div")
    row.textContent = line
    row.style.opacity = "0.75"
    root.append(row)
  }
  if (actions.length) {
    const bar = document.createElement("div")
    bar.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;margin-top:6px"
    for (const action of actions) {
      const el = document.createElement(action.href ? "a" : "button")
      el.textContent = action.text
      el.style.cssText = "padding:2px 8px;border:1px solid currentColor;border-radius:6px;font-size:11px;color:inherit;text-decoration:none"
      if (action.href) Object.assign(el, { href: action.href, target: "_blank", rel: "noopener noreferrer" })
      else el.onclick = action.run!
      bar.append(el)
    }
    root.append(bar)
  }
  return root
}

declare global {
  interface Window {
    __daedalusMaps?: () => void
    gm_authFailure?: () => void
  }
}
let sdk: Promise<void> | null = null
function loadMaps(key: string): Promise<void> {
  sdk ??= new Promise<void>((resolve, reject) => {
    window.__daedalusMaps = () => resolve()
    const script = document.createElement("script")
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&loading=async&callback=__daedalusMaps`
    script.async = true
    script.onerror = () => {
      sdk = null
      reject(new Error("Couldn't load the Google Maps script"))
    }
    document.head.append(script)
  }).then(async () => {
    await Promise.all(["maps", "marker", "geometry"].map((lib) => google.maps.importLibrary(lib)))
  })
  return sdk
}

function presetOf(routes: MapRoute[], locations: MapLocation[]): { waypoints: Waypoint[]; profile: Profile } | null {
  const route = routes.find((r) => r.mode && r.mode !== "line")
  if (!route) return null
  const waypoints = route.stops.flatMap((stop) => {
    const l = locations.find((x) => x.label === stop)
    return l ? [{ label: l.label, point: [l.latitude, l.longitude] as LatLng }] : []
  })
  return waypoints.length >= 2 ? { waypoints, profile: PROFILE_OF[route.mode as keyof typeof PROFILE_OF] } : null
}

type Props = {
  locations: MapLocation[]
  routes: MapRoute[]
  colors: string[]
  focus: number | null
  onFocus: (index: number) => void
  label?: string
  children?: ReactNode
}

export default function GoogleMap(props: Props) {
  const server = useServer()
  const [phase, setPhase] = useState<{ kind: "loading" } | { kind: "unconfigured" } | { kind: "error"; message: string } | { kind: "ready"; mapId?: string }>({ kind: "loading" })

  useEffect(() => {
    let live = true
    window.gm_authFailure = () =>
      live && setPhase({ kind: "error", message: "Google rejected the Maps key. Check that the Maps JavaScript API is enabled, billing is on, and this site is an allowed referrer." })
    api<{ configured: boolean; mapsKey?: string; mapId?: string }>(server, "/api/geo/config")
      .then(async (config) => {
        if (!config.configured || !config.mapsKey) return live && setPhase({ kind: "unconfigured" })
        await loadMaps(config.mapsKey)
        if (live) setPhase({ kind: "ready", mapId: config.mapId })
      })
      .catch((err) => live && setPhase({ kind: "error", message: errorText(err, "Couldn't load the map") }))
    return () => {
      live = false
    }
  }, [server])

  if (phase.kind === "ready") return <LoadedMap {...props} mapId={phase.mapId} />
  return (
    <>
      {phase.kind === "loading" ? (
        <Skeleton aria-busy="true" className="h-24 w-full rounded-none" />
      ) : (
        <div className="p-3">
          {phase.kind === "unconfigured" ? (
            <Notice tone="warn" title="Google Maps isn't set up">
              Add a Maps JavaScript API key as <code>geo.googleMapsKey</code> in <code>data/config.json</code> (and, for routes and places, a server key as{" "}
              <code>geo.googleServerKey</code>), then restart the server.
            </Notice>
          ) : (
            <Notice tone="error" copy={phase.message}>
              {phase.message}
            </Notice>
          )}
        </div>
      )}
      {props.children}
    </>
  )
}

function LoadedMap({ locations, routes, colors, focus, onFocus, label, children, mapId }: Props & { mapId?: string }) {
  const server = useServer()
  const dark = useTheme().resolved === "dark"
  const host = useRef<HTMLDivElement>(null)
  const map = useRef<google.maps.Map | null>(null)
  const info = useRef<google.maps.InfoWindow | null>(null)
  const openers = useRef<(() => void)[]>([])
  const foundOpeners = useRef<Record<string, () => void>>({})
  const preset = presetOf(routes, locations)
  const [waypoints, setWaypoints] = useState<Waypoint[]>(preset?.waypoints ?? EMPTY)
  const [profile, setProfile] = useState<Profile>(preset?.profile ?? "car")
  const [pick, setPick] = useState<number | null>(null)
  const [roads, setRoads] = useState<Road[]>([])
  const [chosen, setChosen] = useState(0)
  const [state, setState] = useState<{ busy: boolean; error?: string; none?: boolean }>({ busy: false })
  const [cats, setCats] = useState<Category[]>([])
  const [found, setFound] = useState<Found[]>([])
  const [foundState, setFoundState] = useState<{ busy: boolean; error?: string }>({ busy: false })

  /* Map clicks and marker popups write a waypoint through this, so the map is built once and
     never has to know the panel's state. A click fills the slot being picked, else the first
     empty one, else nothing - a stray click must not move a route someone planned. */
  const place = (index: number | "next", label: string, point: LatLng) =>
    setWaypoints((list) => {
      const at = index === "next" ? list.findIndex((w) => !w.point) : index
      return at < 0 ? list : list.map((w, i) => (i === at ? { label, point } : w))
    })
  const placeRef = useRef(place)
  placeRef.current = place
  const pickRef = useRef(pick)
  pickRef.current = pick

  // Map and the model's markers: rebuilt when the locations or the colour scheme change.
  useEffect(() => {
    if (!host.current) return
    const m = new google.maps.Map(host.current, {
      mapId: mapId ?? "DEMO_MAP_ID",
      colorScheme: (dark ? "DARK" : "LIGHT") as google.maps.ColorScheme,
      gestureHandling: "cooperative",
      streetViewControl: false,
      mapTypeControl: false,
      clickableIcons: false,
    })
    const window_ = new google.maps.InfoWindow()
    info.current = window_
    const markers = locations.map((location, index) => {
      const point: LatLng = [location.latitude, location.longitude]
      const marker = new google.maps.marker.AdvancedMarkerElement({
        map: m,
        position: { lat: point[0], lng: point[1] },
        content: dot(colors[index % colors.length], 18),
        title: location.label,
      })
      const open = () => {
        window_.setContent(
          popup(location.label, [location.detail ?? ""], [
            { text: "From here", run: () => (setWaypoints((l) => l.map((w, i) => (i === 0 ? { label: location.label, point } : w))), window_.close()) },
            { text: "To here", run: () => (setWaypoints((l) => l.map((w, i) => (i === l.length - 1 ? { label: location.label, point } : w))), window_.close()) },
          ])
        )
        window_.open({ map: m, anchor: marker })
      }
      openers.current[index] = open
      marker.addListener("click", () => {
        onFocus(index)
        open()
      })
      return marker
    })
    m.addListener("click", (e: google.maps.MapMouseEvent) => {
      if (!e.latLng) return
      const point: LatLng = [e.latLng.lat(), e.latLng.lng()]
      placeRef.current(pickRef.current ?? "next", coordLabel(point), point)
      setPick(null)
    })
    if (locations.length > 1) {
      const bounds = new google.maps.LatLngBounds()
      locations.forEach((l) => bounds.extend({ lat: l.latitude, lng: l.longitude }))
      m.fitBounds(bounds, 32)
      google.maps.event.addListenerOnce(m, "idle", () => (m.getZoom() ?? 0) > 14 && m.setZoom(14))
    } else {
      m.setCenter(locations[0] ? { lat: locations[0].latitude, lng: locations[0].longitude } : { lat: 20, lng: 0 })
      m.setZoom(locations.length ? 10 : 2)
    }
    map.current = m
    return () => {
      markers.forEach((marker) => (marker.map = null))
      window_.close()
      google.maps.event.clearInstanceListeners(m)
      map.current = null
      info.current = null
      host.current?.replaceChildren()
    }
  }, [locations, colors, onFocus, mapId, dark])

  // Straight `line` routes: drawn once, dashed, in their route's colour.
  useEffect(() => {
    const m = map.current
    if (!m) return
    const lines = routes.flatMap((route, index) => {
      if (route.mode && route.mode !== "line") return []
      const path = route.stops.flatMap((stop) => {
        const l = locations.find((x) => x.label === stop)
        return l ? [{ lat: l.latitude, lng: l.longitude }] : []
      })
      return path.length < 2 ? [] : [new google.maps.Polyline({ map: m, path, strokeColor: concrete(colors[index % colors.length]), strokeWeight: 3, ...dashed })]
    })
    return () => lines.forEach((line) => line.setMap(null))
  }, [locations, routes, colors, dark])

  // Ask the server whenever the filled waypoints or the mode change; the newest ask wins.
  const filled = waypoints.flatMap((w) => (w.point ? [w.point] : []))
  const query = filled.length >= 2 ? `${profile}|${filled.map((p) => p.join(",")).join(";")}` : ""
  useEffect(() => {
    if (!query) return void setRoads([])
    const [p, points] = query.split("|")
    const abort = new AbortController()
    setState({ busy: true })
    api<{ routes: { polyline: string; meters: number; seconds: number }[] }>(
      server,
      `/api/geo/route?profile=${p}&points=${points}&alternatives=1&lang=${encodeURIComponent(navigator.language)}`,
      { signal: abort.signal }
    )
      .then((body) => {
        const next = body.routes.map((r): Road => ({
          path: google.maps.geometry.encoding.decodePath(r.polyline).map((pt) => [pt.lat(), pt.lng()] as LatLng),
          encoded: r.polyline,
          meters: r.meters,
          seconds: r.seconds,
        }))
        setRoads(next)
        setChosen(0)
        setState({ busy: false, none: next.length === 0 })
        const bounds = new google.maps.LatLngBounds()
        next.forEach((r) => r.path.forEach(([lat, lng]) => bounds.extend({ lat, lng })))
        if (next.length) map.current?.fitBounds(bounds, 40)
      })
      .catch((err) => !abort.signal.aborted && setState({ busy: false, error: errorText(err, "Couldn't find a route") }))
    return () => abort.abort()
  }, [query, server])

  // The routes and the draggable waypoints. Alternatives sit under the chosen one and pick on click.
  useEffect(() => {
    const m = map.current
    if (!m) return
    const overlays: { setMap(m: null): void }[] = []
    const primary = concrete("var(--primary)")
    roads.forEach((road, index) => {
      const path = road.path.map(([lat, lng]) => ({ lat, lng }))
      if (index === chosen) {
        overlays.push(new google.maps.Polyline({ map: m, path, strokeColor: concrete("var(--card)"), strokeOpacity: 0.9, strokeWeight: 9, zIndex: 1 }))
        overlays.push(new google.maps.Polyline({ map: m, path, strokeColor: primary, strokeWeight: 5, zIndex: 2 }))
      } else {
        const alt = new google.maps.Polyline({ map: m, path, strokeColor: concrete("var(--muted-foreground)"), strokeOpacity: 0.6, strokeWeight: 6, zIndex: 0 })
        alt.addListener("click", () => setChosen(index))
        overlays.push(alt)
      }
    })
    waypoints.forEach((w, index) => {
      if (!w.point) return
      const last = index === waypoints.length - 1
      const marker = new google.maps.marker.AdvancedMarkerElement({
        map: m,
        position: { lat: w.point[0], lng: w.point[1] },
        gmpDraggable: true,
        zIndex: 1000,
        content: dot(last ? "var(--destructive)" : "var(--primary)", 22, last ? "B" : index === 0 ? "A" : String(index)),
        title: w.label || (last ? "Destination" : "Start"),
      })
      marker.addListener("dragend", () => {
        const point = toLatLng(marker.position)
        place(index, coordLabel(point), point)
      })
      overlays.push({ setMap: () => (marker.map = null) })
    })
    return () => overlays.forEach((o) => o.setMap(null))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roads, chosen, waypoints, dark])

  // Gas, hotels and food: along the chosen route when there is one, else around the map's centre.
  const road = roads[chosen]
  const encoded = road?.encoded
  useEffect(() => {
    if (!cats.length) return void setFound([])
    const centre = map.current?.getCenter()
    if (!encoded && !centre) return
    const abort = new AbortController()
    setFoundState({ busy: true })
    api<{ places: Found[] }>(server, "/api/geo/nearby", {
      method: "POST",
      signal: abort.signal,
      body: JSON.stringify({
        categories: cats,
        lang: navigator.language,
        ...(encoded ? { polyline: encoded } : { center: [centre!.lat(), centre!.lng()], radius: 3000 }),
      }),
    })
      .then((body) => {
        setFound(body.places)
        setFoundState({ busy: false })
      })
      .catch((err) => !abort.signal.aborted && setFoundState({ busy: false, error: errorText(err, "Couldn't load places") }))
    return () => abort.abort()
  }, [cats, encoded, server])

  useEffect(() => {
    const m = map.current
    if (!m) return
    const markers = found.map((f) => {
      const kind = CATEGORIES.find((c) => c.id === f.category)!
      const marker = new google.maps.marker.AdvancedMarkerElement({
        map: m,
        position: { lat: f.latitude, lng: f.longitude },
        content: dot(kind.color, 20, kind.letter),
        title: f.name,
      })
      const open = () => {
        const rated = f.rating ? `${f.rating.toFixed(1)} stars${f.ratings ? ` (${f.ratings})` : ""}` : ""
        const status = f.openNow == null ? "" : f.openNow ? "Open now" : "Closed now"
        info.current?.setContent(
          popup(f.name, [f.kind ?? kind.label, [rated, status].filter(Boolean).join(" - "), f.address ?? ""], [
            ...(f.uri && /^https:\/\/(www\.)?google\.[a-z.]+\/maps|^https:\/\/maps\.google\./.test(f.uri) ? [{ text: "Open in Google Maps", href: f.uri }] : []),
          ])
        )
        info.current?.open({ map: m, anchor: marker })
      }
      foundOpeners.current[f.id] = open
      marker.addListener("click", open)
      return marker
    })
    return () => {
      markers.forEach((marker) => (marker.map = null))
      foundOpeners.current = {}
    }
  }, [found, dark])

  // Navigation: a row in the list flies there and opens its popup.
  useEffect(() => {
    const location = focus == null ? null : locations[focus]
    if (!location || !map.current) return
    map.current.panTo({ lat: location.latitude, lng: location.longitude })
    map.current.setZoom(Math.max(map.current.getZoom() ?? 0, 12))
    openers.current[focus!]?.()
  }, [focus, locations])

  useEffect(() => {
    map.current?.setOptions({ draggableCursor: pick == null ? undefined : "crosshair" })
  }, [pick])

  const reference: LatLng | null = filled[0] ?? (map.current ? toLatLng(map.current.getCenter()) : null)
  const nearest = reference ? [...found].sort((a, b) => metersBetween(reference, [a.latitude, a.longitude]) - metersBetween(reference, [b.latitude, b.longitude])) : found
  const openFound = (f: Found) => {
    map.current?.panTo({ lat: f.latitude, lng: f.longitude })
    map.current?.setZoom(Math.max(map.current.getZoom() ?? 0, 15))
    foundOpeners.current[f.id]?.()
  }
  const locate = () =>
    navigator.geolocation?.getCurrentPosition(
      (pos) => place(0, "My location", [pos.coords.latitude, pos.coords.longitude]),
      (err) => setState({ busy: false, error: `Couldn't read your location: ${err.message}` }),
      { enableHighAccuracy: true, timeout: 10_000 }
    )

  return (
    <>
      <div ref={host} className="z-0 h-72 w-full @panel-sm:h-96" role="application" aria-label={label ?? "Interactive map"} />
      <Collapsible className="border-t text-sm">
        <CollapsibleTrigger className="group/trigger flex w-full items-center gap-2 px-3 py-2.5 text-start outline-none hover:bg-muted focus-visible:bg-muted @panel-sm:px-4">
          <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[panel-open]/trigger:rotate-90" />
          <span className="font-medium text-foreground">Directions and places</span>
          {road && (
            <span className="ms-auto text-xs text-muted-foreground">
              {clock(road.seconds)} - {km(road.meters)}
            </span>
          )}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="space-y-3 border-t px-3 py-3 @panel-sm:px-4">
            <div className="flex flex-wrap items-center gap-1.5">
              <ToggleGroup variant="outline" size="sm" spacing={0} value={[profile]} onValueChange={(next) => next[0] && setProfile(next[0] as Profile)} aria-label="Travel mode">
                {PROFILES.map((p) => (
                  <ToggleGroupItem key={p.id} value={p.id}>
                    {p.icon}
                    {p.label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              <span className="ms-auto flex gap-1">
                <IconButton title="Start from my location" onClick={locate} icon={<LocateFixed />} />
                <IconButton title="Swap start and destination" onClick={() => setWaypoints((list) => [...list].reverse())} icon={<ArrowDownUp />} />
              </span>
            </div>
            {waypoints.map((w, index) => (
              <WaypointField
                key={index}
                index={index}
                count={waypoints.length}
                waypoint={w}
                picking={pick === index}
                onPick={() => setPick(pick === index ? null : index)}
                onPlace={(label, point) => {
                  place(index, label, point)
                  map.current?.panTo({ lat: point[0], lng: point[1] })
                  map.current?.setZoom(Math.max(map.current.getZoom() ?? 0, 13))
                }}
                onClear={() =>
                  setWaypoints((list) => (list.length > 2 ? list.filter((_, i) => i !== index) : list.map((x, i) => (i === index ? { label: "", point: null } : x))))
                }
              />
            ))}
            {pick != null && <p className="text-xs text-muted-foreground">Click the map to set this point.</p>}
            {filled.length < 2 && pick == null && <p className="text-xs text-muted-foreground">Search a place, click the map, or use a marker's From / To to plan a route.</p>}
            {state.busy && (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Spinner className="size-3.5" /> Finding a route...
              </p>
            )}
            {state.error && (
              <Notice tone="error" copy={state.error}>
                {state.error}
              </Notice>
            )}
            {state.none && <p className="text-xs text-muted-foreground">No {PROFILES.find((p) => p.id === profile)!.label.toLowerCase()} route between these points.</p>}
            {roads.length > 1 && (
              <ToggleGroup
                variant="outline"
                size="sm"
                spacing={1}
                value={[String(chosen)]}
                onValueChange={(next) => next[0] && setChosen(Number(next[0]))}
                className="flex-wrap"
                aria-label="Route"
              >
                {roads.map((r, index) => (
                  <ToggleGroupItem key={index} value={String(index)}>
                    {index === 0 ? "Fastest" : `Route ${index + 1}`} - {clock(r.seconds)}, {km(r.meters)}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            )}
            {road && !state.busy && (
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1">
                  <span className="font-medium text-foreground">{clock(road.seconds)}</span>
                  <span className="text-muted-foreground"> - {km(road.meters)}{profile === "car" ? " in current traffic" : ""}</span>
                </span>
                <Button variant="outline" size="sm" nativeButton={false} render={<a href={googleMapsUrl(filled, profile)} target="_blank" rel="noopener noreferrer" />}>
                  Open in Google Maps
                  <ExternalLink data-icon="inline-end" />
                </Button>
              </div>
            )}
            <div className="space-y-2 border-t pt-3">
              <div className="flex items-center gap-2">
                <span className="font-medium text-foreground">{road ? "Along the route" : "Near the map centre"}</span>
                {foundState.busy && <Spinner className="size-3.5" />}
              </div>
              <ToggleGroup
                multiple
                variant="outline"
                size="sm"
                spacing={0}
                value={cats}
                onValueChange={(next) => setCats(next as Category[])}
                aria-label="Places to show"
              >
                {CATEGORIES.map((c) => (
                  <ToggleGroupItem key={c.id} value={c.id}>
                    {c.icon}
                    {c.label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              {foundState.error && (
                <Notice tone="error" copy={foundState.error}>
                  {foundState.error}
                </Notice>
              )}
              {cats.length > 0 && !foundState.busy && !foundState.error && found.length === 0 && (
                <p className="text-xs text-muted-foreground">Nothing found {road ? "along this route" : "near here"}.</p>
              )}
              {nearest.length > 0 && (
                <ul className="max-h-56 overflow-y-auto rounded-xl border p-1">
                  {nearest.map((f) => {
                    const c = CATEGORIES.find((x) => x.id === f.category)!
                    return (
                      <li key={`${f.category}-${f.id}`}>
                        <Item size="xs" className="flex-nowrap items-start text-start hover:bg-muted" render={<button type="button" onClick={() => openFound(f)} />}>
                          <ItemMedia variant="icon" className="text-muted-foreground">{c.icon}</ItemMedia>
                          <ItemContent className="min-w-0">
                            <span className="block font-medium break-words">{f.name}</span>
                            <span className="block text-xs break-words text-muted-foreground">
                              {[f.rating ? `${f.rating.toFixed(1)} stars` : "", f.openNow == null ? "" : f.openNow ? "Open now" : "Closed", f.address ?? ""].filter(Boolean).join(" - ")}
                            </span>
                          </ItemContent>
                          {reference && <ItemActions className="shrink-0 text-xs text-muted-foreground tabular-nums">{km(metersBetween(reference, [f.latitude, f.longitude]))}</ItemActions>}
                        </Item>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          </div>
          {children}
        </CollapsibleContent>
      </Collapsible>
    </>
  )
}

function IconButton({ title, onClick, icon, loading, pressed }: { title: string; onClick: () => void; icon: ReactNode; loading?: boolean; pressed?: boolean }) {
  return (
    <Button type="button" variant={pressed ? "default" : "outline"} size="icon-sm" title={title} aria-pressed={pressed} loading={loading} onClick={onClick}>
      {icon}
    </Button>
  )
}

/* One waypoint: type and press Enter to search (never as-you-type - a keystroke is a billed
   request), pick a result, or arm the pin and click the map. */
function WaypointField({
  index,
  count,
  waypoint,
  picking,
  onPick,
  onPlace,
  onClear,
}: {
  index: number
  count: number
  waypoint: Waypoint
  picking: boolean
  onPick: () => void
  onPlace: (label: string, point: LatLng) => void
  onClear: () => void
}) {
  const server = useServer()
  const [text, setText] = useState(waypoint.label)
  const [results, setResults] = useState<Place[] | null>(null)
  const [state, setState] = useState<{ busy: boolean; error?: string }>({ busy: false })
  useEffect(() => setText(waypoint.label), [waypoint.label])
  const name = index === 0 ? "Start" : index === count - 1 ? "Destination" : `Stop ${index}`

  const search = async () => {
    const q = text.trim()
    if (!q) return
    setState({ busy: true })
    try {
      const body = await api<{ places: Place[] }>(server, `/api/geo/search?q=${encodeURIComponent(q)}&lang=${encodeURIComponent(navigator.language)}`)
      setResults(body.places)
      setState({ busy: false })
    } catch (err) {
      setState({ busy: false, error: errorText(err, "Search failed") })
    }
  }

  return (
    <div className="relative">
      <div className="flex items-center gap-1.5">
        <MapPin className={cn("size-3.5 shrink-0", index === count - 1 ? "text-destructive" : "text-primary")} />
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void search()
            if (e.key === "Escape") setResults(null)
          }}
          placeholder={`${name}: search a place`}
          aria-label={name}
          className="h-8"
        />
        <IconButton title="Search" onClick={() => void search()} icon={<Search />} loading={state.busy} />
        <IconButton title="Pick on the map" onClick={onPick} icon={<Crosshair />} pressed={picking} />
        <IconButton title={count > 2 ? "Remove this stop" : "Clear"} onClick={onClear} icon={<X />} />
      </div>
      {state.error && <p className="mt-1 ps-5 text-xs text-destructive">{state.error}</p>}
      {results && (
        <ul className="absolute inset-x-5 top-full z-50 mt-1 max-h-56 overflow-y-auto rounded-2xl bg-popover p-1 text-popover-foreground shadow-2xl ring-1 ring-foreground/5">
          {results.length === 0 && <li className="px-2.5 py-1.5 text-muted-foreground">No places found.</li>}
          {results.map((p, i) => (
            <li key={i}>
              <Item
                size="xs"
                className="text-start break-words hover:bg-accent hover:text-accent-foreground"
                render={
                  <button
                    type="button"
                    onClick={() => {
                      setResults(null)
                      onPlace(p.label.split(",").slice(0, 2).join(","), [p.latitude, p.longitude])
                    }}
                  />
                }
              >
                {p.label}
              </Item>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
