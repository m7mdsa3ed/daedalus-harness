import * as React from "react"
import { KeyRound, Loader2, Server, TriangleAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { saveSettings, type ServerSettings } from "@/lib/settings"

const POINTS = [
  "Threads run on the server; this client is just the ACP endpoint.",
  "Projects and profiles are shared by every connected client.",
  "The URL and token stay on this device — nothing is baked into the build.",
]

export function ConnectScreen({ onConnected }: { onConnected: (s: ServerSettings) => void }) {
  const [url, setUrl] = React.useState("http://localhost:8791")
  const [token, setToken] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)

  const connect = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const base = url.replace(/\/+$/, "")
      const res = await fetch(new URL("/api/health", base), {
        headers: { authorization: `Bearer ${token}` },
      })
      const health = (await res.json()) as { ok: boolean; authorized: boolean }
      if (!health.ok) throw new Error("not a daedalus server")
      if (!health.authorized) throw new Error("invalid token")
      const settings = { url: base, token }
      saveSettings(settings)
      onConnected(settings)
    } catch (err) {
      setError(err instanceof Error ? err.message : "connection failed")
    } finally {
      setBusy(false)
    }
  }

  return (
    <main
      data-drag-region
      className="relative flex min-h-svh items-center justify-center overflow-hidden p-6"
    >
      {/* Soft field behind the panel — the only ornament on the screen. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 left-1/2 size-[36rem] -translate-x-1/2 rounded-full bg-primary/10 blur-3xl"
      />
      <div className="relative grid w-full max-w-4xl overflow-hidden rounded-2xl border bg-card shadow-glass-lg lg:grid-cols-[1.1fr_1fr]">
        <section className="hidden flex-col justify-between gap-10 border-r bg-muted/30 p-10 lg:flex">
          <div className="flex items-center gap-2.5">
            <img src="/logo.svg" alt="" className="size-8" />
            <span className="text-base font-semibold tracking-tight">Daedalus</span>
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-balance">
              One harness, every ACP agent.
            </h1>
            <ul className="mt-6 space-y-3">
              {POINTS.map((point) => (
                <li key={point} className="flex gap-2.5 text-sm text-pretty text-muted-foreground">
                  <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary/60" />
                  {point}
                </li>
              ))}
            </ul>
          </div>
          <p className="font-mono text-xs text-muted-foreground">
            server prints the token on <span className="text-foreground">pnpm dev</span>
          </p>
        </section>

        <section className="flex flex-col justify-center p-7 sm:p-10" data-no-drag>
          <div className="mb-7 flex items-center gap-2.5 lg:hidden">
            <img src="/logo.svg" alt="" className="size-7" />
            <span className="text-sm font-semibold tracking-tight">Daedalus</span>
          </div>
          <h2 className="text-lg font-semibold tracking-tight">Connect</h2>
          <p className="mt-1 text-sm text-muted-foreground">Point this client at a harness server.</p>

          <form onSubmit={connect} className="mt-6 space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="server-url" className="text-xs font-medium">
                Server URL
              </Label>
              <div className="relative">
                <Server className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="server-url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="http://192.168.1.10:8791"
                  autoCapitalize="none"
                  autoCorrect="off"
                  className="pl-9 font-mono text-xs"
                  required
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="server-token" className="text-xs font-medium">
                Access token
              </Label>
              <div className="relative">
                <KeyRound className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="server-token"
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="printed by the server on startup"
                  className="pl-9"
                  required
                />
              </div>
            </div>
            {error && (
              <p className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                {error}
              </p>
            )}
            <Button type="submit" className="w-full" disabled={busy}>
              {busy && <Loader2 className="size-4 animate-spin" />}
              {busy ? "Connecting…" : "Connect"}
            </Button>
          </form>
        </section>
      </div>
    </main>
  )
}
