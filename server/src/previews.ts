/* Saved preview URLs for a project.
 *
 * The URL is validated on the way in, not on the way out. A preview panel puts
 * whatever is stored here into an iframe, so a stored `javascript:` or `data:`
 * URL would be a stored XSS with the app's own origin behind it — the check
 * belongs at the point where the value stops being someone's typing and starts
 * being data. http and https only, and nothing else is a preview anyway.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import { db, projectPreviews } from "./db/index.js";
import { WorkspaceError } from "./workspace-fs.js";
import { getProject } from "./projects.js";

export interface Preview {
  id: string;
  projectId: string;
  label: string;
  url: string;
  createdAt: number;
}

const fail = (status: 400 | 404 | 409, message: string) => new WorkspaceError(message, status);

/** The one place a preview URL is judged. Returns the normalized form. */
export function normalizePreviewUrl(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) throw fail(400, "a preview needs a URL");
  const text = raw.trim();

  /* Deciding whether the input already names a scheme is the whole trick, and
     "does it contain a colon" gets it wrong: `localhost:5173` — which is what
     people actually type — parses as the scheme `localhost:`. So:
       - `scheme://…`  is a real scheme, parse it and judge the protocol.
       - `scheme:` NOT followed by a digit is also a real scheme, and since it
         is not http(s) with an authority it is rejected by name — this is the
         `javascript:` / `data:` / `mailto:` case.
       - anything else is a host, possibly with a port, so assume http. */
  const hasAuthority = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(text);
  const schemeOnly = /^[a-zA-Z][a-zA-Z0-9+.-]*:(?!\d)/.test(text);
  if (!hasAuthority && schemeOnly) throw fail(400, "a preview must be http or https");

  let url: URL;
  try {
    url = new URL(hasAuthority ? text : `http://${text}`);
  } catch {
    throw fail(400, "that is not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw fail(400, "a preview must be http or https");
  return url.toString();
}

export function listPreviews(projectId: string): Preview[] {
  if (!getProject(projectId)) throw fail(404, "unknown project");
  return db
    .select()
    .from(projectPreviews)
    .where(eq(projectPreviews.projectId, projectId))
    .all()
    .sort((a, b) => a.createdAt - b.createdAt);
}

export function createPreview(projectId: string, label: unknown, url: unknown): Preview {
  if (!getProject(projectId)) throw fail(404, "unknown project");
  const normalized = normalizePreviewUrl(url);
  const row: Preview = {
    id: randomUUID(),
    projectId,
    label: typeof label === "string" && label.trim() ? label.trim() : new URL(normalized).host,
    url: normalized,
    createdAt: Date.now(),
  };
  db.insert(projectPreviews).values(row).run();
  return row;
}

export function deletePreview(id: string): boolean {
  return db.delete(projectPreviews).where(eq(projectPreviews.id, id)).run().changes > 0;
}
