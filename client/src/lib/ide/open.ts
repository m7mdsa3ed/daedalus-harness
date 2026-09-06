/* ── Requests into the IDE ──
   A file chip in a transcript, a "compare with HEAD" button, a turn's "N files
   changed" all resolve to one of these.

   **Nothing in this file loads Monaco**, and that is the whole reason it is a
   file of its own. It is imported by the transcript, which every reader loads;
   the editor is a couple of megabytes reached only by opening the IDE panel. A
   request is therefore plain data written into the tab store
   (`lib/ide/editors.ts`), which is also free of Monaco — the panel reads the
   store when it mounts and the editor component pulls the library in then.

   There is no queue and no performer any more: the store is plain data rather
   than a running editor that may still be loading, so a request made before the
   panel exists is simply a tab already open when it appears.

   The panel is opened by the caller: the IDE cannot open itself. */
import { openTab } from "./editors"

export type IdeRequest =
  | { kind: "file"; projectId: string; path: string; line?: number; endLine?: number }
  | { kind: "diff"; projectId: string; path: string }
  | { kind: "changes"; projectId: string; sessionId: string; scope: string }

export function requestIde(request: IdeRequest): void {
  switch (request.kind) {
    case "file":
      openTab(
        request.projectId,
        { kind: "file", path: request.path },
        request.line
          ? {
              reveal: {
                line: request.line,
                /* A one-line "span" is a point: tinting the line the caret is
                   already on says nothing the active-line highlight does not. */
                ...(request.endLine && request.endLine > request.line
                  ? { endLine: request.endLine }
                  : {}),
              },
            }
          : {}
      )
      return
    case "diff":
      openTab(request.projectId, { kind: "diff", path: request.path, comparison: "head" })
      return
    case "changes":
      openTab(request.projectId, {
        kind: "changes",
        sessionId: request.sessionId,
        scope: request.scope,
      })
      return
  }
}
