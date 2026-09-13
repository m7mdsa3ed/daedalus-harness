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
  GlobeIcon,
  LoaderCircleIcon,
  MonitorIcon,
  PlayIcon,
  RefreshCwIcon,
  ShieldAlertIcon,
  SmartphoneIcon,
  TabletIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Empty } from "@/components/empty"
import { Notice } from "@/components/notice"
import { PanelToolbar } from "@/components/workspace/primitives"
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

/** The Browser panel: a typed URL, or a source followed out of a transcript. */
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
    api.setTitle(url ? new URL(url).host : project ? `Browser — ${project.name}` : "Browser")
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
     case on a phone, not an edge one. Say it rather than show nothing. */
  const mixedContent =
    window.location.protocol === "https:" && url.startsWith("http://")

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

      {/* Plenty of the web refuses to be framed at all — `X-Frame-Options` and
          `frame-ancestors` are the publisher's call, the refusal is enforced by
          the browser, and a blocked frame is indistinguishable from a slow one
          from in here (no error crosses the boundary, and a cross-origin frame
          cannot be inspected). So this is said once, up front, rather than
          detected badly after the fact: the frame may stay blank, and the
          button that always works is in the toolbar. */}
      {trust === "external" && url && !mixedContent && hint && (
        <div className="px-2 py-1.5">
          <Notice
            icon={<ShieldAlertIcon />}
            action={
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => setHint(false)}
              >
                Got it
              </Button>
            }
          >
            Some sites refuse to be shown inside another page. If this stays blank, use{" "}
            <span className="text-foreground">Open in your browser</span>.
          </Notice>
        </div>
      )}
      {mixedContent && (
        <div className="px-2 py-1.5">
          <Notice tone="warn" className="text-foreground">
            This page is served over https, so the browser will not let it frame an{" "}
            <code className="font-mono">http://</code> address. Open it in a browser tab instead, or
            serve the dev server over https.
          </Notice>
        </div>
      )}
      {/* The dev server is down and the panel knows a command that starts it —
          the two halves of "link the project to the browser" meeting. The run
          lives in a terminal (helpers always do — a dev server asks things
          and only a PTY can be answered), and the probe's fast lane reloads
          the frame the moment it answers. If nothing is marked as the preview
          command, the hint is all there is to say. */}
      {trust === "project" && url && probe && probe.url === url && !probe.up && (
        <div className="px-2 py-1.5">
          <Notice
            icon={<GlobeIcon />}
            action={
              previewHelper && !starting ? (
                <Button size="sm" variant="outline" onClick={() => void startPreview(previewHelper)}>
                  <PlayIcon /> Start {previewHelper.name}
                </Button>
              ) : undefined
            }
          >
            Nothing is answering at <code className="font-mono">{probe.url}</code>.{" "}
            {previewHelper
              ? "The dev server looks stopped."
              : "Start the dev server, then reload it here."}
            {starting && <LoaderCircleIcon aria-label="Starting…" className="ml-1 inline size-3.5 animate-spin" />}
          </Notice>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto bg-muted/20">
        {url ? (
          <div className="mx-auto h-full" style={width ? { width, maxWidth: "100%" } : undefined}>
            <iframe
              key={reloadKey}
              src={url}
              title={`Browser: ${url}`}
              className="h-full w-full border-0 bg-white"
              /* No `allow-same-origin`: a dev server is code being written and
                 does not get to reach into the app framing it. Scripts and
                 forms yes — it is a web page — but not the app's origin, its
                 storage, or its token. */
              sandbox={SANDBOX}
              referrerPolicy="no-referrer"
            />
          </div>
        ) : (
          <Centered>
            {trust === "external"
              ? "Enter an address, or follow a source from a thread — the pages an agent read open here."
              : null}
            {trust === "project" && (
              <>
                Enter the address of this project's development server —{" "}
                <code className="font-mono">localhost:5173</code>, or whatever your{" "}
                <code className="font-mono">dev</code> script prints.
              </>
            )}
          </Centered>
        )}
      </div>
    </div>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="p-3">
      <Empty size="lg">{children}</Empty>
    </div>
  )
}
