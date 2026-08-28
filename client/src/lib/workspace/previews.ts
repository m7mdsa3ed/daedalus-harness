/* Saved preview URLs. The server is the store (they belong to the project, not
   to a device), and the server is also the validator — but the same check runs
   here so a bad address is refused before a round trip, and so the URL bar can
   accept the `localhost:5173` people actually type. */
import { api, loadSettings, ApiError, type ServerSettings } from "@/lib/settings"

export interface Preview {
  id: string
  projectId: string
  label: string
  url: string
  createdAt: number
}

function server(): ServerSettings {
  const settings = loadSettings()
  if (!settings) throw new ApiError({ status: 0, path: "/api", serverMessage: "not connected" })
  return settings
}

/**
 * A typed address → a URL this panel will open, or a throw.
 *
 * http and https only. A `javascript:` or `data:` URL in an iframe runs with
 * the framing document's privileges in some browsers, which for a saved
 * "preview" would be stored XSS with the app's own origin behind it. Nothing
 * legitimate is lost: a preview is a web page.
 */
export function normalizeUrl(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) throw new Error("Enter an address")

  /* Same three-way test as the server's `normalizePreviewUrl`, and for the same
     reason: "contains a colon" reads `localhost:5173` — what people actually
     type — as the scheme `localhost:`. A `scheme://` is parsed as given; a
     bare `scheme:` not followed by a digit is a real non-http scheme and is
     refused by name; anything else is a host with a port. */
  const hasAuthority = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)
  const schemeOnly = /^[a-zA-Z][a-zA-Z0-9+.-]*:(?!\d)/.test(trimmed)
  if (!hasAuthority && schemeOnly)
    throw new Error("A preview has to be an http or https address")

  let url: URL
  try {
    url = new URL(hasAuthority ? trimmed : `http://${trimmed}`)
  } catch {
    throw new Error(`"${raw}" is not a valid address`)
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("A preview has to be an http or https address")
  return url.toString()
}

const base = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/previews`

export const listPreviews = (projectId: string): Promise<Preview[]> =>
  api<Preview[]>(server(), base(projectId))

export const createPreview = (projectId: string, label: string, url: string): Promise<Preview> =>
  api<Preview>(server(), base(projectId), {
    method: "POST",
    body: JSON.stringify({ label, url }),
  })

export const deletePreview = (projectId: string, previewId: string): Promise<{ ok: true }> =>
  api<{ ok: true }>(server(), `${base(projectId)}/${encodeURIComponent(previewId)}`, {
    method: "DELETE",
  })
