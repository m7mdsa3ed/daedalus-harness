/* ── The browser panel's availability ──
   Whether this server can run the project browser at all (`GET
   /api/browser/status`). The server measures it by launching Chrome, so the
   answer is a reading about the machine, not a setting: cached for a while and
   never asked of a server that does not advertise the panel. */
import { browserPaths, type BrowserStatusResponse } from "@daedalus/browser-protocol"

import { useServer } from "@/lib/server-context"
import type { ServerSettings } from "@/lib/settings"
import { useApiQuery } from "./helpers"
import { scope } from "./keys"
import { useFeature } from "./surfaces"

export const browserStatusKey = (s: ServerSettings) => scope(s).concat(["browser-status"])

export function useBrowserStatus() {
  const enabled = useFeature("browserPanel")
  const query = useApiQuery<BrowserStatusResponse>(browserStatusKey(useServer()), browserPaths.status, {
    enabled,
    staleTime: 5 * 60_000,
  })
  return { enabled, ...query }
}

/** Whether to offer a browser panel: the server speaks it *and* found a Chrome. */
export function useBrowserAvailable(): boolean {
  const { enabled, data } = useBrowserStatus()
  return enabled && data?.available === true
}
