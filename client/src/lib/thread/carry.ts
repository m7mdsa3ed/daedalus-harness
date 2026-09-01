import type { ThreadItem } from "../store"

/**
 * Rows the journal cannot produce, and that a re-fold must therefore keep.
 *
 * A non-resumed attach replaces the transcript — it has to, or a windowed
 * replay would be appended onto a stale one and every event in the overlap
 * would draw twice. But two kinds of row are *this device's* and exist nowhere
 * on the server, so replacing the transcript deleted them outright:
 *
 * - **A user bubble marked `local` and with no `turnId`** is a prompt this device
 *   has drawn and the server has not yet acknowledged. This device is the one
 *   peer that never receives a `turn_started` for its own words (the
 *   origin-peer exclusion), so
 *   there is nothing in the replay to redraw it from. On the first message of a
 *   new thread that is guaranteed: the attach happens *before* the prompt is
 *   dispatched, so the replay is empty and the message simply vanished. It was
 *   patched by re-dispatching the bubble afterwards if a heuristic could tell it
 *   had gone — which worked for the one path that ran the heuristic, and for no
 *   other.
 * - **An error row this client wrote** (`local`) is its own account of a
 *   failure, never journaled and, before this, wiped with no restoration at all.
 *   That is the whole of how a failed send became an empty thread: the failure
 *   was recorded, the attach that followed replaced the transcript, and the
 *   evidence went with it.
 *
 * A journaled error — the one a `turn_ended` carries — is deliberately *not*
 * carried: the replay brings it back on its own, and carrying it too would show
 * it twice.
 *
 * `local` is what makes the user half of that test correct, and it was not always
 * there. A bubble rebuilt from a `session/load` replay has no `turnId` either —
 * the agent replays the conversation as `user_message_chunk`s, and a `turnId` is
 * minted by the harness's own `turn_started`, which is not part of a replay — so
 * every message of a revived thread looked exactly like an unacknowledged prompt.
 * Continuing an old thread therefore reset the transcript, re-folded it, and then
 * appended the entire user side of the conversation to the bottom of it, as if
 * all of it had just been sent. It looked right again after a reload only because
 * a reload starts with an empty store and so has nothing to carry.
 */
export function carryOf(items: ThreadItem[]): ThreadItem[] {
  return items.filter(
    (item) =>
      (item.kind === "user" && !item.turnId && item.local === true) ||
      (item.kind === "error" && item.local === true)
  )
}

/**
 * Which carried rows are still missing from the transcript that replaced them.
 *
 * Matched by item id, which is minted per row and never reused, so a fold that
 * happens to contain the same text does not silently absorb a different message.
 *
 * The one case this does not cover: a prompt that reached the server and was
 * journaled while its reply was still in flight, on a device that re-attached in
 * that window. The bubble is untagged (the reply is what tags it), so it is
 * carried, and the replay also contains the `turn_started` — two bubbles for one
 * message. It is a narrow race, it is visible, and it is recoverable by a
 * reload; the alternative — matching on text — would silently drop the second of
 * two identical messages, and losing a message the user typed is the failure
 * this whole mechanism exists to prevent.
 */
export function unclaimed(carry: ThreadItem[], folded: ThreadItem[]): ThreadItem[] {
  if (carry.length === 0) return carry
  const present = new Set(folded.map((item) => item.id))
  return carry.filter((item) => !present.has(item.id))
}
