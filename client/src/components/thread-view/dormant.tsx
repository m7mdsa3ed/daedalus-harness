/* ── Dormant rows ── what stands in for the transcript's virtualization.
   `content-visibility: auto` already skips layout and paint for a row off
   screen, but not what React and the DOM hold for it: the fibers, the nodes,
   a Base UI root per bubble and stamp, the aside walk over its text. A long
   live session grows all of that without limit. So a *settled* row far from
   the viewport keeps its scroller item — its key, `messageId`, registration
   and place in the flow — and swaps only its contents for an empty box of the
   height they last had.

   Not a windowed virtualizer, on purpose: everything here that reads the
   transcript reads the items as in-flow direct children of the content — the
   primitive's prepend restore, `useEarlierAnchor`'s row arithmetic,
   `scrollToMessage` for the rail, the inspector and every jump, the browser's
   own scroll anchoring under the follow pin. A dormant row is still exactly
   that, at its real height, so none of them can tell.

   Who sleeps is the caller's (`eligible` — never the live tail, never the
   newest turns, never in a short thread); when is the observer's: a row more
   than a screen and a half from the viewport, and not one the reader is
   holding — focus in it, a selection through it, a menu or dialog it opened,
   media playing. A held row is left as it is and asked again on its next
   crossing. Rows mount awake, so a replay or a re-fold never draws a blank
   frame; the far ones fall asleep on the observer's first answer.

   Waking is synchronous (`flushSync`) wherever it can be: an observer's
   answer, a programmatic jump (`useTranscriptJump`, which wakes the landing
   before it scrolls), a selection reaching across sleeping rows (or Copy —
   either would otherwise quote only the rows that were mounted), and focus
   arriving on a sleeping row's box from the keyboard. */
import * as React from "react"
import { flushSync } from "react-dom"

import { useMessageScroller } from "@/components/ui/message-scroller"
import { RevivedContext } from "@/lib/row-open"

type OnNear = (near: boolean) => void

export type DormancyRoot = {
  observe: (item: Element, onNear: OnNear) => () => void
  /** Wake the item with this id and enough of its neighbours to fill the
      screen it is about to be scrolled onto. */
  wake: (messageId: string) => void
}

const DormancyContext = React.createContext<DormancyRoot | null>(null)

export const DormancyProvider = DormancyContext.Provider

/** One IntersectionObserver per transcript, over its scroller items. */
export function useDormancyRoot(viewport: HTMLElement | null): DormancyRoot | null {
  const [root, setRoot] = React.useState<DormancyRoot | null>(null)
  React.useEffect(() => {
    if (!viewport) return
    const callbacks = new Map<Element, OnNear>()
    /* In the same task, not the scheduler's next one: an observer's answer
       already lands a frame after the scroll that caused it, and a blank band
       for a second frame is what a fast scroll would see. */
    const wakeAll = (items: Iterable<Element>) => {
      const sleeping = [...items].filter((item) => item.querySelector(":scope > [data-dormant]"))
      if (sleeping.length > 0) flushSync(() => sleeping.forEach((item) => callbacks.get(item)?.(true)))
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const near: Element[] = []
        for (const entry of entries) {
          /* A hidden dock tab (`display: none`) reports every row as far, at
             size 0 — that is "not on screen", not "far", and a row put to
             sleep there would wake to a height of nothing. */
          if (!entry.rootBounds?.height) continue
          if (entry.isIntersecting) near.push(entry.target)
          else callbacks.get(entry.target)?.(false)
        }
        wakeAll(near)
      },
      { root: viewport, rootMargin: "150% 0px" }
    )
    /* A selection that reaches across sleeping rows wakes them, or Copy, "Ask
       about this" and an aside's quote would skip their text. Once inside a
       selection a row is held (`held`), so it stays up while the selection does. */
    const wakeSelected = () => {
      const selection = document.getSelection()
      if (!selection || selection.isCollapsed) return
      const items = Array.from(viewport.querySelectorAll("[data-dormant]"), (box) => box.parentElement!)
      wakeAll(items.filter((item) => selection.containsNode(item, true)))
    }
    let frame = 0
    const onSelectionChange = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(wakeSelected)
    }
    document.addEventListener("selectionchange", onSelectionChange)
    // Copy reads the selection after its handlers: the last chance, synchronously.
    document.addEventListener("copy", wakeSelected, true)
    const wake = (messageId: string) => {
      const target = viewport.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`)
      if (!target) return
      const items = [target]
      const screen = viewport.clientHeight
      // The observer's own reach: a screen and a half above, the same below
      // the screen the jump lands on (it lands at the top).
      let reach = 0
      for (let el = target.previousElementSibling; el && reach < screen * 1.5; el = el.previousElementSibling) {
        items.push(el)
        reach += el.getBoundingClientRect().height
      }
      reach = 0
      for (let el = target.nextElementSibling; el && reach < screen * 2.5; el = el.nextElementSibling) {
        items.push(el)
        reach += el.getBoundingClientRect().height
      }
      wakeAll(items)
    }
    setRoot({
      observe: (item, onNear) => {
        callbacks.set(item, onNear)
        observer.observe(item)
        return () => {
          callbacks.delete(item)
          observer.unobserve(item)
        }
      },
      wake,
    })
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
      document.removeEventListener("selectionchange", onSelectionChange)
      document.removeEventListener("copy", wakeSelected, true)
      setRoot(null)
    }
  }, [viewport])
  return root
}

/* ── Programmatic jumps ──
   The rail, the inspector and the thread dock's Agents panel scroll the
   transcript from outside it, so no gesture is ever recorded and the follow
   pin would stay set: the first row whose size moved under the jump — a row
   waking, a chip landing — handed the viewport back to the end. A jump is the
   reader leaving the tail, so it says so, the way paging back does. */
type JumpPrep = { release: () => void; wake?: (messageId: string) => void }

const JumpPrepContext = React.createContext<JumpPrep | null>(null)

export const JumpPrepProvider = JumpPrepContext.Provider

/** `scrollToMessage` for a jump the reader asked for from outside the
    transcript: wakes the landing, scrolls, and releases the follow pin. */
export function useTranscriptJump() {
  const { scrollToMessage } = useMessageScroller()
  const prep = React.useContext(JumpPrepContext)
  return React.useCallback(
    (messageId: string, options?: Parameters<typeof scrollToMessage>[1]) => {
      prep?.wake?.(messageId)
      const moved = scrollToMessage(messageId, options)
      if (moved) prep?.release()
      return moved
    },
    [prep, scrollToMessage]
  )
}

/** The pin's release, for a row that grows because the reader opened it (a
    folded message). Same bargain as a jump: the growth is what they asked to
    read, so it must not be handed straight back to the end of the transcript. */
export function useFollowRelease(): (() => void) | undefined {
  return React.useContext(JumpPrepContext)?.release
}

/** Whether the reader is holding something in this row. */
function held(el: HTMLElement): boolean {
  if (el.contains(document.activeElement)) return true
  const selection = document.getSelection()
  if (selection && !selection.isCollapsed && selection.containsNode(el, true)) return true
  /* A popup's trigger, not any `aria-expanded`: an opened step is a
     disclosure, and is remembered rather than held (`lib/row-open`). */
  if (el.querySelector("[data-popup-open],[aria-haspopup][aria-expanded='true']")) return true
  return Array.from(el.querySelectorAll<HTMLMediaElement>("audio,video")).some((media) => !media.paused)
}

const FOCUSABLE =
  "a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex='-1'])"

/**
 * A row's contents, asleep while `eligible` and far. Always rendered — the
 * same box in both states, so a row becoming eligible never remounts what it
 * holds. Its parent must be the scroller item, with no vertical padding: the
 * item is what is observed (a box inside a `content-visibility`-skipped item
 * has no fresh geometry to intersect) and its height is what the placeholder
 * keeps — read off a skipped item, that is the size it remembers, and read
 * unrounded, so sleeping and waking moves nothing by a fraction of a pixel.
 *
 * Asleep, the box is one tab stop: keyboard focus arriving on it wakes the row
 * and passes on to the first focusable thing inside (the last, coming back
 * with Shift+Tab), or stays on the box when there is none — so Tab still walks
 * the whole transcript.
 */
export function Dormant({ eligible, children }: { eligible: boolean; children: React.ReactNode }) {
  const root = React.useContext(DormancyContext)
  const ref = React.useRef<HTMLDivElement>(null)
  /* `revived` is set the first time a sleeping row wakes and stays set: its
     contents' entrances are history, so the attribute below turns them off
     (index.css) and `RevivedContext` lets a disclosure restore its answer. */
  const [state, setState] = React.useState<{ height: number | null; revived: boolean }>({
    height: null,
    revived: false,
  })
  React.useEffect(() => {
    const el = ref.current
    const item = el?.parentElement
    if (!eligible || !root || !el || !item) {
      setState((s) => (s.height === null ? s : { height: null, revived: true }))
      return
    }
    return root.observe(item, (near) => {
      if (near) {
        setState((s) => (s.height === null ? s : { height: null, revived: true }))
        return
      }
      if (held(el)) return
      const height = item.getBoundingClientRect().height
      if (height > 0) setState((s) => (s.height === height ? s : { height, revived: s.revived }))
    })
  }, [eligible, root])
  const asleep = state.height !== null
  const onFocus = (event: React.FocusEvent<HTMLDivElement>) => {
    const el = event.currentTarget
    if (event.target !== el) return
    const back =
      event.relatedTarget instanceof Node &&
      (el.compareDocumentPosition(event.relatedTarget) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
    flushSync(() => setState({ height: null, revived: true }))
    const inside = el.querySelectorAll<HTMLElement>(FOCUSABLE)
    const next = back ? inside[inside.length - 1] : inside[0]
    if (next) next.focus()
    else {
      // Nothing to land on: keep focus on the box (no longer a tab stop).
      el.tabIndex = -1
      el.focus()
    }
  }
  return (
    <div
      ref={ref}
      style={asleep ? { height: state.height! } : undefined}
      data-dormant={asleep || undefined}
      tabIndex={asleep ? 0 : undefined}
      role={asleep ? "group" : undefined}
      aria-label={asleep ? "Earlier message" : undefined}
      onFocus={asleep ? onFocus : undefined}
      data-revived={(!asleep && state.revived) || undefined}
    >
      {!asleep && <RevivedContext.Provider value={state.revived}>{children}</RevivedContext.Provider>}
    </div>
  )
}
