/* eslint-disable react-refresh/only-export-components */
import * as React from "react"
import { Button } from "@/components/ui/button"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"

interface ConfirmOptions {
  title: string
  description?: string
  confirmLabel?: string
  destructive?: boolean
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>

const ConfirmCtx = React.createContext<ConfirmFn>(() => Promise.resolve(false))

/** Replaces native confirm(): `if (await confirm({ title: "Delete?" })) …` */
export function useConfirm(): ConfirmFn {
  return React.useContext(ConfirmCtx)
}

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = React.useState<
    (ConfirmOptions & { resolve: (ok: boolean) => void }) | null
  >(null)

  const confirm = React.useCallback<ConfirmFn>(
    (options) => new Promise((resolve) => setPending({ ...options, resolve })),
    []
  )

  const settle = (ok: boolean) => {
    pending?.resolve(ok)
    setPending(null)
  }

  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      <ResponsiveDialog open={pending !== null} onOpenChange={(open) => !open && settle(false)}>
        <ResponsiveDialogContent className="sm:max-w-sm">
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle>{pending?.title}</ResponsiveDialogTitle>
            {pending?.description && (
              <ResponsiveDialogDescription>{pending.description}</ResponsiveDialogDescription>
            )}
          </ResponsiveDialogHeader>
          <ResponsiveDialogFooter>
            <Button variant="outline" onClick={() => settle(false)}>
              Cancel
            </Button>
            <Button
              variant={pending?.destructive ? "destructive" : "default"}
              onClick={() => settle(true)}
            >
              {pending?.confirmLabel ?? "Confirm"}
            </Button>
          </ResponsiveDialogFooter>
        </ResponsiveDialogContent>
      </ResponsiveDialog>
    </ConfirmCtx.Provider>
  )
}
