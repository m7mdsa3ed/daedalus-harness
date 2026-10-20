/* The one door to "get a newer build of this app", whichever shell it runs
   in — what the compatibility gate's Update button calls when a server needs
   a newer client. The PWA asks its service worker; the desktop shell asks
   electron-updater over the preload bridge; anything else can only reload. */
import { checkDesktopUpdate, hasDesktopUpdater, installDesktopUpdate } from "@/lib/desktop"
import { checkForPwaUpdate, hasPwaWorker } from "@/lib/pwa"

export type ClientUpdateVia = "pwa" | "desktop" | "reload"

/** Which mechanism `requestClientUpdate` will use on this device. */
export function clientUpdateVia(): ClientUpdateVia {
  if (hasDesktopUpdater()) return "desktop"
  if (hasPwaWorker()) return "pwa"
  return "reload"
}

/** Fetch and apply a newer build now. Resolves once the update is applied or
    handed to the shell; rejects with a reason a surface can show. */
export async function requestClientUpdate(): Promise<void> {
  switch (clientUpdateVia()) {
    case "desktop": {
      const { available } = await checkDesktopUpdate()
      if (!available) throw new Error("This is the newest desktop build; the server needs a newer one than has been published.")
      await installDesktopUpdate()
      return
    }
    case "pwa":
      if (!(await checkForPwaUpdate())) throw new Error("No newer app build is published yet. The server was updated before the app.")
      return
    case "reload":
      window.location.reload()
  }
}
