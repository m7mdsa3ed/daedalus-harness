import { searchModelsDev } from "./models-dev.js";

/**
 * The model list behind a profile's credentials, and its models.dev half.
 *
 * A profile is credentials — a base URL and a key — so "fetch models" means
 * asking *that endpoint* what it serves (the OpenAI-compatible `GET /models`,
 * which Anthropic-shaped endpoints also answer) and then mapping each id onto
 * models.dev for the metadata nobody should have to type: name, description,
 * context window, pricing, efforts, modalities.
 *
 * The mapping is exact-match only — a full id first, then the id's tail after
 * the last "/" (how OpenRouter-style gateway ids carry their provider prefix).
 * A gateway id models.dev does not know comes back bare rather than
 * fuzzy-guessed, and a dead models.dev degrades to bare ids, never to a failed
 * fetch.
 */

/** One model as the provider serves it — id, plus the endpoint's own display
    name when it offers one (OpenAI's `id` only, Anthropic's `display_name`). */
export interface ProviderModel {
  id: string;
  label?: string;
}

/** A fetch result ready for the profile's `models[]`: the provider's id with
    models.dev's metadata attached wherever the id is known there. */
export interface ProviderModelCandidate {
  id: string;
  label: string;
  reasoningEfforts: string[];
  description?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  pricing?: { input: number; output: number };
  modalities?: string[];
  /** "providerId/modelId" in models.dev when the metadata came from there. */
  devRef?: string;
}

const FETCH_TIMEOUT_MS = 15_000;

/** Where a provider's model list lives, given what the user pasted as the base
    URL — both conventions exist: `https://api.openai.com/v1` (base includes
    the version) and `https://api.anthropic.com` (it does not). Both /models
    spellings are tried against both, so either paste works. */
function candidateUrls(base: string): string[] {
  const trimmed = base.replace(/\/+$/, "");
  if (trimmed.endsWith("/v1")) {
    const root = trimmed.slice(0, -3);
    return [`${trimmed}/models`, `${root}/models`];
  }
  return [`${trimmed}/v1/models`, `${trimmed}/models`];
}

/** The list endpoint's body, in whatever dialect the endpoint speaks: OpenAI's
    `{data: [...]}`, Anthropic's `{data: [{id, display_name}]}`, Ollama's
    `{models: [...]}`, or a bare array. Ids are deduped in server order. */
export function parseProviderModels(body: unknown): ProviderModel[] {
  const list: unknown[] = Array.isArray(body)
    ? body
    : Array.isArray((body as { data?: unknown[] })?.data)
      ? (body as { data: unknown[] }).data
      : Array.isArray((body as { models?: unknown[] })?.models)
        ? (body as { models: unknown[] }).models
        : [];
  const out: ProviderModel[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    const record = entry as { id?: unknown; name?: unknown; display_name?: unknown } | null;
    const id =
      typeof entry === "string"
        ? entry.trim()
        : String(record?.id ?? record?.name ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (typeof entry === "string") {
      out.push({ id });
      continue;
    }
    const label = String(record?.display_name ?? record?.name ?? "").trim();
    out.push({ id, ...(label && label !== id ? { label } : {}) });
  }
  return out;
}

/**
 * Ask the provider what it serves. Both candidate URLs are tried in turn — a
 * 404/401 on the first is expected for half of all base URLs, not an error —
 * and the first one that answers with a parseable, non-empty list wins. The
 * key rides both auth headers at once: `Authorization: Bearer` for the
 * OpenAI-compatible world, `x-api-key` (+ a version header) for Anthropic's,
 * and endpoints outside those two simply ignore the one that isn't theirs.
 */
export async function fetchProviderModels(baseUrl: string, apiKey: string): Promise<ProviderModel[]> {
  const attempts: string[] = [];
  for (const url of candidateUrls(baseUrl)) {
    try {
      const res = await fetch(url, {
        headers: {
          ...(apiKey ? { authorization: `Bearer ${apiKey}`, "x-api-key": apiKey } : {}),
          "anthropic-version": "2023-06-01",
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        attempts.push(`${url} → ${res.status}`);
        continue;
      }
      const models = parseProviderModels(await res.json());
      if (models.length) return models;
      attempts.push(`${url} → no models in the response`);
    } catch (err) {
      attempts.push(`${url} → ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`the provider didn't answer with a model list (${attempts.join("; ")})`);
}

/**
 * Map fetched models onto models.dev and return them as catalog candidates.
 * Concurrency is free after the first id: the catalog arrives once and every
 * lookup after that is a scan of what is already in memory.
 */
export async function enrichProviderModels(models: ProviderModel[]): Promise<ProviderModelCandidate[]> {
  return Promise.all(
    models.map(async (model): Promise<ProviderModelCandidate> => {
      const candidate: ProviderModelCandidate = {
        id: model.id,
        label: model.label ?? model.id,
        reasoningEfforts: [],
      };
      try {
        // The gateway id first, then its tail — `anthropic/claude-x` on a
        // gateway is `claude-x` in Anthropic's own corner of models.dev.
        const tail = model.id.includes("/") ? (model.id.split("/").pop() ?? "") : "";
        for (const lookup of [model.id, tail]) {
          if (!lookup) continue;
          const [hit] = await searchModelsDev(lookup, { limit: 1 });
          if (!hit || hit.id.toLowerCase() !== lookup.toLowerCase()) continue;
          // The endpoint's own display name wins; models.dev's name only when
          // the endpoint offered none (and its name is not the id again).
          if (!model.label && hit.name !== lookup) candidate.label = hit.name;
          candidate.description = hit.description;
          candidate.contextWindow = hit.contextWindow;
          candidate.maxOutputTokens = hit.maxOutputTokens;
          candidate.pricing = hit.pricing;
          candidate.modalities = hit.modalities;
          candidate.reasoningEfforts = hit.reasoningEfforts;
          candidate.devRef = `${hit.providerId}/${hit.id}`;
          break;
        }
      } catch {
        // models.dev is unreachable or malformed — the bare candidate stands.
      }
      return candidate;
    }),
  );
}
