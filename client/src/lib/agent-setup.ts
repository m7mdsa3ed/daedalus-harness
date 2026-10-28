/* ── Getting an agent ready: install it, log it in ──
   One hook for every surface that offers it — Settings › Agents and the
   first-run wizard — so the two cannot disagree about what a login is.

   Nothing here names a vendor. The methods are the agent's own (ACP
   `authMethods`, read by the server's status probe): a `terminal` one runs in a
   setup terminal panel the person answers, an `agent` one (codex's device
   code) is a link and a one-time code drawn in place while the server holds
   the login open. Closing it — Cancel, or leaving the page — is the cancel.

   Whether it worked is measured, never inferred from the flow ending: the
   server re-reads the status when a login settles, and a terminal login is
   followed by re-reading the status until it says logged in. */
import * as React from "react"
import { useQueryClient } from "@tanstack/react-query"

import { DockContext } from "@/components/workspace/dock-context"
import { reportError } from "@/lib/errors"
import { useAgentsStatus, useCatalogLoaded, useProfiles, useProjects } from "@/lib/queries/catalog"
import { agentsStatusKey } from "@/lib/queries/keys"
import { ApiError, api, profileSupports, type AgentDef, type AgentLoginMethod, type AgentStatus } from "@/lib/settings"
import { useServer } from "@/lib/server-context"
import { toast } from "@/lib/toast"
import { queuePanel } from "@/lib/workspace/pending-panels"
import type { TerminalInfo } from "@/lib/workspace/terminals"

/** The project id a setup terminal is filed under (server `SETUP_PROJECT`). */
const SETUP_PROJECT = "setup"
/** How often a terminal login's outcome is re-read, and for how long. */
const FOLLOW_MS = 4000
const FOLLOW_FOR_MS = 10 * 60_000

export interface DeviceCode {
  url: string
  message: string
}

export interface AgentSetup {
  /** What is running for an agent right now, if anything. */
  busy: (agentId: string) => "install" | "login" | null
  /** An agent-handled login waiting on the person: a link and a code. */
  deviceCode: (agentId: string) => DeviceCode | null
  install: (agent: AgentDef) => Promise<void>
  login: (agent: AgentDef, method: AgentLoginMethod) => Promise<void>
  cancel: (agentId: string) => void
}

export function useAgentSetup(): AgentSetup {
  const settings = useServer()
  const qc = useQueryClient()
  const dock = React.useContext(DockContext)
  const { refresh } = useAgentsStatus()
  const [busy, setBusy] = React.useState<ReadonlyMap<string, "install" | "login">>(() => new Map())
  const [codes, setCodes] = React.useState<ReadonlyMap<string, DeviceCode>>(() => new Map())
  const [following, setFollowing] = React.useState<ReadonlyMap<string, number>>(() => new Map())
  const aborts = React.useRef(new Map<string, AbortController>())

  const mark = React.useCallback((agentId: string, what: "install" | "login" | null) => {
    setBusy((current) => {
      const next = new Map(current)
      if (what) next.set(agentId, what)
      else next.delete(agentId)
      return next
    })
  }, [])

  /* A terminal login ends in a panel this hook does not own, so its outcome
     is read back: the server re-measures when the terminal exits, and a plain
     re-read (not `?refresh=1`, which would spawn the probe each time) picks
     that up. Stops once the agent says logged in, or after the code's life. */
  React.useEffect(() => {
    if (following.size === 0) return
    const tick = window.setInterval(() => {
      void qc.invalidateQueries({ queryKey: agentsStatusKey(settings) })
      const status = qc.getQueryData<{ agents: { agentId: string; authenticated?: boolean | null }[] }>(
        agentsStatusKey(settings),
      )
      setFollowing((current) => {
        const next = new Map(current)
        for (const [agentId, since] of current) {
          const done = status?.agents.find((a) => a.agentId === agentId)?.authenticated === true
          if (done || Date.now() - since > FOLLOW_FOR_MS) next.delete(agentId)
        }
        return next.size === current.size ? current : next
      })
    }, FOLLOW_MS)
    return () => window.clearInterval(tick)
  }, [following, qc, settings])

  /* Leaving the surface ends any login still holding a connection open. */
  React.useEffect(() => {
    const open = aborts.current
    return () => {
      for (const abort of open.values()) abort.abort()
    }
  }, [])

  const install = React.useCallback(
    async (agent: AgentDef) => {
      mark(agent.id, "install")
      try {
        await api(settings, `/api/agents/${encodeURIComponent(agent.id)}/install`, { method: "POST" })
        toast.success(`${agent.name} installed`)
        await refresh()
      } catch (err) {
        reportError(err, `Couldn't install ${agent.name}`)
      } finally {
        mark(agent.id, null)
      }
    },
    [settings, refresh, mark],
  )

  const loginInTerminal = React.useCallback(
    async (agent: AgentDef, method: AgentLoginMethod) => {
      const terminal = await api<TerminalInfo>(settings, `/api/agents/${encodeURIComponent(agent.id)}/login`, {
        method: "POST",
        body: JSON.stringify({ methodId: method.id }),
      })
      /* Closed on a clean exit — ACP's success — and kept on a failure, whose
         output is the reason. */
      const panel = { kind: "terminal", projectId: SETUP_PROJECT, terminalId: terminal.id, closeOnExit: true } as const
      if (dock) dock.openPanel(panel, { direction: "below" })
      else queuePanel(panel, { direction: "below" })
      setFollowing((current) => new Map(current).set(agent.id, Date.now()))
    },
    [settings, dock],
  )

  const loginByAgent = React.useCallback(
    async (agent: AgentDef, method: AgentLoginMethod) => {
      const abort = new AbortController()
      aborts.current.set(agent.id, abort)
      const setCode = (code: DeviceCode | null) =>
        setCodes((current) => {
          const next = new Map(current)
          if (code) next.set(agent.id, code)
          else next.delete(agent.id)
          return next
        })
      try {
        const path = `/api/agents/${encodeURIComponent(agent.id)}/authenticate`
        const res = await fetch(new URL(path, settings.url), {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${settings.token}` },
          body: JSON.stringify({ methodId: method.id }),
          signal: abort.signal,
        })
        if (!res.ok || !res.body) {
          const text = await res.text().catch(() => "")
          let serverMessage = text.trim() || undefined
          try {
            serverMessage = (JSON.parse(text) as { error?: string }).error ?? serverMessage
          } catch {
            /* not JSON */
          }
          throw new ApiError({ status: res.status, path, serverMessage })
        }
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
        let buffer = ""
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += value
          let newline = buffer.indexOf("\n")
          while (newline >= 0) {
            const line = buffer.slice(0, newline).trim()
            buffer = buffer.slice(newline + 1)
            newline = buffer.indexOf("\n")
            if (!line) continue
            const event = JSON.parse(line) as
              | { elicitation: DeviceCode }
              | { done: true; ok: boolean; error?: string }
            if ("elicitation" in event) setCode(event.elicitation)
            else if (event.ok) toast.success(`${agent.name} is logged in`)
            else throw new Error(event.error ?? "The login did not complete")
          }
        }
      } catch (err) {
        if (!abort.signal.aborted) reportError(err, `Couldn't log in to ${agent.name}`)
      } finally {
        aborts.current.delete(agent.id)
        setCode(null)
        await refresh().catch(() => {})
      }
    },
    [settings, refresh],
  )

  const login = React.useCallback(
    async (agent: AgentDef, method: AgentLoginMethod) => {
      mark(agent.id, "login")
      try {
        if (method.kind === "terminal") await loginInTerminal(agent, method)
        else await loginByAgent(agent, method)
      } catch (err) {
        reportError(err, `Couldn't log in to ${agent.name}`)
      } finally {
        mark(agent.id, null)
      }
    },
    [mark, loginInTerminal, loginByAgent],
  )

  const cancel = React.useCallback((agentId: string) => aborts.current.get(agentId)?.abort(), [])

  return React.useMemo(
    () => ({
      busy: (agentId: string) => busy.get(agentId) ?? (following.has(agentId) ? "login" : null),
      deviceCode: (agentId: string) => codes.get(agentId) ?? null,
      install,
      login,
      cancel,
    }),
    [busy, following, codes, install, login, cancel],
  )
}

/* ── Is this server ready to run a thread ──
   Read from what exists, never from a "setup done" flag: deleting the last
   project brings the wizard back, and two devices always agree.

   A profile is usable when it is stored (it carries its own credentials), or
   when it is an agent's virtual Default and that agent can run on the
   machine's own login. The virtual Defaults always exist, which is why
   counting profiles used to call a fresh install ready.

   "Not checked" (`authenticated: null`) is two answers on purpose: it does not
   block the app — a runtime that cannot report its login may well work — but
   it does not tick the wizard's Agents step either. */
export interface SetupState {
  loading: boolean
  /** The app can open a thread. */
  ready: boolean
  /** The wizard's steps, each measured. */
  agents: boolean
  profile: boolean
  project: boolean
}

const runnable = (s: AgentStatus) => s.installed && !s.error

export function useSetupState(): SetupState {
  const projects = useProjects()
  const profiles = useProfiles()
  const catalogLoaded = useCatalogLoaded()
  const { status, error } = useAgentsStatus()
  const stored = profiles.filter((p) => !p.virtual)
  /* A server that cannot say (an older one, a failed read) is not a reason to
     lock anyone out: it answers as before this check existed. */
  const unknown = !!error || (status !== undefined && status.agents.every((s) => s.authenticated === undefined))
  const readings = status?.agents ?? []
  const loggedIn = readings.some((s) => runnable(s) && s.authenticated === true)
  return {
    /* Only waited on when it decides the answer: with a stored profile the
       readings change nothing about whether the app can run. */
    loading: !catalogLoaded || (stored.length === 0 && status === undefined && !error),
    ready:
      projects.length > 0 &&
      (stored.length > 0 || unknown || readings.some((s) => runnable(s) && s.authenticated !== false)),
    agents:
      unknown ||
      readings.some((s) => runnable(s) && (s.authenticated === true || stored.some((p) => profileSupports(p, s.agentId)))),
    profile: stored.length > 0 || unknown || loggedIn,
    project: projects.length > 0,
  }
}
