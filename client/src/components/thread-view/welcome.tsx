/* ── The empty state ── two sentences, shared by the transcript and the
   landing console. Its own file so the console (`landing/landing-page.tsx`)
   can reach it through the `thread-view` barrel without the transcript's own
   surface being what defines it. */

/** Sits directly above the composer while a thread is empty, so it travels with
    it rather than being stranded at the top of an empty transcript. Exported
    because the landing page is this same empty state — the composer of a thread
    that does not exist yet — and two copies of these two sentences would drift. */
export function ThreadWelcome({ draft }: { draft?: boolean }) {
  return (
    <div className="mx-auto flex w-full max-w-[var(--harness-composer-width)] flex-col items-center gap-2 px-4 pb-6 text-center">
      <p className="text-base font-medium">
        {draft ? "What are we working on?" : "Thread ready"}
      </p>
      <p className="max-w-xs text-sm text-balance text-muted-foreground">
        {draft
          ? "Nothing is running yet — the agent starts when you send the first message."
          : "Send the first message — tool calls, plans and thinking stream in here as steps."}
      </p>
    </div>
  )
}
