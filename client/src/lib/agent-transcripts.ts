import * as React from "react"
import { api, type ServerSettings } from "./settings"

/**
 * The transcripts of a native workflow's agents, keyed by
 * `<transcriptDir>|<agentId>`.
 *
 * A Claude Code dynamic workflow runs its agents inside the CLI: they have no
 * session the harness can open and produce no ACP frames, so nothing about
 * what they *did* ever crosses the wire. It is on the server's disk instead,
 * one file per agent beside the run's journal, which `/api/tasks/agent` reads
 * back whole.
 *
 * Same shape as `task-events.ts` and for the same reasons: a module store
 * rather than the reducer, because these are keyed by a directory rather than
 * by a thread and nothing in the transcript's own state depends on them, and
 * runtime-only, because the file on disk is the durable copy — a reload
 * re-reads it.
 *
 * Fetched only when a step is opened. A run of thirty agents is thirty files
 * of a few hundred KB each, and a reader opens one.
 */
const transcripts = new Map<string, unknown[]>()
const listeners = new Set<() => void>()
const EMPTY: unknown[] = []

const keyOf = (dir: string, agentId: string): string => `${dir}|${agentId}`

export function useAgentTranscript(dir: string, agentId: string): unknown[] {
  return React.useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    () => transcripts.get(keyOf(dir, agentId)) ?? EMPTY
  )
}

const inflight = new Map<string, Promise<void>>()

/**
 * Read one agent's transcript, once per (dir, agent) at a time.
 *
 * A live agent's file grows, so a caller may ask again — `force` re-reads it
 * where the default answers from what is already held, which is what keeps an
 * open step from re-fetching on every render.
 */
export function loadAgentTranscript(
  settings: ServerSettings,
  dir: string,
  agentId: string,
  force = false
): Promise<void> {
  const key = keyOf(dir, agentId)
  const running = inflight.get(key)
  if (running) return running
  if (!force && transcripts.has(key)) return Promise.resolve()
  const request = api<{ events: unknown[] }>(settings, "/api/tasks/agent", {
    method: "POST",
    body: JSON.stringify({ transcriptDir: dir, agentId }),
  })
    .then(({ events }) => {
      transcripts.set(key, events)
      for (const listener of listeners) listener()
    })
    .finally(() => inflight.delete(key))
  inflight.set(key, request)
  return request
}
