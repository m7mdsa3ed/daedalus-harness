/*
 * The web-search backend the built-in `web-search` MCP server answers against.
 *
 * This is the *shared* half — the API calls and the hit formatting — and it is
 * deliberately free of harness internals and free of import-time side effects,
 * because it is imported by two processes with two different config sources:
 *
 *   - the MCP server subprocess (`websearch-mcp.ts`), which receives the
 *     credentials through `process.env` (the env the harness declared on the
 *     `McpServerStdio` entry at spawn), and
 *   - the harness itself, which only needs `toMcpServerEnv` to build that env
 *     from data/config.json (see sessions.mcpServersFor / library.seedWebSearch).
 *
 * Every function takes an explicit `env` object rather than reading ambient
 * globals, so a caller can supply whatever source it owns. Nothing here knows
 * what `config.json` is, and nothing here mutates process state.
 *
 * The endpoint shapes match the cc-cli proxy (`~/bin/cc-cli/src/webproxy.ts`),
 * which this leans on: `/v1/search` answers `{ results: [{ title, url, ... }] }`
 * and `/v1/web/fetch` answers `{ content | text | markdown }`.
 */

export const FETCH_CHAR_LIMIT = 15_000;
const TOOL_TIMEOUT_MS = 20_000;
const SEARCH_COUNT = 10;

/** Name of the harness's own `web-search` MCP server, both as the agent sees it
    (`mcp__web-search__web_search`) and as the `McpServerStdio.name` key. */
export const WEB_SEARCH_SERVER_NAME = "web-search";

/** The env vars a spawned `web-search` MCP server reads. The harness maps its
    `data/config.json` `webSearch` block onto these (see `toMcpServerEnv`). */
export const SEARCH_ENV_KEYS = [
  "WEB_SEARCH_API_BASE_URL",
  "WEB_SEARCH_API_TOKEN",
  "WEB_SEARCH_MODEL",
  "WEB_FETCH_MODEL",
] as const;

export type SearchEnv = {
  /** Search API base URL, e.g. `http://localhost:20128`. */
  WEB_SEARCH_API_BASE_URL: string;
  /** Bearer token for the search API. */
  WEB_SEARCH_API_TOKEN: string;
  /** Model id the search API serves for `/v1/search`. */
  WEB_SEARCH_MODEL: string;
  /** Model id the search API serves for `/v1/web/fetch`. */
  WEB_FETCH_MODEL: string;
};

export type Hit = { title: string; url: string; description: string };

/** Read the four env vars a spawned server expects. Throws on the missing ones
    rather than silently returning no results — a misconfigured thread should
    say so, not come back empty. */
export function readSearchEnv(env: NodeJS.ProcessEnv): SearchEnv {
  const base = env.WEB_SEARCH_API_BASE_URL;
  const token = env.WEB_SEARCH_API_TOKEN;
  const searchModel = env.WEB_SEARCH_MODEL;
  const fetchModel = env.WEB_FETCH_MODEL;
  const missing = [
    !base && "WEB_SEARCH_API_BASE_URL",
    !token && "WEB_SEARCH_API_TOKEN",
    !searchModel && "WEB_SEARCH_MODEL",
    !fetchModel && "WEB_FETCH_MODEL",
  ].filter(Boolean);
  if (missing.length) {
    throw new Error(`web-search is missing env: ${missing.join(", ")}`);
  }
  return {
    WEB_SEARCH_API_BASE_URL: base!.replace(/\/$/, ""),
    WEB_SEARCH_API_TOKEN: token!,
    WEB_SEARCH_MODEL: searchModel!,
    WEB_FETCH_MODEL: fetchModel!,
  };
}

/** The `McpServerStdio.env` pairs a spawned `web-search` server gets. Each key
    is in `SEARCH_ENV_KEYS`. The library row stores none of these — they are
    injected at spawn so a config edit is live, never a stale cached token. */
export function toMcpServerEnv(cfg: {
  searchApiBaseUrl: string;
  searchApiToken: string;
  searchModel: string;
  fetchModel: string;
}): { name: string; value: string }[] {
  return [
    { name: "WEB_SEARCH_API_BASE_URL", value: cfg.searchApiBaseUrl },
    { name: "WEB_SEARCH_API_TOKEN", value: cfg.searchApiToken },
    { name: "WEB_SEARCH_MODEL", value: cfg.searchModel },
    { name: "WEB_FETCH_MODEL", value: cfg.fetchModel },
  ];
}

async function apiJson(env: SearchEnv, path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${env.WEB_SEARCH_API_BASE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.WEB_SEARCH_API_TOKEN}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TOOL_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`search API returned ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

export function toHits(raw: unknown): Hit[] {
  const items =
    (raw as { results?: unknown })?.results ??
    (raw as { data?: unknown })?.data ??
    (raw as { web?: { results?: unknown } })?.web?.results ??
    [];
  return (Array.isArray(items) ? items : []).map((h) => {
    const o = (h ?? {}) as Record<string, unknown>;
    return {
      title: String(o.title ?? o.name ?? ""),
      url: String(o.url ?? o.link ?? ""),
      description: stripTags(String(o.description ?? o.snippet ?? o.content ?? o.text ?? "")),
    };
  });
}

export async function runProvider(env: SearchEnv, query: string): Promise<Hit[]> {
  const raw = await apiJson(env, "/v1/search", {
    model: env.WEB_SEARCH_MODEL,
    query,
    search_type: "web",
    max_results: SEARCH_COUNT,
  });
  return toHits(raw);
}

/** Numbered title/url/snippet list — what a model reads best. */
export function formatHits(hits: Hit[]): string {
  if (hits.length === 0) return "No results.";
  return hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.description}`).join("\n\n");
}

/** Search, formatted for the model. Errors are folded into the returned text
    so the tool still answers and the agent can react, never throws. */
export async function runSearch(env: SearchEnv, query: string): Promise<string> {
  try {
    return formatHits(await runProvider(env, query));
  } catch (err) {
    return `Error: ${(err as Error).message}.`;
  }
}

/** Strip HTML and decode the numeric/named entities a snippet is littered with,
    collapsing whitespace so the model gets readable prose, not markup. */
export function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    // Brave snippets are full of &#x27; and &#39; — decode numerics before the
    // named ones so &amp;#39; can't turn into a stray quote.
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Fetch a URL as readable markdown, truncated to `FETCH_CHAR_LIMIT`. */
export async function runFetch(env: SearchEnv, url: string): Promise<string> {
  if (!/^https?:\/\//i.test(url)) return "Error: only http(s) URLs are supported.";
  try {
    const raw = await apiJson(env, "/v1/web/fetch", { model: env.WEB_FETCH_MODEL, url, format: "markdown" });
    const o = raw as Record<string, unknown>;
    const text = String(o.content ?? o.text ?? o.markdown ?? (o.data as Record<string, unknown>)?.content ?? "");
    return text.length > FETCH_CHAR_LIMIT ? text.slice(0, FETCH_CHAR_LIMIT) + "\n\n[truncated]" : text;
  } catch (err) {
    return `Error: ${(err as Error).message}.`;
  }
}
