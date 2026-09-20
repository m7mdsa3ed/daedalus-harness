/* ── A barrel, not a component ──
   The sidebar is `components/sidebar/`: the layout that stacks the tiers lives
   in `sidebar/sidebar.tsx`, the fixed nav in `sidebar/nav.tsx`, the sort/filter
   store and its menu in `sidebar/view.tsx`, the Trash's own action in
   `sidebar/trash.tsx`, the group primitives in `sidebar/groups.tsx`, the
   memoized row and list in `sidebar/thread-row.tsx` / `sidebar/thread-list.tsx`
   and the footer's plan reading in `sidebar/usage.tsx`.

   This path stays because it is the one the rest of the app already imports —
   `app-shell.tsx` for the nav and the scale (the settings nav draws from the
   same one, so the whole panel has one spacing voice), `project-page.tsx` for
   the "new thread in this project" front door. */
export { FOOTER_ICON, GROUP, GROUP_LABEL, MENU, ROW, TIER } from "@/components/sidebar/scale"
export { SidebarNav } from "@/components/sidebar/nav"
export { SettingsNav, inSettingsPanel } from "@/components/sidebar/settings-nav"
export { SidebarUsage } from "@/components/sidebar/usage"
export { ThreadSidebar, useStartThreadIn } from "@/components/sidebar/sidebar"
