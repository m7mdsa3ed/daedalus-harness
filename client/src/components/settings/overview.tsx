/* ── Settings overview ──
   The index of settings: every section, in the same groups the rail draws, as
   one page of links. In a wide panel the rail already lists them, so this is a
   landing rather than the only way in; in a narrow one the rail is a picker
   that closes on every pick, and without this page "Settings" dropped you
   straight into General with the other sections behind a menu. Every
   opener that means *settings*, not a section, lands here (`settingsRootPath`);
   the rail's rows and the palette still go straight to a section. */
import * as React from "react"
import { ChevronRight, SearchX } from "lucide-react"
import { useNavigate } from "react-router"
import { Empty } from "@/components/empty"
import { settingsPath } from "@/lib/router"
import { Group, PageHeader, Toolbar } from "./primitives"
import { SETTINGS_NAV_GROUPS, SETTINGS_OVERVIEW, sectionMeta, type SettingsSectionId } from "./sections"

/* The one group whose home is this device rather than the server — the
   overview description says as much in prose; here it is said where it applies. */
const GROUP_HINT: Record<string, string> = { Personal: "Kept on this device" }

/* One full-width 56px target: icon tile, title, one line of description (plus
   the group's name while searching, when the groups are gone), chevron. */
function NavRow({ id, group }: { id: SettingsSectionId; group?: string }) {
  const navigate = useNavigate()
  const meta = sectionMeta(id)
  const Icon = meta.icon
  return (
    <button
      type="button"
      onClick={() => void navigate(settingsPath(id))}
      className="-mx-3 flex min-h-14 w-[calc(100%+1.5rem)] items-center gap-3 px-3 py-2 text-left @panel-sm:-mx-4 @panel-sm:w-[calc(100%+2rem)] @panel-sm:px-4 transition-colors outline-none hover:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset active:bg-muted/50 pointer-coarse:min-h-16"
    >
      <span
        aria-hidden
        className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted"
      >
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{meta.title}</span>
        <span className="block truncate text-sm text-muted-foreground">
          {group && <span className="font-medium">{group} · </span>}
          {meta.description}
        </span>
      </span>
      <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
    </button>
  )
}

export function SettingsOverviewPage() {
  const [query, setQuery] = React.useState("")
  const needle = query.trim().toLowerCase()
  /* Name + description, and the short label the rail wears — what someone
     types is as likely "mcp" as "MCP servers". Empty groups drop out whole. */
  const groups = SETTINGS_NAV_GROUPS.map((group) => ({
    ...group,
    sections: group.sections.filter((id) => {
      if (!needle) return true
      const m = sectionMeta(id)
      return `${m.title} ${m.label} ${m.description}`.toLowerCase().includes(needle)
    }),
  })).filter((group) => group.sections.length > 0)

  return (
    <>
      <PageHeader meta={SETTINGS_OVERVIEW} />
      <Toolbar search={query} onSearch={setQuery} placeholder="Search settings" />
      {groups.length === 0 && (
        <Empty size="lg" icon={SearchX} role="status">
          Nothing matches “{query.trim()}”.
        </Empty>
      )}
      {needle && groups.length > 0 && (
        <Group>
          {groups.flatMap((group) =>
            group.sections.map((id) => <NavRow key={id} id={id} group={group.label} />)
          )}
        </Group>
      )}
      {/* Groups flow in two columns once the panel is wide; a column break
          never splits a group's card. */}
      {!needle && (
        <div className="gap-x-6 @panel-lg:columns-2 [&>[data-kit-block]]:break-inside-avoid">
          {groups.map((group) => (
            <Group key={group.label} label={group.label} hint={GROUP_HINT[group.label]}>
              {group.sections.map((id) => (
                <NavRow key={id} id={id} />
              ))}
            </Group>
          ))}
        </div>
      )}
    </>
  )
}
