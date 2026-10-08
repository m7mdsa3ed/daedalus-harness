import { FileExplorer } from "@/components/files/file-explorer"
import { PageForm, PageHeader } from "./primitives"
import { sectionMeta } from "./sections"

/* ── Files ──
   The library the composer's "From library" and every logo field's Upload
   choose from. Folders nest; dropping files on a folder uploads into it and
   dragging a row onto one moves it. */
export function FilesPage() {
  return (
    <>
      <PageHeader meta={sectionMeta("files")} />
      <PageForm onSubmit={(e) => e.preventDefault()}>
        <FileExplorer className="h-[min(70svh,36rem)]" />
      </PageForm>
    </>
  )
}
