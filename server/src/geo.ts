/**
 * Routing, search and places for the openui `Map`'s directions panel, all Google's, asked
 * server-side so the key that can spend money (`geo.googleServerKey`) never reaches a browser.
 *
 * Three Google products, each its own enabled API on the key's project:
 *  - Routes API `computeRoutes` - the road path, distance, traffic-aware time and alternatives;
 *  - Places API (New) `places:searchText` - an address or a place, and, with
 *    `searchAlongRouteParameters`, gas / hotels / food along a route polyline;
 *  - Places API (New) `places:searchNearby` - the same categories around a point when there is no route.
 * The browser gets the Maps JavaScript key (`geo.googleMapsKey`, referrer-restricted) from
 * `GET /api/geo/config` behind the bearer token; it is public by design, the server key is not.
 */
import { getConfig } from "./config.js";
import { HttpError } from "./http-error.js";

export const PROFILES = ["car", "bike", "foot"] as const;
export type Profile = (typeof PROFILES)[number];
export const CATEGORIES = ["fuel", "lodging", "food"] as const;
export type Category = (typeof CATEGORIES)[number];

export type Route = { polyline: string; meters: number; seconds: number };
export type Place = { label: string; latitude: number; longitude: number };
export type Nearby = {
  id: string;
  category: Category;
  name: string;
  address?: string;
  kind?: string;
  latitude: number;
  longitude: number;
  rating?: number;
  ratings?: number;
  openNow?: boolean;
  uri?: string;
};

const TRAVEL_MODE: Record<Profile, string> = { car: "DRIVE", bike: "BICYCLE", foot: "WALK" };
const TEXT_QUERY: Record<Category, string> = { fuel: "gas station", lodging: "hotel", food: "restaurant" };
const NEARBY_TYPES: Record<Category, string[]> = {
  fuel: ["gas_station", "electric_vehicle_charging_station"],
  lodging: ["lodging"],
  food: ["restaurant", "cafe", "fast_food_restaurant"],
};
const PER_CATEGORY = 20;

/** What the browser needs to load the map; `configured: false` is an answer, not a failure. */
export function mapsConfig(): { configured: boolean; mapsKey?: string; mapId?: string } {
  const google = getConfig().geo;
  return google?.googleMapsKey ? { configured: true, mapsKey: google.googleMapsKey, mapId: google.googleMapId } : { configured: false };
}

function serverKey(): string {
  const geo = getConfig().geo;
  const key = geo?.googleServerKey ?? geo?.googleMapsKey;
  if (!key) throw new HttpError("Google Maps isn't configured - set geo.googleMapsKey in data/config.json", 503);
  return key;
}

async function google(url: string, fieldMask: string, body: unknown): Promise<any> {
  const key = serverKey(); // before the try: a missing key is the 503 it is, not "couldn't reach Google"
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key, "x-goog-fieldmask": fieldMask },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new HttpError(`Couldn't reach Google at ${new URL(url).origin}: ${(err as Error).message}`, 502);
  }
  const json = (await res.json().catch(() => ({}))) as { error?: { message?: string; status?: string } };
  // Google says why in the body (API not enabled, key restricted, quota): that is the message worth showing.
  if (!res.ok) throw new HttpError(`Google answered ${res.status}: ${json.error?.message ?? res.statusText}`, 502);
  return json;
}

const latLng = ([latitude, longitude]: [number, number]) => ({ location: { latLng: { latitude, longitude } } });

/** `points` are [lat, lng]. "No route" is an answer (an empty list), not an error. */
export async function route(profile: Profile, points: [number, number][], alternatives: boolean, language?: string): Promise<Route[]> {
  const body: Record<string, unknown> = {
    origin: latLng(points[0]),
    destination: latLng(points[points.length - 1]),
    travelMode: TRAVEL_MODE[profile],
    units: "METRIC",
    ...(language ? { languageCode: language } : {}),
  };
  if (points.length > 2) body.intermediates = points.slice(1, -1).map(latLng);
  // Google offers alternatives only without intermediate stops, and traffic only for driving.
  if (alternatives && points.length === 2) body.computeAlternativeRoutes = true;
  if (profile === "car") body.routingPreference = "TRAFFIC_AWARE";
  const out = await google(
    "https://routes.googleapis.com/directions/v2:computeRoutes",
    "routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline",
    body,
  );
  return (out.routes ?? []).map((r: any) => ({
    polyline: r.polyline.encodedPolyline,
    meters: r.distanceMeters ?? 0,
    seconds: parseInt(r.duration ?? "0", 10),
  }));
}

export async function searchPlaces(query: string, language?: string): Promise<Place[]> {
  const out = await google(
    "https://places.googleapis.com/v1/places:searchText",
    "places.displayName,places.formattedAddress,places.location",
    { textQuery: query, pageSize: 6, ...(language ? { languageCode: language } : {}) },
  );
  return (out.places ?? []).map((p: any) => {
    const name = p.displayName?.text ?? "";
    const address = p.formattedAddress ?? "";
    return {
      label: name && !address.startsWith(name) ? `${name}, ${address}` : address || name,
      latitude: p.location.latitude,
      longitude: p.location.longitude,
    };
  });
}

const PLACE_FIELDS = [
  "id", "displayName", "formattedAddress", "location", "rating", "userRatingCount",
  "googleMapsUri", "primaryTypeDisplayName", "currentOpeningHours.openNow",
].map((f) => `places.${f}`).join(",");

/**
 * Each category along `polyline` (an encoded route) when given, else around `center` within
 * `radius` metres. One request per category, so a motorway of fuel stops cannot crowd out the hotels.
 */
export async function nearby(
  categories: Category[],
  where: { polyline: string } | { center: [number, number]; radius: number },
  language?: string,
): Promise<Nearby[]> {
  const lang = language ? { languageCode: language } : {};
  const lists = await Promise.all(
    categories.map(async (category) => {
      const out =
        "polyline" in where
          ? await google("https://places.googleapis.com/v1/places:searchText", PLACE_FIELDS, {
              textQuery: TEXT_QUERY[category],
              pageSize: PER_CATEGORY,
              searchAlongRouteParameters: { polyline: { encodedPolyline: where.polyline } },
              ...lang,
            })
          : await google("https://places.googleapis.com/v1/places:searchNearby", PLACE_FIELDS, {
              includedTypes: NEARBY_TYPES[category],
              maxResultCount: PER_CATEGORY,
              rankPreference: "DISTANCE",
              locationRestriction: { circle: { center: { latitude: where.center[0], longitude: where.center[1] }, radius: where.radius } },
              ...lang,
            });
      return (out.places ?? []).map(
        (p: any): Nearby => ({
          id: p.id,
          category,
          name: p.displayName?.text ?? TEXT_QUERY[category],
          address: p.formattedAddress,
          kind: p.primaryTypeDisplayName?.text,
          latitude: p.location.latitude,
          longitude: p.location.longitude,
          rating: p.rating,
          ratings: p.userRatingCount,
          openNow: p.currentOpeningHours?.openNow,
          uri: p.googleMapsUri,
        }),
      );
    }),
  );
  return lists.flat();
}

export type PlacePhoto = { url: string; attribution?: string };
const photoCache = new Map<string, { at: number; photo: PlacePhoto | null }>();
const PHOTO_TTL = 6 * 60 * 60_000; // every lookup is two billed Google calls, so a repeat is answered from here

/**
 * One photo for a named place, for the openui CardGrid. `skipHttpRedirect` makes Google answer
 * with the image's own short-lived URL instead of redirecting, so the browser never sees the
 * key (it travels in a header). No match, or a place with no photo, is an answer: `null`.
 */
export async function placePhoto(query: string, near?: [number, number]): Promise<PlacePhoto | null> {
  const cacheKey = `${query.toLowerCase()}|${near?.map((n) => n.toFixed(2)).join(",") ?? ""}`;
  const hit = photoCache.get(cacheKey);
  if (hit && Date.now() - hit.at < PHOTO_TTL) return hit.photo;
  const out = await google("https://places.googleapis.com/v1/places:searchText", "places.photos", {
    textQuery: query,
    pageSize: 1,
    ...(near ? { locationBias: { circle: { center: { latitude: near[0], longitude: near[1] }, radius: 50_000 } } } : {}),
  });
  const photo = out.places?.[0]?.photos?.[0] as { name: string; authorAttributions?: { displayName?: string }[] } | undefined;
  let result: PlacePhoto | null = null;
  if (photo) {
    let res: Response;
    try {
      res = await fetch(`https://places.googleapis.com/v1/${photo.name}/media?maxWidthPx=800&skipHttpRedirect=true`, {
        headers: { "x-goog-api-key": serverKey() },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new HttpError(`Couldn't reach Google at https://places.googleapis.com: ${(err as Error).message}`, 502);
    }
    const json = (await res.json().catch(() => ({}))) as { photoUri?: string; error?: { message?: string } };
    if (!res.ok) throw new HttpError(`Google answered ${res.status}: ${json.error?.message ?? res.statusText}`, 502);
    if (json.photoUri) result = { url: json.photoUri, attribution: photo.authorAttributions?.[0]?.displayName };
  }
  if (photoCache.size >= 200) photoCache.delete(photoCache.keys().next().value!);
  photoCache.set(cacheKey, { at: Date.now(), photo: result });
  return result;
}
