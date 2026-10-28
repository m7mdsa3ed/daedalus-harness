/* ── Connecting over SSH (desktop only) ──
   The connect screen's second way in: a host from ~/.ssh/config, the
   directory the harness lives in there, and the shell does the rest through
   the system's own ssh (electron/ssh.cjs).

     1. Trust the host — once, by its fingerprint, never silently.
     2. Find the harness, or install it: clone into an empty spot and run
        `setup.sh --local`, so the server listens on the host's loopback only
        and SSH is its one door.
     3. Open a tunnel on a local port chosen once for this host, read the token
        over SSH, and verify the server exactly as a typed address is.

   `SshGate` is the other half: a saved SSH server reopens its tunnel before
   the app connects to it, and says so when it cannot. */
import * as React from "react"
import { FolderGit2, Hash, ServerCog, ShieldCheck } from "lucide-react"

import { verifyServer } from "@/components/connect-screen"
import { Notice } from "@/components/notice"
import { Button } from "@/components/ui/busy-button"
import { CopyButton } from "@/components/ui/copy-button"
import { Field, FieldLabel } from "@/components/ui/field"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { loadServers, saveSettings, type ServerSettings } from "@/lib/settings"

const REPO_KEY = "daedalus.ssh.repo"
/** Where `pm2:start` binds when setup.sh is not told otherwise. */
const DEFAULT_REMOTE_PORT = 4001

type Step =
  | { kind: "form" }
  | { kind: "trust"; fingerprints: string[] }
  | { kind: "install" }
  | { kind: "installing" }

/** Unwraps the bridge's `{ok, error}` answers into a throw. */
async function call<T extends object>(answer: Promise<({ ok: true } & T) | { ok: false; error: string }>): Promise<T> {
  const result = await answer
  if (!result.ok) throw new Error(result.error)
  return result
}

export function SshConnect({
  onConnected,
  onCancel,
}: {
  onConnected: (s: ServerSettings) => void
  onCancel?: () => void
}) {
  const ssh = window.desktop?.ssh
  const [available, setAvailable] = React.useState<boolean | null>(null)
  const [hosts, setHosts] = React.useState<string[]>([])
  const [host, setHost] = React.useState("")
  const [dir, setDir] = React.useState("~/daedalus-harness")
  const [remotePort, setRemotePort] = React.useState(String(DEFAULT_REMOTE_PORT))
  const [repo, setRepo] = React.useState(() => localStorage.getItem(REPO_KEY) ?? "")
  const [step, setStep] = React.useState<Step>({ kind: "form" })
  const [log, setLog] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!ssh) return
    void ssh.available().then((r) => setAvailable(r.ok && r.available))
    void ssh.hosts().then((r) => r.ok && setHosts(r.hosts))
    return ssh.onOutput(({ text }) => setLog((current) => (current + text).slice(-20_000)))
  }, [ssh])

  if (!ssh) return null
  if (available === false)
    return (
      <Notice tone="warn" size="md">
        No <code className="font-mono">ssh</code> was found on this computer. Install the OpenSSH client (on
        Windows: Settings › System › Optional features › OpenSSH Client), then reopen this screen.
      </Notice>
    )

  /** Steps 2 and 3, once the host is trusted. */
  const findAndConnect = async () => {
    const found = await call(ssh.probe(host, dir))
    if (found.dir === "occupied") throw new Error(`${dir} on ${host} exists and is not a harness checkout — choose another directory.`)
    if (found.dir === "absent" || !found.token) {
      setStep({ kind: "install" })
      return
    }
    const port = found.port ?? Number(remotePort)
    /* The local port is this host's for good: reuse the saved one, so the
       entry's URL — and the entry — stay the same. */
    const saved = loadServers().find((s) => s.ssh?.host === host)
    const localPort = saved?.ssh?.localPort ?? (await call(ssh.freePort())).port
    await call(ssh.tunnel(host, localPort, port))
    const url = `http://127.0.0.1:${localPort}`
    await verifyServer(url, found.token).catch((err: Error) => {
      throw new Error(
        `The tunnel is open but the server did not answer: ${err.message} Is it running on ${host}? (pm2 list, or run setup.sh again)`,
      )
    })
    onConnected(
      saveSettings({
        id: saved?.id,
        name: saved?.name ?? host,
        url,
        token: found.token,
        ssh: { host, dir, remotePort: port, localPort },
      }),
    )
  }

  const run = (fn: () => Promise<void>) => async () => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const start = run(async () => {
    if (!host.trim()) throw new Error("Choose a host.")
    const key = await call(ssh.hostKey(host.trim()))
    if (!key.known) {
      setStep({ kind: "trust", fingerprints: key.fingerprints })
      return
    }
    await findAndConnect()
  })

  const trust = run(async () => {
    await call(ssh.trust(host))
    setStep({ kind: "form" })
    await findAndConnect()
  })

  const install = run(async () => {
    const port = Number(remotePort)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("The server port must be a number.")
    localStorage.setItem(REPO_KEY, repo.trim())
    setLog("")
    setStep({ kind: "installing" })
    const { code } = await call(ssh.install(host, dir, repo.trim(), port))
    if (code !== 0) {
      setStep({ kind: "install" })
      throw new Error(`Setting up on ${host} stopped (exit ${code}) — the output above says why.`)
    }
    setStep({ kind: "form" })
    await findAndConnect()
  })

  const field = (id: string, label: string, icon: React.ReactNode, input: React.ReactNode, hint?: string) => (
    <Field>
      <FieldLabel htmlFor={id}>
        {label} {hint && <span className="font-normal text-muted-foreground">{hint}</span>}
      </FieldLabel>
      <InputGroup>
        <InputGroupAddon>{icon}</InputGroupAddon>
        {input}
      </InputGroup>
    </Field>
  )

  return (
    <>
      {field(
        "ssh-host",
        "Host",
        <ServerCog />,
        <>
          <InputGroupInput
            id="ssh-host"
            list="ssh-hosts"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="a Host from ~/.ssh/config, or user@hostname"
            autoCapitalize="none"
            autoCorrect="off"
            className="font-mono"
            disabled={step.kind !== "form"}
          />
          <datalist id="ssh-hosts">
            {hosts.map((h) => (
              <option key={h} value={h} />
            ))}
          </datalist>
        </>,
      )}
      {field(
        "ssh-dir",
        "Directory",
        <FolderGit2 />,
        <InputGroupInput
          id="ssh-dir"
          value={dir}
          onChange={(e) => setDir(e.target.value)}
          className="font-mono"
          disabled={step.kind !== "form"}
        />,
        "(on the host)",
      )}

      {step.kind === "trust" && (
        <Notice tone="warn" size="md" title={`First connection to ${host}`}>
          <p>Check these fingerprints against the host's own (ssh-keygen -lf /etc/ssh/ssh_host_*_key.pub) before trusting it:</p>
          <pre className="mt-2 overflow-x-auto font-mono text-xs whitespace-pre select-text">{step.fingerprints.join("\n")}</pre>
        </Notice>
      )}

      {(step.kind === "install" || step.kind === "installing") && (
        <>
          <Notice tone="info" size="md" title={`No harness at ${dir} on ${host}`}>
            Install it there: clone the repository and run setup.sh, which needs git, Node 22, pnpm and
            PostgreSQL on the host. The server will listen on the host's loopback only.
          </Notice>
          {field(
            "ssh-repo",
            "Repository",
            <FolderGit2 />,
            <InputGroupInput
              id="ssh-repo"
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              placeholder="git@github.com:you/daedalus-harness.git"
              className="font-mono"
              disabled={step.kind === "installing"}
            />,
            "(cloned on the host)",
          )}
          {field(
            "ssh-port",
            "Server port",
            <Hash />,
            <InputGroupInput
              id="ssh-port"
              value={remotePort}
              onChange={(e) => setRemotePort(e.target.value)}
              inputMode="numeric"
              className="font-mono"
              disabled={step.kind === "installing"}
            />,
            "(on the host's loopback)",
          )}
        </>
      )}

      {log && (
        <pre className="max-h-56 overflow-auto rounded-lg bg-muted px-3 py-2 font-mono text-xs whitespace-pre-wrap select-text">
          {log}
        </pre>
      )}

      {error && (
        <Notice tone="error" size="md" action={<CopyButton text={error} size="icon-xs" className="shrink-0" />}>
          {error}
        </Notice>
      )}

      <Field orientation="horizontal">
        {onCancel && (
          <Button type="button" variant="outline" className="flex-1" onClick={onCancel}>
            Cancel
          </Button>
        )}
        {step.kind === "trust" ? (
          <>
            <Button type="button" variant="outline" className="flex-1" onClick={() => setStep({ kind: "form" })}>
              Don't trust
            </Button>
            <Button type="button" className="flex-1" loading={busy} onClick={() => void trust()}>
              <ShieldCheck data-icon="inline-start" />
              Trust and connect
            </Button>
          </>
        ) : step.kind === "install" || step.kind === "installing" ? (
          <Button
            type="button"
            className="flex-1"
            loading={busy}
            disabled={!repo.trim()}
            onClick={() => void install()}
          >
            Install on {host}
          </Button>
        ) : (
          <Button type="button" className="flex-1" loading={busy} onClick={() => void start()}>
            Connect
          </Button>
        )}
      </Field>
    </>
  )
}

/**
 * A saved SSH server's tunnel, opened before anything connects through it.
 * The children (the connected app) mount once it is open; until then, and
 * when it cannot be opened, this says which — with Retry, and a way back to
 * the connect screen. A browser (no `desktop.ssh`) has no tunnel to open and
 * renders the children as they are.
 */
export function SshGate({
  settings,
  onChooseAnother,
  children,
}: {
  settings: ServerSettings
  onChooseAnother: () => void
  children: React.ReactNode
}) {
  const ssh = window.desktop?.ssh
  const target = settings.ssh
  const [state, setState] = React.useState<"opening" | "open" | { error: string }>(
    ssh && target ? "opening" : "open",
  )
  const [attempt, setAttempt] = React.useState(0)

  React.useEffect(() => {
    if (!ssh || !target) return
    let live = true
    setState("opening")
    void ssh.tunnel(target.host, target.localPort, target.remotePort).then((r) => {
      if (live) setState(r.ok ? "open" : { error: r.error })
    })
    return () => {
      live = false
    }
  }, [ssh, target, attempt])

  if (state === "open") return <>{children}</>
  return (
    <main className="flex min-h-svh items-center justify-center bg-muted p-6" data-drag-region>
      <div className="w-full max-w-md space-y-3" data-no-drag>
        {state === "opening" ? (
          <Notice tone="info" size="md">
            Opening the SSH tunnel to {target?.host}…
          </Notice>
        ) : (
          <Notice
            tone="error"
            size="md"
            title={`Couldn't reach ${target?.host} over SSH`}
            action={<CopyButton text={state.error} size="icon-xs" className="shrink-0" />}
          >
            {state.error}
          </Notice>
        )}
        {state !== "opening" && (
          <div className="flex gap-2">
            <Button type="button" className="flex-1" onClick={() => setAttempt((n) => n + 1)}>
              Retry
            </Button>
            <Button type="button" variant="outline" className="flex-1" onClick={onChooseAnother}>
              Connect another way
            </Button>
          </div>
        )}
      </div>
    </main>
  )
}
