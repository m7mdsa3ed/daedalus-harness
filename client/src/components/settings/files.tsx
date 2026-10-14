import { FileExplorer } from "@/components/files/file-explorer"
import { PageHeader } from "./primitives"
import { sectionMeta } from "./sections"

/* ── Files ──
   The library the composer's "From library" and every logo field's Upload
   choose from, as a full explorer. Not a form, so it takes the frame's whole
   width (`FULL_WIDTH_SETTINGS`) and clamps itself like the other wide pages. */
export function FilesPage() {
  return (
    <div className="mx-auto w-full max-w-7xl">
      <PageHeader meta={sectionMeta("files")} />
      <FileExplorer className="h-[max(24rem,calc(100svh-16rem))]" />
    </div>
  )
}
