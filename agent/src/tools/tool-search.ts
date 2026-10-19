/* ── Deferred MCP tools ──
   Every MCP server a reader links adds its whole tool block to *every* step's
   request, used or not, and ten servers can be a fifth of the window before the
   conversation starts. So every MCP tool is marked `deferLoading` — always, not
   past a share of the window, because the reader adding a server should never
   be what decides how the prompt is shaped — and the AI SDK's `toolSearch()` is
   added: the SDK leaves
   deferred tools out of the request until a search finds them, and sends a
   match from the next step on.

   Two things are ours, because the SDK's are per generation:
   - **What a thread already loaded is read off its conversation, never
     stored.** The SDK forgets its discoveries when `streamText` returns, so
     every turn would search again for the tool it used the turn before. A
     tool named by a search result or a call in the history is built
     undeferred; a reload keeps it because the history does, and a compaction
     that summarises the results away defers it again.
   - **It works the way Claude Code's `ToolSearch` does: the model already
     knows the names, and the search is how it loads a schema.** The
     description lists every MCP tool grouped by server with a one-line summary
     (see `catalogue`), and `select:a,b` loads named tools outright — keywords
     are the fallback, not the method. The list is every MCP tool rather than
     the ones still held back, so it does not change when one loads: a
     description that moved with every load would cost the next turn its cached
     prefix.

   Three things the first version got wrong, all of them paid for in wasted
   steps, and what stands in their place:
   - A `select:` was an exact-string match, so a model that wrote a leaf name or
     a server path loaded nothing at all. `resolveOne` now takes the whole name,
     a `<server>/<tool>` path, `<server>/*`, or a bare tool name when it is
     unambiguous, and tolerates the punctuation a model guesses at.
   - `+server` had to be a whole token of the tool name, so `+gh` never found
     `mcp__github__…`. It resolves the server by prefix now, and alone it loads
     that server rather than its first three tools.
   - Both caps truncated in silence. The SDK's is set to the catalogue's own
     size (`maxResults`), so no selection of named tools is ever cut short, and
     the two caps that remain are stated in the description.

   The cost is the provider's prefix cache: the tool block sits at the front of
   an OpenAI-shaped request, so a step that loads a tool re-sends what follows
   uncached. Once per load, against every step paying for every schema. */
import { toolSearch, type ModelMessage, type ToolSet } from "ai";
import type { ToolMeta } from "./context.js";
import { inputOf } from "./context.js";
import { norm } from "./repair.js";

export const SEARCH_TOOL = "search_tools";

/* A keyword search loads this many — enough that a task spanning a handful of
   one server's tools takes one search rather than three. A whole-server load
   (`+server`, `select:server/*`) takes up to `SERVER_RESULTS`; a selection of
   *named* tools is never capped, because the SDK's cap is set to the
   catalogue's own size below. */
const KEYWORD_RESULTS = 5;
const SERVER_RESULTS = 25;
const MAX_RESULTS = 25;

export const searchToolsMeta: ToolMeta = {
  kind: "search",
  title: (input) => `Search tools: ${String(inputOf(input).query ?? "")}`,
};

export interface Deferral {
  /** Every tool that is never deferred, `search_tools` included — what the
      system prompt names. Not the active set: a load would rewrite the prompt
      at the next turn, and everything after the list (most of the prompt) went
      uncached on that turn's first call. Measured: 12% cached against 94%. */
  base: string[];
  /** The tool names a step sends, given the messages it sends — the SDK's
      own choice, mirrored for the token breakdown. */
  activeFor(messages: ModelMessage[]): string[];
}

/**
 * Defer every MCP tool in `tools` except those `messages` already loaded. Adds
 * `search_tools` and returns how to read a step's active set, or null when
 * there is no MCP tool to defer.
 */
export function deferMcpTools(tools: ToolSet, messages: ModelMessage[]): Deferral | null {
  const mcp = Object.keys(tools).filter((name) => name.startsWith("mcp__"));
  if (mcp.length === 0) return null;
  const deferred = new Set(mcp);
  const loaded = new Set(loadedIn(messages, deferred));
  for (const name of mcp) {
    if (!loaded.has(name)) tools[name] = { ...tools[name], deferLoading: true };
  }
  /* Spread, not rebuilt: the SDK tags its search tool with symbols, which the
     spread keeps, and the tags are what bind it to the generation. The cap is
     the catalogue's size, so a selection can never be quietly cut short. */
  tools[SEARCH_TOOL] = {
    ...toolSearch({ search: searchDeferred, maxResults: Math.max(MAX_RESULTS, mcp.length) }),
    description: `Loads the full schema of MCP tools that are deferred to save context. Every MCP tool on this thread is in the list at the bottom: it is complete, and it does not change as tools load. A deferred tool cannot be called until it is loaded — its schema is not in your tool list yet. Load it here first; it becomes callable from the next step and stays loaded for the rest of the conversation. A tool already loaded can be called directly.

A search is a step of its own, so when the catalogue already names what you need, select it instead of describing it.

Query forms:
- "select:<name>" loads the tools named, separated by commas or spaces. A name is the whole \`mcp__<server>__<tool>\`, or \`<server>/<tool>\`, or \`<server>/*\` for that server's tools (up to ${SERVER_RESULTS}), or the bare tool name when only one tool in the catalogue carries it. Naming tools is never cut short.
- "+<server> <keywords>" searches one server only. "+<server>" alone loads that server's tools.
- Keywords ("github issue") load the ${KEYWORD_RESULTS} best matches by name, then description.

MCP tools, by server:
${catalogue(mcp, tools)}`,
  };
  const base = Object.keys(tools).filter((name) => !deferred.has(name));
  return {
    base,
    activeFor: (stepMessages) => [...base, ...loadedIn(stepMessages, deferred)],
  };
}

/* The catalogue: every tool, grouped under the server it came from, one line
   each. Grouping is what makes `+server` and `select:server/*` legible — a flat
   list of `mcp__github__…` lines never showed a model that twelve of them
   belonged together, so a task needing four took three searches. It costs about
   what the flat list cost, and it is built from the names the tool set already
   has, so it stays byte-identical as tools load. */
const SYNOPSIS_CHARS = 160;

function catalogue(mcp: string[], tools: ToolSet): string {
  const groups = new Map<string, string[]>();
  for (const name of mcp) {
    const { server, leaf } = parts(name);
    const line = `  ${leaf}${synopsis(tools[name]?.description)}`;
    const group = groups.get(server);
    if (group) group.push(line);
    else groups.set(server, [line]);
  }
  return [...groups]
    .map(([server, lines]) => [`${server} (${lines.length} ${lines.length === 1 ? "tool" : "tools"})`, ...lines].join("\n"))
    .join("\n");
}

/* A summary and the first sentence of what it does, capped at a clause
   boundary. Bare names were Claude Code's dialect, and a Claude model guesses
   from them and selects; an OpenAI model is trained on a tool search that shows
   each deferred function's description and holds back only its schema, so
   handed bare names it searched by keyword for the descriptions — a wasted step
   that loaded strangers. */
function synopsis(description: unknown): string {
  if (typeof description !== "string") return "";
  const text = description.trim().replace(/\s+/g, " ");
  if (!text) return "";
  const first = (text.split(/(?<=[.!?])\s|\n/)[0] ?? text).trim();
  if (!first) return "";
  if (first.length <= SYNOPSIS_CHARS) return `: ${first}`;
  const cut = first.slice(0, SYNOPSIS_CHARS);
  const clause = Math.max(cut.lastIndexOf("; "), cut.lastIndexOf(", "));
  const head = clause > SYNOPSIS_CHARS / 2 ? cut.slice(0, clause) : cut.slice(0, cut.lastIndexOf(" ") + 1);
  return `: ${head.trimEnd()}…`;
}

/**
 * The SDK's `search` callback: exact names for `select:`, else a keyword rank.
 * The SDK drops unknown names and duplicates, so a selection is passed through.
 */
export function searchDeferred({ query, tools }: { query: string; tools: { name: string; description?: string }[] }): string[] {
  const text = query.trim();
  const select = /^select:(.+)$/is.exec(text);
  if (select) return resolveSelect(select[1], tools);

  const names = tools.map((tool) => tool.name);
  const { servers, loose } = resolveServers(
    [...text.matchAll(/(?:^|\s)\+(\S+)/g)].map((match) => match[1]),
    names,
  );
  const words = tokenize(text.replace(/(^|\s)\+\S+/g, " "));
  /* Nothing to go on — a bare "+" — is not a search for the first five tools. */
  if (words.length === 0 && servers.size === 0 && loose.length === 0) return [];
  /* A `+server` with no keywords is a request for that server, not for its best
     five tools — the cluster is the thing the caller named. */
  const whole = words.length === 0 && servers.size > 0 && loose.length === 0;
  const cap = whole ? SERVER_RESULTS : KEYWORD_RESULTS;
  const ranked = tools
    .filter(({ name }) => servers.size === 0 || servers.has(parts(name).server))
    .map(({ name, description }) => {
      /* A `+term` naming no server is still required to appear in the name, even
         with no keywords to rank by — otherwise `+issue` would load the first
         five tools of every server. */
      if (!loose.every((term) => tokenize(name).includes(term))) return { name, score: 0 };
      return { name, score: words.length === 0 ? 1 : keywordScore(name, description ?? "", words) };
    })
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, cap)
    .map((match) => match.name);
  if (ranked.length > 0 || words.length === 0) return ranked;
  return looseMatches(words, tools, servers);
}

/* The SDK's own weights: a name hit outranks a description hit, and a plural or
   an inflection counts as its stem (`issue` finding `issues`) — the one case
   that used to come back empty on a query that plainly named the tool. */
function keywordScore(name: string, description: string, words: string[]): number {
  const nameTerms = tokenize(name);
  const descTerms = tokenize(description);
  const nameStems = new Set(nameTerms.map(stem));
  const descStems = new Set(descTerms.map(stem));
  return words.reduce(
    (sum, word) => sum + (nameTerms.includes(word) || nameStems.has(stem(word)) ? 2 : 0) + (descTerms.includes(word) || descStems.has(stem(word)) ? 1 : 0),
    0,
  );
}

/* Nothing scored: a query one plural, one inflection or one suffix away from a
   name would otherwise come back empty and cost the step. Only the *name*
   counts here — matching loose text in a description is how a keyword search
   loads strangers, which is the failure the synopsis and the stem pass exist to
   avoid. */
function looseMatches(words: string[], tools: { name: string }[], servers: Set<string>): string[] {
  const terms = words.map(norm).filter((term) => term.length >= 3);
  if (terms.length === 0) return [];
  return tools
    .filter(({ name }) => servers.size === 0 || servers.has(parts(name).server))
    .map(({ name }) => ({ name, score: terms.reduce((sum, term) => sum + (norm(name).includes(term) ? 1 : 0), 0) }))
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, KEYWORD_RESULTS)
    .map((match) => match.name);
}

/* A `+term` that names a server — `+gh`, `+git` and `+github` all reach a
   `github` server. One that names none keeps its old meaning: a term the tool's
   own name must contain. */
function resolveServers(tokens: string[], names: string[]): { servers: Set<string>; loose: string[] } {
  const servers = new Set<string>();
  const loose: string[] = [];
  for (const token of tokens) {
    const key = norm(token.replace(/\/\*$/, ""));
    if (!key) continue;
    const matched = serversMatching(key, names);
    if (matched.length === 0) {
      loose.push(...tokenize(token));
      continue;
    }
    for (const server of matched) servers.add(server);
  }
  return { servers, loose };
}

/** `select:` — every name it lists, in the forms the description promises. */
function resolveSelect(text: string, tools: { name: string }[]): string[] {
  const names = tools.map((tool) => tool.name);
  const chosen: string[] = [];
  for (const token of text.split(/[,\s]+/)) {
    if (token) chosen.push(...resolveOne(token, names));
  }
  return chosen;
}

/**
 * One selected name. Exact first, then the same name spelled with different
 * punctuation, then a `<server>/<tool>` (or `<server>/*`) path, then a bare
 * server name, then a bare tool name when exactly one tool carries it, then a
 * server prefix. Anything still unmatched resolves to nothing, which the model
 * sees as an empty result and can answer by selecting the full name.
 */
function resolveOne(token: string, names: string[]): string[] {
  const exact = names.find((name) => name === token);
  if (exact) return [exact];
  const key = norm(token);
  if (!key) return [];
  const spelled = names.find((name) => norm(name) === key);
  if (spelled) return [spelled];

  const slash = token.indexOf("/");
  if (slash > 0) {
    const servers = serversMatching(norm(token.slice(0, slash)), names);
    if (servers.length === 0) return [];
    const own = names.filter((name) => servers.includes(parts(name).server));
    const leaf = token.slice(slash + 1).trim();
    if (leaf === "*" || leaf === "") return own.slice(0, SERVER_RESULTS);
    const leafKey = norm(leaf);
    return own.filter((name) => norm(parts(name).leaf) === leafKey);
  }

  /* A bare server name outranks a tool name: `github` is the cluster, and a
     whole-server load is what a model naming it is asking for. */
  const exactServer = knownServers(names).filter((server) => norm(server) === key);
  if (exactServer.length > 0) return names.filter((name) => exactServer.includes(parts(name).server));
  const leaf = names.filter((name) => norm(parts(name).leaf) === key);
  if (leaf.length === 1) return leaf;
  if (key.length > 1) {
    const prefixed = serversMatching(key, names);
    if (prefixed.length > 0) return names.filter((name) => prefixed.includes(parts(name).server));
  }
  return [];
}

/**
 * Servers named by `key`: the exact ones, else every name it prefixes, else —
 * for an abbreviation like `gh` for `github` — the one server it is a
 * subsequence of. Two servers answering to an abbreviation is ambiguity, and
 * nothing is loaded: a wrong whole-server load is dozens of schemas.
 */
function serversMatching(key: string, names: string[]): string[] {
  if (!key) return [];
  const servers = knownServers(names);
  const exact = servers.filter((server) => norm(server) === key);
  if (exact.length > 0) return exact;
  const prefixed = servers.filter((server) => norm(server).startsWith(key));
  if (prefixed.length > 0) return prefixed;
  if (key.length < 2) return [];
  const abbreviated = servers.filter((server) => isSubsequence(key, norm(server)));
  return abbreviated.length === 1 ? abbreviated : [];
}

/** Every character of `needle` in `haystack`, in order — `gh` in `github`. */
function isSubsequence(needle: string, haystack: string): boolean {
  let at = 0;
  for (const char of haystack) {
    if (char === needle[at]) at++;
    if (at === needle.length) return true;
  }
  return false;
}

/** Every distinct server in `names`, in the order the tool set was built in. */
function knownServers(names: string[]): string[] {
  return [...new Set(names.map((name) => parts(name).server))];
}

/** `mcp__<server>__<tool>` split — the server's own name and the tool's, with
    any punctuation the server shipped already flattened by `toolKey`. */
function parts(name: string): { server: string; leaf: string } {
  const segments = name.split("__");
  if (segments.length < 3) return { server: segments[0] ?? name, leaf: name };
  return { server: segments[1] ?? name, leaf: segments.slice(2).join("__") };
}

/* The SDK's tokenizer, so a keyword means here what it meant before: camelCase
   split, lower-cased, letters and digits only. */
function tokenize(text: string): string[] {
  return text.replace(/([a-z\d])([A-Z])/g, "$1 $2").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/* One inflection, not a stemmer: `issues` and `issue` are the same word for a
   search, and `repositories`/`repository` are too. Anything deeper is a library
   and a different set of misses. */
function stem(term: string): string {
  if (term.length > 4 && term.endsWith("ies")) return `${term.slice(0, -3)}y`;
  if (term.length > 4 && term.endsWith("es")) {
    /* "boxes" and "dishes" drop the whole ending; "issues" only the `s`. */
    const base = term.slice(0, -2);
    return /(?:[sxz]|ch|sh)$/.test(base) ? base : term.slice(0, -1);
  }
  if (term.length > 3 && term.endsWith("s") && !term.endsWith("ss") && !term.endsWith("us")) return term.slice(0, -1);
  return term;
}

/** The subset of `tools` named by `names` — what a step's request carries. */
export function pickTools(tools: ToolSet, names: string[]): ToolSet {
  return Object.fromEntries(names.filter((n) => n in tools).map((n) => [n, tools[n]])) as ToolSet;
}

/* The SDK's search answers `{ tools: [{ name, description }] }`. A deferred
   tool the model called without searching counts too (an old thread from before
   deferral, or a call the SDK refused as unloaded), so its next call has its
   schema. */
function loadedIn(messages: ModelMessage[], deferred: Set<string>): string[] {
  const loaded = new Set<string>();
  for (const message of messages) {
    if (typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type === "tool-call" && deferred.has(part.toolName)) loaded.add(part.toolName);
      if (part.type === "tool-result" && part.toolName === SEARCH_TOOL && part.output.type === "json") {
        const found = (part.output.value as { tools?: unknown } | null)?.tools;
        if (!Array.isArray(found)) continue;
        for (const t of found) {
          const name = (t as { name?: unknown } | null)?.name;
          if (typeof name === "string" && deferred.has(name)) loaded.add(name);
        }
      }
    }
  }
  return [...loaded];
}
