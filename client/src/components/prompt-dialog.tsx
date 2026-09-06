/* eslint-disable react-refresh/only-export-components */
/* Replaces native prompt(), the way confirm-dialog.tsx replaces confirm().

   One provider mounted at the root rather than a dialog beside each caller,
   because asking for a name is something four surfaces do about the same
   thread — the sidebar row, its right-click menu, the app header's ⋯ and the
   command palette — and a dialog per surface is four places for the trimming,
   the Enter key and the empty-name rule to drift apart. */
import * as React from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"

interface PromptOptions {
  title: string
  description?: string
  /** What the box starts with — selected, so typing replaces it. */
  value?: string
  placeholder?: string
  confirmLabel?: string
  /** Longest answer accepted, matching whatever the server will store. */
  maxLength?: number
}

/** Resolves with the trimmed text, or null if it was cancelled. */
type PromptFn = (options: PromptOptions) => Promise<string | null>

const PromptCtx = React.createContext<PromptFn>(() => Promise.resolve(null))

/** `const name = await prompt({ title: "Rename", value: session.title })` */
export function usePrompt(): PromptFn {
  return React.useContext(PromptCtx)
}

export function PromptProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = React.useState<
    (PromptOptions & { resolve: (value: string | null) => void }) | null
  >(null)
  const [text, setText] = React.useState("")

  const prompt = React.useCallback<PromptFn>(
    (options) =>
      new Promise((resolve) => {
        setText(options.value ?? "")
        setPending({ ...options, resolve })
      }),
    []
  )

  const settle = (value: string | null) => {
    pending?.resolve(value)
    setPending(null)
  }

  const trimmed = text.trim()
  // An empty answer is a cancel that looks like a confirm, so it is refused at
  // the button rather than accepted and thrown away by the caller.
  const submit = () => trimmed && settle(trimmed)

  return (
    <PromptCtx.Provider value={prompt}>
      {children}
      <ResponsiveDialog open={pending !== null} onOpenChange={(open) => !open && settle(null)}>
        <ResponsiveDialogContent className="sm:max-w-md">
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle>{pending?.title}</ResponsiveDialogTitle>
          </ResponsiveDialogHeader>
          {pending?.description && (
            <ResponsiveDialogDescription>{pending.description}</ResponsiveDialogDescription>
          )}
          <form
            className="px-4 sm:px-0"
            onSubmit={(e) => {
              e.preventDefault()
              submit()
            }}
          >
            <Input
              // The box is the whole dialog: it takes the focus on open and
              // arrives selected, so the common edit is one keystroke.
              autoFocus
              value={text}
              maxLength={pending?.maxLength}
              placeholder={pending?.placeholder}
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => setText(e.target.value)}
            />
          </form>
          <ResponsiveDialogFooter>
            <Button variant="outline" onClick={() => settle(null)}>
              Cancel
            </Button>
            <Button disabled={!trimmed} onClick={submit}>
              {pending?.confirmLabel ?? "Save"}
            </Button>
          </ResponsiveDialogFooter>
        </ResponsiveDialogContent>
      </ResponsiveDialog>
    </PromptCtx.Provider>
  )
}
