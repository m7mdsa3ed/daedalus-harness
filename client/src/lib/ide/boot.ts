/* ── Booting the workbench ──
   VS Code's services are global and initialize exactly once per page — the
   library guards it (`checkServicesNotInitialized`), and there is no second
   workbench to open in a second panel. So this module is the whole lifetime
   of the IDE: `startIde(container)` initializes on the first call and, on
   every call after it, moves the already-built workbench DOM into the
   container that asked. A panel that unmounts (a closed tab, a dock relayout)
   parks it in a detached holder rather than tearing it down; reopening the
   panel is a re-attach, so the editor group, the dirty buffers and the
   explorer's scroll position survive.

   The workspace is one project folder, which is what the file system provider
   addresses; `openIdeProject` switches it through the configuration service's
   `reinitializeWorkspace`, so opening a file from another project moves the
   workbench there rather than opening a second one.

   Which service overrides are here is the whole feature list: files, the
   explorer, search, SCM, the diff editors, plus the workbench itself. Adding
   a view means adding its override — nothing else turns one on. */
import { initialize as initializeServices, IWorkbenchThemeService, getService } from "@codingame/monaco-vscode-api"
import type { IWorkbenchConstructionOptions } from "@codingame/monaco-vscode-api"
import getConfigurationServiceOverride, {
  initUserConfiguration,
  reinitializeWorkspace,
} from "@codingame/monaco-vscode-configuration-service-override"
import getDialogsServiceOverride from "@codingame/monaco-vscode-dialogs-service-override"
import getExplorerServiceOverride from "@codingame/monaco-vscode-explorer-service-override"
import getFilesServiceOverride, {
  registerFileSystemOverlay,
} from "@codingame/monaco-vscode-files-service-override"
import getKeybindingsServiceOverride from "@codingame/monaco-vscode-keybindings-service-override"
import getLanguagesServiceOverride from "@codingame/monaco-vscode-languages-service-override"
import getLifecycleServiceOverride from "@codingame/monaco-vscode-lifecycle-service-override"
import getModelServiceOverride from "@codingame/monaco-vscode-model-service-override"
import getMultiDiffEditorServiceOverride from "@codingame/monaco-vscode-multi-diff-editor-service-override"
import getNotificationsServiceOverride from "@codingame/monaco-vscode-notifications-service-override"
import getQuickAccessServiceOverride from "@codingame/monaco-vscode-quickaccess-service-override"
import getScmServiceOverride from "@codingame/monaco-vscode-scm-service-override"
import getSearchServiceOverride from "@codingame/monaco-vscode-search-service-override"
import getStatusBarServiceOverride from "@codingame/monaco-vscode-view-status-bar-service-override"
import getStorageServiceOverride from "@codingame/monaco-vscode-storage-service-override"
import getTextmateServiceOverride from "@codingame/monaco-vscode-textmate-service-override"
import getThemeServiceOverride from "@codingame/monaco-vscode-theme-service-override"
import getWorkbenchServiceOverride from "@codingame/monaco-vscode-workbench-service-override"
import getWorkingCopyServiceOverride from "@codingame/monaco-vscode-working-copy-service-override"
import * as monaco from "monaco-editor"

/* The extension host, in this page's own heap: the harness's extension calls
   the app's fetch wrappers directly, which a worker host could not do. */
import "vscode/localExtensionHost"

/* Themes and grammars are extensions, and these are the ones that ship. A
   language not listed here still opens — it is coloured as plain text. */
import "@codingame/monaco-vscode-theme-defaults-default-extension"
import "@codingame/monaco-vscode-typescript-basics-default-extension"
import "@codingame/monaco-vscode-javascript-default-extension"
import "@codingame/monaco-vscode-json-default-extension"
import "@codingame/monaco-vscode-css-default-extension"
import "@codingame/monaco-vscode-scss-default-extension"
import "@codingame/monaco-vscode-html-default-extension"
import "@codingame/monaco-vscode-markdown-basics-default-extension"
import "@codingame/monaco-vscode-python-default-extension"
import "@codingame/monaco-vscode-go-default-extension"
import "@codingame/monaco-vscode-rust-default-extension"
import "@codingame/monaco-vscode-yaml-default-extension"
import "@codingame/monaco-vscode-shellscript-default-extension"
import "@codingame/monaco-vscode-sql-default-extension"
import "@codingame/monaco-vscode-xml-default-extension"
import "@codingame/monaco-vscode-cpp-default-extension"
import "@codingame/monaco-vscode-java-default-extension"
import "@codingame/monaco-vscode-csharp-default-extension"
import "@codingame/monaco-vscode-php-default-extension"
import "@codingame/monaco-vscode-ruby-default-extension"
import "@codingame/monaco-vscode-docker-default-extension"
import "@codingame/monaco-vscode-git-base-default-extension"

import type { Project } from "@/lib/settings"

import { getVscode } from "./extension"
import { HarnessFileSystemProvider } from "./fs-provider"
import { setIdePerformer } from "./open"
import { performer } from "./perform"
import { installScm } from "./scm"
import { registerTurnContent } from "./turn-changes"
import { installWorkers } from "./workers"

/** Where the workbench lives while no panel is showing it. Detached, never
    in the document, so nothing about it is laid out or painted. */
let holder: HTMLElement | null = null
let booted: Promise<void> | null = null
/** The project the workspace folder currently points at. */
let folder: string | null = null

const USER_CONFIGURATION = JSON.stringify(
  {
    "workbench.colorTheme": "Dark Modern",
    "workbench.iconTheme": "vs-minimal",
    "workbench.startupEditor": "none",
    "workbench.activityBar.location": "top",
    "workbench.statusBar.visible": true,
    "editor.fontSize": 13,
    "editor.minimap.enabled": false,
    "editor.renderWhitespace": "selection",
    "editor.guides.bracketPairs": "active",
    "files.autoSave": "off",
    /* The harness watches the project itself and the provider translates
       those events, so VS Code's own polling watcher has nothing to do. */
    "files.watcherExclude": { "**": true },
    "search.followSymlinks": false,
    "git.enabled": false,
    "telemetry.telemetryLevel": "off",
    "update.mode": "none",
  },
  null,
  2
)

function workbenchOptions(project: Project): IWorkbenchConstructionOptions {
  return {
    /* Trusted: the folder is a project the user already added to the harness,
       and an untrusted workspace disables the very features this panel is
       for. */
    enableWorkspaceTrust: false,
    workspaceProvider: {
      trusted: true,
      workspace: { folderUri: monaco.Uri.file(project.cwd) },
      async open() {
        return false
      },
    },
    productConfiguration: {
      nameShort: "Daedalus",
      nameLong: "Daedalus IDE",
    },
    configurationDefaults: {
      "window.title": "${activeEditorShort}${separator}${rootName}",
    },
  }
}

/**
 * Build the workbench once, then hand its element to whoever asks.
 *
 * Returns the element to mount; the caller appends it and, on unmount, calls
 * `parkIde()`. Everything after the first call is synchronous re-attachment,
 * so switching tabs does not re-run any of this.
 */
export function startIde(project: Project): { element: HTMLElement; ready: Promise<void> } {
  if (!holder) {
    holder = document.createElement("div")
    holder.className = "daedalus-ide h-full w-full"
  }
  const element = holder
  booted ??= boot(project, element)
  return { element, ready: booted }
}

async function boot(project: Project, container: HTMLElement): Promise<void> {
  installWorkers()
  await initUserConfiguration(USER_CONFIGURATION)

  registerFileSystemOverlay(1, new HarnessFileSystemProvider())
  folder = project.cwd

  await initializeServices(
    {
      ...getFilesServiceOverride(),
      ...getModelServiceOverride(),
      ...getConfigurationServiceOverride(),
      ...getKeybindingsServiceOverride(),
      ...getLanguagesServiceOverride(),
      ...getTextmateServiceOverride(),
      ...getThemeServiceOverride(),
      ...getNotificationsServiceOverride(),
      ...getDialogsServiceOverride(),
      ...getStorageServiceOverride(),
      ...getLifecycleServiceOverride(),
      ...getWorkingCopyServiceOverride(),
      ...getQuickAccessServiceOverride({
        isKeybindingConfigurationVisible: () => true,
        shouldUseGlobalPicker: () => false,
      }),
      ...getStatusBarServiceOverride(),
      ...getExplorerServiceOverride(),
      ...getSearchServiceOverride(),
      ...getScmServiceOverride(),
      ...getMultiDiffEditorServiceOverride(),
      ...getWorkbenchServiceOverride(),
    },
    container,
    workbenchOptions(project)
  )

  const api = await getVscode()
  registerTurnContent(api)
  installScm(api)
  /* Everything queued while this was booting runs now, in order. */
  setIdePerformer(performer(api))
}

/** Point the workspace at another project. A no-op for the one it is on. */
export async function openIdeProject(project: Project): Promise<void> {
  if (!booted || folder === project.cwd) return
  await booted
  folder = project.cwd
  await reinitializeWorkspace({ id: project.id, uri: monaco.Uri.file(project.cwd) })
}

/** Follow the app's light/dark. The workbench keeps its own colour theme —
    a VS Code theme is not the app's palette — but which of the two it is
    should never disagree with the window around it. */
export async function setIdeDark(dark: boolean): Promise<void> {
  if (!booted) return
  await booted
  const themes = await getService(IWorkbenchThemeService)
  const wanted = dark ? "Dark Modern" : "Light Modern"
  const available = await themes.getColorThemes()
  const theme = available.find((entry) => entry.label === wanted || entry.settingsId === wanted)
  if (theme) await themes.setColorTheme(theme, undefined)
}

/** Whether the workbench has ever been built — the panel's empty state. */
export const ideStarted = (): boolean => booted !== null
