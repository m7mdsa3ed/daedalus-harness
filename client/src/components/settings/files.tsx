import { FileExplorer } from "@/components/files/file-explorer"
import { PageHeader } from "./primitives"
import { sectionMeta } from "./sections"

/* ── Files ──
   The library the composer's "From library" and every logo field's Upload
   choose from, as a full explorer. Not a form, so the frame gives it the `xl`
   column (`sections.ts`); the explorer fills the panel's height. */
export function FilesPage() {
  return (
    <>
      <PageHeader meta={sectionMeta("files")} />
      <FileExplorer className="h-[max(24rem,calc(var(--panel-h,100svh)-16rem))]" />
    </>
  )
}
