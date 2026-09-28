/* ── What adds to the message ──
   Every way of adding to the message, as its own button at the head of the
   toolbar — attach, photo (touch only), mention, command, project command,
   code block, earlier prompt, and clear once there is something to clear. It
   was one "+" over a menu; nothing on the composer opens a menu now, and a
   button per verb is one click where the menu was two. Each is offered only
   where it can do something, so a fresh draft's row is short.

   The two hidden pickers live here because these buttons are all that click
   them. Two, because `capture` is an attribute and not a mode: an input with it
   goes straight to the camera, right for "take a photo" and wrong for
   "attach". Cleared after each pick, or picking the same file twice fires no
   change event. */
import * as React from "react"
import { AtSign, Camera, Code, History, Paperclip, Slash, SquareTerminal, Trash2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { useChords } from "@/lib/keybindings"
import { formatChord } from "@/lib/shortcuts"
import { cn } from "@/lib/utils"

export function ComposerAddButtons({
  disabled,
  size,
  coarse,
  onFiles,
  canMention,
  hasCommands,
  hasProjectCommands,
  hasHistory,
  hasContent,
  onMention,
  onCommand,
  onProjectCommand,
  onCodeBlock,
  onHistory,
  onClear,
}: {
  disabled: boolean
  size: React.ComponentProps<typeof Button>["size"]
  coarse: boolean
  onFiles: (files: FileList) => void
  /** A file can only be mentioned where there is a project to resolve it in. */
  canMention: boolean
  hasCommands: boolean
  hasProjectCommands: boolean
  hasHistory: boolean
  hasContent: boolean
  onMention: () => void
  onCommand: () => void
  onProjectCommand: () => void
  onCodeBlock: () => void
  onHistory: () => void
  onClear: () => void
}) {
  const historyChords = useChords("historyPrev")
  const filePicker = React.useRef<HTMLInputElement>(null)
  const cameraPicker = React.useRef<HTMLInputElement>(null)
  const button = (title: string, icon: React.ReactNode, onClick: () => void, className?: string) => (
    <Button
      variant="ghost"
      size={size}
      className={cn("shrink-0 rounded-pill text-muted-foreground hover:text-foreground [&_svg]:size-3.5", className)}
      disabled={disabled}
      title={title}
      onClick={onClick}
    >
      {icon}
    </Button>
  )
  const historyChord = formatChord(historyChords[0] ?? "")

  return (
    <>
      {button("Attach files", <Paperclip />, () => filePicker.current?.click())}
      {coarse && button("Take a photo", <Camera />, () => cameraPicker.current?.click())}
      {canMention && button("Mention a file (@)", <AtSign />, onMention)}
      {hasCommands && button("Run a command (/)", <Slash />, onCommand)}
      {hasProjectCommands && button("Run a project command (!)", <SquareTerminal />, onProjectCommand)}
      {button("Insert code block", <Code />, onCodeBlock)}
      {hasHistory && button(`Earlier prompt${historyChord ? ` (${historyChord})` : ""}`, <History />, onHistory)}
      {hasContent && button("Clear message", <Trash2 />, onClear, "hover:text-destructive")}
      <input
        ref={filePicker}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files) onFiles(e.target.files)
          e.target.value = ""
        }}
      />
      <input
        ref={cameraPicker}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          if (e.target.files) onFiles(e.target.files)
          e.target.value = ""
        }}
      />
    </>
  )
}
