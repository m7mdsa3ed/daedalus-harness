/* ── The sidebar's few departures from the stock Sidebar parts ──
   Rows, labels, groups and menus are the registry's own sizes and spacing
   (`SidebarGroup`, `SidebarGroupLabel`, `SidebarMenuButton` at its default
   size, `SidebarMenuAction` at its own per-size offset). What is left here is
   what the stock parts do not answer:

     FLOAT_ROW     a thread row reserves no gutter for its ⋯ — the title runs
                   to the edge and the ⋯ floats over it on hover, painted in
                   the row's own hover colour (`FLOAT_ACTION`), instead of
                   stopping 32px early on every row for a control that is only
                   there when the pointer is.
     NEST          a folder's threads, indented the way `SidebarMenuSub` is. The
                   sub threads under a thread wear it too, and "Compact rows"
                   tightens it (`data-nest`, index.css) so the rail's padding and
                   the gap between its rows shrink with the rows themselves. */
export const FOOTER_ICON = "text-muted-foreground"
export const FLOAT_ROW = "pr-3!"
export const FLOAT_ACTION = "bg-sidebar-accent hover:bg-sidebar-border"
export const NEST = "ml-2.5 border-l border-sidebar-border pl-0 py-1"

/** A project section's body: its rows sit on the list's own column, and it
    scrolls inside itself once it outgrows the cap, so one long project cannot
    push the next section's heading off the foot of the sidebar. Deliberately a
    scroll box and not a shorter list: the
    rows below the fold are the reader's own history, not something to hide. */
export const SECTION_BODY = "max-h-[min(20rem,45vh)] overflow-y-auto overscroll-contain"

/** Rows a long project list shows before "Show more". */
export const PROJECT_PAGE_SIZE = 6
