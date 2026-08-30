/* ── VS Code ──
   A whole editor, running on the server, framed.

   **This panel draws almost nothing, and that is the design.** Everything
   inside the frame is code-server's: its file tree, its command palette, its
   settings, its extensions, its terminal. What is left for this file is the
   part a frame cannot do for itself — deciding whether there is an editor to
   show, saying so plainly when there is not, and giving the two commands
   (restart, stop) that only the process's owner can carry out.

   **Opening the panel starts the editor; closing it does not stop one.** Same
   bargain as the terminal, for the same reason: a running extension host, a
   task mid-build and an unsaved buffer are exactly the state you close a laptop
   on. The server sweeps an editor nobody has loaded in hours; Stop is how you
   mean it now.

   **The frame is not sandboxed.** Every other framed thing in this app is —
   the web panel's preview most of all — but the trust levels are not
   comparable. A preview is a page being looked at. This is the user's own
   editor, already running as them, already holding a shell on the project; a
   `sandbox` attribute would not contain any of that and would break the parts
   VS Code needs (workers, its service worker, clipboard, downloads) in ways
   that read as "the IDE is broken" rather than as a policy. */
import * as React from "react"
import type { IDockviewPanelProps } from "dockview-react"
import {
  CodeXmlIcon,
  ExternalLinkIcon,
  Loader2Icon,
  PowerIcon,
  RefreshCwIcon,
  TerminalIcon,
  TriangleAlertIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { PanelEmptyState, PanelNotice, PanelToolbar } from "@/components/workspace/primitives"
import { reportError } from "@/lib/errors"
import { useStore } from "@/lib/store"
import { useCustomThemes, useTheme } from "@/lib/theme"
import {
  getIdeStatus,
  ideFrameUrl,
  setIdeTheme,
  startIde,
  stopIde,
  type IdeStatus,
} from "@/lib/workspace/ide"
import { ideThemeFor } from "@/lib/workspace/ide-theme"

/** How often the panel re-checks that the key its frame is using still names a
    running editor. Slow on purpose — see the note beside the poll. */
const POLL_MS = 10_000
/** After this long with the frame still loading, say so and offer a way out. */
const SLOW_LOAD_MS = 20_000

export function IdePanel({ api, params }: IDockviewPanelProps<{ projectId: string }>) {
  const { projectId } = params
  const { state } = useStore()
  const project = state.projects.find((candidate) => candidate.id === projectId)
  const { resolved, colorTheme } = useTheme()
  const customThemes = useCustomThemes()

  const [status, setStatus] = React.useState<IdeStatus | null>(null)
  const [busy, setBusy] = React.useState(false)
  /* Bumped to remount the frame. A cross-origin frame cannot be reloaded any
     other way — `contentWindow.location.reload()` is a same-origin call and
     throws — and after a restart the old frame is pointed at a key that no
     longer resolves, so it has to be replaced rather than refreshed. */
  const [frameKey, setFrameKey] = React.useState(0)
  /* **`ready` is the server's word, not the browser's.** It means `/healthz`
     answered — the iframe *can* load — but the workbench is ~20 MB of script
     the frame still has to fetch and boot, and until it does the frame paints
     nothing at all. A cross-origin frame cannot be asked how far along it is,
     so `load` is the one signal there is: draw over the frame until it fires,
     and after a while say that it is still on its way, because a blank pane
     with a spinner and a blank pane that is broken look the same. */
  const [frameLoaded, setFrameLoaded] = React.useState(false)
  const [slowLoad, setSlowLoad] = React.useState(false)

  React.useEffect(() => {
    api.setTitle(project ? `VS Code — ${project.name}` : "VS Code")
  }, [api, project])

  /* Ask, then start if there is nothing running. Both in one effect so a
     remount — a theme change, a tab drag — asks first and finds the editor it
     started a moment ago, rather than posting a second start every time the
     component happens to mount. `cancelled` is what keeps a panel closed
     mid-start from writing state into a component that is gone. */
  const resolvedRef = React.useRef(resolved)
  resolvedRef.current = resolved

  React.useEffect(() => {
    let cancelled = false
    setBusy(true)
    void (async () => {
      try {
        const current = await getIdeStatus(projectId)
        if (cancelled) return
        setStatus(current)
        if (current.state === "ready") {
          // Already running, possibly since a different palette was worn.
          void setIdeTheme(projectId, ideThemeFor(resolvedRef.current)).catch(() => {})
          return
        }
        if (current.state !== "off") return
        const started = await startIde(projectId, ideThemeFor(resolvedRef.current))
        if (!cancelled) setStatus(started)
      } catch (err) {
        if (!cancelled) reportError(err, "Couldn't reach the editor")
      } finally {
        if (!cancelled) setBusy(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [projectId])

  /* **A framed key can die without the frame noticing.** The key is minted per
     process and held in memory, so a server restart — a deploy, a crash, `tsx
     watch` in dev — invalidates every open frame at once, and so does the idle
     sweep. What the user sees is not an error this app raised: it is VS Code's
     own "failed to connect to the server (1006)" dialog, inside an iframe this
     app cannot read, with no way back but knowing to reload.

     So the panel checks. A tiny GET on a slow interval, paused while the tab is
     hidden and while a command of ours is already in flight, and it acts only
     on a *changed* path — a remount is an entire IDE reloading, so it must not
     fire on anything less. This is also what makes Stop-from-another-tab and
     the sweep show up here as the idle state rather than as a dead frame. */
  const pathRef = React.useRef<string | null>(null)
  pathRef.current = status?.path ?? null
  /** Set by Stop, cleared by Start — the poll's one reason not to revive. */
  const stoppedRef = React.useRef(false)
  const busyRef = React.useRef(busy)
  busyRef.current = busy

  React.useEffect(() => {
    const timer = setInterval(() => {
      if (busyRef.current || document.visibilityState !== "visible") return
      void getIdeStatus(projectId)
        .then(async (next) => {
          if (next.path === pathRef.current) return
          /* A restart takes the editor with it, and the panel is still open —
             which is the same statement of intent as opening it was, so bring
             it back rather than making the user press Start on a panel they
             never left. Unless they *are* the reason it stopped: Stop means
             stopped, and a poll that undid it a few seconds later would make
             the button look broken. */
          if (next.state === "off" && !stoppedRef.current) {
            setStatus(await startIde(projectId, ideThemeFor(resolvedRef.current)))
          } else {
            setStatus(next)
          }
          setFrameKey((current) => current + 1)
        })
        .catch(() => {
          /* A poll that cannot reach the server says nothing about the editor,
             and a toast every ten seconds while a laptop is offline is worse
             than a frame that is briefly wrong. The next poll decides. */
        })
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [projectId])

  /* **The editor wears the app's palette**, and keeps wearing it. Every
     theme change — light/dark, a different palette, a slider in the theme
     builder — is restated as VS Code settings and sent; the server writes
     them where the workbench is already watching. Deferred a tick because
     this effect runs *before* the provider's (children's effects fire first),
     so the root's attributes have not been swapped yet when it starts — and
     debounced, since the builder's sliders fire by the dozen. Only while the
     editor is running: writing settings for a stopped one is fine but
     pointless, and the start call carries the theme itself. */
  const readyRef = React.useRef(false)
  readyRef.current = status?.state === "ready"
  const firstThemeRef = React.useRef(true)
  React.useEffect(() => {
    if (firstThemeRef.current) {
      // The mount's theme went with the start call.
      firstThemeRef.current = false
      return
    }
    const timer = setTimeout(() => {
      if (!readyRef.current) return
      setIdeTheme(projectId, ideThemeFor(resolved)).catch(() => {
        /* A colour that did not land is not worth a toast — the next change
           sends the whole palette again. */
      })
    }, 300)
    return () => clearTimeout(timer)
  }, [projectId, resolved, colorTheme, customThemes])

  const run = async (action: () => Promise<IdeStatus>, context: string) => {
    setBusy(true)
    try {
      setStatus(await action())
      setFrameKey((current) => current + 1)
    } catch (err) {
      reportError(err, context)
    } finally {
      setBusy(false)
    }
  }

  const start = () => {
    stoppedRef.current = false
    return run(() => startIde(projectId, ideThemeFor(resolved)), "Couldn't start the editor")
  }
  const restart = () => {
    stoppedRef.current = false
    return run(async () => {
      await stopIde(projectId)
      return startIde(projectId, ideThemeFor(resolved))
    }, "Couldn't restart the editor")
  }
  const stop = () => {
    stoppedRef.current = true
    return run(() => stopIde(projectId), "Couldn't stop the editor")
  }

  const url = status ? ideFrameUrl(status) : null

  React.useEffect(() => {
    setFrameLoaded(false)
    setSlowLoad(false)
    if (!url) return
    const timer = setTimeout(() => setSlowLoad(true), SLOW_LOAD_MS)
    return () => clearTimeout(timer)
  }, [url, frameKey])

  /* The same trap the web panel hits, and it is likelier here: the PWA is
     served over https behind `dev:tunnel`, and a server reached over plain
     http cannot be framed by it at all. The frame would simply stay blank. */
  const mixedContent =
    !!url && window.location.protocol === "https:" && url.startsWith("http://")

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelToolbar>
        <CodeXmlIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
          {status?.binary ?? "code-server"}
          {project ? ` · ${project.name}` : ""}
        </span>
        {busy && <Loader2Icon className="size-3.5 shrink-0 animate-spin text-muted-foreground" />}
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Restart the editor"
          title="Restart the editor"
          className="size-6"
          disabled={busy || !status || status.state === "unavailable"}
          onClick={() => void restart()}
        >
          <RefreshCwIcon className="size-3.5" />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Open in a browser tab"
          title="Open in a browser tab"
          className="size-6"
          disabled={!url}
          onClick={() => url && window.open(url, "_blank", "noopener")}
        >
          <ExternalLinkIcon className="size-3.5" />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Stop the editor"
          title="Stop the editor — closing this panel leaves it running"
          className="size-6"
          disabled={busy || status?.state !== "ready"}
          onClick={() => void stop()}
        >
          <PowerIcon className="size-3.5" />
        </Button>
      </PanelToolbar>

      {mixedContent && (
        <PanelNotice className="text-foreground">
          This page is served over https, so the browser will not let it frame this server's{" "}
          <code className="font-mono">http://</code> address. Open the editor in a browser tab
          instead, or reach the server over https.
        </PanelNotice>
      )}

      <div className="relative min-h-0 flex-1">
        {url && !mixedContent ? (
          <>
            <iframe
              key={frameKey}
              src={url}
              title={project ? `VS Code — ${project.name}` : "VS Code"}
              className="h-full w-full border-0 bg-background"
              /* No `sandbox` — see the note at the top of the file. `allow`
                 grants the two capabilities VS Code asks a frame for and does
                 not get by default. */
              allow="clipboard-read; clipboard-write; fullscreen"
              onLoad={() => setFrameLoaded(true)}
            />
            {!frameLoaded && (
              <PanelEmptyState className="absolute inset-0 bg-background">
                <Loader2Icon className="size-5 animate-spin" />
                <p>Loading VS Code…</p>
                {slowLoad && (
                  <div className="space-y-2">
                    <p className="max-w-xs text-muted-foreground">
                      Still loading. The editor is a large download the first time — on a slow
                      link it can take a while. If it never appears, open it in a tab or restart
                      it.
                    </p>
                    <div className="flex justify-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => window.open(url, "_blank", "noopener")}
                      >
                        <ExternalLinkIcon />
                        Open in a tab
                      </Button>
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => void restart()}>
                        <RefreshCwIcon />
                        Restart
                      </Button>
                    </div>
                  </div>
                )}
              </PanelEmptyState>
            )}
          </>
        ) : (
          <Idle status={status} busy={busy} onStart={() => void start()} />
        )}
      </div>
    </div>
  )
}

function Idle({
  status,
  busy,
  onStart,
}: {
  status: IdeStatus | null
  busy: boolean
  onStart: () => void
}) {
  if (busy || !status)
    return (
      <PanelEmptyState>
        <Loader2Icon className="size-5 animate-spin" />
        <p>Starting VS Code… the first run unpacks the server and takes a moment.</p>
      </PanelEmptyState>
    )

  if (status.state === "unavailable")
    return (
      <PanelEmptyState className="text-foreground">
        <TerminalIcon className="size-6 text-muted-foreground" />
        <div className="space-y-1">
          <p className="text-sm font-medium">code-server isn't installed on this server</p>
          <p className="max-w-sm text-xs text-muted-foreground">
            {status.message} Install it there once and this panel will find it — nothing here runs
            an installer on your behalf.
          </p>
        </div>
        <code className="max-w-full overflow-x-auto rounded border border-border/60 bg-muted/40 px-2 py-1 font-mono text-[11px] text-foreground">
          {status.install}
        </code>
        <Button size="sm" variant="outline" onClick={onStart}>
          <RefreshCwIcon />
          Check again
        </Button>
      </PanelEmptyState>
    )

  if (status.state === "failed")
    return (
      <PanelEmptyState className="text-foreground">
        <TriangleAlertIcon className="size-6 text-muted-foreground" />
        <div className="space-y-1">
          <p className="text-sm font-medium">The editor didn't start</p>
          {status.message && (
            <pre className="max-h-40 max-w-full overflow-auto rounded border border-border/60 bg-muted/40 p-2 text-left font-mono text-[11px] whitespace-pre-wrap text-muted-foreground">
              {status.message}
            </pre>
          )}
        </div>
        <Button size="sm" variant="outline" onClick={onStart}>
          <RefreshCwIcon />
          Try again
        </Button>
      </PanelEmptyState>
    )

  return (
    <PanelEmptyState className="text-foreground">
      <CodeXmlIcon className="size-6 text-muted-foreground" />
      <div className="space-y-1">
        <p className="text-sm font-medium">The editor is stopped</p>
        <p className="max-w-xs text-xs text-muted-foreground">
          A full VS Code, running on the server in this project's directory.
        </p>
      </div>
      <Button size="sm" variant="outline" onClick={onStart}>
        Start VS Code
      </Button>
    </PanelEmptyState>
  )
}
