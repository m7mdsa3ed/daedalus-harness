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
 * searches from that. A failed fetch drops the cache slot and rethrows — the
 * routes turn that into a 502 and the UI renders enrichment as unavailable,
 * because a dead upstream must degrade to "no metadata", never to an error in
 * the editor.
 */

const CATALOG_URL = process.env.DAEDALUS_MODELS_DEV_URL ?? "https://models.dev/api.json";

/** One hour: the catalog changes on maintainer time, not request time. */
const CACHE_TTL_MS = 60 * 60 * 1000;

const FETCH_TIMEOUT_MS = 20_000;

/** The slice of a models.dev model entry we understand. Anything else in the
    payload is ignored — the file grows fields constantly and we must not care. */
interface RawModel {
  id?: string;
  name?: string;
  description?: string;
  limit?: { context?: number; output?: number };
  /** USD per million tokens, as models.dev serves it — no conversion. */
  cost?: { input?: number; output?: number };
  modalities?: { input?: string[]; output?: string[] };
  reasoning_options?: { type?: string; values?: string[] }[];
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
}

export interface ModelsDevProvider {
  id: string;
  name: string;
}

interface NormalizedProvider extends ModelsDevProvider {
  models: ModelDevEntry[];
}

type Catalog = NormalizedProvider[];

function toEntry(providerId: string, providerName: string, id: string, raw: RawModel): ModelDevEntry {
  const efforts: string[] = [];
  for (const option of raw.reasoning_options ?? []) {
    if (option.type === "effort") {
      for (const value of option.values ?? []) {
        const lowered = value.trim().toLowerCase();
        if (lowered && !efforts.includes(lowered)) efforts.push(lowered);
      }
    }
  }
  const context = raw.limit?.context;
  const output = raw.limit?.output;
  const input = raw.cost?.input;
  const outputCost = raw.cost?.output;
  return {
    providerId,
    providerName,
    id,
    name: raw.name?.trim() || id,
    ...(raw.description?.trim() ? { description: raw.description.trim() } : {}),
    ...(typeof context === "number" && context > 0 ? { contextWindow: Math.round(context) } : {}),
    ...(typeof output === "number" && output > 0 ? { maxOutputTokens: Math.round(output) } : {}),
    ...(typeof input === "number" && Number.isFinite(input) && typeof outputCost === "number" && Number.isFinite(outputCost)
      ? { pricing: { input, output: outputCost } }
      : {}),
    reasoningEfforts: efforts,
    ...(raw.modalities?.input?.length ? { modalities: raw.modalities.input } : {}),
  };
}

let cache: { at: number; data: Catalog } | undefined;
let inflight: Promise<Catalog> | undefined;

async function fetchCatalog(): Promise<Catalog> {
  const res = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`models.dev returned ${res.status}`);
  const raw = (await res.json()) as Record<string, RawProvider>;
  const catalog: Catalog = [];
  for (const [providerId, provider] of Object.entries(raw)) {
    const providerName = provider?.name?.trim() || providerId;
    const models: ModelDevEntry[] = [];
    for (const [modelId, model] of Object.entries(provider?.models ?? {})) {
      if (!model) continue;
      models.push(toEntry(providerId, providerName, modelId, model));
    }
    catalog.push({ id: providerId, name: providerName, models });
  }
  catalog.sort((a, b) => a.name.localeCompare(b.name));
  return catalog;
}

/** The normalized catalog, from cache when it is fresh and otherwise from one
    shared fetch — two concurrent callers must not both pull 4.4 MB. */
async function catalog(): Promise<Catalog> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.data;
  if (!inflight) {
    inflight = fetchCatalog()
      .then((data) => {
        cache = { at: Date.now(), data };
        return data;
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
