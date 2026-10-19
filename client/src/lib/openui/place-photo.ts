/* A photo for a named place, from the harness server (`GET /api/geo/photo`, Google Places). Its own
   module so `library.tsx` stays free of the server context, and so `gen-openui.mjs` stubs it with
   the map: the prompt generator only needs the component table. `undefined` = not asked or
   still loading, `null` = asked and there is none. */
import { useEffect, useState } from "react"
import { useServer } from "@/lib/server-context"
import { api } from "@/lib/settings"

export type PlacePhoto = { url: string; attribution?: string }

export function usePlacePhoto(query: string | null, near?: [number, number]): PlacePhoto | null | undefined {
  const server = useServer()
  const [photo, setPhoto] = useState<PlacePhoto | null | undefined>(undefined)
  const lat = near?.[0]
  const lon = near?.[1]
  useEffect(() => {
    if (!query) return
    let live = true
    const params = new URLSearchParams({ q: query })
    if (lat !== undefined && lon !== undefined) params.set("lat", String(lat)), params.set("lon", String(lon))
    api<{ photo: PlacePhoto | null }>(server, `/api/geo/photo?${params}`)
      .then((r) => live && setPhoto(r.photo))
      .catch(() => live && setPhoto(null)) // no key, no quota: the card keeps its placeholder
    return () => {
      live = false
    }
  }, [server, query, lat, lon])
  return query ? photo : undefined
}
