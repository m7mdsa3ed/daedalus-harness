/* ── Carrying out a request, inside the workbench ──
   The other half of `lib/ide/open.ts`: this one names the extension API, so
   it is only ever reached from `boot.ts` — that is, from the IDE panel's
   dynamic import. A failure is a toast, because the request came from a
   surface outside the workbench and that surface has already moved on. */
import type * as vscode from "vscode"

import { describeError } from "@/lib/errors"
import { toast } from "@/lib/toast"

import { GIT_SCHEME } from "./extension"
import type { IdeRequest } from "./open"
import { absolutePath, ideProject } from "./projects"
import { showTurnChanges } from "./turn-changes"

/** HEAD's or the index's copy of a file, as a URI the content provider in
    `scm.ts` answers. The path is the real one, so a diff tab is titled by the
    file rather than by a query string. */
export function gitUri(
  api: typeof vscode,
  projectId: string,
  absolute: string,
  comparison: "head" | "staged"
): vscode.Uri {
  return api.Uri.from({
    scheme: GIT_SCHEME,
    path: absolute,
    query: JSON.stringify({ projectId, comparison }),
  })
}

export function performer(api: typeof vscode) {
  return async (request: IdeRequest): Promise<void> => {
    try {
      await perform(api, request)
    } catch (err) {
      const { title, detail } = describeError(err)
      toast.error(title, { description: detail })
    }
  }
}

async function perform(api: typeof vscode, request: IdeRequest): Promise<void> {
  const project = ideProject(request.projectId)
  if (!project) return
  switch (request.kind) {
    case "file": {
      const uri = api.Uri.file(absolutePath(project.cwd, request.path))
      const line = request.line ? request.line - 1 : undefined
      const selection =
        line === undefined
          ? undefined
          : request.endLine && request.line && request.endLine > request.line
            ? new api.Range(line, 0, request.endLine, 0)
            : new api.Range(line, 0, line, 0)
      await api.window.showTextDocument(uri, { preview: false, selection })
      return
    }
    case "diff": {
      const absolute = absolutePath(project.cwd, request.path)
      const name = request.path.split("/").pop() ?? request.path
      await api.commands.executeCommand(
        "vscode.diff",
        gitUri(api, project.id, absolute, "head"),
        api.Uri.file(absolute),
        `${name} (HEAD \u2194 Working Tree)`
      )
      return
    }
    case "changes":
      await showTurnChanges(api, project, request.sessionId, request.scope)
      return
  }
}
