import * as React from "react"
import { toast } from "sonner"
import { AppShell } from "@/components/app-shell"
import { ConfirmProvider } from "@/components/confirm-dialog"
import { ConnectScreen } from "@/components/connect-screen"
import { Toaster } from "@/components/ui/sonner"
import { useActions } from "@/lib/actions"
import { setupPush } from "@/lib/push"
import { loadSettings, type ServerSettings } from "@/lib/settings"
import { initialState, reducer, StoreContext } from "@/lib/store"
import { ThemeProvider } from "@/lib/theme"

function App() {
  const [settings, setSettings] = React.useState<ServerSettings | null>(loadSettings)
  const [state, dispatch] = React.useReducer(reducer, initialState)

  return (
    <ThemeProvider>
      <ConfirmProvider>
        <StoreContext.Provider value={{ state, dispatch }}>
          {settings ? <Connected settings={settings} /> : <ConnectScreen onConnected={setSettings} />}
          <Toaster position="top-center" />
        </StoreContext.Provider>
      </ConfirmProvider>
    </ThemeProvider>
  )
}

function Connected({ settings }: { settings: ServerSettings }) {
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
      .catch((err) => toast.error(String(err)))
      .finally(() => setLoaded(true))
  }, [actions, settings])

  return <AppShell loading={!loaded} settings={settings} actions={actions} />
}

export default App
