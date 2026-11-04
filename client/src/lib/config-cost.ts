/* ── What a settings change on a started thread costs ──
   Two questions the reader weighs before picking: does the agent restart, and
   does the provider's prompt cache start over (the next call bills the whole
   history uncached once). Both are the harness's own facts about its settings
   — `applyConfigLive` decides the restart from the agent row's `liveConfig`,
   and what moves the prompt prefix is what the spawn text and tool list carry
   — so they are read here, never from a vendor name. The agent's own options
   (mode and the rest) are not ours to know and carry no cost. A draft has no
   cache to lose, so only a started thread's menu draws these. */
export type ConfigSetting = "profile" | "model" | "effort" | "persona" | "mcp" | "suggestions" | "ui" | "helpers"

export interface ConfigCost {
  /** `"maybe"`: decided by something the menu cannot see (a gateway). */
  restarts: boolean | "maybe"
  cache: "kept" | "lost" | "maybe"
  /** The sentence the menu shows. */
  text: string
}

/** `live`: the process can take the change as it is — the agent row's
    `liveConfig` for a harness pick, always for the agent's own selector. */
export function configCost(setting: ConfigSetting, live: boolean): ConfigCost {
  switch (setting) {
    case "profile":
      return { restarts: live ? "maybe" : true, cache: "lost", text: live ? "May restart the agent. The prompt cache starts over on another provider." : "Restarts the agent. The prompt cache starts over on another provider." }
    case "model":
      return { restarts: !live, cache: "lost", text: `${live ? "No restart, but the" : "Restarts the agent. The"} prompt cache starts over: it is per model.` }
    case "effort":
      return { restarts: !live, cache: "maybe", text: `${live ? "No restart." : "Restarts the agent."} Some providers drop the cached history when the thinking budget changes.` }
    case "persona":
      return { restarts: false, cache: "kept", text: "No restart, and the prompt cache is kept: the change rides your next message." }
    case "mcp":
      return { restarts: true, cache: "lost", text: "Restarts the agent. The prompt cache starts over: the tool list heads the prompt." }
    case "suggestions":
    case "ui":
      return { restarts: true, cache: "lost", text: "Restarts the agent. The prompt cache starts over: these are system-prompt text." }
    case "helpers":
      return { restarts: true, cache: "maybe", text: "Restarts the agent. A new model for a role keeps the cache; adding or removing a role starts it over." }
  }
}

/** Whether a change is worth warning about at a glance. */
export const isCostly = (cost: ConfigCost) => cost.restarts !== false || cost.cache !== "kept"
