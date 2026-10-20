/* ── The compatibility gate's screen ──
   What stands in for the shell when this build and the active server cannot
   work together (`compatOf`, lib/compat.ts). Two answers, each with the one
   thing that fixes it: an old server is updated where it runs, so the screen
   hands over the command; an old app is updated here, through whichever door
   this shell has (lib/client-update.ts). Either way the other servers and Add
   stay one click away, because the fix may be on a machine you are not at. */
import * as React from "react"
import { Notice } from "@/components/notice"
import { ErrorNote } from "@/components/error-note"
import { Button } from "@/components/ui/button"
import { CopyButton } from "@/components/ui/copy-button"
import { SERVER_UPDATE_COMMAND, type Compat } from "@/lib/compat"
import { clientUpdateVia, requestClientUpdate } from "@/lib/client-update"
import { captureError, type InlineError } from "@/lib/errors"
import { useAppMeta } from "@/lib/queries"
import { loadServers, setActiveServer, type ServerSettings } from "@/lib/settings"

export function IncompatibleServer({
  compat,
  settings,
  onAddServer,
  onRecheck,
}: {
  compat: Exclude<Compat, "ok">
  settings: ServerSettings
  onAddServer: () => void
  /** Re-read the server's health — the way out once it has been updated. */
  onRecheck: () => void
}) {
  const others = React.useMemo(() => loadServers().filter((s) => s.id !== settings.id), [settings.id])

  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <div className="flex w-full max-w-md flex-col gap-3">
        {compat === "server-old" ? <ServerOld settings={settings} /> : <ClientOld settings={settings} />}
        <div className="flex flex-wrap gap-2">
          {others.map((server) => (
            <Button key={server.id} variant="outline" size="sm" onClick={() => setActiveServer(server.id)}>
              Switch to {server.name}
            </Button>
          ))}
          <Button variant="outline" size="sm" onClick={onRecheck}>
            Check again
          </Button>
          <Button variant="outline" size="sm" onClick={onAddServer}>
            Add server…
          </Button>
        </div>
      </div>
    </div>
  )
}

function ServerOld({ settings }: { settings: ServerSettings }) {
  /* `/api/meta` is authed and may predate this app's reader; the version is a
     courtesy, so an unknown one just goes unsaid. */
  const version = useAppMeta(settings).data?.version
  return (
    <Notice tone="warn" size="md" title={`${settings.name} needs an update`}>
      <p>
        The server at {settings.name} runs an older Daedalus
        {version ? ` (${version})` : ""} that this app no longer supports. Update it where it
        runs:
      </p>
      <div className="flex items-center gap-1">
        <code className="min-w-0 flex-1 rounded-md bg-muted px-2 py-1 font-mono text-sm">
          {SERVER_UPDATE_COMMAND}
        </code>
        <CopyButton text={SERVER_UPDATE_COMMAND} label="Copy" />
      </div>
    </Notice>
  )
}

function ClientOld({ settings }: { settings: ServerSettings }) {
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<InlineError | null>(null)
  const via = clientUpdateVia()
  const message = `${settings.name} runs a newer Daedalus than this app supports.`

  const update = async () => {
    setPending(true)
    setError(null)
    try {
      await requestClientUpdate()
    } catch (err) {
      setError(captureError(err, "Couldn't update the app"))
    } finally {
      setPending(false)
    }
  }

  return (
    <>
      <Notice
        tone="warn"
        size="md"
        title="This app needs an update"
        action={
          <Button size="sm" disabled={pending} onClick={() => void update()}>
            {pending ? "Updating…" : via === "reload" ? "Reload" : "Update app"}
          </Button>
        }
      >
        <p>{message}</p>
        <CopyButton text={message} label="Copy" />
      </Notice>
      <ErrorNote error={error} />
    </>
  )
}
