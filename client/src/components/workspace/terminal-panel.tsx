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
   different buttons that do different things.

   Everything a terminal needs that a canvas cannot offer is chrome here: search
   over the scrollback, copy and paste (the two a phone has no other way to do
   at all), clear, the type size, and — when the shell has exited — starting a
   fresh one in the same project rather than reconnecting to a dead PTY. The
   toolbar holds the two that are pressed mid-task; the rest live behind ⋯,
   because this panel is frequently 300px wide beside a transcript. */
import * as React from "react"
import type { IDockviewPanelProps } from "dockview-react"
import { FitAddon } from "@xterm/addon-fit"
import { SearchAddon } from "@xterm/addon-search"
import { WebLinksAddon } from "@xterm/addon-web-links"
import { Terminal } from "@xterm/xterm"
import "@xterm/xterm/css/xterm.css"
import {
  ChevronDownIcon,
  ChevronUpIcon,
  ClipboardPasteIcon,
  CopyIcon,
  EraserIcon,
  KeyboardIcon,
  MinusIcon,
  PlusIcon,
  RotateCwIcon,
  SearchIcon,
  SquarePlusIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { MoreHorizontal } from "lucide-react"
import { useConfirm } from "@/components/confirm-dialog"
import { useDock } from "@/components/workspace/dock"
import { PanelNotice, PanelToolbar } from "@/components/workspace/primitives"
import { TerminalKeyRow } from "@/components/workspace/terminal-keys"
import { writeClipboard } from "@/lib/clipboard"
import { describeError, reportError } from "@/lib/errors"
import { loadSettings, serverName } from "@/lib/settings"
import { colorToHex, useTheme } from "@/lib/theme"
import { useCoarsePointer } from "@/hooks/use-mobile"
import { toast } from "@/lib/toast"
import { useProjects } from "@/lib/queries/catalog"
import { Logo } from "@/components/ui/logo"
import { cn } from "@/lib/utils"
import { createTerminal, killTerminal, terminalSocketUrl } from "@/lib/workspace/terminals"
import { panelId } from "@/lib/workspace/panels"
import { usePublishPanelStatus } from "@/lib/workspace/panel-status"
import {
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  setTerminalPrefs,
  useTerminalPrefs,
} from "@/lib/workspace/terminal-prefs"

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

/**
 * Colours from the app tokens plus the ANSI ramp above, resolved at mount and
 * re-read whenever the mode or the palette changes.
 *
 * Two things xterm will not do for itself, and the terminal was getting both
 * wrong — which is what "no light mode" looked like:
 *
 * - **It parses colours itself, and its parser knows `#rgb`, `#rrggbb` and
 *   `rgb()`.** This app's palettes are `oklch`, which is what
 *   `getPropertyValue("--foreground")` hands back verbatim, so every token
 *   passed straight through was a colour xterm could not read and quietly
 *   dropped for its own default — white on black, whatever the app was wearing.
 *   `colorToHex` (lib/theme.tsx, a 1px canvas) is the one translation.
 * - **`background: "transparent"` is only transparent with
 *   `allowTransparency`**, which must be set before `open()` and costs
 *   performance. Without it xterm forces the alpha to 1, and `transparent`
 *   becomes opaque *black*. So the background is resolved to the real colour
 *   the panel is painted in and handed over opaque — which is also what lets
 *   xterm compute contrast for dim text and for the selection.
 */
function themeFrom(element: HTMLElement, dark: boolean) {
  const style = getComputedStyle(element)
  const token = (name: string, fallback: string) =>
    colorToHex(style.getPropertyValue(name).trim()) ?? fallback
  const foreground = token("--foreground", dark ? "#e5e5e5" : "#1a1a1a")
  const background = paintedBackground(element) ?? token("--background", dark ? "#0a0a0a" : "#ffffff")
  return {
    ...ANSI[dark ? "dark" : "light"],
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    selectionBackground: token("--muted", dark ? "#333333" : "#e4e4e7"),
    selectionForeground: foreground,
  }
}

/**
 * The colour this element is actually painted on, walking up until something
 * paints one.
 *
 * The terminal host has no background of its own — it inherits the panel's,
 * which inherits the dock's — so asking it directly answers `rgba(0, 0, 0, 0)`,
 * and handing *that* to xterm is the black rectangle again by another route.
 * The walk stops at the first ancestor with a non-transparent colour, which is
 * the one a reader sees behind the text.
 */
function paintedBackground(element: HTMLElement): string | null {
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const color = getComputedStyle(node).backgroundColor
    if (!color || isTransparent(color)) continue
    const hex = colorToHex(color)
    if (hex) return hex
  }
  return null
}

/** Whether a computed colour paints nothing. The alpha is read as a *number*
    rather than pattern-matched: `rgb(0, 0, 0)` — an opaque black background, an
    entirely reasonable thing for a palette to have — ends in the same three
    characters as `rgba(0, 0, 0, 0)`, and a test that could not tell them apart
    would walk straight past the one theme that needs this most. */
function isTransparent(color: string): boolean {
  if (color === "transparent") return true
  const match = /^rgba?\(([^)]+)\)$/.exec(color.trim())
  if (!match) return false
  const parts = match[1].split(/[,/]/).map((part) => part.trim())
  return parts.length > 3 && Number(parts[3].replace("%", "")) === 0
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
  const { resolved, colorTheme } = useTheme()

  const prefs = useTerminalPrefs()
  const coarse = useCoarsePointer()
  /* "auto" is the pointer's answer: a finger has no Ctrl key and a mouse comes
     with a keyboard that does. Both overrides exist because that guess is wrong
     in both directions — a tablet with a keyboard case, a desktop reader who
     defined an escape sequence they cannot otherwise type. */
  const showKeys = prefs.keyRow === "auto" ? coarse : prefs.keyRow === "on"

  const host = React.useRef<HTMLDivElement | null>(null)
  const term = React.useRef<Terminal | null>(null)
  const fit = React.useRef<FitAddon | null>(null)
  const search = React.useRef<SearchAddon | null>(null)
  const socket = React.useRef<WebSocket | null>(null)
  const [status, setStatus] = React.useState<Status>("connecting")
  const [detail, setDetail] = React.useState<string | null>(null)
  const [generation, setGeneration] = React.useState(0)
  /* What the shell called itself, through the OSC title sequence every shell
     and most long-running commands write. It is the one thing that can say
     *what is running* in a tab you are not looking at — "npm run build" beats
     "daedalus — shell" on a strip of five terminals. */
  const [shellTitle, setShellTitle] = React.useState<string | null>(null)
  /* The bell, held until the panel is looked at again. A `\x07` is the shell
     asking for attention (a finished build, a prompt from a program), and in a
     dock it is invariably rung by the panel nobody has in front of them. */
  const [bell, setBell] = React.useState(false)
  const [finding, setFinding] = React.useState(false)
  /* The size the terminal is *created* at. Read through a ref because the
     effect that owns the terminal must not re-run when it changes — that would
     tear down the socket and lose the scrollback to a zoom. The effect below
     applies later changes in place. */
  const prefsRef = React.useRef(prefs)
  prefsRef.current = prefs

  React.useEffect(() => {
    const name = project ? `${project.name} — shell` : "Terminal"
    api.setTitle(shellTitle ? `${shellTitle} — ${project?.name ?? "shell"}` : name)
  }, [api, project, shellTitle])

  /* A shell that has stopped is the whole reason a terminal needs a tab mark:
     the panel says so plainly, but a terminal is normally the tab you are NOT
     looking at, and a build that failed twenty minutes ago is worth knowing
     about without going to look. Connecting says nothing — it is a fraction of
     a second, and a mark that flashes on every open is noise. */
  usePublishPanelStatus(
    api.id,
    status === "exited"
      ? { tone: "warn", label: detail ?? "The shell exited" }
      : status === "failed"
        ? { tone: "warn", label: detail ?? "The shell disconnected" }
        : bell
          ? { tone: "attention", label: "The shell rang the bell" }
          : null
  )

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
      fontSize: prefsRef.current.fontSize,
      scrollback: 5000,
      theme: themeFrom(container, document.documentElement.classList.contains("dark")),
    })
    const fitAddon = new FitAddon()
    const searchAddon = new SearchAddon()
    terminal.loadAddon(fitAddon)
    terminal.loadAddon(searchAddon)
    terminal.loadAddon(new WebLinksAddon())
    terminal.open(container)
    term.current = terminal
    fit.current = fitAddon
    search.current = searchAddon

    /* What the shell says it is, and when it asks to be noticed. Both are
       cleared by the effect's teardown through the state they write, so a
       reconnect starts from the project's name and no bell. */
    const title = terminal.onTitleChange((next) => setShellTitle(next.trim() || null))
    const bellRing = terminal.onBell(() => setBell(true))

    /* Copy and paste, on the chords every terminal emulator uses. xterm sends
       Ctrl+C to the PTY, which is correct — it is SIGINT — *except* when there
       is a selection, which is the one case where the user means copy and no
       shell will ever see the keystroke as anything else. Ctrl+V is
       unambiguous: nothing reads it, so it is ours. ⌘ on a Mac takes both
       outright, since ⌘C was never a control byte. Returning false is what
       stops xterm from also writing the key to the PTY. */
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true
      const mod = event.metaKey || event.ctrlKey
      if (!mod) return true
      const key = event.key.toLowerCase()
      if (key === "c" && (event.metaKey || terminal.hasSelection())) {
        const selection = terminal.getSelection()
        if (!selection) return true
        void writeClipboard(selection)
        return false
      }
      if (key === "v") {
        void pasteInto(terminal)
        return false
      }
      /* Find: ⌘F / Ctrl+Shift+F. Bare Ctrl+F is forward-a-character in every
         readline and in vi, and taking it would break the shell to add a
         feature the panel already has a button for. */
      if (key === "f" && (event.metaKey || event.shiftKey)) {
        setFinding(true)
        return false
      }
      return true
    })
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
      /* Typing is looking: the bell was raised for a panel nobody was reading,
         and the reader is plainly here now. */
      setBell(false)
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
      title.dispose()
      bellRing.dispose()
      /* 1000: a normal close. The server reads it as a detach, not a kill —
         the process keeps running and the scrollback is waiting next time. */
      ws.onclose = null
      ws.close(1000, "panel closed")
      socket.current = null
      terminal.dispose()
      term.current = null
      fit.current = null
      search.current = null
    }
  }, [projectId, terminalId, generation])

  /* The palette is read again when the app flips light↔dark **and when the
     colour theme changes** — the second was missing, so a reader who switched
     from Default to another palette in the same mode kept the old terminal
     until they reopened the panel. xterm cannot see CSS variables, but it does
     accept a fresh theme object at any time: the buffer is re-rendered in
     place, no reconnect, no lost scrollback.

     A frame late, deliberately. The class and the `data-color-theme` attribute
     are written by the theme provider's own effect, and reading the computed
     tokens in the same commit can catch the stylesheet the palette is leaving
     rather than the one it is arriving at. */
  React.useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const terminal = term.current
      const container = host.current
      if (!terminal || !container) return
      terminal.options.theme = themeFrom(container, resolved === "dark")
    })
    return () => cancelAnimationFrame(frame)
  }, [resolved, colorTheme])

  /* Type size, applied in place. xterm re-measures its cell on the next render,
     so the fit has to follow it — and the PTY has to be told, or the shell keeps
     wrapping at a width that is no longer on screen. */
  React.useEffect(() => {
    const terminal = term.current
    if (!terminal || terminal.options.fontSize === prefs.fontSize) return
    terminal.options.fontSize = prefs.fontSize
    try {
      fit.current?.fit()
    } catch {
      return
    }
    const ws = socket.current
    if (ws?.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify({ t: "resize", cols: terminal.cols, rows: terminal.rows }))
  }, [prefs.fontSize])

  /* The key row appearing or leaving takes height from the canvas, and so does
     the soft keyboard sliding up under it. Neither is a resize of the *panel*,
     so the observer in the effect above never sees them — this is the one
     signal for both. */
  React.useEffect(() => {
    const terminal = term.current
    if (!terminal) return
    try {
      fit.current?.fit()
    } catch {
      return
    }
    const ws = socket.current
    if (ws?.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify({ t: "resize", cols: terminal.cols, rows: terminal.rows }))
  }, [showKeys, prefs.keysExpanded, finding])

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

  /* ── The actions ──
     Copy and paste are the two a phone cannot do any other way: there is no
     Ctrl, and a long-press over a canvas selects nothing the OS understands. */
  const copySelection = () => {
    const selection = term.current?.getSelection()
    if (!selection) {
      toast.info("Nothing is selected")
      return
    }
    writeClipboard(selection)
      .then(() => toast.success("Copied"))
      .catch((err: unknown) => reportError(err, "Couldn't copy the selection"))
  }

  const paste = () => {
    const terminal = term.current
    if (terminal) void pasteInto(terminal)
  }

  /* Clear the screen, not the shell: `terminal.clear()` keeps the buffer's last
     line (the prompt you are typing at) and drops the scrollback above it, which
     is what Ctrl+L does and what a person means. The server's scrollback is not
     touched, so a reconnect brings back what was cleared here — deliberately:
     this is a view, and losing a build log to a tidy-up would be the panel
     destroying evidence. */
  const clear = () => {
    term.current?.clear()
    term.current?.focus()
  }

  const zoom = (delta: number) => setTerminalPrefs({ fontSize: prefs.fontSize + delta })

  /* A shell that exited cannot be reconnected to — the PTY is gone, and the
     Reconnect button on a dead terminal is a button that reopens the same
     corpse. Starting a fresh one in the same project is what the reader
     actually wants, and it is a new panel because it is a new process: this
     one keeps its scrollback until it is closed. */
  const restart = async () => {
    try {
      const created = await createTerminal(projectId)
      dock.openPanel({ kind: "terminal", projectId, terminalId: created.id })
      void dock.closePanel(panelId({ kind: "terminal", projectId, terminalId }))
    } catch (err) {
      reportError(err, "Couldn't start a new shell")
    }
  }

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
    /* `--keyboard-inset` is the height of the soft keyboard drawn OVER the page
       (`lib/keyboard-inset.ts`; the page deliberately does not resize). Padding
       the column by it is what keeps the helper key row above the keyboard
       instead of behind it, and it shortens the canvas by the same amount so no
       output is hidden either. The transition matches the composer's, because
       both are following the same slide. */
    <div
      className="flex h-full min-h-0 flex-col pt-[var(--dock-content-overlap,var(--app-header-h))] pb-[var(--keyboard-inset,0px)] transition-[padding] duration-[285ms] ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none"
    >
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
        {/* Two buttons in the strip and the rest behind ⋯: this panel is often
            300px wide beside a transcript, and a toolbar that wraps is a
            toolbar that eats the terminal. Search is here because it is used
            mid-read; the shell's own life (reconnect, restart, end) is one
            press further in, where a mis-tap costs nothing. */}
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Search the scrollback"
          aria-pressed={finding}
          title="Search (⌘F)"
          className={cn("size-6", finding && "bg-muted text-foreground")}
          onClick={() => setFinding((current) => !current)}
        >
          <SearchIcon className="size-3.5" />
        </Button>
        {status === "exited" || status === "failed" ? (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={status === "exited" ? "Start a new shell" : "Reconnect"}
            title={status === "exited" ? "Start a new shell" : "Reconnect"}
            className="size-6"
            onClick={() =>
              status === "exited" ? void restart() : setGeneration((current) => current + 1)
            }
          >
            {status === "exited" ? (
              <SquarePlusIcon className="size-3.5" />
            ) : (
              <RotateCwIcon className="size-3.5" />
            )}
          </Button>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Terminal actions"
                title="Terminal actions"
                className="size-6"
              >
                <MoreHorizontal className="size-3.5" />
              </Button>
            }
          />
          <DropdownMenuContent align="end" className="w-auto min-w-52">
            <DropdownMenuItem onClick={copySelection}>
              <CopyIcon className="text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">Copy selection</span>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={paste}>
              <ClipboardPasteIcon className="text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">Paste</span>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={clear}>
              <EraserIcon className="text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">Clear the screen</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {/* Type size is this device's, shared by every terminal it opens
                (`lib/workspace/terminal-prefs.ts`) — it is a question about
                eyes, not about a panel. */}
            <div className="flex items-center gap-1 px-2 py-1.5 text-sm">
              <span className="min-w-0 flex-1 truncate text-muted-foreground">Type size</span>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Smaller type"
                title="Smaller type"
                className="size-6"
                disabled={prefs.fontSize <= MIN_FONT_SIZE}
                onClick={(event) => {
                  event.preventDefault()
                  zoom(-1)
                }}
              >
                <MinusIcon className="size-3.5" />
              </Button>
              <span className="w-6 text-center text-xs tabular-nums">{prefs.fontSize}</span>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Larger type"
                title="Larger type"
                className="size-6"
                disabled={prefs.fontSize >= MAX_FONT_SIZE}
                onClick={(event) => {
                  event.preventDefault()
                  zoom(1)
                }}
              >
                <PlusIcon className="size-3.5" />
              </Button>
            </div>
            <DropdownMenuItem
              onClick={() =>
                /* Explicit either way, never back to "auto": the reader pressing
                   this has just disagreed with the guess. */
                setTerminalPrefs({ keyRow: showKeys ? "off" : "on" })
              }
            >
              <KeyboardIcon className="text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">
                {showKeys ? "Hide the key row" : "Show the key row"}
              </span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => setGeneration((current) => current + 1)}>
              <RotateCwIcon className="text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">Reconnect</span>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void restart()}>
              <SquarePlusIcon className="text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">Start a new shell</span>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void kill()} variant="destructive">
              <Trash2Icon />
              <span className="min-w-0 flex-1 truncate">End this shell</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </PanelToolbar>

      {finding && (
        <TerminalFindBar
          onClose={() => {
            setFinding(false)
            search.current?.clearDecorations()
            term.current?.focus()
          }}
          onFind={(query, direction) => {
            const addon = search.current
            if (!addon || !query) return null
            const options = {
              decorations: FIND_DECORATIONS,
              incremental: direction === "incremental",
            }
            return direction === "previous"
              ? addon.findPrevious(query, options)
              : addon.findNext(query, options)
          }}
          results={search.current}
        />
      )}

      {detail && (
        <PanelNotice>
          {detail}
        </PanelNotice>
      )}

      <div
        ref={host}
        aria-label="Terminal"
        className="min-h-0 flex-1 overflow-hidden px-2 py-1"
        /* A bell is news about a panel nobody is reading; clicking into it is
           the reader arriving. */
        onPointerDown={() => setBell(false)}
      />

      {/* The keys a soft keyboard cannot reach. `input()` routes through onData
          so the PTY sees one real keypress. It sits at the bottom, where a soft
          keyboard lives, so it reads as input rather than as part of the
          terminal — and the column's own `--keyboard-inset` padding keeps it
          above that keyboard rather than behind it. */}
      {showKeys && (
        <TerminalKeyRow
          disabled={status !== "ready"}
          onKey={(data) => {
            term.current?.input(data)
            term.current?.focus()
          }}
        />
      )}
    </div>
  )
}

/** Match colours for the search addon. Literals, like the ANSI ramp above and
    for the same reason: xterm paints these itself and cannot read a CSS
    variable. Amber for the matches, a stronger amber for the one you are on. */
const FIND_DECORATIONS = {
  matchBackground: "#7a5c00",
  matchOverviewRuler: "#c4a000",
  activeMatchBackground: "#c4a000",
  activeMatchColorOverviewRuler: "#fce94f",
}

/** The find bar: a box, a count, and the two arrows.

    It owns the term and nothing else — the addon is the state, and asking it
    again is how a repeat search moves. `onFind` returns whether anything
    matched, which is the only honest thing to draw when the addon's result
    count is not available (it is only emitted while decorations are on, and
    only after the search has run). */
function TerminalFindBar({
  onClose,
  onFind,
  results,
}: {
  onClose: () => void
  onFind: (query: string, direction: "next" | "previous" | "incremental") => boolean | null
  results: SearchAddon | null
}) {
  const [term, setTerm] = React.useState("")
  const [found, setFound] = React.useState<boolean | null>(null)
  const [count, setCount] = React.useState<{ index: number; total: number } | null>(null)

  React.useEffect(() => {
    if (!results) return
    const listener = results.onDidChangeResults((event) =>
      setCount({ index: event.resultIndex, total: event.resultCount })
    )
    return () => listener.dispose()
  }, [results])

  const run = (direction: "next" | "previous" | "incremental") => {
    if (!term) {
      setFound(null)
      setCount(null)
      return
    }
    setFound(onFind(term, direction))
  }

  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-border/60 px-2 py-1">
      <input
        autoFocus
        value={term}
        onChange={(event) => {
          setTerm(event.target.value)
          /* Incremental while typing: the selection grows with the term, the
             way every find box behaves. The state is read on the next tick
             through `term` — so the search below runs against what was typed,
             not against the previous value. */
          const next = event.target.value
          if (!next) {
            setFound(null)
            setCount(null)
            return
          }
          setFound(onFind(next, "incremental"))
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault()
            run(event.shiftKey ? "previous" : "next")
          } else if (event.key === "Escape") {
            event.preventDefault()
            onClose()
          }
        }}
        placeholder="Find in the scrollback"
        className={cn(
          "h-7 min-w-0 flex-1 rounded-md border border-input bg-input/30 px-2 text-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring",
          found === false && "border-destructive"
        )}
      />
      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
        {count && count.total > 0
          ? `${count.index + 1}/${count.total}`
          : found === false
            ? "none"
            : ""}
      </span>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label="Previous match"
        title="Previous match (⇧↵)"
        className="size-6"
        onClick={() => run("previous")}
      >
        <ChevronUpIcon className="size-3.5" />
      </Button>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label="Next match"
        title="Next match (↵)"
        className="size-6"
        onClick={() => run("next")}
      >
        <ChevronDownIcon className="size-3.5" />
      </Button>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label="Close find"
        title="Close find (Esc)"
        className="size-6"
        onClick={onClose}
      >
        <XIcon className="size-3.5" />
      </Button>
    </div>
  )
}

/** Clipboard → the PTY. Its own function because the key handler inside the
    terminal effect and the ⋯ menu both do it, and a paste that silently does
    nothing when the browser refuses permission is a bug that looks like a dead
    button. */
async function pasteInto(terminal: Terminal): Promise<void> {
  try {
    const text = await navigator.clipboard.readText()
    if (text) terminal.paste(text)
  } catch {
    /* Firefox without the permission, an insecure origin, a browser that asked
       and was refused. Nothing to recover — say so and let the reader use the
       soft keyboard's own paste into the terminal. */
    toast.error("The browser did not allow reading the clipboard")
  }
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
