/* The library in a dialog, to choose from — the composer's "From library"
   (several files) and every logo field's Upload (one) share it. It is the explorer in pick
   mode, so uploading, folders, search and drag-and-drop are all here too: a
   file just uploaded is one click from chosen. */
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
  multiple = false,
  pickLabel,
  onPick,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  accept?: string
  title?: string
  /** Choose several at once (⌘/Ctrl- and Shift-click); otherwise one. */
  multiple?: boolean
  pickLabel?: string
  onPick: (files: FileRecord[]) => void
}) {
  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="sm:max-w-5xl">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>{title}</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            {multiple
              ? "Select files with ⌘/Ctrl- or Shift-click, or upload new ones."
              : "Double-click a file to choose it, or upload a new one."}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <FileExplorer
          accept={accept}
          multiple={multiple}
          pickLabel={pickLabel}
          className="h-[min(70svh,36rem)]"
          onCancel={() => onOpenChange(false)}
          onPick={(files) => {
            onOpenChange(false)
            onPick(files)
          }}
        />
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
