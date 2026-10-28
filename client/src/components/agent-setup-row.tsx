/* One agent, getting ready: whether it is installed and logged in, and the one
   button that moves it forward — Install, then Log in, then nothing. The
   first-run wizard draws one per agent; Settings › Agents carries the same
   actions in its table (both through `useAgentSetup`).

   A device-code login is drawn here, in place: the link to open and the
   message carrying the code, with Cancel — closing it is the cancel. */
import { DownloadIcon, ExternalLinkIcon, LogInIcon } from "lucide-react"

import { AgentIcon } from "@/components/entity-icon"
import { StatusBadge } from "@/components/settings/primitives"
import { Button } from "@/components/ui/button"
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item"
import { Spinner } from "@/components/ui/spinner"
import type { AgentSetup } from "@/lib/agent-setup"
import type { AgentDef, AgentStatus } from "@/lib/settings"

/** Ready means it can run a thread: installed, answering, and not known to be
    logged out. "Not checked" (null) is not ready for the wizard's step, which
    still offers Log in — but it never blocks the app (see `app-shell`). */
export const agentReady = (status: AgentStatus | undefined): boolean =>
  !!status?.installed && !status.error && status.authenticated === true

export function AgentSetupRow({
  agent,
  status,
  setup,
}: {
  agent: AgentDef
  status: AgentStatus | undefined
  setup: AgentSetup
}) {
  const busy = setup.busy(agent.id)
  const code = setup.deviceCode(agent.id)
  const methods = status?.login ?? []

  const state = !status ? (
    <StatusBadge>Checking…</StatusBadge>
  ) : !status.installed ? (
    <StatusBadge tone="bad">Not installed</StatusBadge>
  ) : status.error ? (
    <span title={status.error}>
      <StatusBadge tone="bad">Not answering</StatusBadge>
    </span>
  ) : status.authenticated === true ? (
    <StatusBadge tone="ok">Logged in</StatusBadge>
  ) : status.authenticated === false ? (
    <StatusBadge tone="warn">Not logged in</StatusBadge>
  ) : (
    <StatusBadge>Login not checked</StatusBadge>
  )

  const action = busy ? (
    <Button size="sm" variant="outline" disabled>
      <Spinner />
      {busy === "install" ? "Installing…" : "Logging in…"}
    </Button>
  ) : status && !status.installed && status.install ? (
    <Button size="sm" onClick={() => void setup.install(agent)} title={status.install}>
      <DownloadIcon />
      Install
    </Button>
  ) : status?.installed && !status.error && status.authenticated !== true ? (
    methods.map((method) => (
      <Button
        key={method.id}
        size="sm"
        variant={status.authenticated === false ? "default" : "outline"}
        title={method.description ?? undefined}
        onClick={() => void setup.login(agent, method)}
      >
        <LogInIcon />
        {methods.length > 1 ? method.name : "Log in"}
      </Button>
    ))
  ) : null

  return (
    <Item variant="outline" className="items-start gap-3 p-3">
      <ItemMedia variant="icon" className="size-9 rounded-inner bg-muted">
        <AgentIcon agentId={agent.id} className="size-5" />
      </ItemMedia>
      <ItemContent className="min-w-0 gap-1.5">
        <ItemTitle className="flex flex-wrap items-center gap-2">
          {agent.name}
          {state}
          {status?.agent?.version && <StatusBadge dot={false}>v{status.agent.version}</StatusBadge>}
        </ItemTitle>
        {status && !status.installed && status.install && (
          <ItemDescription className="font-mono text-xs break-all">{status.install}</ItemDescription>
        )}
        {status?.installed && methods.length > 0 && status.authenticated !== true && (
          <ItemDescription>
            The login is this server's — every thread on it, and everyone using it, shares it.
          </ItemDescription>
        )}
        {code && (
          <div className="mt-1 space-y-2 rounded-lg bg-muted px-3 py-2 text-sm">
            <p className="text-foreground select-text">{code.message}</p>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="xs" render={<a href={code.url} target="_blank" rel="noreferrer" />}>
                <ExternalLinkIcon />
                Open the sign-in page
              </Button>
              <Button size="xs" variant="ghost" onClick={() => setup.cancel(agent.id)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </ItemContent>
      {action && !code && <ItemActions className="flex-wrap justify-end">{action}</ItemActions>}
    </Item>
  )
}
