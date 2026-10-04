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
     description lists every MCP tool by name with a one-line summary (see
     `listed`), and `select:a,b` loads named
     tools outright — keywords are the fallback, not the method. The list is
     every MCP tool rather than the ones still held back, so it does not change
     when one loads: a description that moved with every load would cost the
     next turn its cached prefix.

   The cost is the provider's prefix cache: the tool block sits at the front of
   an OpenAI-shaped request, so a step that loads a tool re-sends what follows
   uncached. Once per load, against every step paying for every schema. */
import { toolSearch, type ModelMessage, type ToolSet } from "ai";
import type { ToolMeta } from "./context.js";
import { inputOf } from "./context.js";

export const SEARCH_TOOL = "search_tools";

/* A keyword search loads this many; a `select:` loads every name it lists, up
   to the SDK's cap, which is set above any selection a model writes. */
const KEYWORD_RESULTS = 3;
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
     spread keeps, and the tags are what bind it to the generation. */
  tools[SEARCH_TOOL] = {
    ...toolSearch({ search: searchDeferred, maxResults: MAX_RESULTS }),
    description: `Loads the full schema of MCP tools that are deferred to save context. The tools below exist, but a deferred tool cannot be called until it is loaded: its schema is not in your tool list yet. Load it here first; it becomes callable from your next step and stays loaded for the rest of the conversation. A tool already loaded can be called directly.

Query forms:
- "select:name1,name2" loads those exact tools. Use this whenever you know the name.
- Keywords ("github issue") load the ${KEYWORD_RESULTS} best matches by name and description.
- "+server keywords" requires "server" in the tool name and ranks the rest.

MCP tools:
${mcp.map((name) => listed(name, tools[name].description)).join("\n")}`,
  };
  const base = Object.keys(tools).filter((name) => !deferred.has(name));
  return {
    base,
    activeFor: (stepMessages) => [...base, ...loadedIn(stepMessages, deferred)],
  };
}

/* A name and the first sentence of what it does, capped. Bare names were
   Claude Code's dialect, and a Claude model guesses from them and selects; an
   OpenAI model is trained on a tool search that shows each deferred function's
   description and holds back only its schema, so handed bare names it searched
   by keyword for the descriptions — a wasted step that loaded strangers. */
const SUMMARY_CHARS = 100;

function listed(name: string, description: unknown): string {
  if (typeof description !== "string") return name;
  const first = description.trim().split(/(?<=[.!?])\s|\n/)[0].trim();
  if (!first) return name;
  return `${name}: ${first.length > SUMMARY_CHARS ? `${first.slice(0, SUMMARY_CHARS - 1).trimEnd()}…` : first}`;
}

/**
 * The SDK's `search` callback: exact names for `select:`, else a keyword rank.
 * The SDK drops unknown names and duplicates, so a selection is passed through.
 */
export function searchDeferred({ query, tools }: { query: string; tools: { name: string; description?: string }[] }): string[] {
  const select = /^select:(.+)$/i.exec(query.trim());
  if (select) return select[1].split(",").map((name) => name.trim()).filter(Boolean);

  const words = tokenize(query.replace(/(^|\s)\+\S+/g, " "));
  const required = [...query.matchAll(/(?:^|\s)\+(\S+)/g)].flatMap((m) => tokenize(m[1]));
  return tools
    .map(({ name, description }) => {
      const nameTerms = tokenize(name);
      if (!required.every((term) => nameTerms.includes(term))) return { name, score: 0 };
      const descTerms = tokenize(description ?? "");
      /* The SDK's own weights: a name hit outranks a description hit. A bare
         `+server` query (no keywords) keeps every tool of that server. */
      const score = words.reduce((s, w) => s + (nameTerms.includes(w) ? 2 : 0) + (descTerms.includes(w) ? 1 : 0), 0);
      return { name, score: words.length === 0 && required.length > 0 ? 1 : score };
    })
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, KEYWORD_RESULTS)
    .map((match) => match.name);
}

/* The SDK's tokenizer, so a keyword means here what it meant before: camelCase
   split, lower-cased, letters and digits only. */
function tokenize(text: string): string[] {
  return text.replace(/([a-z\d])([A-Z])/g, "$1 $2").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
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
