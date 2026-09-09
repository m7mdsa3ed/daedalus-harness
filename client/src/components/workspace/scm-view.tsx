/* ── Source control: the barrel ──
   The view itself is `scm/`, split along the seams it already had — the
   repository list (`scm/view.tsx`), one repository (`scm/repo-section.tsx`),
   the groups and rows (`scm/file-rows.tsx`), the branch control
   (`scm/branch-menu.tsx`) and the vocabulary they share (`scm/shared.tsx`).
   This file exists so `@/components/workspace/scm-view` keeps meaning what it
   has always meant to the IDE panel; it holds nothing of its own. */
export { ScmView } from "@/components/workspace/scm/view"
