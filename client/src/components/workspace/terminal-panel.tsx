/* ── Terminal ──
   xterm.js in front of a PTY the server owns.

   Two things this panel has to be honest about, because both surprise people.

   **The shell runs on the Daedalus server**, which is frequently not the
   machine the browser is on — that is the whole point of the harness, and a
   terminal that does not say so is a terminal you will `rm` the wrong thing in.
   The status line names the project and says where it is running.

   **Closing the panel does not kill the process.** It detaches; the build keeps
   building, and reopening the terminal picks up the scrollback. Killing is a
   separate, explicit action — which is why the tab's × and the trash button are
   different buttons that do different things. */
import * as React from "react"
import type { IDockviewPanelProps } from "dockview-react"
import { FitAddon } from "@xterm/addon-fit"
import { WebLinksAddon } from "@xterm/addon-web-links"
import { Terminal } from "@xterm/xterm"
import "@xterm/xterm/css/xterm.css"
import { RotateCwIcon, Trash2Icon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { useConfirm } from "@/components/confirm-dialog"
import { useDock } from "@/components/workspace/dock"
import { describeError, reportError } from "@/lib/errors"
import { loadSettings, serverName } from "@/lib/settings"
import { useStore } from "@/lib/store"
import { cn } from "@/lib/utils"
import { createTerminal, killTerminal, terminalSocketUrl } from "@/lib/workspace/terminals"
import { panelId } from "@/lib/workspace/panels"

type Status = "connecting" | "ready" | "exited" | "failed"

/** Colours from the app tokens, resolved at mount. xterm paints to a canvas, so
    it cannot read CSS variables the way the rest of the UI does — the theme has
    to be handed over as literal values, and re-read when the palette changes. */
function themeFrom(element: HTMLElement) {
  const style = getComputedStyle(element)
  const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback
  return {
    background: "transparent",
    foreground: token("--foreground", "#e5e5e5"),
    cursor: token("--foreground", "#e5e5e5"),
    cursorAccent: token("--background", "#000000"),
    selectionBackground: token("--muted", "#333333"),
  }
}

export function TerminalPanel({
  api,
  params,
}: IDockviewPanelProps<{ projectId: string; terminalId: string }>) {
  const { projectId, terminalId } = params
  const dock = useDock()
  const confirm = useConfirm()
  const { state } = useStore()
  const project = state.projects.find((candidate) => candidate.id === projectId)

  const host = React.useRef<HTMLDivElement | null>(null)
  const term = React.useRef<Terminal | null>(null)
  const fit = React.useRef<FitAddon | null>(null)
  const socket = React.useRef<WebSocket | null>(null)
  const [status, setStatus] = React.useState<Status>("connecting")
  const [detail, setDetail] = React.useState<string | null>(null)
  const [generation, setGeneration] = React.useState(0)

  React.useEffect(() => {
    api.setTitle(project ? `${project.name} — shell` : "Terminal")
  }, [api, project])

  /* One effect owns the terminal and the socket together. They are not
     separable: the socket's `ready` frame carries the scrollback the terminal
     has to render before anything else, and a reconnect has to reset both. */
  React.useEffect(() => {
    const container = host.current
    if (!container) return

    const terminal = new Terminal({
      allowProposedApi: true,
      convertEol: false,
      cursorBlink: true,
      fontFamily:
        getComputedStyle(container).getPropertyValue("--font-mono").trim() ||
        "ui-monospace, monospace",
      fontSize: 12,
      scrollback: 5000,
      theme: themeFrom(container),
    })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.loadAddon(new WebLinksAddon())
    terminal.open(container)
    term.current = terminal
    fit.current = fitAddon
    try {
      fitAddon.fit()
    } catch {
      /* the panel has no size yet; the resize observer below will do it */
    }

    const settings = loadSettings()
    if (!settings) {
      setStatus("failed")
      setDetail("Not connected to a server.")
      return () => terminal.dispose()
    }

    const ws = new WebSocket(terminalSocketUrl(settings, projectId, terminalId))
    socket.current = ws

    ws.onopen = () => {
      /* Tell the PTY the size before anything runs in it: a shell that starts
         at 80×24 and is resized a beat later has already drawn its prompt at
         the wrong width, and `less` will have picked the wrong page size. */
      ws.send(JSON.stringify({ t: "resize", cols: terminal.cols, rows: terminal.rows }))
    }

    ws.onmessage = (event) => {
      let frame: { t?: string; data?: string; scrollback?: string; exitCode?: number; message?: string }
      try {
        frame = JSON.parse(String(event.data)) as typeof frame
      } catch {
        return
      }
      if (frame.t === "ready") {
        setStatus("ready")
        setDetail(null)
        if (frame.scrollback) terminal.write(frame.scrollback)
        terminal.focus()
      } else if (frame.t === "data" && frame.data) {
        terminal.write(frame.data)
      } else if (frame.t === "exit") {
        setStatus("exited")
        setDetail(`The shell exited (${frame.exitCode ?? 0}).`)
      } else if (frame.t === "error") {
        setDetail(frame.message ?? null)
      }
    }

    ws.onerror = () => {
      setStatus((current) => (current === "exited" ? current : "failed"))
    }

    ws.onclose = (event) => {
      setStatus((current) => (current === "exited" ? current : "failed"))
      /* 4004 is the server refusing the attach (no such terminal, wrong
         project) and the reason is written for a person — show it rather than
         a code. Anything else is an ordinary drop. */
      if (event.reason) setDetail(event.reason)
    }

    const input = terminal.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "data", data }))
    })

    /* Dockview resizes by changing the element, not by telling anyone, so the
       observer is the only reliable signal — and the PTY has to be told too, or
       the remote process keeps wrapping at the old width. */
    const observer = new ResizeObserver(() => {
      try {
        fitAddon.fit()
      } catch {
        return
      }
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ t: "resize", cols: terminal.cols, rows: terminal.rows }))
    })
    observer.observe(container)

    return () => {
      observer.disconnect()
      input.dispose()
      /* 1000: a normal close. The server reads it as a detach, not a kill —
         the process keeps running and the scrollback is waiting next time. */
      ws.onclose = null
      ws.close(1000, "panel closed")
      socket.current = null
      terminal.dispose()
      term.current = null
      fit.current = null
    }
  }, [projectId, terminalId, generation])

  /* A terminal is a running process; closing its panel must not silently end
     it, and must not silently leave it either. The guard says which. */
  React.useEffect(
    () =>
      dock.registerCloseGuard(panelId({ kind: "terminal", projectId, terminalId }), async () => {
        if (status === "exited" || status === "failed") return true
        const answer = await confirm({
          title: "Close this terminal?",
          description:
            "The shell keeps running on the server and you can reopen it. Use the trash button instead to end the process.",
          confirmLabel: "Close panel",
        })
        return answer
      }),
    [dock, confirm, projectId, terminalId, status]
  )

  const kill = async () => {
    const ok = await confirm({
      title: "End this shell?",
      description: "The process and everything running in it are terminated.",
      confirmLabel: "End it",
      destructive: true,
    })
    if (!ok) return
    try {
      await killTerminal(projectId, terminalId)
      void dock.closePanel(panelId({ kind: "terminal", projectId, terminalId }))
    } catch (err) {
      reportError(err, "Couldn't end the terminal")
    }
  }

  const settings = loadSettings()
  const where = settings ? serverName(settings.url) : "the server"

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-2 py-1">
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
          {/* Where this shell actually is. Not decoration — it is frequently not
              this machine, and every command here is typed on that assumption. */}
          {project?.name ?? "project"} · running on {where}
        </span>
        {status !== "ready" && (
          <span
            className={cn(
              "shrink-0 text-[11px]",
              status === "failed" ? "text-destructive" : "text-muted-foreground"
            )}
          >
            {status === "connecting" ? "connecting…" : status === "exited" ? "exited" : "disconnected"}
          </span>
        )}
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Reconnect"
          title="Reconnect"
          className="size-6"
          onClick={() => setGeneration((current) => current + 1)}
        >
          <RotateCwIcon className="size-3.5" />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="End this shell"
          title="End this shell"
          className="size-6 hover:text-destructive"
          onClick={() => void kill()}
        >
          <Trash2Icon className="size-3.5" />
        </Button>
      </div>

      {detail && (
        <p className="shrink-0 border-b border-border/60 bg-muted/40 px-2 py-1 text-[11px] text-muted-foreground">
          {detail}
        </p>
      )}

      <div ref={host} className="min-h-0 flex-1 overflow-hidden px-2 py-1" />
    </div>
  )
}

/** Open a new terminal for a project and put it in the dock. Exported because
    the palette and the shell's ⌃` both want it and neither owns a panel. */
export async function openTerminal(
  dock: ReturnType<typeof useDock>,
  projectId: string
): Promise<void> {
  try {
    const created = await createTerminal(projectId)
    dock.openPanel(
      { kind: "terminal", projectId, terminalId: created.id },
      { direction: "below" }
    )
  } catch (err) {
    const { title } = describeError(err)
    reportError(err, title === "The request failed" ? "Couldn't open a terminal" : undefined)
  }
}
