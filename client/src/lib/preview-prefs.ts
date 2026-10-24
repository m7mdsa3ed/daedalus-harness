/* ── How the Preview panel's explorer is drawn ──
   Device-local, like every other reader's property: whether the tree is open
   beside the preview, how wide it was dragged, and whether dotfiles and
   git-ignored directories are listed. It is deliberately not part of a panel's
   descriptor, which is where a thing being *read* is kept — how wide a pane is
   is the reader's, follows them to every Preview they open, and must not travel
   in a layout saved on another machine. */
import { createLocalStore } from "@/lib/local-store"

export interface PreviewPrefs {
  /** The tree is drawn beside the preview. Ignored where the panel is too narrow for one. */
  explorer: boolean
  /** Its width in pixels, as the divider last left it. */
  width: number
  /** List dotfiles. */
  hidden: boolean
  /** List what `.gitignore` covers — `node_modules`, build output. */
  ignored: boolean
}

/** The narrowest a tree is worth drawing at, and the widest it may be dragged. */
export const TREE_WIDTH = { min: 160, max: 480, default: 260 }

const DEFAULTS: PreviewPrefs = {
  explorer: true,
  width: TREE_WIDTH.default,
  hidden: false,
  ignored: false,
}

export const previewPrefs = createLocalStore<PreviewPrefs>(
  "daedalus.preview.explorer",
  (raw) => {
    const value = (raw ?? {}) as Partial<PreviewPrefs>
    const bool = (key: keyof PreviewPrefs) =>
      typeof value[key] === "boolean" ? (value[key] as boolean) : (DEFAULTS[key] as boolean)
    const width =
      typeof value.width === "number" && Number.isFinite(value.width)
        ? Math.min(TREE_WIDTH.max, Math.max(TREE_WIDTH.min, Math.round(value.width)))
        : DEFAULTS.width
    return { explorer: bool("explorer"), width, hidden: bool("hidden"), ignored: bool("ignored") }
  },
  DEFAULTS
)

export const setPreviewPrefs = (patch: Partial<PreviewPrefs>) =>
  previewPrefs.set({ ...previewPrefs.get(), ...patch })
