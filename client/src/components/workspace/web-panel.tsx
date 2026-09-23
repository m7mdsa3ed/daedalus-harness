/* ── Web ──
   One panel, two trust levels — both live. `external` is what a source
   followed out of a transcript opens in: the pages an agent searched and read
   are the ones a reader most wants beside the thread that cited them, and
   sending those to a browser tab meant leaving the app to read the thing the
   app was talking about.

   **Why one panel and not two.** The chrome is identical — URL bar, back,
   forward, reload, open externally, viewport presets — and only the trust
   differs. Merging is what makes the security model *safer*, not looser: a
   project preview whose page navigates to a third-party origin has to become
   external-trust, and with two panel types that transition has nowhere to go.
   You would have to close one panel and open another mid-navigation, which is
   exactly the moment a mistake is invisible.

   **Trust only ever drops.** `parsePanel` re-derives it on restore rather than
   believing what is in localStorage, and nothing here raises it — going back to
   the project's own origin does not restore project trust for the session,
   because the page has already run.

   **The iframe is sandboxed and same-origin is NOT granted.** A dev server the
   panel frames is code the user is writing; it does not get to reach into the
   app that framed it, read its localStorage, or touch the bearer token. That
   costs the preview nothing — it is a page being looked at, not an extension. */
import * as React from "react"
import type { IDockviewPanelProps } from "dockview-react"
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ExternalLinkIcon,
  MonitorIcon,
  RefreshCwIcon,
  SmartphoneIcon,
  TabletIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { PanelToolbar } from "@/components/workspace/primitives"
import { WebFrameHint, WebProblemView, type WebProblem } from "@/components/workspace/web-state"
import { useServer } from "@/lib/server-context"
/* Aliased: this component's `api` prop is dockview's panel handle. */
import { api as request, type HelperCommand } from "@/lib/settings"
import { reportError } from "@/lib/errors"
import { useProjects } from "@/lib/queries/catalog"
import { cn } from "@/lib/utils"
import { useDock } from "@/components/workspace/dock"
import { useRunHelper } from "@/lib/workspace/use-run-helper"

/**
 * A typed address → a URL this panel will open, or a throw.
 *
 * http and https only. A `javascript:` or `data:` URL in an iframe runs with
 * the framing document's privileges in some browsers, which for a page the
 * app framed would be XSS with the app's own origin behind it. Nothing
 * legitimate is lost: what this panel opens is a web page.
 */
function normalizeUrl(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) throw new Error("Enter an address")

  /* "Contains a colon" reads `localhost:5173` — what people actually type — as
     the scheme `localhost:`. So: a `scheme://` is parsed as given; a bare
     `scheme:` not followed by a digit is a real non-http scheme and is refused
     by name; anything else is a host with a port. */
  const hasAuthority = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)
  const schemeOnly = /^[a-zA-Z][a-zA-Z0-9+.-]*:(?!\d)/.test(trimmed)
  if (!hasAuthority && schemeOnly)
    throw new Error("This has to be an http or https address")

  let url: URL
  try {
    url = new URL(hasAuthority ? trimmed : `http://${trimmed}`)
  } catch {
    throw new Error(`"${raw}" is not a valid address`)
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("This has to be an http or https address")
  return url.toString()
}

/** What an external page may do inside the frame. Deliberately the same set a
    project preview gets, minus nothing and plus nothing: the isolation that
    matters is the one clause that is NOT here. Without `allow-same-origin` the
    frame is a unique opaque origin — it cannot read this app's localStorage,
    its cookies or the bearer token, and `postMessage` to the opener is all it
    can address. `allow-top-navigation` is likewise absent, so a page cannot
    navigate the app out from under itself. */
const SANDBOX = "allow-scripts allow-forms allow-popups allow-modals allow-downloads"

const VIEWPORTS = [
  { id: "desktop", label: "Desktop", icon: MonitorIcon, width: null },
  { id: "tablet", label: "Tablet", icon: TabletIcon, width: 834 },
  { id: "mobile", label: "Mobile", icon: SmartphoneIcon, width: 390 },
] as const

type ViewportId = (typeof VIEWPORTS)[number]["id"]

type WebPanelParams = { trust: "project" | "external"; viewId: string; projectId?: string; url?: string }

/** The stored preview answer: whether the project's dev server is up, probed
    from the server's own machine (a browser fetch would be CORS-blocked and a
    cross-origin frame cannot be inspected). */
interface PreviewState {
  url: string
  up: boolean
}

/* How often the browser is asked while the preview is down — the fast lane is
   the seconds right after "Start", when a dev server is still booting. */
const PROBE_MS = 4000
const STARTING_PROBE_MS = 1500

/** The project Preview panel, with an optional address bar for external pages. */
export function WebPanel({ api, params }: IDockviewPanelProps<WebPanelParams>) {
  const { trust, projectId, url: initialUrl } = params
  /* The catalog lives in the query cache now, so a streamed token never
     reaches this panel; only a projects refresh (rare, and its own clock)
     re-renders it. */
  const project = useProjects().find((candidate) => candidate.id === projectId)
  const settings = useServer()
  const dock = useDock()
  const runHelper = useRunHelper(dock)
  const previewUrl = trust === "project" ? (project?.previewUrl ?? "") : ""
  const previewHelper = trust === "project"
    ? project?.helpers?.find((helper) => helper.preview)
    : undefined

  const [url, setUrl] = React.useState(initialUrl ?? "")
  const [typed, setTyped] = React.useState(initialUrl ?? "")
  const [viewport, setViewport] = React.useState<ViewportId>("desktop")
  /* Bumped to force the iframe to remount. There is no other way to reload a
     cross-origin frame: `contentWindow.location.reload()` is a same-origin
     operation and throws, which is the sandbox working as intended. */
  const [reloadKey, setReloadKey] = React.useState(0)
  /* Per panel, not persisted: it is a reminder about the page in front of you,
     and it is cheap to have said once per browser panel you open. */
  const [hint, setHint] = React.useState(true)
  /* Whether anything is answering at the address. `null` is "not asked yet",
     which is why it is not `false`: an unanswered question is not a failure. */
  const [reachable, setReachable] = React.useState<boolean | null>(null)

  /* ── The project preview ──
     Trust-level "project" polls the server's own answer while it has a URL:
     the loopback fetch works from any device the app runs on, which is the
     whole point of probing server-side — a phone in the project's LAN sees
     the same "running/not running" as the machine that hosts the server.
     Polling stops the moment the preview is up: a page that has loaded needs
     no more checks, and a live page is the only "up" that matters. */
  const [probe, setProbe] = React.useState<PreviewState | null>(null)
  const [starting, setStarting] = React.useState(false)
  const probeMs = starting ? STARTING_PROBE_MS : PROBE_MS

  React.useEffect(() => {
    if (trust !== "project" || !projectId) {
      setProbe(null)
      return
    }
    let live = true
    const check = () => {
      request<PreviewState>(settings, `/api/projects/${encodeURIComponent(projectId)}/preview`)
        .then((state) => {
          if (live) setProbe(state)
        })
        .catch(() => {
          /* A failing probe degrades to "down" — the panel's other half
             (Start, the hint) is exactly what down is for. */
          if (live) setProbe((current) => (current ? { ...current, up: false } : current))
        })
    }
    check()
    const timer = setInterval(check, probeMs)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [trust, projectId, settings, probeMs])

  /* The transition from down to up is the moment "Start" paid off: the frame
     already tried to load and failed, so it is reloaded the one time. */
  const wasDown = React.useRef(true)
  React.useEffect(() => {
    if (!probe) return
    if (probe.up) {
      if (wasDown.current && url) setReloadKey((current) => current + 1)
      wasDown.current = false
      setStarting(false)
    } else {
      wasDown.current = true
    }
  }, [probe, url])

  const startPreview = async (helper: HelperCommand) => {
    const started = await runHelper(helper, projectId ?? "")
    if (started) setStarting(true)
  }

  React.useEffect(() => {
    api.setTitle(url ? new URL(url).host : project ? `Preview — ${project.name}` : "Preview")
  }, [api, url, project])

  /* One panel follows successive sources. `openPanel` re-points an existing
     panel's params rather than opening a second tab per link (see dock.tsx),
     and the params are the descriptor, so this is where that arrives. Guarded
     on the value actually differing: typing an address in the bar moves `url`
     and not `params.url`, and re-asserting the descriptor's address would undo
     what was just typed. */
  const lastParamUrl = React.useRef(initialUrl ?? "")
  React.useEffect(() => {
    const next = params.url ?? ""
    if (next === lastParamUrl.current) return
    lastParamUrl.current = next
    if (next) go(next)
    // `go` is re-made every render; the ref above is what makes this fire once
    // per genuinely new address.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.url])

  /* A project panel restored from a saved layout has no address — the
     descriptor was saved before the project had a preview URL, or the field
     was filled in after the tab was opened. The stored URL is the *answer* to
     what this panel is for, so it is loaded rather than offered. Only until
     something else has been loaded: an address the person typed is theirs. */
  const seededRef = React.useRef(false)
  React.useEffect(() => {
    if (seededRef.current || trust !== "project" || !previewUrl || url) return
    seededRef.current = true
    go(previewUrl)
    // `go` closes over `url` (to guard the empty case); the ref above is what
    // keeps this to one shot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trust, previewUrl, url])

  const go = (next: string) => {
    try {
      const normalized = normalizeUrl(next)
      setUrl(normalized)
      setTyped(normalized)
      setReloadKey((current) => current + 1)
    } catch (err) {
      reportError(err, "That isn't a URL this can open")
    }
  }

  /* `https:` page framing an `http:` dev server is blocked as mixed content,
     and the frame just stays blank — which reads as "the preview is broken".
     The PWA is served over https (`pnpm dev:tunnel`), so this is the common
     case on a phone, not an edge one. `WebProblemView` says it *and* the way
     out, which is the half the old line was missing. */
  const mixedContent =
    window.location.protocol === "https:" && url.startsWith("http://")

  /* ── Is anything listening there? ──
     The one question a sandboxed frame cannot answer. A blocked or refused
     frame fires `load` exactly like a real page — an error page is still a page
     as far as the frame is concerned — so a load-timeout heuristic cannot tell
     "nothing is there" from "here is what the browser drew instead", and a
     wrong "no page came back" over a page that loaded is worse than saying
     nothing. So the address is *measured*, by the server (`/api/preview`): it
     can reach loopback and a LAN host, which this page's origin cannot.

     Asked on every new address, not polled: this is what a person typed, and
     the answer is for the frame about to be drawn against it. A failing check
     is a `null` rather than a `false` — an unreachable server or an old build
     without the route must not paint "nothing is answering" over a page that
     is. Only a measured `false` does. */
  React.useEffect(() => {
    if (!url || mixedContent) {
      setReachable(null)
      return
    }
    let live = true
    setReachable(null)
    request<{ up: boolean }>(settings, `/api/preview?url=${encodeURIComponent(url)}`)
      .then((answer) => {
        if (live) setReachable(answer.up)
      })
      .catch(() => {
        if (live) setReachable(null)
      })
    return () => {
      live = false
    }
  }, [url, reloadKey, mixedContent, settings])

  /* ── The one failure being shown, if any ──
     Derived rather than stored, so nothing has to remember to clear it: `url`
     changes and the answer recomputes. Order is certainty — something the
     browser will certainly refuse, then something that has been *measured*
     (the project's own configured preview, or the address as typed), and
     nothing after that. `null` is a page that is up, or one still on its way. */
  const unreachable =
    (trust === "project" && probe?.url === url && !probe.up) ||
    (url !== "" && reachable === false)
  const problem: WebProblem | null = !url
    ? { kind: "empty" }
    : mixedContent
      ? { kind: "mixed", url }
      : unreachable
        ? { kind: "unreachable", url }
        : null

  /* "Change the address" is a focus on the toolbar's own field, which is where
     the address lives — the panel does not grow a second input to say the same
     thing in a modal. The ref is the field's; the frame is the next paint, so
     the focus lands after the notice has given way to it. */
  const addressRef = React.useRef<HTMLInputElement>(null)
  const focusAddress = React.useCallback(() => {
    requestAnimationFrame(() => {
      addressRef.current?.focus()
      addressRef.current?.select()
    })
  }, [])

  const width = VIEWPORTS.find((entry) => entry.id === viewport)?.width ?? null

  return (
    <div className="flex h-full min-h-0 flex-col pt-[var(--dock-content-overlap,var(--app-header-h))]">
      <PanelToolbar>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Back"
          className="size-6"
          disabled
          title="A sandboxed frame does not expose its history"
        >
          <ArrowLeftIcon className="size-3.5" />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Forward"
          className="size-6"
          disabled
          title="A sandboxed frame does not expose its history"
        >
          <ArrowRightIcon className="size-3.5" />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Reload"
          className="size-6"
          onClick={() => setReloadKey((current) => current + 1)}
        >
          <RefreshCwIcon className="size-3.5" />
        </Button>

        <form
          className="min-w-0 flex-1"
          onSubmit={(event) => {
            event.preventDefault()
            go(typed)
          }}
        >
          <Input
            ref={addressRef}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            placeholder="localhost:5173"
            aria-label="Address"
            className="h-7 font-mono text-xs"
          />
        </form>

        {/* The project preview's own status, probed from the server: the one
            reading a plain iframe cannot be trusted with. Shown only where a
            preview URL is configured — an empty bar says nothing. */}
        {trust === "project" && probe?.url && (
          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px]",
              probe.up
                ? "border-emerald-500/30 text-emerald-600 dark:text-emerald-400"
                : "border-amber-500/30 text-amber-600 dark:text-amber-400"
            )}
          >
            <span
              aria-hidden
              className={cn(
                "size-1.5 rounded-full",
                probe.up ? "bg-emerald-500" : "bg-amber-500"
              )}
            />
            {probe.up ? "Running" : "Not running"}
          </span>
        )}


        {VIEWPORTS.map((entry) => (
          <Button
            key={entry.id}
            size="icon-xs"
            variant="ghost"
            aria-label={entry.label}
            title={entry.label}
            className={cn("size-6", viewport === entry.id && "text-primary")}
            onClick={() => setViewport(entry.id)}
          >
            <entry.icon className="size-3.5" />
          </Button>
        ))}

        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Open in your browser"
          title="Open in your browser"
          className="size-6"
          disabled={!url}
          onClick={() => url && window.open(url, "_blank", "noopener")}
        >
          <ExternalLinkIcon className="size-3.5" />
        </Button>
      </PanelToolbar>

      {/* ── One failure at a time ──
          Every reason this panel can be showing no page is derived once, here,
          and exactly one of them is what is happening — a frame can be blank
          for one reason, and three stacked notices about it is the panel
          talking past itself. The order is the order of certainty: something
          the browser will certainly refuse, then something the project's own
          probe has said, then the frame that was asked for and did not answer.

          Below `md`-wide the notice goes *in place of* the frame rather than
          above it: a phone's panel is one screen, and a paragraph over a blank
          white box is a page that looks broken under an explanation of why. */}
      {problem && (
        <div className="min-h-0 flex-1 overflow-auto">
          <WebProblemView
            problem={problem}
            trust={trust}
            starting={starting}
            previewHelperName={previewHelper?.name}
            onReload={() => setReloadKey((current) => current + 1)}
            onEditAddress={focusAddress}
            onOpenExternal={() => url && window.open(url, "_blank", "noopener")}
            onStartPreview={previewHelper ? () => void startPreview(previewHelper) : undefined}
          />
        </div>
      )}

      {/* The frame is hidden while a *terminal* failure is on screen and kept
          mounted while the address is merely empty: a blank half gets out of
          the notice's way, and a page that is only waiting for an address
          needs no iframe at all. */}
      <div
        className={cn(
          "min-h-0 flex-1 overflow-auto bg-muted/20",
          problem && problem.kind !== "empty" && "hidden"
        )}
      >
        {url ? (
          <>
            {/* The publisher's own refusal — `X-Frame-Options`, `frame-ancestors`
                — is the one failure nothing here can detect: the browser
                enforces it, no error crosses the boundary, and a blocked frame
                is indistinguishable from a slow one. So it is only said while
                the frame is *unproven*, and it goes the moment the frame
                reports that it loaded (`onLoad`). A page already drawing needs
                no warning about the pages that might not have. */}
            {hint && <WebFrameHint onDismiss={() => setHint(false)} />}
            <div className="mx-auto h-full" style={width ? { width, maxWidth: "100%" } : undefined}>
              <iframe
                key={reloadKey}
                src={url}
                title={`Browser: ${url}`}
                className="h-full w-full border-0 bg-white"
                /* Something drew here — the addressed page or the browser's own
                   error page, which this cannot tell apart (that is what the
                   server's check above is for). What it does settle is the one
                   hint: the frame is not *blank*, so "if this stays blank" has
                   nothing left to say and goes. */
                onLoad={() => setHint(false)}
                /* No `allow-same-origin`: a dev server is code being written and
                   does not get to reach into the app framing it. Scripts and
                   forms yes — it is a web page — but not the app's origin, its
                   storage, or its token. */
                sandbox={SANDBOX}
                referrerPolicy="no-referrer"
              />
            </div>
          </>
        ) : null}
      </div>
    </div>
  )
}
