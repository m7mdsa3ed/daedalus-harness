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
import { PanelNotice, PanelToolbar } from "@/components/workspace/primitives"
import { TerminalKeyRow } from "@/components/workspace/terminal-keys"
import { describeError, reportError } from "@/lib/errors"
import { loadSettings, serverName } from "@/lib/settings"
import { useTheme } from "@/lib/theme"
import { useProjects } from "@/lib/queries/catalog"
import { Logo } from "@/components/ui/logo"
import { cn } from "@/lib/utils"
import { createTerminal, killTerminal, terminalSocketUrl } from "@/lib/workspace/terminals"
import { panelId } from "@/lib/workspace/panels"

type Status = "connecting" | "ready" | "exited" | "failed"

/* The 16 ANSI slots are the one part xterm cannot borrow from CSS variables:
   each is a literal hex. The dark row is exactly the palette xterm ships by
   default, so an existing dark-mode terminal does not change. Light needs the
   dark-on-paper convention a light terminal lives by — normal colours dark
   enough to read on white, `white` a readable grey instead of glare — which is
   the ramp VS Code's light terminal converges on. */
const ANSI = {
  dark: {
    black: "#2e3436",
    red: "#cc0000",
    green: "#4e9a06",
    yellow: "#c4a000",
    blue: "#3465a4",
    magenta: "#75507b",
    cyan: "#06989a",
    white: "#d3d7cf",
    brightBlack: "#555753",
    brightRed: "#ef2929",
    brightGreen: "#8ae234",
    brightYellow: "#fce94f",
    brightBlue: "#729fcf",
    brightMagenta: "#ad7fa8",
    brightCyan: "#34e2e2",
    brightWhite: "#eeeeec",
  },
  light: {
    black: "#333333",
    red: "#cd3131",
    green: "#00bc00",
    yellow: "#949800",
    blue: "#0451a5",
    magenta: "#bc05bc",
    cyan: "#0598bc",
    white: "#555555",
    brightBlack: "#666666",
    brightRed: "#f14c4c",
    brightGreen: "#23d18b",
    brightYellow: "#f5f543",
    brightBlue: "#3b8eea",
    brightMagenta: "#d670d6",
    brightCyan: "#29b8db",
    brightWhite: "#a5a5a5",
  },
} as const

/** Colours from the app tokens plus the ANSI ramp above, resolved at mount and
    re-read whenever the mode flips. xterm paints to a canvas, so it cannot read
    CSS variables the way the rest of the UI does — the theme has to be handed
    over as literal values. */
function themeFrom(element: HTMLElement, dark: boolean) {
  const style = getComputedStyle(element)
  const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback
  return {
    ...ANSI[dark ? "dark" : "light"],
    background: "transparent",
    foreground: token("--foreground", dark ? "#e5e5e5" : "#1a1a1a"),
    cursor: token("--foreground", dark ? "#e5e5e5" : "#1a1a1a"),
    cursorAccent: token("--background", dark ? "#000000" : "#ffffff"),
    selectionBackground: token("--muted", dark ? "#333333" : "#f4f4f5"),
  }
}

export function TerminalPanel({
  api,
  params,
}: IDockviewPanelProps<{ projectId: string; terminalId: string }>) {
  const { projectId, terminalId } = params
  const dock = useDock()
  const confirm = useConfirm()
  /* The catalog lives in the query cache now, so a streamed token never
     reaches this panel; only a projects refresh (rare, and its own clock)
     re-renders it. */
  const project = useProjects().find((candidate) => candidate.id === projectId)
  const { resolved } = useTheme()

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
      theme: themeFrom(container, document.documentElement.classList.contains("dark")),
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

  /* The palette is read again when the app flips light↔dark. xterm cannot see
     CSS variables, but it does accept a fresh theme object at any time — the
     buffer is re-rendered in place, no reconnect, no lost scrollback. A custom
     palette change lands the same way: themeFrom reads the live tokens. */
  React.useEffect(() => {
    const terminal = term.current
    const container = host.current
    if (!terminal || !container) return
    terminal.options.theme = themeFrom(container, resolved === "dark")
  }, [resolved])

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
      <PanelToolbar>
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
          {/* Where this shell actually is. Not decoration — it is frequently not
              this machine, and every command here is typed on that assumption. */}
          {project?.name ?? "project"} · running on {where}
        </span>
        {status !== "ready" && (
          <span
            className={cn(
              "flex shrink-0 items-center gap-1.5 text-[11px]",
              status === "failed"
                ? "text-destructive"
                : status === "connecting"
                  ? "text-primary"
                  : "text-muted-foreground"
            )}
          >
            {status === "connecting" && <Logo working className="size-3.5 shrink-0" />}
            {status === "connecting" ? (
              <span className="harness-shimmer">connecting…</span>
            ) : status === "exited" ? (
              "exited"
            ) : (
              "disconnected"
            )}
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
      </PanelToolbar>

      {detail && (
        <PanelNotice>
          {detail}
        </PanelNotice>
      )}

      <div ref={host} className="min-h-0 flex-1 overflow-hidden px-2 py-1" />

      {/* Mobile only: a row of keys the soft keyboard can't reach. `input()`
          routes through onData so the PTY sees one real keypress. It sits at the
          bottom, where a soft keyboard lives, so it reads as input rather than
          as part of the terminal. */}
      <TerminalKeyRow
        disabled={status !== "ready"}
        onKey={(data) => {
          term.current?.input(data)
          term.current?.focus()
        }}
      />
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
