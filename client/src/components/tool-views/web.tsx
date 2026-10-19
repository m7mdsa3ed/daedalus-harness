/* ── The web views ──
   Everything whose subject is an address: a plain fetch, a search of the web,
   the page a fetcher read, and the stack of site favicons a row wears whether
   it is open or not. The two web views are matched on the tool's *leaf* name
   in `lib/tools` (`toolLeafName`), never here. */
import * as React from "react"
import { GlobeIcon } from "lucide-react"
import { Avatar, AvatarFallback, AvatarGroup, AvatarImage } from "@/components/ui/avatar"
import { ToolCallSkeleton } from "@/components/ui/skeletons"
import {
  DetailSection,
  Favicon,
  PANE,
  PANE_MAX_H,
  ShowAll,
  SmartBlock,
  ToolProse,
  useShowAll,
  useSourceOpener,
} from "@/components/tool-parts"
import {
  extractWebFetch,
  extractWebSearch,
  hostOf,
  toolOutputText,
  type WebResult,
} from "@/lib/tools"
import type { ToolItem } from "@/lib/store"
import { cn } from "@/lib/utils"
import { useLayoutOptionsContext } from "@/lib/layout-options"

/** A fetch: the URL as a link first, because that is the thing you want to open. */
export function FetchDetail({ item }: { item: ToolItem }) {
  const input =
    item.rawInput && typeof item.rawInput === "object" && !Array.isArray(item.rawInput)
      ? (item.rawInput as Record<string, unknown>)
      : null
  const pick = (key: string) => (typeof input?.[key] === "string" ? (input[key] as string) : null)
  const url = pick("url")
  const query = pick("query") ?? pick("prompt")
  const { text } = toolOutputText(item, 20_000)

  return (
    <div className="space-y-1.5">
      {url && (
        <a
          href={/^https?:\/\//.test(url) ? url : undefined}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1.5 font-mono text-[11px] text-primary hover:underline"
        >
          <GlobeIcon className="size-3 shrink-0" />
          <span className="truncate">{url}</span>
        </a>
      )}
      {query && !url && <div className="text-[11px] text-muted-foreground">“{query}”</div>}
      <SmartBlock text={text} />
    </div>
  )
}

// ─── Web search and web fetch ────────────────────────────────────────────────

/**
 * A search of the *web*. ACP files it under the same `kind` as a ripgrep, and
 * Codex actively uses `kind: "search"` for it — so the repo-search layout was
 * counting sentences as "matches" and trying to split prose on `path:line:`.
 *
 * Results are drawn as sources — icon, site, title, snippet — because a link
 * is the thing a reader wants to do something with, and the snippet under it
 * is what the agent actually read. Snippets are clamped: a search backend
 * that returns page text hands back paragraphs per hit, and ten of those are
 * a wall. Codex's other two actions (opening a page, finding within one) name
 * themselves instead: there is no result list for those.
 */
export function WebSearchDetail({ item, active }: { item: ToolItem; active: boolean }) {
  const call = extractWebSearch(item)
  if (!call) return null
  const domains = [
    ...(call.allowedDomains ?? []).map((domain) => ({ domain, allowed: true })),
    ...(call.blockedDomains ?? []).map((domain) => ({ domain, allowed: false })),
  ]
  const { text } = toolOutputText(item, 40_000)
  const failed = item.status === "failed" || call.error !== undefined

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11px]">
        <GlobeIcon className="size-3 shrink-0 self-center text-muted-foreground/60" />
        {call.query && <span className="text-foreground">“{call.query}”</span>}
        {call.pattern && <code className="font-mono text-foreground">{call.pattern}</code>}
        {call.url && (
          <a
            href={call.url}
            target="_blank"
            rel="noreferrer"
            className="min-w-0 truncate font-mono text-primary hover:underline"
          >
            {call.url}
          </a>
        )}
        {call.action && call.action !== "search" && (
          <span className="text-muted-foreground/70">{call.action.replace(/([A-Z])/g, " $1").toLowerCase()}</span>
        )}
        {call.results.length > 0 && (
          <span className="ml-auto text-muted-foreground/60">
            {call.results.length} {call.results.length === 1 ? "result" : "results"}
          </span>
        )}
      </div>
      {domains.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {domains.map(({ domain, allowed }) => (
            <span
              key={domain}
              className={cn(
                "rounded-sm border px-1 py-px font-mono text-[10px]",
                allowed
                  ? "border-border/60 text-muted-foreground"
                  : "border-destructive/40 text-destructive/80"
              )}
            >
              {allowed ? "" : "−"}
              {domain}
            </span>
          ))}
        </div>
      )}
      {call.results.length > 0 ? (
        <>
          <WebResultList results={call.results} />
          {/* What the tool said about what it found — Claude Code's built-in
              search answers the query itself. Under the list, because the
              links are the evidence and this is the reading of it. */}
          {call.summary && (
            <DetailSection label="Summary">
              <ToolProse text={call.summary} />
            </DetailSection>
          )}
        </>
      ) : failed ? (
        <SmartBlock text={call.error ?? text} tone="error" />
      ) : (
        /* No parsed hits: the runtime returned prose (a page's text, a
           summary), which is worth showing whole rather than discarding
           because it did not look like a result list. */
        <SmartBlock text={text} />
      )}
      {call.results.length === 0 && !text.trim() && active && <ToolCallSkeleton className="py-1" />}
    </div>
  )
}

/** How many site avatars a row stacks before folding the rest into a count. */
const ROW_SOURCES = 6

/**
 * The pages behind a web step, on the row itself: every site a search
 * returned and the page a fetch read, as a stack of favicons, visible whether
 * or not the step is open. The detail above has the titles and snippets;
 * this is the glance — which sites answered — and it is the tool-call-level
 * counterpart of the turn's Sources strip, which keeps only what the answer
 * used. One avatar per host, in result order, so ten hits from three sites
 * are three faces and not a row of duplicates; each is a link to the first
 * hit from that site, and the count at the end opens the rest. Null for
 * anything that is not a web step, which is what lets every row pass
 * through it.
 */
export function ToolSources({ item }: { item: ToolItem }) {
  const [all, setAll] = React.useState(false)
  const view = useLayoutOptionsContext()
  const fetched = extractWebFetch(item)
  const search = fetched ? null : extractWebSearch(item)
  const pages: WebResult[] = fetched
    ? [{ title: fetched.prompt ?? "", url: fetched.url }]
    : (search?.results ?? [])
  if (pages.length === 0 || !view.showSources) return null
  const byHost = new Map<string, WebResult>()
  for (const page of pages) {
    const host = hostOf(page.url) || page.url
    if (!byHost.has(host)) byHost.set(host, page)
  }
  const hosts = [...byHost.entries()]
  const shown = all ? hosts : hosts.slice(0, ROW_SOURCES)
  const hidden = hosts.length - shown.length
  return (
    <div className="flex min-w-0 items-center gap-2">
      <AvatarGroup className="-space-x-1.5">
        {shown.map(([host, page]) => (
          <SiteAvatar key={host} host={host} url={page.url} title={page.title} />
        ))}
        {hidden > 0 && (
          /* The group's own count slot is a div; this is the same ring and
             size on a button, because the count is the thing you click to see
             the rest of the stack. */
          <button
            type="button"
            data-slot="avatar-group-count"
            onClick={() => setAll(true)}
            title={hosts.slice(ROW_SOURCES).map(([host]) => host).join("\n")}
            className="relative flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-full bg-muted text-[10px] text-muted-foreground ring-2 ring-background hover:z-10 hover:text-foreground"
          >
            +{hidden}
          </button>
        )}
      </AvatarGroup>
      <span className="min-w-0 truncate text-[11px] leading-5 text-muted-foreground/60">
        {fetched
          ? hosts[0][0]
          : `${pages.length} ${pages.length === 1 ? "result" : "results"} · ${hosts.length} ${hosts.length === 1 ? "site" : "sites"}`}
      </span>
    </div>
  )
}

/** One site in a stack: its favicon as an avatar, the host's initial when the
    icon does not load, the whole thing a link to the page. `render` makes the
    anchor the avatar's own root, which is what keeps the group's ring styling
    (it targets direct `data-slot=avatar` children) on the element it expects. */
function SiteAvatar({ host, url, title }: { host: string; url: string; title?: string }) {
  const open = useSourceOpener()
  return (
    <Avatar
      size="sm"
      render={
        <a
          href={url}
          target="_blank"
          rel="noreferrer noopener"
          onClick={(event) => open(event, url)}
        />
      }
      title={title ? `${host}\n${title}` : host}
      className="size-5 bg-background transition-transform hover:z-10 hover:scale-110"
    >
      <AvatarImage
        src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`}
        alt={host}
        referrerPolicy="no-referrer"
        className="p-[3px]"
      />
      <AvatarFallback className="text-[9px] font-medium uppercase">{host.charAt(0)}</AvatarFallback>
    </Avatar>
  )
}

/** How many lines of a snippet show before it is clamped. */
const SNIPPET_LINES = 3

function WebResultList({ results }: { results: WebResult[] }) {
  return (
    <ol className={cn(PANE, PANE_MAX_H, "divide-y divide-border/40 overflow-auto")}>
      {results.map((hit, index) => (
        <WebResultRow key={`${hit.url}-${index}`} hit={hit} />
      ))}
    </ol>
  )
}

function WebResultRow({ hit }: { hit: WebResult }) {
  const [open, setOpen] = React.useState(false)
  const openSource = useSourceOpener()
  const host = hostOf(hit.url)
  return (
    <li className="px-2.5 py-2">
      <div className="flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground/70">
        <Favicon url={hit.url} className="size-3.5" />
        <span className="truncate">{host || hit.url}</span>
      </div>
      <a
        href={hit.url}
        target="_blank"
        rel="noreferrer noopener"
        onClick={(event) => openSource(event, hit.url)}
        title={hit.url}
        className="mt-0.5 block truncate text-[12px] font-medium leading-5 text-foreground hover:text-primary hover:underline"
      >
        {hit.title}
      </a>
      {hit.snippet && (
        /* A button, not a link: the click toggles the clamp, and a snippet is
           read in place. The clamp is CSS, so the whole text is in the DOM
           for find-in-page either way. */
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className={cn(
            "mt-0.5 block w-full text-left text-[11.5px] leading-[1.45] text-muted-foreground",
            !open && "line-clamp-3"
          )}
          style={open ? undefined : { WebkitLineClamp: SNIPPET_LINES }}
          title={open ? "Show less" : "Show more"}
        >
          {hit.snippet}
        </button>
      )}
    </li>
  )
}

/**
 * A page read off the web. The address is the heading, the page is the body
 * — as markdown, because that is what every fetcher returns, and a `pre` of
 * it was a wall of bracketed links. Claude Code's `WebFetch` answers a prompt
 * about the page rather than returning it, so the prompt is shown above the
 * answer when there is one.
 */
export function WebFetchDetail({ item, active }: { item: ToolItem; active: boolean }) {
  const call = extractWebFetch(item)
  const openSource = useSourceOpener()
  const [shown, clipped, showAll] = useShowAll(call?.text ?? "")
  if (!call) return null
  const failed = item.status === "failed" || /^error:/i.test(call.text.trim())
  return (
    <div className="space-y-1.5">
      <div className="flex min-w-0 items-center gap-1.5 text-[11px]">
        <Favicon url={call.url} />
        <span className="shrink-0 text-muted-foreground/70">{hostOf(call.url)}</span>
        <a
          href={call.url}
          target="_blank"
          rel="noreferrer noopener"
          onClick={(event) => openSource(event, call.url)}
          className="min-w-0 truncate font-mono text-primary hover:underline"
          title={call.url}
        >
          {call.url}
        </a>
        {call.text && !failed && (
          <span className="ml-auto shrink-0 text-muted-foreground/60">
            {call.text.length >= 1000 ? `${Math.round(call.text.length / 1000)}k` : call.text.length} chars
            {call.truncated ? "+" : ""}
          </span>
        )}
      </div>
      {call.prompt && (
        <DetailSection label="Asked">
          <p className="text-xs text-foreground/80">{call.prompt}</p>
        </DetailSection>
      )}
      {failed ? (
        <SmartBlock text={call.text} tone="error" />
      ) : call.text.trim() ? (
        <>
          <ToolProse text={shown} />
          {clipped && <ShowAll onClick={showAll} />}
        </>
      ) : active ? (
        <ToolCallSkeleton className="py-1" />
      ) : null}
    </div>
  )
}
