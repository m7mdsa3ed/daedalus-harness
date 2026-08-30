/* ── Sources of a turn ──
   The pages a turn's answer rests on, read out of the tool calls that fetched
   and searched during it. A search row lists ten results; the answer used two
   of them. This is the two.

   A page counts as a source when the agent *read* it (a web fetch) or *cited*
   it (its address appears in the agent's own prose for the turn — as a link
   or bare). A result the agent merely saw in a list is not a source: listing
   every hit would make the strip a second copy of the search rows above it.
   All of it is derived from the transcript, so it survives reload and replay
   for free and needs nothing journaled. */
import type { TextItem, ThreadItem, ToolItem } from "./store"
import { extractWebFetch, extractWebSearch, hostOf } from "./tools"

export interface Source {
  url: string
  title?: string
  /** `fetched` beats `cited`: a page the agent read is a stronger claim than
      one it linked. */
  via: "fetched" | "cited"
}

export interface TurnSources {
  sources: Source[]
  searches: number
  fetches: number
}

/** `https://Example.com/a/` and `example.com/a` are one page. */
const canon = (url: string): string =>
  url
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/[)\].,;:'"]+$/, "")
    .replace(/\/+$/, "")
    .toLowerCase()

const URL_RE = /https?:\/\/[^\s<>()"'\]]+/g

/** The sources of one turn's items — everything after a user message up to
    the next one. Empty when the turn touched the web but the answer cites
    nothing and read nothing, which is the honest answer. */
export function turnSources(items: ThreadItem[]): TurnSources {
  const tools = items.filter((item): item is ToolItem => item.kind === "tool")
  const prose = items
    .filter((item): item is TextItem => item.kind === "agent")
    .map((item) => item.text)
    .join("\n")
  const cited = new Set([...prose.matchAll(URL_RE)].map((m) => canon(m[0])))

  const seen = new Map<string, Source>()
  const add = (source: Source) => {
    const key = canon(source.url)
    if (!hostOf(source.url) || !key) return
    const prior = seen.get(key)
    if (!prior) seen.set(key, source)
    else if (prior.via === "cited" && source.via === "fetched") seen.set(key, { ...source, title: source.title ?? prior.title })
    else if (!prior.title && source.title) seen.set(key, { ...prior, title: source.title })
  }

  let searches = 0
  let fetches = 0
  for (const tool of tools) {
    if (tool.status === "failed") continue
    const fetch = extractWebFetch(tool)
    if (fetch) {
      fetches += 1
      add({ url: fetch.url, via: "fetched" })
      continue
    }
    const search = extractWebSearch(tool)
    if (!search) continue
    searches += 1
    for (const hit of search.results) {
      if (cited.has(canon(hit.url))) add({ url: hit.url, title: hit.title, via: "cited" })
    }
  }
  // A page cited in prose that no search returned is still a source — the
  // agent named it, and the reader can follow it.
  for (const item of items) {
    if (item.kind !== "agent") continue
    for (const match of item.text.matchAll(URL_RE)) {
      const url = match[0].replace(/[)\].,;:'"]+$/, "")
      if (!seen.has(canon(url))) add({ url, via: "cited" })
    }
  }

  const sources = [...seen.values()].sort((a, b) => (a.via === b.via ? 0 : a.via === "fetched" ? -1 : 1))
  return { sources, searches, fetches }
}

/** Split a transcript into turns: each user message starts one, and whatever
    precedes the first user message (a replayed notice, say) is its own. */
export function splitTurns(items: ThreadItem[]): ThreadItem[][] {
  const turns: ThreadItem[][] = []
  let current: ThreadItem[] = []
  for (const item of items) {
    if (item.kind === "user" && current.length > 0) {
      turns.push(current)
      current = []
    }
    current.push(item)
  }
  if (current.length > 0) turns.push(current)
  return turns
}
