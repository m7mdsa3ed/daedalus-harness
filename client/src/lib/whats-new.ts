import { createLocalStore } from "./local-store"

/* ── What's new ──
   Which release's changelog this device last read. The server's version
   (GET /api/meta) is the authority for what "current" is; this stores only
   the string seen, device-locally — the deployment is shared by every
   connected client, and "you haven't read this release yet" is one device's
   opinion about itself. */

const store = createLocalStore<string | null>(
  "ui.whatsNewSeenRelease",
  (raw) => (typeof raw === "string" && raw ? raw : null),
  null,
)

/** The release whose changelog was last opened on this device, live. */
export const useSeenRelease = store.use

export function markReleaseSeen(version: string): void {
  store.set(version)
}

/** True while the deployment's release is not the one last read here. */
export function releaseUnseen(current: string | null | undefined, seen: string | null): boolean {
  return !!current && current !== seen
}
