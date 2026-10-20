/* A side lane's chosen (profile, model): the completion model that finishes the
   line being typed, and the decision model a typed question would go to
   (`server/src/side-models.ts`, docs/plans/fim-composer.md).

   Unlike the other AI helpers this is **not** a device-local pick. A completion
   or decision model is a row inside a profile, so the pair is a fact about the
   install's catalogue, and two devices disagreeing about which model finishes a
   line would be two different products. One value, stored server-side, and a
   write invalidates the key rather than patching the cache. */
import { api, type ServerSettings } from "@/lib/settings"
import { useServer } from "@/lib/server-context"
import { sideModelKey } from "./keys"
import { useApiMutation, useApiQuery } from "./helpers"

export type SideLane = "completion" | "decision"

/** One (profile, model) pair the lane could use. */
export interface SideChoice {
  profileId: string
  profileName: string
  model: string
  label: string
}

/** What the lane answers with: the choice in force, where it came from, and
    everything it could be. */
export interface SideModel {
  default: SideChoice | null
  /** `fallback` = nobody has chosen, so the server picked the first candidate.
      It runs either way; the word says whether a person decided. */
  source: "explicit" | "fallback" | null
  candidates: SideChoice[]
}

/** The door each lane answers on. The completion lane's is also its call. */
const PATH: Record<SideLane, string> = { completion: "/api/fim", decision: "/api/decision" }

const EMPTY: SideModel = { default: null, source: null, candidates: [] }

export function useSideModel(lane: SideLane): SideModel {
  const settings = useServer()
  const { data } = useApiQuery<SideModel>(sideModelKey(settings, lane), PATH[lane], {
    staleTime: 30_000,
  })
  /* A persisted dump can hold a body of the wrong shape (`queries/persist.ts`);
     empty is what "not yet" already draws. */
  if (!data || typeof data !== "object") return EMPTY
  return {
    default: data.default ?? null,
    source: data.source ?? null,
    candidates: Array.isArray(data.candidates) ? data.candidates : [],
  }
}

/** Set the lane's pair, or clear it back to the fallback with `null`. */
export function useSetSideModel(lane: SideLane) {
  const settings = useServer()
  return useApiMutation<{ profileId: string; model: string } | null, Omit<SideModel, "candidates">>(
    [sideModelKey(settings, lane)],
    (s: ServerSettings, input) =>
      input === null
        ? api<Omit<SideModel, "candidates">>(s, PATH[lane], { method: "DELETE" })
        : api<Omit<SideModel, "candidates">>(s, PATH[lane], { method: "PUT", body: JSON.stringify(input) }),
  )
}
