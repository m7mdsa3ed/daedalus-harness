import * as React from "react"
import { api, type ServerSettings } from "./settings"

/**
 * Live journals of background tasks — work a tool call launched that outlives
 * its turn (see `lib/tools.extractBackgroundTask`). Keyed by the task's
 * transcript dir on the server. Same reactive shape as `pins.ts`, but
 * runtime-only: the server's watch endpoint answers with the whole journal
 * from disk, so there is nothing to persist — a reload re-reads it.
 *
 * Written from two directions: `watchTask` replaces a journal with the watch
 * response, and the `task_event` thread event appends lines
 * as the server's tail sees them (wired in `actions.makeCallbacks`).
 */

export interface TaskEvent {
  type?: string
  agentId?: string
  [key: string]: unknown
}

const journals = new Map<string, TaskEvent[]>()
const listeners = new Set<() => void>()
const EMPTY: TaskEvent[] = []

function notify() {
  for (const listener of listeners) listener()
}

export function setTaskEvents(dir: string, events: TaskEvent[]): void {
  journals.set(dir, events)
  notify()
}

/** Append one live event. The watch response and the live stream can overlap
    around the moment the watch was placed, so an exact duplicate is dropped. */
export function appendTaskEvent(dir: string, event: TaskEvent): void {
  const current = journals.get(dir) ?? []
  const key = JSON.stringify(event)
  if (current.some((existing) => JSON.stringify(existing) === key)) return
  journals.set(dir, [...current, event])
  notify()
}

export function useTaskEvents(dir: string): TaskEvent[] {
  return React.useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    () => journals.get(dir) ?? EMPTY
  )
}

const inflight = new Map<string, Promise<void>>()

/**
 * Ask the server to tail this task's journal and load what it holds so far.
 * Idempotent on both ends; panels re-call it on an interval, which keeps the
 * server's tail alive and backfills anything a missed notification dropped.
 * Several mounted panels for one dir share a single in-flight request.
 */
export function watchTask(settings: ServerSettings, dir: string): Promise<void> {
  const running = inflight.get(dir)
  if (running) return running
  const request = api<{ events: TaskEvent[] }>(settings, "/api/tasks/watch", {
    method: "POST",
    body: JSON.stringify({ transcriptDir: dir }),
  })
    .then(({ events }) => setTaskEvents(dir, events))
    .finally(() => inflight.delete(dir))
  inflight.set(dir, request)
  return request
}
