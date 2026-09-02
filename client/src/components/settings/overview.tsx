/* ── Settings overview ──
   The index of settings: every section, in the same groups the sidebar nav
   draws, as one page of links. On a desktop the sidebar already lists them,
   so this is a landing rather than the only way in; on a phone the sidebar
   is a drawer that closes on every pick, and without this page "Settings"
   dropped you straight into General with the other fourteen sections hidden
   behind the menu button. Every opener that means *settings*, not a section,
   lands here (`settingsRootPath`); the sidebar rows and the palette still go
   straight to a section. */
import { ChevronRight } from "lucide-react"
import { useNavigate } from "react-router"
import { settingsPath } from "@/lib/router"
import { PageHeader } from "./primitives"
import { SETTINGS_NAV_GROUPS, SETTINGS_OVERVIEW, sectionMeta } from "./sections"

export function SettingsOverviewPage() {
  const navigate = useNavigate()
  return (
    <>
      <PageHeader meta={SETTINGS_OVERVIEW} />
      {SETTINGS_NAV_GROUPS.map((group) => (
        <section key={group.label} className="mb-6 last:mb-0">
          <h2 className="mb-2 px-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {group.label}
          </h2>
          {/* One column on a phone — a full-width row is the easiest thing to
              tap — two at the form's width, where the descriptions are short
              enough to sit side by side. */}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {group.sections.map((id) => {
              const meta = sectionMeta(id)
              const Icon = meta.icon
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => void navigate(settingsPath(id))}
                  className="group flex min-h-16 items-center gap-3 rounded-xl border bg-card px-4 py-3 text-left transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none active:bg-accent"
                >
                  <span className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
                    <Icon className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{meta.title}</span>
                    <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">
                      {meta.description}
                    </span>
                  </span>
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5" />
                </button>
              )
            })}
          </div>
        </section>
      ))}
    </>
  )
}
