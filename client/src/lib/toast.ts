/* ── The one way to raise a toast ──
   `components/ui/toast.tsx` is the shadcn/Base UI component, kept exactly as
   the registry ships it so a later `shadcn add toast` diffs cleanly. Its
   manager speaks one call — `add({ title, description, type, actionProps })` —
   which is the right shape for the renderer and the wrong one for forty call
   sites that each want to say one line about one thing that just happened.
   This module is the sentence form of it, and it is deliberately the SAME
   sentence the app was already written in:

     toast("Moved to Trash", { description: title, action: { label, onClick } })
     toast.success("Copied")
     toast.error("Couldn't clear it", { description: reason })
     toast.dismiss(SOME_ID)

   Two things worth stating about the translation. A fixed `id` UPSERTS — the
   pwa update offer and the notification offer both re-raise the same id and
   expect the toast to be replaced rather than stacked, which is what
   `add({ id })` does. And a `duration` is a `timeout`, where sonner's
   `Infinity` is Base UI's `0` ("never dismiss on your own"): the two libraries
   spell the same idea with opposite sentinels, so the conversion is here and
   nowhere else. */
import type { ReactNode } from "react"
import { toast as manager } from "@/components/ui/toast"

type ToastType = "success" | "info" | "warning" | "error" | "loading"

export interface ToastAction {
  label: ReactNode
  onClick: () => void
}

export interface ToastOptions {
  description?: ReactNode
  /** Fixed id: raising it again replaces the toast in place. */
  id?: string
  /** ms, or `Infinity` for a toast that only closes when told to. */
  duration?: number
  action?: ToastAction
  /** Announce urgently (assertive live region). Errors default to this. */
  priority?: "low" | "high"
  onClose?: () => void
}

/** Base UI counts "no auto-dismiss" as 0; sonner counted it as Infinity, and
    that is the spelling every call site here already uses. */
function timeoutOf(duration: number | undefined): number | undefined {
  if (duration === undefined) return undefined
  return Number.isFinite(duration) ? duration : 0
}

function optionsOf(
  title: ReactNode,
  type: ToastType | undefined,
  options: ToastOptions = {}
): Parameters<typeof manager.add>[0] {
  const { description, id, duration, action, priority, onClose } = options
  return {
    id,
    title,
    description,
    type,
    timeout: timeoutOf(duration),
    priority: priority ?? (type === "error" ? "high" : undefined),
    onClose,
    actionProps: action
      ? { children: action.label, onClick: action.onClick }
      : undefined,
  }
}

function raise(type: ToastType | undefined) {
  return (title: ReactNode, options?: ToastOptions): string =>
    manager.add(optionsOf(title, type, options))
}

/** Promise options in the app's own vocabulary: each state is a line, or the
    full option bag when it needs a description or an action. `error` gets the
    rejection so a failure can say what failed. */
export interface ToastPromiseOptions<T> {
  loading: string | ({ title: ReactNode } & ToastOptions)
  success: string | ((value: T) => string | ({ title: ReactNode } & ToastOptions))
  error: string | ((err: unknown) => string | ({ title: ReactNode } & ToastOptions))
}

function stateOf(
  value: string | ({ title: ReactNode } & ToastOptions),
  type: ToastType
): Parameters<typeof manager.update>[1] {
  // `id` is the add-only half of the shape: a promise's states update the
  // toast the loading state already minted, so carrying one here would name a
  // second toast.
  const { id: _id, ...rest } =
    typeof value === "string" ? optionsOf(value, type) : optionsOf(value.title, type, value)
  return rest
}

const toastBase = raise(undefined)

/**
 * The one toast call. `toast("Saved")`, or with `.success` / `.error` /
 * `.warning` / `.info` / `.loading` for a typed icon.
 */
export const toast = Object.assign(toastBase, {
  message: toastBase,
  success: raise("success"),
  info: raise("info"),
  warning: raise("warning"),
  error: raise("error"),
  loading: raise("loading"),

  /** Close one toast, or every toast when given nothing. */
  dismiss: (id?: string): void => manager.close(id),

  /** Change a toast that is already on screen — how a loading row becomes its
      own result without the stack shuffling underneath the reader. */
  update: (id: string, title: ReactNode, options?: ToastOptions & { type?: ToastType }) =>
    manager.update(id, optionsOf(title, options?.type, options)),

  /**
   * One toast for the whole of an async job: a spinner while it runs, then the
   * same card becomes the outcome. This is the shape any operation with a
   * visible latency should use — a success toast that appears out of nowhere
   * cannot say that the work had *started*, which is the half a slow export or
   * a slow import actually needs to communicate.
   */
  promise: <T>(promise: Promise<T>, options: ToastPromiseOptions<T>): Promise<T> =>
    manager.promise(promise, {
      loading: stateOf(options.loading, "loading"),
      success: (value: T) =>
        stateOf(typeof options.success === "function" ? options.success(value) : options.success, "success"),
      error: (err: unknown) =>
        stateOf(typeof options.error === "function" ? options.error(err) : options.error, "error"),
    }),

  /** The renderer's own manager, for anything this vocabulary doesn't cover. */
  manager,
})
