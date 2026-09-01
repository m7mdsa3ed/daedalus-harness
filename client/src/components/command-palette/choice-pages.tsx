/* The second screens: a filtered list of one kind of thing, entered from a row
   on the root page. Each one is `PaletteItem[]` through `ItemList`, so the
   query filters and ranks them exactly the way it does the commands — there is
   one matcher in the palette, not one per page. */
import { Cpu, Drama, FolderPlus, Gauge, Palette as PaletteIcon, ShieldCheck } from "lucide-react"
import { useNavigate } from "react-router"

import { useSidebar } from "@/components/ui/sidebar"
import { reportError } from "@/lib/errors"
import { projectPath, settingsPath } from "@/lib/router"
import { activityAt, isTopLevel } from "@/lib/settings"
import { usePersonas, useProjects } from "@/lib/queries/catalog"
import { useStoreSelect } from "@/lib/store"
import { customThemeValue } from "@/lib/custom-themes"
import { BUILTIN_THEMES, useCustomThemes, useTheme } from "@/lib/theme"
import { loadThreadDefaults } from "@/lib/thread-defaults"
import { usePalette } from "./context"
import { ItemList, type PaletteItem } from "./list"
import { projectItem } from "./rows"
import { retune, useThreadTarget } from "./thread-config"

export function ThemePage() {
  const palette = usePalette()
  const navigate = useNavigate()
  const { colorTheme, setColorTheme } = useTheme()
  const customThemes = useCustomThemes()

  const items: PaletteItem[] = [
    ...BUILTIN_THEMES.map(({ value, label }) => ({
      id: `palette:${value}`,
      group: "Palettes",
      title: label,
      icon: <PaletteIcon className={colorTheme === value ? "text-primary" : undefined} />,
      checked: colorTheme === value,
      onSelect: () => palette.run(() => setColorTheme(value)),
    })),
    ...customThemes.map((custom) => ({
      id: `palette:custom:${custom.id}`,
      group: "Your themes",
      title: custom.name,
      icon: (
        <PaletteIcon
          className={colorTheme === customThemeValue(custom.id) ? "text-primary" : undefined}
        />
      ),
      checked: colorTheme === customThemeValue(custom.id),
      onSelect: () => palette.run(() => setColorTheme(customThemeValue(custom.id))),
    })),
    {
      id: "palette:build",
      group: "",
      title: "Build a theme…",
      keywords: "custom new palette editor",
      icon: <PaletteIcon />,
      rank: "bottom",
      onSelect: () => palette.run(() => void navigate(settingsPath("appearance"))),
    },
  ]

  return <ItemList items={items} query={palette.query} />
}

export function ModelPage() {
  const palette = usePalette()
  const { sessionId, options, modelChoices } = useThreadTarget()
  const current = options.model?.type === "select" ? options.model.currentValue : undefined

  const items: PaletteItem[] = modelChoices.map((choice) => ({
    id: `model:${choice.value}`,
    group: options.model?.name ?? "Model",
    title: choice.name,
    icon: <Cpu className={current === choice.value ? "text-primary" : undefined} />,
    checked: current === choice.value,
    onSelect: () => palette.run(() => retune(palette.actions, sessionId, options.model, choice.value)),
  }))

  return <ItemList items={items} query={palette.query} />
}

export function EffortPage() {
  const palette = usePalette()
  const { sessionId, options, effortChoices } = useThreadTarget()
  const current = options.effort?.type === "select" ? options.effort.currentValue : undefined

  const items: PaletteItem[] = effortChoices.map((choice) => ({
    id: `effort:${choice.value}`,
    group: options.effort?.name ?? "Reasoning effort",
    title: choice.name,
    className: "capitalize",
    icon: <Gauge className={current === choice.value ? "text-primary" : undefined} />,
    checked: current === choice.value,
    onSelect: () =>
      palette.run(() => retune(palette.actions, sessionId, options.effort, choice.value)),
  }))

  return <ItemList items={items} query={palette.query} />
}

export function ModePage() {
  const palette = usePalette()
  const { sessionId, modes } = useThreadTarget()
  if (!modes) return null

  const items: PaletteItem[] = modes.availableModes.map((mode) => ({
    id: `mode:${mode.id}`,
    group: "Permission mode",
    title: mode.name,
    keywords: mode.description ?? "",
    icon: <ShieldCheck className={modes.currentModeId === mode.id ? "text-primary" : undefined} />,
    checked: modes.currentModeId === mode.id,
    onSelect: () =>
      palette.run(() => {
        if (!sessionId) return
        palette.actions
          .setMode(sessionId, mode.id)
          .catch((err) => reportError(err, "Couldn't switch mode"))
      }),
  }))

  return <ItemList items={items} query={palette.query} />
}

/**
 * How the open thread is worked on.
 *
 * The one page here that costs something: a persona is read at `session/new` /
 * `session/load` and nowhere else, so picking one restarts the agent (the
 * conversation is restored with it). No confirmation, unlike the same row in
 * the settings menu — the palette is a keyboard surface and a dialog inside a
 * dialog is worse than an undo, and the undo here is picking the old one back.
 * A draft is left out entirely: it has no thread to reconfigure, and its
 * persona is a field on the composer's own menu.
 */
export function PersonaPage() {
  const palette = usePalette()
  const personas = usePersonas()
  const { meta } = useThreadTarget()
  if (!meta || meta.draft) return null

  const current = meta.personaId ?? ""
  const items: PaletteItem[] = personas.map((persona) => ({
    id: `persona:${persona.id}`,
    group: "Persona",
    title: persona.name,
    keywords: persona.description,
    icon: <Drama className={current === persona.id ? "text-primary" : undefined} />,
    checked: current === persona.id,
    onSelect: () =>
      palette.run(() => {
        palette.actions
          .changeThreadPersona(meta, persona.id)
          .catch((err) => reportError(err, "Couldn't change how this thread works"))
      }),
  }))
  if (current) {
    items.push({
      id: "persona:none",
      group: "",
      title: "No persona",
      keywords: "clear none default off",
      icon: <Drama />,
      rank: "bottom",
      onSelect: () =>
        palette.run(() => {
          palette.actions
            .changeThreadPersona(meta, "")
            .catch((err) => reportError(err, "Couldn't change how this thread works"))
        }),
    })
  }

  return <ItemList items={items} query={palette.query} />
}

/** Every project as a destination: its own page — the overview, its threads and
    its numbers — not the settings form. */
export function ProjectsPage() {
  const palette = usePalette()
  const projects = useProjects()
  const navigate = useNavigate()
  const { setOpenMobile } = useSidebar()

  const items: PaletteItem[] = projects.map((project) =>
    projectItem({
      project,
      group: "Projects",
      onSelect: () =>
        palette.run(() => {
          setOpenMobile(false)
          void navigate(projectPath(project.id))
        }),
    })
  )
  items.push({
    id: "projects:new",
    group: "",
    title: "New project…",
    keywords: "workspace directory cwd add",
    icon: <FolderPlus />,
    rank: "bottom",
    onSelect: () => palette.run(palette.newProject),
  })

  return <ItemList items={items} query={palette.query} />
}

/** Same message, another workspace. The project decides the cwd the agent runs
    in, which is the one part of "start a thread" the remembered defaults can
    genuinely get wrong. */
export function StartPage() {
  const palette = usePalette()
  const projects = useProjects()
  const sessions = useStoreSelect((store) => store.sessions)

  /* Where a bare "New thread" would have landed — called out below, because it
     is what ⌘N and the row above this page would have chosen. */
  const defaults = loadThreadDefaults()
  const preferred =
    projects.find((project) => project.id === defaults.projectId) ?? projects[0] ?? null

  /* Newest turn per project — the one worked in last is the one most likely to
     be wanted next, and a fresh project with no threads sorts last, not first. */
  const latest = new Map<string, number>()
  for (const session of sessions.filter(isTopLevel)) {
    const at = activityAt(session)
    if (at > (latest.get(session.projectId) ?? 0)) latest.set(session.projectId, at)
  }

  const ordered = [...projects].sort((a, b) => {
    if (a.id === preferred?.id) return -1
    if (b.id === preferred?.id) return 1
    return (latest.get(b.id) ?? 0) - (latest.get(a.id) ?? 0)
  })

  const heading = palette.askText ? `Start “${palette.askText}” in` : "New thread in"
  const items: PaletteItem[] = ordered.map((project) =>
    projectItem({
      project,
      group: heading,
      badge: project.id === preferred?.id ? "Last used" : undefined,
      lastActivity: latest.get(project.id),
      onSelect: () =>
        palette.run(() =>
          palette.newThread({ text: palette.askText || undefined, projectId: project.id })
        ),
    })
  )
  // A workspace that is not on the list yet is the other reason to be here, so
  // the page is not a dead end.
  items.push({
    id: "start:new-project",
    group: "",
    title: "New project…",
    keywords: "workspace directory cwd add",
    icon: <FolderPlus />,
    rank: "bottom",
    onSelect: () => palette.run(palette.newProject),
  })

  return <ItemList items={items} query={palette.query} />
}
