/* ── Web ──
   One panel, two trust levels. Only `project` trust is enabled; `external` is
   built but gated (see `EXTERNAL_TRUST_ENABLED`) until its isolation model has
   been reviewed.

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
  ShieldAlertIcon,
  SmartphoneIcon,
  StarIcon,
  TabletIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { PanelEmptyState, PanelNotice, PanelToolbar } from "@/components/workspace/primitives"
import { reportError } from "@/lib/errors"
import { useStore } from "@/lib/store"
import { cn } from "@/lib/utils"
import {
  createPreview,
  deletePreview,
  listPreviews,
  normalizeUrl,
  type Preview,
} from "@/lib/workspace/previews"

/** External trust ships when its isolation review is done — see the plan's
    Phase 7. Project trust is unaffected by the wait, which is the point of
    gating it here rather than leaving the panel out entirely. */
const EXTERNAL_TRUST_ENABLED = false

const VIEWPORTS = [
  { id: "desktop", label: "Desktop", icon: MonitorIcon, width: null },
  { id: "tablet", label: "Tablet", icon: TabletIcon, width: 834 },
  { id: "mobile", label: "Mobile", icon: SmartphoneIcon, width: 390 },
] as const

type ViewportId = (typeof VIEWPORTS)[number]["id"]

export function WebPanel({
  api,
  params,
}: IDockviewPanelProps<{ trust: "project" | "external"; viewId: string; projectId?: string; url?: string }>) {
  const { trust, projectId, url: initialUrl } = params
  const { state } = useStore()
  const project = state.projects.find((candidate) => candidate.id === projectId)

  const [url, setUrl] = React.useState(initialUrl ?? "")
  const [typed, setTyped] = React.useState(initialUrl ?? "")
  const [viewport, setViewport] = React.useState<ViewportId>("desktop")
  const [previews, setPreviews] = React.useState<Preview[]>([])
  /* Bumped to force the iframe to remount. There is no other way to reload a
     cross-origin frame: `contentWindow.location.reload()` is a same-origin
     operation and throws, which is the sandbox working as intended. */
  const [reloadKey, setReloadKey] = React.useState(0)

  React.useEffect(() => {
    api.setTitle(url ? new URL(url).host : project ? `Browser — ${project.name}` : "Browser")
  }, [api, url, project])

  React.useEffect(() => {
    if (!projectId) return
    listPreviews(projectId)
      .then(setPreviews)
      .catch(() => {
        /* An empty list is a fine starting state; the URL bar still works. */
      })
  }, [projectId])

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

  const save = async () => {
    if (!projectId || !url) return
    try {
      const saved = await createPreview(projectId, new URL(url).host, url)
      setPreviews((current) => [...current, saved])
    } catch (err) {
      reportError(err, "Couldn't save that page")
    }
  }

  const forget = async (preview: Preview) => {
    if (!projectId) return
    try {
      await deletePreview(projectId, preview.id)
      setPreviews((current) => current.filter((entry) => entry.id !== preview.id))
    } catch (err) {
      reportError(err, "Couldn't remove that page")
    }
  }

  if (trust === "external" && !EXTERNAL_TRUST_ENABLED) {
    return (
      <Centered>
        <ShieldAlertIcon className="size-6" />
        <div className="space-y-1">
          <p className="text-sm font-medium">External pages aren't enabled yet</p>
          <p className="max-w-sm text-xs">
            This panel only opens a project's own development server for now. General browsing
            needs its navigation, download and permission policy reviewed first.
          </p>
        </div>
        {url && (
          <Button size="sm" variant="outline" onClick={() => window.open(url, "_blank", "noopener")}>
            <ExternalLinkIcon />
            Open in your browser
          </Button>
        )}
      </Centered>
    )
  }

  /* `https:` page framing an `http:` dev server is blocked as mixed content,
     and the frame just stays blank — which reads as "the preview is broken".
     The PWA is served over https (`pnpm dev:tunnel`), so this is the common
     case on a phone, not an edge one. Say it rather than show nothing. */
  const mixedContent =
    window.location.protocol === "https:" && url.startsWith("http://")

  const width = VIEWPORTS.find((entry) => entry.id === viewport)?.width ?? null

  return (
    <div className="flex h-full min-h-0 flex-col">
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

        {previews.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button size="icon-xs" variant="ghost" aria-label="Saved pages" className="size-6">
                  <StarIcon className="size-3.5" />
                </Button>
              }
            />
            <DropdownMenuContent align="end">
              {previews.map((preview) => (
                <DropdownMenuItem key={preview.id} onClick={() => go(preview.url)}>
                  <span className="truncate">{preview.label}</span>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              {previews.map((preview) => (
                <DropdownMenuItem key={`x:${preview.id}`} onClick={() => void forget(preview)}>
                  <span className="truncate text-muted-foreground">Forget {preview.label}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        {url && projectId && !previews.some((preview) => preview.url === url) && (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Save this page"
            title="Save this page"
            className="size-6"
            onClick={() => void save()}
          >
            <StarIcon className="size-3.5" />
          </Button>
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

      {mixedContent && (
        <PanelNotice className="text-foreground">
          This page is served over https, so the browser will not let it frame an{" "}
          <code className="font-mono">http://</code> address. Open it in a browser tab instead, or
          serve the dev server over https.
        </PanelNotice>
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
              sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads"
              referrerPolicy="no-referrer"
            />
          </div>
        ) : (
          <Centered>
            <p className="max-w-xs">
              Enter the address of this project's development server — {" "}
              <code className="font-mono">localhost:5173</code>, or whatever your{" "}
              <code className="font-mono">dev</code> script prints.
            </p>
          </Centered>
        )}
      </div>
    </div>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return <PanelEmptyState>{children}</PanelEmptyState>
}
