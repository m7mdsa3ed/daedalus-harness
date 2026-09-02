import * as React from "react"
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client"
import { AppShell } from "@/components/app-shell"
import { AppToaster } from "@/components/app-toaster"
import { ConfirmProvider } from "@/components/confirm-dialog"
import { PromptProvider } from "@/components/prompt-dialog"
import { ConnectScreen } from "@/components/connect-screen"
import { useActions } from "@/lib/actions"
import { refreshNotificationOffer } from "@/lib/notifications"
import { setupPush } from "@/lib/push"
import { loadSettings, subscribeActiveServer, type ServerSettings } from "@/lib/settings"
import { pruneAgentOptions } from "@/lib/agent-options"
import { makeQueryClient } from "@/lib/queries/client"
import { persistOptionsFor } from "@/lib/queries/persist"
import { useProfiles } from "@/lib/queries/catalog"
import { navigateTo } from "@/lib/router"
import { ServerProvider } from "@/lib/server-context"
import { currentRegistry } from "@/lib/thread/registry"
import { StoreProvider } from "@/lib/store"
import { ThemeProvider } from "@/lib/theme"
import { reportError } from "@/lib/errors"

function App() {
  const [settings, setSettings] = React.useState<ServerSettings | null>(loadSettings)
  // "Add server" reuses the connect screen over the shell; connecting activates
  // the new server, and the reload below is what re-bootstraps against it.
  const [adding, setAdding] = React.useState(false)
  /* Switching connections is a state change, not a reload: `Connected` and the
     store below are keyed by the server id, so the new server starts cold —
     one query cache, one reducer, one bootstrap. What React cannot unmount is
     the thread registry, which is module-level because it holds live sockets,
     so the old server's are ended here before the new tree mounts. The route
     goes back to the root: a thread id belongs to the server that minted it. */
  React.useEffect(
    () =>
      subscribeActiveServer(() => {
        currentRegistry()?.destroyAll()
        navigateTo("/")
        setSettings(loadSettings())
      }),
    []
  )
  /* The reducer is the provider's, not this component's, and that is what
     makes every narrow subscription below it count: holding it here re-ran
     App on every dispatch, which recreated the element for the whole tree, so
     a background thread's streamed token re-rendered every open transcript
     whatever it had subscribed to. See lib/store. */

  return (
    <ThemeProvider>
      <ConfirmProvider>
        <PromptProvider>
          <StoreProvider key={settings?.id ?? "none"}>
            {settings && !adding ? (
              <Connected key={settings.id} settings={settings} onAddServer={() => setAdding(true)} />
            ) : (
              <ConnectScreen
                onConnected={(next) => {
                  if (adding) return location.assign("/")
                  setSettings(next)
                }}
                onCancel={settings && adding ? () => setAdding(false) : undefined}
              />
            )}
            {/* Bottom-trailing on a desktop, top on a phone, and no `theme` prop
                to reconcile: the Base UI toast is drawn entirely out of the
                palette's own tokens, so it follows the app's mode rather than the
                OS's the way sonner's hardcoded per-theme colours had to be talked
                out of. */}
            <AppToaster />
          </StoreProvider>
        </PromptProvider>
      </ConfirmProvider>
    </ThemeProvider>
  )
}

function Connected({
  settings,
  onAddServer,
}: {
  settings: ServerSettings
  onAddServer: () => void
}) {
  // One cache per connection: `Connected` is keyed by settings.id, so a new
  // server starts cold here, and keys.ts scopes every entry by server anyway.
  const [queryClient] = React.useState(() => makeQueryClient())
  const [persistOptions] = React.useState(() => persistOptionsFor(settings))

  /* The provider has to sit ABOVE anything that reads the cache, and
     `useActions` does (it holds a `useQueryClient` for the callback-time reads
     described in lib/actions) — so the shell below it is a component of its
     own rather than the rest of this one's body.

     The *persisting* provider: the cache is written to localStorage and read
     back on the next load, so a reload paints the app it had instead of a
     screen of skeletons while the same requests run again (lib/queries/persist
     for what is kept and for how long). Children render straight away; what
     the restore holds is the *fetching* — every query stays parked until the
     dump has been read, so a request is never fired for something the cache
     was about to answer. The read itself is synchronous localStorage, resolved
     in this provider's own mount effect, so the parked window is a tick. */
  return (
    <ServerProvider settings={settings}>
      <PersistQueryClientProvider client={queryClient} persistOptions={persistOptions}>
        <ConnectedShell settings={settings} onAddServer={onAddServer} />
      </PersistQueryClientProvider>
    </ServerProvider>
  )
}

function ConnectedShell({
  settings,
  onAddServer,
}: {
  settings: ServerSettings
  onAddServer: () => void
}) {
  const actions = useActions(settings)
  const booted = React.useRef(false)
  const [loaded, setLoaded] = React.useState(false)

  React.useEffect(() => {
    if (booted.current) return
    booted.current = true
    // The route decides which thread opens (see lib/router) — bootstrap only loads data.
    actions
      .bootstrap()
      .then(() => setupPush(settings))
      .catch((err) => reportError(err, "Couldn't load anything from the server"))
      .finally(() => {
        setLoaded(true)
        // The enable-notifications offer is now a persistent toast, not a header
        // row — show it once the page is up and the Toaster can render it.
        refreshNotificationOffer()
      })
  }, [actions, settings])

  return (
    <>
      <PruneAgentOptions />
      <AppShell loading={!loaded} settings={settings} actions={actions} onAddServer={onAddServer} />
    </>
  )
}

/** A deleted profile's remembered option set is dead weight, and its id will
    never be asked for again. It hangs off the profile list rather than off a
    refresh call, because the list is a query now and its refetches are the
    cache's own (stale, focus) — there is no single place a re-read happens. */
function PruneAgentOptions() {
  const profiles = useProfiles()
  React.useEffect(() => {
    if (profiles.length > 0) pruneAgentOptions(profiles.map((profile) => profile.id))
  }, [profiles])
  return null
}

export default App
