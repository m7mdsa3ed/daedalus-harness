/* ── Settings overview ──
   The index of settings: every section, in the same groups the rail draws, as
   one page of links. In a wide panel the rail already lists them, so this is a
   landing rather than the only way in; in a narrow one the rail is a picker
   that closes on every pick, and without this page "Settings" dropped you
   straight into General with the other nineteen sections behind a menu. Every
   opener that means *settings*, not a section, lands here (`settingsRootPath`);
   the rail's rows and the palette still go straight to a section. */
import { ChevronRight } from "lucide-react"
import { useNavigate } from "react-router"
import { settingsPath } from "@/lib/router"
import { Group, PageHeader } from "./primitives"
import { SETTINGS_NAV_GROUPS, SETTINGS_OVERVIEW, sectionMeta } from "./sections"

export function SettingsOverviewPage() {
  const navigate = useNavigate()
  return (
    <>
      <PageHeader meta={SETTINGS_OVERVIEW} />
      {SETTINGS_NAV_GROUPS.map((group) => (
        <Group key={group.label} label={group.label}>
          {group.sections.map((id) => {
            const meta = sectionMeta(id)
            const Icon = meta.icon
            return (
              /* A `Row`'s shape, but the whole row is the target — a section
                 has nothing on it to press *except* itself, and a chevron in a
                 Row's action slot would be a button inside a button. The card
                 and its hairlines are the Group's, so a group of sections is
                 one card of rows — not a grid of tiles, which would be a
                 second card idiom on a page already made of them. */
              <button
                key={id}
                type="button"
                onClick={() => void navigate(settingsPath(id))}
                /* Bleeds to the card's edge so the hover wash is the full row
                   and not a pill floating inside the card's own inset. */
                className="group -mx-3 flex min-h-12 w-full items-center gap-3 px-3 py-3 text-left transition-colors hover:bg-accent/50 focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring active:bg-accent @panel-sm:-mx-4 @panel-sm:px-4"
              >
                <Icon className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{meta.title}</span>
                  <span className="mt-0.5 line-clamp-2 block text-xs/relaxed text-muted-foreground">
                    {meta.description}
                  </span>
                </span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5" />
              </button>
            )
          })}
        </Group>
      ))}
    </>
  )
}
