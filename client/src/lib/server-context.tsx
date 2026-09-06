/* The active server connection, as context.

   Today the settings pages receive `settings` through the outlet and everyone
   else reaches for `loadSettings()` — a module-level read that works only
   because there happens to be one active connection. Providing it here gives
   every query hook and every api() call site the same answer through one
   door, and a component under `Connected` can never ask for a server that is
   not connected. */
import * as React from "react"

import type { ServerSettings } from "@/lib/settings"

const ServerContext = React.createContext<ServerSettings | null>(null)

export function ServerProvider({
  settings,
  children,
}: {
  settings: ServerSettings
  children: React.ReactNode
}) {
  return <ServerContext.Provider value={settings}>{children}</ServerContext.Provider>
}

/** The active connection. Throws outside the provider — under `Connected`
    that is a wiring bug, not a state the UI should render. */
export function useServer(): ServerSettings {
  const settings = React.useContext(ServerContext)
  if (!settings) throw new Error("useServer outside <ServerProvider>")
  return settings
}
