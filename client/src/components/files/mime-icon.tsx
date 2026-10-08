import {
  FileArchiveIcon,
  FileAudioIcon,
  FileCodeIcon,
  FileIcon,
  FileImageIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FileVideoIcon,
  FolderIcon,
  FolderOpenIcon,
  type LucideIcon,
} from "lucide-react"

import { FOLDER_MIME } from "@/lib/files"

/** One glyph per kind of thing, chosen by mime type alone — the same record a
    listing carries, so no extension table lives in a component. */
export function mimeIcon(mimeType: string, open = false): LucideIcon {
  if (mimeType === FOLDER_MIME) return open ? FolderOpenIcon : FolderIcon
  if (mimeType.startsWith("image/")) return FileImageIcon
  if (mimeType.startsWith("video/")) return FileVideoIcon
  if (mimeType.startsWith("audio/")) return FileAudioIcon
  if (/zip|tar|gzip|compressed|7z|rar/.test(mimeType)) return FileArchiveIcon
  if (/spreadsheet|excel|csv/.test(mimeType)) return FileSpreadsheetIcon
  if (/json|xml|javascript|typescript|x-sh|html|css|yaml/.test(mimeType)) return FileCodeIcon
  if (mimeType.startsWith("text/") || mimeType === "application/pdf") return FileTextIcon
  return FileIcon
}
