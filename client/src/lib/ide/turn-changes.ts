/* ── A turn's changes, in the workbench ──
   What a turn did is git's answer (server `turn-changes.ts`: two trees per
   turn), and the multi-diff editor is VS Code's way of showing a list of
   them. The before side of every file is read whole from the turn's start
   tree through `GET /api/sessions/:id/changes/file`; the after side is the
   end tree when the turn has ended, and the working file itself while it is
   still running or for `uncommitted` — live, and editable in place. */
import type * as vscode from "vscode"
import type { Project } from "@/lib/settings"

import { api as call, loadSettings } from "@/lib/settings"
import { changedFiles, sessionChanges } from "@/lib/workspace/git-api"

import { TURN_SCHEME } from "./extension"
import { absolutePath } from "./projects"

interface TurnQuery {
  sessionId: string
  scope: string
  side: "before" | "after"
  path: string
}

export function registerTurnContent(api: typeof vscode): vscode.Disposable {
  return api.workspace.registerTextDocumentContentProvider(TURN_SCHEME, {
    async provideTextDocumentContent(uri) {
      const settings = loadSettings()
      if (!settings) return ""
      const query = JSON.parse(uri.query) as TurnQuery
      const search = new URLSearchParams({ scope: query.scope, path: query.path, side: query.side })
      const result = await call<{ content: string; missing: boolean }>(
        settings,
        `/api/sessions/${encodeURIComponent(query.sessionId)}/changes/file?${search}`
      )
      return result.content
    },
  })
}

export async function showTurnChanges(
  api: typeof vscode,
  project: Project,
  sessionId: string,
  scope: string
): Promise<void> {
  const settings = loadSettings()
  if (!settings) return
  const [{ files, unavailable }, { turns }] = await Promise.all([
    changedFiles(settings, sessionId, scope),
    sessionChanges(settings, sessionId),
  ])
  if (unavailable) {
    void api.window.showWarningMessage(unavailable)
    return
  }
  const turnId = scope.startsWith("turn:") ? scope.slice(5) : null
  const turn = turnId ? turns.find((entry) => entry.turnId === turnId) : undefined
  const ended = !!turn?.ended
  const turnUri = (path: string, side: "before" | "after") =>
    api.Uri.from({
      scheme: TURN_SCHEME,
      path: absolutePath(project.cwd, path),
      query: JSON.stringify({ sessionId, scope, side, path } satisfies TurnQuery),
    })

  const resources = files.map((file) => {
    const absolute = absolutePath(project.cwd, file.path)
    const before = file.status === "added" ? undefined : turnUri(file.from ?? file.path, "before")
    const after =
      file.status === "deleted"
        ? undefined
        : ended
          ? turnUri(file.path, "after")
          : api.Uri.file(absolute)
    return [api.Uri.file(absolute), before, after] as [vscode.Uri, vscode.Uri | undefined, vscode.Uri | undefined]
  })
  const title = turnId
    ? `Turn changes (${files.length} ${files.length === 1 ? "file" : "files"})`
    : `Uncommitted changes (${files.length} ${files.length === 1 ? "file" : "files"})`
  if (resources.length === 0) {
    void api.window.showInformationMessage(turnId ? "This turn changed nothing." : "Nothing is uncommitted.")
    return
  }
  await api.commands.executeCommand("vscode.changes", title, resources)
}
