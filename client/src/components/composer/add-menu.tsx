/* ── The "+" ──
   The first half of the composer's rule: what *adds to* the message lives
   behind this menu, and what governs *how it sends* lives at the other end of
   the row. The two hidden pickers are here rather than in the card because
   this menu is the only thing that clicks them. */
import * as React from "react"
import { AtSign, Camera, Code, History, Paperclip, Plus, Slash, SquareTerminal, Trash2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useChords } from "@/lib/keybindings"
import { formatChord } from "@/lib/shortcuts"

export function ComposerAddMenu({
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
  /** The row's one scale — 24px under a mouse, 32px under a finger. */
  size: React.ComponentProps<typeof Button>["size"]
  coarse: boolean
  onFiles: (files: FileList) => void
  /** A file can only be mentioned where there is a project to resolve it in. */
  canMention: boolean
  hasCommands: boolean
  /** The current project has saved shell lines — the `!` menu would list them. */
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
  // Rebindable in Settings › Keyboard, so it is read rather than named here.
  const historyChords = useChords("historyPrev")
  const filePicker = React.useRef<HTMLInputElement>(null)
  const cameraPicker = React.useRef<HTMLInputElement>(null)

  return (
    <>
      {/* What goes in. One menu holds every way of adding to the message
          — the row used to give each its own button, and on a phone that
          row was the first thing to overflow. */}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size={size}
              className="shrink-0 rounded-pill bg-muted text-muted-foreground hover:bg-muted/70 hover:text-foreground data-popup-open:bg-muted data-popup-open:text-foreground [&_svg]:size-3.5"
              disabled={disabled}
              title="Add to the message"
            />
          }
        >
          <Plus />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" sideOffset={8} className="min-w-52">
          <DropdownMenuItem onClick={() => filePicker.current?.click()}>
            <Paperclip />
            Attach files
          </DropdownMenuItem>
          {/* The camera is a touch thing: a laptop's webcam is not what
              "take a photo" means, and the picker on a desktop already
              opens the file dialog. */}
          {coarse && (
            <DropdownMenuItem onClick={() => cameraPicker.current?.click()}>
              <Camera />
              Take a photo
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          {canMention && (
            <DropdownMenuItem onClick={onMention}>
              <AtSign />
              Mention a file
              <DropdownMenuShortcut>@</DropdownMenuShortcut>
            </DropdownMenuItem>
          )}
          {hasCommands && (
            <DropdownMenuItem onClick={onCommand}>
              <Slash />
              Run a command
              <DropdownMenuShortcut>/</DropdownMenuShortcut>
            </DropdownMenuItem>
          )}
          {/* The project's own saved shell lines — "Restart server", "Run
              migrations" — which run as a terminal rather than reaching the
              agent. Offered only where the project has some. */}
          {hasProjectCommands && (
            <DropdownMenuItem onClick={onProjectCommand}>
              <SquareTerminal />
              Run a project command
              <DropdownMenuShortcut>!</DropdownMenuShortcut>
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={onCodeBlock}>
            <Code />
            Insert code block
          </DropdownMenuItem>
          {/* The browsable half of the prompt history — Up is the other,
              and both walk the same global list. Offered only once there
              is something in it, so a fresh install is not given a door
              onto an empty room. */}
          {hasHistory && (
            <DropdownMenuItem onClick={onHistory}>
              <History />
              Earlier prompt
              <DropdownMenuShortcut>{formatChord(historyChords[0] ?? "")}</DropdownMenuShortcut>
            </DropdownMenuItem>
          )}
          {hasContent && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={onClear}>
                <Trash2 />
                Clear message
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {/* The pickers. Two, because `capture` is an attribute and not a
          mode: an input with it goes straight to the camera and skips the
          gallery, which is right for "take a photo" and wrong for
          "attach". Cleared after each pick, or choosing the same file twice
          fires no change event. */}
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
