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
     NEST          a folder's threads, indented the way `SidebarMenuSub` is. */
export const FOOTER_ICON = "text-muted-foreground"
export const FLOAT_ROW = "pr-3!"
export const FLOAT_ACTION = "bg-sidebar-accent hover:bg-sidebar-border"
export const NEST = "ml-5 border-l border-sidebar-border pl-1 py-1"

/** Rows a long-tail list (a project folder, Trash) shows before "Show more". */
export const PROJECT_PAGE_SIZE = 6
