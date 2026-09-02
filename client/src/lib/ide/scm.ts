/* ── Source control, over the project's git routes ──
   The SCM view is VS Code's; what fills it is `GET …/git/status` shaped into
   resource groups, and every button is one of the write routes the review
   panel used to call (`gitWrite`). Nothing here runs git: the server owns the
   worktree, and this is a view of one repository — the project's — the way
   the status route already scopes it.

   The gutter's quick diff and every "open diff" read HEAD through the
   `daedalus-git` content scheme, which is `gitFileAt` with the absolute path
   carried in the URI so a tab is titled by the file, not by a query string.

   Refresh happens on the project watch stream (debounced — a checkout touches
   hundreds of files), after every write here, and when the window regains
   focus. Never on a timer. */
import type * as vscode from "vscode"

import { describeError } from "@/lib/errors"
import { loadSettings } from "@/lib/settings"
import { gitFileAt, gitStatus, gitWrite, type GitFileState, type GitStatus } from "@/lib/workspace/git-api"
import { watchProject } from "@/lib/workspace/watch"

import { COMMANDS, GIT_SCHEME, SCM_ID } from "./extension"
import { gitUri } from "./perform"
import { absolutePath, ideProject, locate } from "./projects"

interface Repo {
  projectId: string
  cwd: string
  control: vscode.SourceControl
  staged: vscode.SourceControlResourceGroup
  changes: vscode.SourceControlResourceGroup
  merge: vscode.SourceControlResourceGroup
  stopWatch: () => void
  status: GitStatus | null
  refreshing: Promise<void> | null
  again: boolean
}

let repo: Repo | null = null
let installed = false

/** Called once by boot; the source control follows the workspace folder. */
export function installScm(api: typeof vscode): void {
  if (installed) return
  installed = true

  api.workspace.registerTextDocumentContentProvider(GIT_SCHEME, {
    async provideTextDocumentContent(uri) {
      const query = JSON.parse(uri.query) as { projectId: string; comparison: "head" | "staged" }
      const found = locate(uri.path)
      if (!found) return ""
      const result = await gitFileAt(query.projectId, found.relative, query.comparison)
      return result.missing ? "" : result.content
    },
  })

  const withPaths = (args: unknown[]): string[] => {
    const states = args.filter(
      (arg): arg is vscode.SourceControlResourceState =>
        !!arg && typeof arg === "object" && "resourceUri" in arg
    )
    return states
      .map((state) => locate(state.resourceUri.path)?.relative)
      .filter((path): path is string => !!path)
  }

  api.commands.registerCommand(COMMANDS.refresh, () => refresh(api))
  api.commands.registerCommand(COMMANDS.open, async (...args: unknown[]) => {
    const state = args.find(
      (arg): arg is vscode.SourceControlResourceState =>
        !!arg && typeof arg === "object" && "resourceUri" in arg
    )
    if (state) await api.window.showTextDocument(state.resourceUri, { preview: false })
  })
  api.commands.registerCommand(COMMANDS.stage, (...args: unknown[]) =>
    write(api, { action: "stage", paths: withPaths(args) })
  )
  api.commands.registerCommand(COMMANDS.unstage, (...args: unknown[]) =>
    write(api, { action: "unstage", paths: withPaths(args) })
  )
  api.commands.registerCommand(COMMANDS.stageAll, () => {
    const status = repo?.status
    if (!status) return
    const paths = [...status.unstaged, ...status.untracked, ...status.conflicted].map((f) => f.path)
    return write(api, { action: "stage", paths })
  })
  api.commands.registerCommand(COMMANDS.unstageAll, () => {
    const status = repo?.status
    if (!status) return
    return write(api, { action: "unstage", paths: status.staged.map((f) => f.path) })
  })
  api.commands.registerCommand(COMMANDS.discard, async (...args: unknown[]) => {
    const paths = withPaths(args)
    if (paths.length === 0) return
    const what = paths.length === 1 ? paths[0] : `${paths.length} files`
    const answer = await api.window.showWarningMessage(
      `Discard changes in ${what}? This cannot be undone.`,
      { modal: true },
      "Discard"
    )
    if (answer !== "Discard") return
    await write(api, { action: "discard", paths })
  })
  api.commands.registerCommand(COMMANDS.commit, () => commit(api))

  api.window.onDidChangeWindowState((state) => {
    if (state.focused) void refresh(api)
  })
  api.workspace.onDidChangeWorkspaceFolders(() => syncFolder(api))
  syncFolder(api)
}

/** Point the source control at the current workspace folder's project. */
function syncFolder(api: typeof vscode): void {
  const folder = api.workspace.workspaceFolders?.[0]
  const found = folder ? locate(folder.uri.path) : null
  const projectId = found?.project.id ?? null
  if (repo?.projectId === projectId) return
  if (repo) {
    repo.stopWatch()
    repo.control.dispose()
    repo = null
  }
  if (!found || !folder) return

  const control = api.scm.createSourceControl(SCM_ID, "Git", folder.uri)
  control.inputBox.placeholder = "Message (⌘Enter to commit)"
  control.acceptInputCommand = { command: COMMANDS.commit, title: "Commit" }
  control.quickDiffProvider = {
    provideOriginalResource: (uri) =>
      uri.scheme === "file" && locate(uri.path)?.project.id === found.project.id
        ? gitUri(api, found.project.id, uri.path, "head")
        : undefined,
  }
  const merge = control.createResourceGroup("merge", "Merge Changes")
  const staged = control.createResourceGroup("staged", "Staged Changes")
  const changes = control.createResourceGroup("changes", "Changes")
  merge.hideWhenEmpty = true
  staged.hideWhenEmpty = true

  let timer: ReturnType<typeof setTimeout> | null = null
  const stopWatch = watchProject(found.project.id, () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void refresh(api)
    }, 400)
  })

  repo = {
    projectId: found.project.id,
    cwd: found.project.cwd,
    control,
    staged,
    changes,
    merge,
    stopWatch: () => {
      if (timer) clearTimeout(timer)
      stopWatch()
    },
    status: null,
    refreshing: null,
    again: false,
  }
  void refresh(api)
}

/** One status read at a time; a request during one asks for one more after. */
function refresh(api: typeof vscode): Promise<void> {
  const current = repo
  if (!current) return Promise.resolve()
  if (current.refreshing) {
    current.again = true
    return current.refreshing
  }
  current.refreshing = (async () => {
    try {
      const settings = loadSettings()
      if (!settings) return
      const status = await gitStatus(settings, current.projectId)
      if (repo !== current) return
      current.status = status
      render(api, current, status)
    } catch (err) {
      if (repo !== current) return
      const { title } = describeError(err)
      current.control.count = 0
      current.control.inputBox.placeholder = title
    } finally {
      current.refreshing = null
      if (current.again) {
        current.again = false
        void refresh(api)
      }
    }
  })()
  return current.refreshing
}

function render(api: typeof vscode, current: Repo, status: GitStatus): void {
  if (!status.repository) {
    current.control.count = 0
    current.control.inputBox.placeholder = "Not a git repository"
    current.staged.resourceStates = []
    current.changes.resourceStates = []
    current.merge.resourceStates = []
    return
  }
  const branch = status.branch ?? (status.unborn ? "no commits yet" : "detached")
  current.control.inputBox.placeholder = `Message (⌘Enter to commit on ${branch})`
  current.control.statusBarCommands = [
    {
      command: COMMANDS.refresh,
      title: `$(git-branch) ${branch}${status.ahead ? ` ↑${status.ahead}` : ""}${status.behind ? ` ↓${status.behind}` : ""}`,
      tooltip: status.upstream ? `Tracking ${status.upstream}` : "Refresh",
    },
  ]
  const toState = (file: GitFileState, side: "index" | "worktree" | "untracked" | "conflict"): vscode.SourceControlResourceState => {
    const absolute = absolutePath(current.cwd, file.path)
    const uri = api.Uri.file(absolute)
    const code = side === "index" ? file.index : side === "worktree" ? file.worktree : side === "untracked" ? "?" : "U"
    const deleted = code === "D"
    const added = code === "A" || code === "?"
    const name = file.path.split("/").pop() ?? file.path
    const command: vscode.Command = deleted
      ? { command: "vscode.open", title: "Open", arguments: [gitUri(api, current.projectId, absolute, "head")] }
      : added
        ? { command: "vscode.open", title: "Open", arguments: [uri] }
        : {
            command: "vscode.diff",
            title: "Open Changes",
            arguments: [
              gitUri(api, current.projectId, absolute, side === "worktree" ? "staged" : "head"),
              uri,
              `${name} (${side === "index" ? "HEAD ↔ Index" : "Index ↔ Working Tree"})`,
            ],
          }
    const label =
      code === "?" ? "Untracked" : code === "A" ? "Added" : code === "D" ? "Deleted" : code === "R" ? `Renamed from ${file.from ?? "?"}` : code === "U" ? "Conflict" : "Modified"
    return {
      resourceUri: uri,
      command,
      decorations: {
        strikeThrough: deleted,
        faded: code === "?",
        tooltip: label,
      },
    }
  }
  current.merge.resourceStates = status.conflicted.map((file) => toState(file, "conflict"))
  current.staged.resourceStates = status.staged.map((file) => toState(file, "index"))
  current.changes.resourceStates = [
    ...status.unstaged.map((file) => toState(file, "worktree")),
    ...status.untracked.map((file) => toState(file, "untracked")),
  ]
  current.control.count =
    status.staged.length + status.unstaged.length + status.untracked.length + status.conflicted.length
}

async function write(
  api: typeof vscode,
  action: Parameters<typeof gitWrite>[2]
): Promise<void> {
  const current = repo
  if (!current) return
  if ("paths" in action && action.paths.length === 0) return
  const settings = loadSettings()
  if (!settings) return
  try {
    const status = await gitWrite(settings, current.projectId, action)
    if (repo !== current) return
    current.status = status
    render(api, current, status)
  } catch (err) {
    const { title, detail } = describeError(err)
    void api.window.showErrorMessage(detail ? `${title}: ${detail}` : title)
    void refresh(api)
  }
}

async function commit(api: typeof vscode): Promise<void> {
  const current = repo
  if (!current?.status?.repository) return
  const message = current.control.inputBox.value.trim()
  if (!message) {
    void api.window.showErrorMessage("A commit needs a message.")
    return
  }
  if (current.status.staged.length === 0) {
    const pending = current.status.unstaged.length + current.status.untracked.length
    if (pending === 0) {
      void api.window.showInformationMessage("There are no changes to commit.")
      return
    }
    const answer = await api.window.showWarningMessage(
      `Nothing is staged. Stage all ${pending} ${pending === 1 ? "change" : "changes"} and commit?`,
      { modal: true },
      "Stage all and commit"
    )
    if (!answer) return
    await write(api, {
      action: "stage",
      paths: [...current.status.unstaged, ...current.status.untracked].map((f) => f.path),
    })
    if (repo !== current) return
  }
  const settings = loadSettings()
  if (!settings) return
  try {
    const result = await gitWrite(settings, current.projectId, { action: "commit", message })
    if (repo !== current) return
    current.control.inputBox.value = ""
    current.status = result
    render(api, current, result)
    const first = result.output?.split("\n").find((line) => line.trim())
    if (first) void api.window.setStatusBarMessage(`$(check) ${first.trim()}`, 5000)
  } catch (err) {
    const { title, detail } = describeError(err)
    void api.window.showErrorMessage(detail ? `${title}: ${detail}` : title)
    void refresh(api)
  }
}
