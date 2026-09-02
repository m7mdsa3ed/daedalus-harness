/* ── The harness's own extension ──
   Everything the harness does *inside* the workbench — the git source
   control, the turn-changes reader, "open this file at line 42" — is done
   through the extension API, the way an extension would, because that is the
   surface VS Code keeps stable. One extension, registered in-process
   (`LocalProcess`: no worker, same heap, so it can call the harness's fetch
   wrappers directly), and `getVscode()` is its API handle. Commands and
   menus are declared in the manifest, so the SCM view draws its inline
   buttons; the handlers are attached in `scm.ts`. */
import { ExtensionHostKind, registerExtension } from "@codingame/monaco-vscode-api/extensions"
import type * as vscode from "vscode"

export const GIT_SCHEME = "daedalus-git"
export const TURN_SCHEME = "daedalus-turn"
export const SCM_ID = "daedalus-git"

export const COMMANDS = {
  refresh: "daedalus.git.refresh",
  stage: "daedalus.git.stage",
  stageAll: "daedalus.git.stageAll",
  unstage: "daedalus.git.unstage",
  unstageAll: "daedalus.git.unstageAll",
  discard: "daedalus.git.discard",
  commit: "daedalus.git.commit",
  open: "daedalus.git.openFile",
} as const

const scmWhen = `scmProvider == ${SCM_ID}`

const { getApi } = registerExtension(
  {
    name: "daedalus",
    publisher: "daedalus",
    version: "1.0.0",
    engines: { vscode: "*" },
    contributes: {
      commands: [
        { command: COMMANDS.refresh, title: "Refresh", icon: "$(refresh)", category: "Git" },
        { command: COMMANDS.stage, title: "Stage Changes", icon: "$(add)", category: "Git" },
        { command: COMMANDS.stageAll, title: "Stage All Changes", icon: "$(add)", category: "Git" },
        { command: COMMANDS.unstage, title: "Unstage Changes", icon: "$(remove)", category: "Git" },
        { command: COMMANDS.unstageAll, title: "Unstage All Changes", icon: "$(remove)", category: "Git" },
        { command: COMMANDS.discard, title: "Discard Changes", icon: "$(discard)", category: "Git" },
        { command: COMMANDS.commit, title: "Commit", icon: "$(check)", category: "Git" },
        { command: COMMANDS.open, title: "Open File", icon: "$(go-to-file)", category: "Git" },
      ],
      menus: {
        "scm/title": [
          { command: COMMANDS.commit, when: scmWhen, group: "navigation@1" },
          { command: COMMANDS.refresh, when: scmWhen, group: "navigation@2" },
        ],
        "scm/resourceGroup/context": [
          { command: COMMANDS.stageAll, when: `${scmWhen} && scmResourceGroup == changes`, group: "inline" },
          { command: COMMANDS.unstageAll, when: `${scmWhen} && scmResourceGroup == staged`, group: "inline" },
        ],
        "scm/resourceState/context": [
          { command: COMMANDS.open, when: scmWhen, group: "inline@1" },
          { command: COMMANDS.discard, when: `${scmWhen} && scmResourceGroup == changes`, group: "inline@2" },
          { command: COMMANDS.stage, when: `${scmWhen} && scmResourceGroup == changes`, group: "inline@3" },
          { command: COMMANDS.unstage, when: `${scmWhen} && scmResourceGroup == staged`, group: "inline@3" },
        ],
      },
    },
  },
  ExtensionHostKind.LocalProcess
)

let api: Promise<typeof vscode> | null = null

export function getVscode(): Promise<typeof vscode> {
  api ??= getApi()
  return api
}
