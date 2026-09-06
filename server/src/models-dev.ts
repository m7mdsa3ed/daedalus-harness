/**
 * models.dev, on demand.
 *
 * models.dev publishes a community-maintained catalog of every provider's
 * models — names, context windows, pricing, reasoning efforts, modalities — as
 * one `api.json`. That is the metadata a profile's `models[]` wants behind it,
 * and it is exactly what nobody wants to type by hand.
 *
 * The file is ~4.4 MB, so the browser never sees it raw: we fetch it once,
 * cache the parsed (normalized) catalog in memory for an hour, and answer
 * searches from that. A failed refetch keeps serving the stale copy; only a
 * failure with nothing cached rethrows — the routes turn that into a 502 and
 * the UI renders enrichment as unavailable, because a dead upstream must
 * degrade to "no metadata", never to an error in the editor.
 */

const CATALOG_URL = process.env.DAEDALUS_MODELS_DEV_URL ?? "https://models.dev/api.json";

/** One hour: the catalog changes on maintainer time, not request time. */
const CACHE_TTL_MS = 60 * 60 * 1000;

const FETCH_TIMEOUT_MS = 20_000;

/** The slice of a models.dev model entry we understand. Anything else in the
    payload is ignored — the file grows fields constantly and we must not care.

    Every field is typed as `unknown`-ish on purpose: this is a community-edited
    file, and these annotations are a hope, not a guarantee. `sarvam-105b` ships
    `reasoning_options: [{type:"effort", values:[null,"low","medium","high"]}]`
    — a leading `null` for "no effort" — and one `.trim()` on it threw inside the
    normalize loop, which failed the whole catalog, which made every provider and
    every search 502 as "couldn't reach models.dev". Two bad characters in one of
    ~200 providers took the feature off the air and blamed the network. So the
    reader below coerces rather than trusts, per field. */
interface RawModel {
  id?: string;
  name?: unknown;
  description?: unknown;
  limit?: { context?: unknown; output?: unknown };
  /** USD per million tokens, as models.dev serves it — no conversion. */
  cost?: { input?: unknown; output?: unknown };
  modalities?: { input?: unknown; output?: unknown };
  reasoning_options?: ({ type?: unknown; values?: unknown } | null)[];
}

interface RawProvider {
  id?: string;
  name?: string;
  models?: Record<string, RawModel>;
}

/** One model, normalized out of api.json into the shape profiles want. */
export interface ModelDevEntry {
  providerId: string;
  providerName: string;
  id: string;
  name: string;
  description?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  pricing?: { input: number; output: number };
  /** Effort levels from `reasoning_options` entries of type "effort" — the only
      kind that maps onto our `reasoningEfforts` ("toggle"/"budget_tokens" are
      different controls). Lowercased to match what the editors store. */
  reasoningEfforts: string[];
  /** Input modalities, e.g. ["text", "image"]. */
  modalities?: string[];
  /** The provider's own mark — models.dev serves one per provider at
      https://models.dev/logos/<provider>.svg, so it is derived, not carried by
      the upstream model entry. */
  iconUrl?: string;
}

export interface ModelsDevProvider {
  id: string;
  name: string;
}

/**
 * A search hit in the shape the client's `ModelCandidate` promises: `label`,
 * not `name`, and the `devRef` provenance already assembled.
 *
 * The two model sources — a provider's own `/models` (via
 * `enrichProviderModels`) and this catalog — are one type in the browser, and
 * this one used to answer with the internal entry instead: `name` where every
 * reader looked for `label`, and no `devRef` at all. TypeScript could not see
 * it (the client types the response, it does not derive it), so a hit's display
 * name silently read `undefined` — importing from models.dev showed bare ids,
 * and writing one into a model row put `undefined` where a string belongs,
 * which the next `.trim()` threw on. `ModelDevEntry` keeps `name` because the
 * ranking and `enrichProviderModels` read it; the conversion happens here, once,
 * at the edge that is the API.
 */
export interface ModelsDevCandidate extends Omit<ModelDevEntry, "name"> {
  label: string;
  devRef: string;
}

export const toCandidate = ({ name, ...entry }: ModelDevEntry): ModelsDevCandidate => ({
  ...entry,
  label: name,
  devRef: `${entry.providerId}/${entry.id}`,
  /* Derived here rather than in `toEntry`: the catalog entry is provider- and
     model-agnostic, and every consumer of the candidate (the profile editor,
     the presets, the fetch flow) wants the mark. */
  iconUrl: `https://models.dev/logos/${entry.providerId}.svg`,
});

interface NormalizedProvider extends ModelsDevProvider {
  models: ModelDevEntry[];
}

type Catalog = NormalizedProvider[];

/** A trimmed string, or "" for anything that is not one (null included). */
const str = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/** A positive finite number, or undefined — a zero limit is not a limit. */
const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;

/** A price, where zero is a real answer: free models are the reason a profile
    points at a gateway in the first place. */
const cost = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

/** The trimmed, lowercased, de-duplicated strings of an array — skipping every
    entry that is not one. An array that is not an array is empty. */
function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const s = str(item).toLowerCase();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

function toEntry(providerId: string, providerName: string, id: string, raw: RawModel): ModelDevEntry {
  const efforts: string[] = [];
  for (const option of raw.reasoning_options ?? []) {
    if (option?.type !== "effort") continue;
    for (const value of strings(option.values)) if (!efforts.includes(value)) efforts.push(value);
  }
  const name = str(raw.name);
  const description = str(raw.description);
  const context = num(raw.limit?.context);
  const output = num(raw.limit?.output);
  const input = cost(raw.cost?.input);
  const outputCost = cost(raw.cost?.output);
  const modalities = strings(raw.modalities?.input);
  return {
    providerId,
    providerName,
    id,
    name: name || id,
    ...(description ? { description } : {}),
    ...(context !== undefined ? { contextWindow: Math.round(context) } : {}),
    ...(output !== undefined ? { maxOutputTokens: Math.round(output) } : {}),
    ...(input !== undefined && outputCost !== undefined ? { pricing: { input, output: outputCost } } : {}),
    reasoningEfforts: efforts,
    ...(modalities.length ? { modalities } : {}),
  };
}

let cache: { at: number; data: Catalog } | undefined;
let inflight: Promise<Catalog> | undefined;

async function fetchCatalog(): Promise<Catalog> {
  const res = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`models.dev returned ${res.status}`);
  const raw = (await res.json()) as Record<string, RawProvider | null>;
  const catalog: Catalog = [];
  for (const [providerId, provider] of Object.entries(raw)) {
    const providerName = str(provider?.name) || providerId;
    const models: ModelDevEntry[] = [];
    for (const [modelId, model] of Object.entries(provider?.models ?? {})) {
      if (!model || typeof model !== "object") continue;
      // The last line of defence, and the one that does not depend on having
      // predicted the shape: a model this reader cannot make sense of is a
      // model missing from the list, never a catalog nobody can search.
      try {
        models.push(toEntry(providerId, providerName, modelId, model));
      } catch (err) {
        console.warn(`models.dev: skipping ${providerId}/${modelId}`, err);
      }
    }
    catalog.push({ id: providerId, name: providerName, models });
  }
  catalog.sort((a, b) => a.name.localeCompare(b.name));
  return catalog;
}

/** The normalized catalog, from cache when it is fresh and otherwise from one
    shared fetch — two concurrent callers must not both pull 4.4 MB.
    A stale slot outlives its TTL when the refetch fails: the catalog changes on
    maintainer time, so an hour-old copy is the same answer, and losing it to a
    ten-second upstream blip is how a lookup that has worked all session suddenly
    502s. Only a cold cache rethrows. */
async function catalog(): Promise<Catalog> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.data;
  if (!inflight) {
    inflight = fetchCatalog()
      .then((data) => {
        cache = { at: Date.now(), data };
        return data;
      })
      .catch((err) => {
        if (cache) return cache.data;
        throw err;
      })
      .finally(() => {
        inflight = undefined;
      });
  }
  return inflight;
}

export async function modelsDevProviders(): Promise<ModelsDevProvider[]> {
  const data = await catalog();
  return data.map(({ id, name }) => ({ id, name }));
}

/** Substring search over model id and name. Exact id match first, then
    id-prefix, then everything else — so a lookup by the id a gateway serves
    (the enrichment case) puts its own answer at the top, and a keyword search
    (the browse case) still works. Empty query + provider = that provider's
    whole list, which is how the browser shows a provider without typing. */
export async function searchModelsDev(
  q: string,
  { provider, limit = 50 }: { provider?: string; limit?: number } = {},
): Promise<ModelDevEntry[]> {
  const data = await catalog();
  const providers = provider ? data.filter((p) => p.id === provider) : data;
  const needle = q.trim().toLowerCase();
  const scored: { score: number; entry: ModelDevEntry }[] = [];
  for (const p of providers) {
    for (const entry of p.models) {
      if (!needle) {
        scored.push({ score: 0, entry });
        continue;
      }
      const id = entry.id.toLowerCase();
      const name = entry.name.toLowerCase();
      let score = -1;
      if (id === needle) score = 0;
      else if (id.startsWith(needle)) score = 1;
      else if (id.includes(needle)) score = 2;
      else if (name.includes(needle)) score = 3;
      if (score >= 0) scored.push({ score, entry });
    }
  }
  scored.sort(
    (a, b) =>
      a.score - b.score ||
      a.entry.providerId.localeCompare(b.entry.providerId) ||
      a.entry.id.localeCompare(b.entry.id),
  );
  return scored.slice(0, Math.max(1, limit)).map((s) => s.entry);
}
