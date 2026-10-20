import * as React from "react"
import { KeyRound, Server, Tag } from "lucide-react"
import { Notice } from "@/components/notice"
import { Logo } from "@/components/ui/logo"
import { Button } from "@/components/ui/button"
import { CopyButton } from "@/components/ui/copy-button"
import { Card, CardContent } from "@/components/ui/card"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { describeError } from "@/lib/errors"
import { saveSettings, serverName, type ServerSettings } from "@/lib/settings"

const POINTS = [
  "Threads run on the server; this client is just the ACP endpoint.",
  "Projects and profiles are shared by every connected client.",
  "The URL and token stay on this device — nothing is baked into the build.",
]

export function ConnectScreen({
  onConnected,
  onCancel,
}: {
  onConnected: (s: ServerSettings) => void
  /** Present when another server is already connected — this is an "add". */
  onCancel?: () => void
}) {
  const [url, setUrl] = React.useState("http://localhost:8791")
  const [token, setToken] = React.useState("")
  const [name, setName] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)

  const connect = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const base = url.replace(/\/+$/, "")
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
      onConnected(saveSettings({ name: name.trim() || serverName(base), url: base, token }))
    } catch (err) {
      setError(describeError(err).title)
    } finally {
      setBusy(false)
    }
  }

  return (
    <main
      data-drag-region
      className="flex min-h-svh items-center justify-center bg-muted p-6 md:p-10"
    >
      <Card className="w-full max-w-4xl overflow-hidden p-0">
        <CardContent className="grid p-0 lg:grid-cols-2">
          <form onSubmit={connect} className="p-6 md:p-8" data-no-drag>
            <FieldGroup>
              <div className="flex flex-col gap-1">
                <div className="mb-4 flex items-center gap-2.5 lg:hidden">
                  <img src="/logo.svg" alt="" className="size-7" />
                  <span className="brand-script text-xl leading-none">Daedalus</span>
                </div>
                <h1 className="font-heading text-xl font-medium">
                  {onCancel ? "Add a server" : "Connect"}
                </h1>
                <p className="text-sm text-balance text-muted-foreground">
                  {onCancel
                    ? "Connections are kept side by side — switch between them in the sidebar."
                    : "Point this client at a harness server."}
                </p>
              </div>
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
            </FieldGroup>
          </form>

          <section className="hidden flex-col justify-between gap-10 bg-muted p-8 lg:flex">
            <div className="flex items-center gap-2.5">
              <Logo className="size-8 text-primary" />
              <span className="brand-script text-2xl leading-none">Daedalus</span>
            </div>
            <div>
              <h2 className="font-heading text-xl font-medium text-balance">
                One harness, every ACP agent.
              </h2>
              <ul className="mt-6 flex flex-col gap-3">
                {POINTS.map((point) => (
                  <li key={point} className="flex gap-2.5 text-sm text-pretty text-muted-foreground">
                    <span className="mt-2 size-1.5 shrink-0 rounded-full bg-primary" />
                    {point}
                  </li>
                ))}
              </ul>
            </div>
            <p className="text-xs text-muted-foreground">
              The server prints the token on <code className="font-mono text-foreground">pnpm dev</code>
            </p>
          </section>
        </CardContent>
      </Card>
    </main>
  )
}
