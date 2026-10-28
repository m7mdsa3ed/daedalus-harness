import * as React from "react"
import { KeyRound, Server, Tag, TerminalSquare } from "lucide-react"
import { Segmented } from "@/components/settings/primitives"
import { SshConnect } from "@/components/ssh-connect"
import { Notice } from "@/components/notice"
import { Logo } from "@/components/ui/logo"
import { Button } from "@/components/ui/busy-button"
import { CopyButton } from "@/components/ui/copy-button"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { describeError } from "@/lib/errors"
import { connectLink, saveSettings, serverName, type ServerSettings } from "@/lib/settings"

type Guide = { title: string; text: React.ReactNode }

const C = ({ children }: { children: React.ReactNode }) => (
  <code className="rounded bg-background px-1 py-0.5 font-mono text-[0.8em] text-foreground">{children}</code>
)

/** What the reader needs before the form makes sense — per way in, because
    an address and an SSH host are found in different places. */
const STEPS: Record<"address" | "ssh", Guide[]> = {
  address: [
    {
      title: "Start the server",
      text: (
        <>
          On the machine that will run your agents, run <C>./setup.sh</C> in the clone. It installs,
          builds, starts the server and prints a link that fills this form in for you. Already set
          up? <C>cd server && pnpm dev</C> works too.
        </>
      ),
    },
    {
      title: "Copy the server URL",
      text: (
        <>
          <C>pnpm dev</C> listens on port <C>8791</C>, <C>pnpm pm2:start</C> on <C>4001</C>. On
          the same machine use <C>localhost</C>; from a phone or another computer use the
          machine's network address, e.g. <C>http://192.168.1.10:8791</C>.
        </>
      ),
    },
    {
      title: "Copy the access token",
      text: (
        <>
          The server prints it on startup as <C>token: …</C>. It's also kept in{" "}
          <C>server/data/config.json</C>. Treat it like a password.
        </>
      ),
    },
  ],
  ssh: [
    {
      title: "Pick a host",
      text: (
        <>
          Hosts come from your <C>~/.ssh/config</C>, and your system's own <C>ssh</C> does the
          connecting, so keys and agents work as they do in a terminal.
        </>
      ),
    },
    {
      title: "Trust it once",
      text: "The first time, you confirm the host's fingerprint. After that it's never asked again, and never trusted silently.",
    },
    {
      title: "Find or install the harness",
      text: (
        <>
          Point at the folder the harness lives in. If it isn't there, the app clones it and runs{" "}
          <C>setup.sh --local</C>, so the server listens only on the host's loopback and SSH is its
          one way in.
        </>
      ),
    },
  ],
}

const TROUBLE: Guide[] = [
  {
    title: "“Couldn't reach that address”",
    text: "Check the server is still running, the port is right, and no firewall sits between this device and it.",
  },
  {
    title: "“The server rejected this token”",
    text: "Copy it again. It changes only if config.json is deleted, so an old copy is usually a typo or a stray space.",
  },
  {
    title: "Installing on a phone",
    text: (
      <>
        The installable app needs https. <C>pnpm dev:tunnel</C> gives you a public https address for
        testing.
      </>
    ),
  },
]

/** Is a Daedalus server answering at `base`, and does it take this token.
    Throws a sentence for each way it is not. Shared with the SSH connect,
    which checks the tunnel's local end the same way. */
export async function verifyServer(base: string, token: string): Promise<void> {
  let res: Response
  try {
    res = await fetch(new URL("/api/health", base), {
      headers: { authorization: `Bearer ${token}` },
    })
  } catch {
    // The one failure this screen exists to diagnose, and the one the
    // browser is least helpful about ("Failed to fetch"). Name the suspects.
    throw new Error(
      "Couldn't reach that address. Check the URL and port, that the server is running, and that it allows this origin."
    )
  }
  if (res.status === 401 || res.status === 403) throw new Error("The server rejected this token.")
  if (!res.ok) throw new Error(`The server answered ${res.status} — that address isn't a Daedalus server.`)
  let health: { ok?: boolean; authorized?: boolean }
  try {
    health = (await res.json()) as typeof health
  } catch {
    throw new Error("That address answered, but not with JSON — it isn't a Daedalus server.")
  }
  if (!health.ok) throw new Error("That address isn't a Daedalus server.")
  if (!health.authorized) throw new Error("The server rejected this token.")
}

export function ConnectScreen({
  onConnected,
  onCancel,
}: {
  onConnected: (s: ServerSettings) => void
  /** Present when another server is already connected — this is an "add". */
  onCancel?: () => void
}) {
  const [url, setUrl] = React.useState(connectLink?.url ?? "http://localhost:8791")
  const [token, setToken] = React.useState(connectLink?.token ?? "")
  const [name, setName] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)

  const [via, setVia] = React.useState<"address" | "ssh">("address")

  const connect = async (e?: React.FormEvent) => {
    e?.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const base = url.replace(/\/+$/, "")
      await verifyServer(base, token)
      onConnected(saveSettings({ name: name.trim() || serverName(base), url: base, token }))
    } catch (err) {
      setError(describeError(err).title)
    } finally {
      setBusy(false)
    }
  }

  /* A link from `setup.sh` is verified at once — the same check a typed one
     gets; a refusal leaves the fields filled for a correction. Once only:
     the link is the page load's, not the screen's. */
  const linked = React.useRef(false)
  React.useEffect(() => {
    if (!connectLink || linked.current) return
    linked.current = true
    void connect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <main data-drag-region className="grid min-h-svh w-full bg-background lg:grid-cols-2">
      <div className="flex flex-col gap-10 p-6 md:p-10 lg:p-16">
        <div className="flex items-center gap-2.5">
          <Logo className="size-7 text-primary" />
          <span className="brand-script text-xl leading-none">Daedalus</span>
        </div>
        <div className="flex flex-1 items-center justify-center">
          <form onSubmit={connect} className="w-full" data-no-drag>
            <FieldGroup>
              <div className="flex flex-col gap-1">
                <h1 className="font-heading text-2xl font-medium">
                  {onCancel ? "Add a server" : "Connect to your harness"}
                </h1>
                <p className="text-sm text-balance text-muted-foreground">
                  {onCancel
                    ? "Connections are kept side by side. Switch between them in the sidebar."
                    : "This app is a window onto a Daedalus server: your agents, projects and threads all live there. Tell it where the server is."}
                </p>
              </div>
              {window.desktop?.ssh && (
                <Segmented
                  label="Connect by"
                  value={via}
                  onChange={setVia}
                  options={[
                    { value: "address", label: "Address", icon: Server },
                    { value: "ssh", label: "SSH", icon: TerminalSquare },
                  ]}
                />
              )}
              {via === "ssh" ? (
                <SshConnect onConnected={onConnected} onCancel={onCancel} />
              ) : (
              <>
              <Field>
                <FieldLabel htmlFor="server-url">Server URL</FieldLabel>
                <InputGroup>
                  <InputGroupAddon>
                    <Server />
                  </InputGroupAddon>
                  <InputGroupInput
                    id="server-url"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="http://192.168.1.10:8791"
                    autoCapitalize="none"
                    autoCorrect="off"
                    className="font-mono"
                    required
                  />
                </InputGroup>
                <FieldDescription>
                  Include the port: 8791 for <code className="font-mono">pnpm dev</code>, 4001 for pm2.
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="server-token">Access token</FieldLabel>
                <InputGroup>
                  <InputGroupAddon>
                    <KeyRound />
                  </InputGroupAddon>
                  <InputGroupInput
                    id="server-token"
                    type="password"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder="printed by the server on startup"
                    required
                  />
                </InputGroup>
                <FieldDescription>
                  The <code className="font-mono">token:</code> line in the server's output, or{" "}
                  <code className="font-mono">server/data/config.json</code>.
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="server-name">
                  Name <span className="font-normal text-muted-foreground">(optional)</span>
                </FieldLabel>
                <InputGroup>
                  <InputGroupAddon>
                    <Tag />
                  </InputGroupAddon>
                  <InputGroupInput
                    id="server-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={serverName(url)}
                  />
                </InputGroup>
              </Field>
              {error && (
                <Notice
                  tone="error"
                  size="md"
                  action={
                    /* Nothing else on this screen is connected yet — no toast
                       pipeline, no transcript to record into — so the clipboard
                       is the only way this sentence leaves the machine. */
                    <CopyButton text={error} size="icon-xs" className="shrink-0" />
                  }
                >
                  {error}
                </Notice>
              )}
              <Field orientation="horizontal">
                {onCancel && (
                  <Button type="button" variant="outline" className="flex-1" onClick={onCancel}>
                    Cancel
                  </Button>
                )}
                <Button type="submit" className="flex-1" loading={busy}>
                  Connect
                </Button>
              </Field>
              </>
              )}
            </FieldGroup>
          </form>
        </div>
        <p className="text-center text-xs text-muted-foreground">
          The address and token are stored on this device only. Nothing is built into the app.
        </p>
      </div>

      {/* Below the form on a phone rather than hidden: the reader who most
          needs to be told where the token is, is the one on a small screen. */}
      <aside className="flex flex-col gap-10 overflow-y-auto bg-muted p-6 md:p-10 lg:p-16" data-no-drag>
        <div className="flex w-full flex-col gap-10 lg:my-auto">
          <section>
            <h2 className="font-heading text-lg font-medium">
              {via === "ssh" ? "Connecting over SSH" : "Where to find these"}
            </h2>
            <ol className="mt-5 flex flex-col gap-5">
              {STEPS[via].map((s, i) => (
                <li key={s.title} className="flex gap-3">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-medium text-primary-foreground">
                    {i + 1}
                  </span>
                  <div className="flex flex-col gap-1">
                    <span className="text-sm font-medium">{s.title}</span>
                    <p className="text-sm text-pretty text-muted-foreground">{s.text}</p>
                  </div>
                </li>
              ))}
            </ol>
          </section>
          <section>
            <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              If it doesn't connect
            </h2>
            <dl className="mt-3 flex flex-col gap-3">
              {TROUBLE.map((t) => (
                <div key={t.title}>
                  <dt className="text-sm font-medium">{t.title}</dt>
                  <dd className="text-sm text-pretty text-muted-foreground">{t.text}</dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
      </aside>
    </main>
  )
}
