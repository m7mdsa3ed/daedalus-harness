/* The library in a dialog, to choose one file from — the composer's "From
   library" and every logo field's Upload share it. It is the explorer in pick
   mode, so uploading, folders and drag-and-drop are all here too: a file just
   uploaded is one click from chosen. */
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { FileExplorer } from "@/components/files/file-explorer"
import type { FileRecord } from "@/lib/files"

export function FilePicker({
  open,
  onOpenChange,
  accept,
  title = "Choose a file",
  onPick,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  accept?: string
  title?: string
  onPick: (file: FileRecord) => void
}) {
  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>{title}</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            {accept ? "Pick a file that is already here, or upload a new one." : "Pick a file, or upload a new one."}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <FileExplorer
          accept={accept}
          className="h-[min(60svh,28rem)]"
          onPick={(file) => {
            onOpenChange(false)
            onPick(file)
          }}
        />
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
