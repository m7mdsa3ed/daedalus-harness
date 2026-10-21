/* ── The New tab page's launcher ──
   A tab is an isolated outlet that can open anything, and this is the page a
   fresh one opens on. Each cell navigates *this* tab, so whatever it opens
   stays in it — the same route can be open in as many tabs as you like.

   One strip and not a row of floating chips. A destination and a project are
   the same question — where am I going — so they share one ground, one hover
   and one radius; a hairline between the two rows is what separates the kinds
   instead of a border around every button. It sits under the composer and
   reads as its footnote: the box above is the page's subject, this is
   everything else the tab can do.

   The chords under it are the reader's own (`Shortcut`, lib/keybindings), so a
   rebinding in settings reaches this page too — and they are hidden on a narrow
   panel, because a phone has no keyboard to press them on. */
import {
  BellIcon,
  RepeatIcon,
  SettingsIcon,
  SquareKanbanIcon,
  type LucideIcon,
} from "lucide-react"
import { useNavigate } from "react-router"

import { ProjectIcon } from "@/components/entity-icon"
import { Shortcut } from "@/components/shortcut"
import {
  automationsPath,
  boardPath,
  notificationsPath,
  projectPath,
  settingsPath,
  settingsRootPath,
} from "@/lib/router"
import type { Project } from "@/lib/settings"

/** How many projects the strip names before the rest become one count. */
const PROJECT_LIMIT = 4

/** The four places a new tab is opened for, in the order the sidebar files
    them. */
const DESTINATIONS: { id: string; label: string; icon: LucideIcon; path: () => string }[] = [
  { id: "tasks", label: "Tasks", icon: SquareKanbanIcon, path: () => boardPath() },
  { id: "automations", label: "Automations", icon: RepeatIcon, path: () => automationsPath() },
  { id: "inbox", label: "Inbox", icon: BellIcon, path: () => notificationsPath() },
  { id: "settings", label: "Settings", icon: SettingsIcon, path: () => settingsRootPath() },
]

/** One cell. Concentric with the strip: its radius is the strip's less the
    padding the strip insets it by, so the two curves share a centre. */
const CELL =
  "flex h-8 min-w-0 items-center gap-2 rounded-lg px-2.5 text-sm text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:h-11"

/* Two columns on a narrow panel and one line from `@panel-sm`: a phone gets a
   tidy 2x2 of destinations instead of however many happen to fit before a
   wrap, and every cell there is wide enough to be a target. */
const ROW =
  "grid min-w-0 grid-cols-2 gap-0.5 p-1 @panel-sm:flex @panel-sm:flex-wrap @panel-sm:items-center"

export function LandingActions({ projects }: { projects: Project[] }) {
  const navigate = useNavigate()
  const shown = projects.slice(0, PROJECT_LIMIT)
  const hidden = projects.length - shown.length
  const go = (path: string) => () => void navigate(path)

  return (
    <div className="px-4 pt-6">
      <nav
        aria-label="Go to"
        className="mx-auto w-full max-w-[var(--harness-composer-width)] rounded-xl border bg-muted/40"
      >
        <div className={ROW}>
          {DESTINATIONS.map(({ id, label, icon: Icon, path }) => (
            <button key={id} type="button" className={CELL} onClick={go(path())}>
              <Icon aria-hidden className="size-4 shrink-0" />
              <span className="truncate">{label}</span>
            </button>
          ))}
        </div>
        {projects.length > 0 && (
          <>
            {/* The seam, inset by the row's own padding so it stops short of
                the strip's rounded corners instead of cutting across them. */}
            <div aria-hidden className="mx-2 h-px bg-border/70" />
            <div className={ROW}>
              {shown.map((project) => (
                <button
                  key={project.id}
                  type="button"
                  className={CELL}
                  onClick={go(projectPath(project.id))}
                  title={project.name}
                >
                  <ProjectIcon project={project} className="size-4 shrink-0" />
                  <span className="max-w-40 truncate">{project.name}</span>
                </button>
              ))}
              {hidden > 0 && (
                <button
                  type="button"
                  className={CELL}
                  onClick={go(settingsPath("projects"))}
                  aria-label={`All projects (${projects.length})`}
                  title="All projects"
                >
                  <span className="tabular-nums">+{hidden}</span>
                </button>
              )}
            </div>
          </>
        )}
      </nav>
      {/* Two chords the page is about: everything, and another tab. Plain text
          between them, so the keycaps are the only thing with a ground. */}
      <p className="mx-auto mt-2.5 hidden w-full max-w-[var(--harness-composer-width)] items-center justify-center gap-1.5 text-xs text-muted-foreground @panel-sm:flex">
        <Shortcut id="palette" />
        <span>for everything</span>
        <span aria-hidden className="px-0.5 text-border">
          &middot;
        </span>
        <Shortcut id="newThread" />
        <span>for a new tab</span>
      </p>
    </div>
  )
}
