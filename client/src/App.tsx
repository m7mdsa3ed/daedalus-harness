import * as React from "react"
import { AppShell } from "@/components/app-shell"
import { ConfirmProvider } from "@/components/confirm-dialog"
import { ConnectScreen } from "@/components/connect-screen"
import { Toaster } from "@/components/ui/sonner"
import { useActions } from "@/lib/actions"
import { setupPush } from "@/lib/push"
import { loadSettings, type ServerSettings } from "@/lib/settings"
import { initialState, reducer, StoreContext } from "@/lib/store"
import { ThemeProvider } from "@/lib/theme"
import { reportError } from "@/lib/errors"

function App() {
  const [settings, setSettings] = React.useState<ServerSettings | null>(loadSettings)
  // "Add server" reuses the connect screen over the shell; connecting activates
  // the new server, and the reload below is what re-bootstraps against it.
  const [adding, setAdding] = React.useState(false)
  const [state, dispatch] = React.useReducer(reducer, initialState)

  return (
    <ThemeProvider>
      <ConfirmProvider>
        <StoreContext.Provider value={{ state, dispatch }}>
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
          <Toaster position="top-center" />
        </StoreContext.Provider>
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
      .finally(() => setLoaded(true))
  }, [actions, settings])

  return (
    <AppShell loading={!loaded} settings={settings} actions={actions} onAddServer={onAddServer} />
  )
}

export default App
