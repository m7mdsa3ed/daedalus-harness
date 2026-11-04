/* ── The voice button ──
   One key for two ways of talking to a thread, because they are the same
   gesture at different lengths: a note you dictate into the box, and a call you
   have with the agent. They used to be two 24px buttons on the send row — one
   drawn only where the browser has a speech API, the other only where a voice
   backend is configured — so which of the two existed depended on two unrelated
   facts, and the row changed shape under them. One key, one place, and the
   modes behind it.

   **A click does the current thing, never the menu.** The common case is
   starting (or stopping) a note; a popover in front of that on every press
   would be the outlining the control was meant to remove. So the button holds
   the *pick* — the last mode the reader chose, a note until they choose
   otherwise — and the fold beside it changes the pick.

   **The face says which mode is picked and whether it is running.** A note
   reads `Mic`, a call `AudioLines`; either one, while live, wears the same
   destructive pulse both old buttons wore alone.

   A screen recording rides the same key as a third mode: it is the same
   "show, then send" gesture, and it ends as a `.webm` on the message's
   attachments (`hooks/use-screen-record.ts`), sent as a file like any other.

   Voice is offered only where it can actually run, and a mode that cannot says
   why on its own row: no speech API in this browser, no backend configured in
   Settings › Voice. A menu that lists a mode that will not start is worse than
   one that explains the mode it has. */
import * as React from "react"
import { AudioLines, ChevronDown, Mic, ScreenShare } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { KEY_MARK } from "@/components/composer/indicator"
import { MENU_WIDTH, MenuRow } from "@/components/menu-row"
import { setComposerPrefs, useComposerPrefs } from "@/lib/composer-prefs"
import { useCoarsePointer } from "@/hooks/use-device"
import { cn } from "@/lib/utils"

export type VoiceMode = "note" | "call" | "screen"

/**
 * The one voice key.
 *
 * `dictation` and `call` are what each mode can say — `supported` and, when it
 * is false, the `reason` its row prints. `active` is which mode is running
 * right now (at most one). The recorder and the call are the composer's, since
 * each has state outliving this button; it only says which one to start.
 */
export function VoiceButton({
  size,
  disabled,
  dictation,
  call,
  screen,
  active,
  onStart,
  onStop,
}: {
  /** The row's one scale — 24px under a mouse, 32px under a finger. */
  size: React.ComponentProps<typeof Button>["size"]
  disabled: boolean
  /** What each mode can say, or why it cannot. */
  dictation: { supported: boolean; reason?: string; shortcut?: string }
  call: { supported: boolean; reason?: string; shortcut?: string }
  screen: { supported: boolean; reason?: string }
  /** Which mode is live, if any is. */
  active: VoiceMode | null
  onStart: (mode: VoiceMode) => void
  onStop: (mode: VoiceMode) => void
}) {
  const coarse = useCoarsePointer()
  const [open, setOpen] = React.useState(false)
  const running = active !== null
  /* The pick is the store's, read here rather than passed in: a chord (⌥C, ⌥D)
     changes it without this component being the one that asked, and a button
     that only re-read when its parent re-rendered would keep showing a mic
     after ⌥C had picked the call. */
  const mode = useVoiceMode()
  /* The mode the key acts on: whatever is *running* wins, so the same key that
     started a call ends it even after a note was picked in between. */
  const current: VoiceMode = active ?? mode
  const canRun = { note: dictation, call, screen }[current].supported
  const Icon = { note: Mic, call: AudioLines, screen: ScreenShare }[current]
  const title = running
    ? { note: "Stop the note", call: "End the voice call", screen: "Stop recording and attach it" }[current]
    : { note: "Take a voice note", call: "Start a voice call", screen: "Record the screen" }[current]
  const chord = current === "call" ? call.shortcut : current === "note" ? dictation.shortcut : undefined

  return (
    /* `group/voice`: the fold is a hover reveal, and it has to come from the
       pair rather than from the fold itself — a control you must first find
       before you can open it is not a control. */
    <div className="group/voice flex shrink-0 items-center">
      <Button
        variant="ghost"
        size={size}
        className={cn(
          "text-muted-foreground",
          /* A live mode is a live state, so it stays coloured — as text, not as
             a filled chip that would reintroduce the chrome the row does not
             wear. */
          running && "animate-pulse pe-0.5 text-destructive hover:text-destructive"
        )}
        onClick={() => (running ? onStop(current) : onStart(current))}
        disabled={disabled || !canRun}
        title={chord ? `${title} (${chord})` : title}
        aria-pressed={running}
        aria-label={title}
      >
        <Icon className={KEY_MARK} />
      </Button>
      {/* The same control's other half: the key is the act, the fold is what it
          changes. Always drawn under a finger, where hover cannot reveal it. */}
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger
          render={
            /* A plain button, not the row's `Button`: `icon-xs` states a fixed
               `size-6`, and a fold that is a third of a key wide cannot be
               expressed as a class that loses to it. Its height is the key's,
               its width is the chevron's. */
            <button
              type="button"
              className={cn(
                "-ms-1 grid w-3.5 place-items-center rounded-pill text-muted-foreground",
                coarse ? "h-8" : "h-6",
                "data-popup-open:bg-muted data-popup-open:text-foreground",
                "opacity-0 transition-opacity focus-visible:opacity-100 group-hover/voice:opacity-100",
                (coarse || open) && "opacity-100"
              )}
              aria-label="Voice options"
              title="Voice options"
            />
          }
        >
          <ChevronDown className="size-3" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="top" className={MENU_WIDTH}>
          <DropdownMenuLabel>Voice</DropdownMenuLabel>
          <ModeRow
            label="Voice note"
            hint={dictation.supported ? "Dictate into the message" : (dictation.reason ?? "Not available here")}
            icon={<Mic />}
            offered={dictation.supported}
            checked={current === "note"}
            onPick={() => {
              setComposerPrefs({ voiceMode: "note" })
              setOpen(false)
            }}
          />
          <ModeRow
            label="Voice call"
            hint={call.supported ? "Talk to the agent, hands free" : (call.reason ?? "Not available here")}
            icon={<AudioLines />}
            offered={call.supported}
            checked={current === "call"}
            onPick={() => {
              setComposerPrefs({ voiceMode: "call" })
              setOpen(false)
            }}
          />
          <ModeRow
            label="Screen recording"
            hint={screen.supported ? "Record the screen, attach it as a video" : (screen.reason ?? "Not available here")}
            icon={<ScreenShare />}
            offered={screen.supported}
            checked={current === "screen"}
            onPick={() => {
              setComposerPrefs({ voiceMode: "screen" })
              setOpen(false)
            }}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

/** One mode, checked when it is the one the key will act on. A mode this
    browser or this server cannot run stays listed and disabled: it is the
    answer to "why is there only one of these?", and hiding it made the absence
    look like a bug. */
function ModeRow({
  label,
  hint,
  icon,
  offered,
  checked,
  onPick,
}: {
  label: string
  hint: string
  icon: React.ReactNode
  offered: boolean
  checked: boolean
  onPick: () => void
}) {
  return (
    <DropdownMenuCheckboxItem
      checked={checked}
      disabled={!offered}
      onCheckedChange={() => offered && onPick()}
    >
      <MenuRow icon={icon} label={label} hint={hint} />
    </DropdownMenuCheckboxItem>
  )
}

/** The pick, read the way every other composer preference is. */
export function useVoiceMode(): VoiceMode {
  const prefs = useComposerPrefs()
  return prefs.voiceMode ?? "note"
}
