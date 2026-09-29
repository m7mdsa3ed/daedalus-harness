import type { StagedConfig } from "@daedalus/protocol"
import { api, type SessionMeta } from "../settings"
import type { ActionsCore } from "./core"

export type LinkKey = "mcpServerIds" | "skillIds" | "commandIds"

export function linkActions(core: ActionsCore) {
  const { settings, dispatch, recordError } = core
  return {
    async changeThreadLink(meta: SessionMeta, key: LinkKey, ids: string[]) {
      try {
        const reply = await api<{ staged: StagedConfig }>(
          settings,
          `/api/sessions/${meta.id}/links`,
          { method: "PATCH", body: JSON.stringify({ key, ids }) },
        )
        dispatch({ type: "staged-config", id: meta.id, config: reply.staged })
      } catch (error) {
        recordError(meta.id, error, "Couldn't update this thread's tools")
        throw error
      }
    },
  }
}
