/* ── The empty state ── two sentences, shared by the transcript and the
   landing console. Its own file so the console (`landing/landing-page.tsx`)
   can reach it through the `thread-view` barrel without the transcript's own
   surface being what defines it. */
import { Logo } from "@/components/ui/logo"
import { cn } from "@/lib/utils"

/** Sits directly above the composer while a thread is empty, so it travels with
    it rather than being stranded at the top of an empty transcript. Exported
    because the landing page is this same empty state — the composer of a thread
    that does not exist yet — and two copies of these two sentences would drift.

    `landing` is the console's one difference: it is a page somebody arrives on
    rather than a thread already open, so it gets the mark and a heading with
    room to be a heading. The sentences stay the same, which is what keeps the
    two surfaces from describing the same state two ways. */
export function ThreadWelcome({ draft, landing }: { draft?: boolean; landing?: boolean }) {
  return (
    <div
      className={cn(
        "mx-auto flex w-full max-w-[var(--harness-composer-width)] flex-col items-center gap-2 px-4 text-center",
        landing ? "pb-7" : "pb-6"
      )}
    >
      {/* The console's own mark: idle, so it retraces itself every few seconds
          the way the shell's does. Decoration — the words below say the state. */}
      {landing && <Logo idle className="mb-2 size-9 text-primary" />}
      <p
        className={cn(
          "font-heading font-medium text-balance",
          landing ? "text-xl tracking-tight @panel-sm:text-2xl" : "text-base"
        )}
      >
        {draft ? "What are we working on?" : "Thread ready"}
      </p>
      <p
        className={cn(
          "text-sm text-balance text-muted-foreground",
          landing ? "max-w-sm" : "max-w-xs"
        )}
      >
        {draft
          ? "Nothing is running yet — the agent starts when you send the first message."
          : "Send the first message — tool calls, plans and thinking stream in here as steps."}
      </p>
    </div>
  )
}
