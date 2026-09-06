import type { ProfileUsageKind } from "./db/index.js";
import { searchModelsDev, toCandidate, type ModelsDevCandidate } from "./models-dev.js";

/*
 * Profile presets — the coding plans a provider sells, as a profile to start
 * from.
 *
 * A profile is a provider (CLAUDE.md), and a coding plan is a provider with
 * everything already decided: which host each runtime talks to (the plans
 * serve Claude Code at an Anthropic-shaped path and everything else at an
 * OpenAI-shaped one), which model ids the plan admits (often a different,
 * shorter list than the pay-as-you-go catalog on the same key), and which
 * account API reports what is left of it (`ProfileUsage.kind`). Typing all of
 * that by hand is the failure this file exists for: a z.ai key pointed at
 * `api.z.ai/api/paas/v4` instead of `/api/coding/paas/v4` works, bills the
 * pay-as-you-go balance instead of the plan, and reads back as "no plan" —
 * three silent wrongs from one path segment.
 *
 * Three rules.
 *
 * **A preset is a starting point, never a stored kind.** Picking one fills the
 * new-profile form; what gets saved is an ordinary profile, with no `presetId`
 * on it. The form stays the one place a profile is described, a preset the
 * harness later changes does not rewrite what someone saved, and a saved
 * profile can drift from its preset by any edit without a "detached" state to
 * reason about.
 *
 * **Models come from models.dev, not from here.** Each preset names the
 * models.dev provider that *is* the plan (`zai-coding-plan`, not `zai` — the
 * plan is listed separately there because its catalog and endpoint differ),
 * and the route fills `models` from that entry at request time through the
 * same `searchModelsDev`/`toCandidate` the editor's "Fill from models.dev"
 * uses. A model list written here would be stale by the next release; a dead
 * models.dev degrades to an empty list, and the form still offers the
 * "Fetch from endpoint" button.
 *
 * **Every URL is per runtime.** `baseUrl` is the OpenAI-compatible endpoint
 * (Daedalus Agent, OpenCode, and Codex through the shim) and `agents` names
 * the Anthropic-compatible one for Claude Code, exactly as `profiles.agents`
 * stores it, so filling the form is a copy and not a translation. A runtime a
 * plan does not serve is left out of `agents`, and the form leaves it off.
 */

export interface ProfilePreset {
  /** Stable id, for the picker; never stored on a profile. */
  id: string;
  name: string;
  /** One line under the name: what the plan is and what it meters. */
  description: string;
  /** Where the key comes from — shown as a link beside the API-key field. */
  keyUrl: string;
  /** models.dev provider mark, the same URL a hand-made profile would paste. */
  logoUrl: string;
  /** The OpenAI-compatible endpoint (chat completions). */
  baseUrl: string;
  /** Per-agent base URLs, in the shape `profiles.agents` stores. Only the
      agents the plan serves; an empty link means "the shared baseUrl". */
  agents: Record<string, { baseUrl?: string }>;
  /** The models.dev provider whose catalog is the plan's. */
  modelsDevProvider: string;
  /** Preferred default, when the catalog has it. */
  defaultModel: string;
  /** Model for the agent's cheap side-jobs, when the plan serves one worth
      naming (see `profiles.smallModel`). */
  smallModel?: string;
  /** The usage reader. `none` for a plan whose provider exposes no account API;
      the row is still worth a preset for the URLs alone. */
  usage: ProfileUsageKind;
}

/** What `GET /api/profile-presets` answers: the preset plus its catalog. */
export interface ResolvedProfilePreset extends ProfilePreset {
  models: ModelsDevCandidate[];
  /** True when models.dev could not be reached, so an empty `models` is a
      failure to read and not a plan with no models. */
  modelsUnavailable: boolean;
}

const logo = (provider: string) => `https://models.dev/logos/${provider}.svg`;

/*
 * The runtimes as `DEFAULT_AGENTS` registers them (registry.ts). Codex is
 * listed on a plan only when the plan serves the Responses API, because codex
 * ≥ 0.148 speaks nothing else (see the codex entry in registry.ts); the shim
 * forwards it, it does not translate it.
 */
const CLAUDE = "claude-code";
const CODEX = "codex";
const OPENCODE = "opencode";
const DAEDALUS = "daedalus";

/** OpenAI-shaped runtimes on the shared base URL, plus Claude Code on the
    plan's Anthropic path. */
const withAnthropic = (anthropicUrl: string, codex = false): ProfilePreset["agents"] => ({
  [CLAUDE]: { baseUrl: anthropicUrl },
  ...(codex ? { [CODEX]: {} } : {}),
  [OPENCODE]: {},
  [DAEDALUS]: {},
});

export const PROFILE_PRESETS: ProfilePreset[] = [
  {
    id: "zai-coding-plan",
    name: "Z.AI GLM Coding Plan",
    description:
      "GLM models on Z.AI's global coding plan. Meters a rolling 5-hour token window and a weekly one, plus a monthly MCP tool allowance.",
    keyUrl: "https://z.ai/manage-apikey/apikey-list",
    logoUrl: logo("zai"),
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    agents: withAnthropic("https://api.z.ai/api/anthropic"),
    modelsDevProvider: "zai-coding-plan",
    defaultModel: "glm-5.3",
    usage: "zai",
  },
  {
    id: "zhipu-coding-plan",
    name: "Zhipu GLM Coding Plan (China)",
    description:
      "The same plan on the bigmodel.cn platform, whose keys are not the global platform's. Same windows, read from the CN monitor route.",
    keyUrl: "https://bigmodel.cn/usercenter/proj-mgmt/apikeys",
    logoUrl: logo("zhipuai"),
    baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
    agents: withAnthropic("https://open.bigmodel.cn/api/anthropic"),
    modelsDevProvider: "zhipuai-coding-plan",
    defaultModel: "glm-5.3",
    usage: "zai",
  },
  {
    id: "minimax-coding-plan",
    name: "MiniMax Coding Plan",
    description:
      "MiniMax models on the global (minimax.io) coding plan. Meters a rolling 5-hour window of requests per model.",
    keyUrl: "https://platform.minimax.io/user-center/basic-information/interface-key",
    logoUrl: logo("minimax"),
    baseUrl: "https://api.minimax.io/v1",
    agents: withAnthropic("https://api.minimax.io/anthropic"),
    modelsDevProvider: "minimax-coding-plan",
    defaultModel: "MiniMax-M3",
    usage: "minimax",
  },
  {
    id: "minimax-cn-coding-plan",
    name: "MiniMax Coding Plan (China)",
    description: "The same plan on minimaxi.com, whose keys are not the global platform's.",
    keyUrl: "https://platform.minimaxi.com/user-center/basic-information/interface-key",
    logoUrl: logo("minimax"),
    baseUrl: "https://api.minimaxi.com/v1",
    agents: withAnthropic("https://api.minimaxi.com/anthropic"),
    modelsDevProvider: "minimax-cn-coding-plan",
    defaultModel: "MiniMax-M3",
    usage: "minimax",
  },
  {
    id: "kimi-for-coding",
    name: "Kimi For Coding",
    description:
      "Moonshot's Kimi coding plan. Meters a rolling 5-hour window and a weekly one, in requests, read from the plan's own usage route.",
    keyUrl: "https://www.kimi.com/code/console",
    logoUrl: logo("moonshotai"),
    baseUrl: "https://api.kimi.com/coding/v1",
    agents: withAnthropic("https://api.kimi.com/coding"),
    modelsDevProvider: "kimi-for-coding",
    defaultModel: "kimi-for-coding",
    usage: "kimi",
  },
  {
    id: "alibaba-coding-plan",
    name: "Alibaba Model Studio Coding Plan",
    description:
      "Qwen (and partner) models on the international coding plan. Its quota is only readable from a signed-in console, so no usage bar here.",
    keyUrl: "https://modelstudio.console.alibabacloud.com/?tab=coding#/coding-plan",
    logoUrl: logo("alibaba"),
    baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
    agents: withAnthropic("https://coding-intl.dashscope.aliyuncs.com/apps/anthropic"),
    modelsDevProvider: "alibaba-coding-plan",
    defaultModel: "qwen3.7-max",
    // The console's quota route answers `ConsoleNeedLogin` to a bare API key
    // (verified against the intl gateway); the reading needs a browser
    // session, which the harness will not hold. Endpoints only.
    usage: "none",
  },
  {
    id: "alibaba-coding-plan-cn",
    name: "Alibaba Bailian Coding Plan (China)",
    description: "The same plan on the China-region platform, whose keys are not the international one's.",
    keyUrl: "https://bailian.console.aliyun.com/?tab=coding#/coding-plan",
    logoUrl: logo("alibaba"),
    baseUrl: "https://coding.dashscope.aliyuncs.com/v1",
    agents: withAnthropic("https://coding.dashscope.aliyuncs.com/apps/anthropic"),
    modelsDevProvider: "alibaba-coding-plan-cn",
    defaultModel: "qwen3.7-max",
    usage: "none",
  },
  {
    id: "synthetic",
    name: "Synthetic",
    description:
      "Open-weight models on Synthetic's flat-rate plan. Meters a rolling 5-hour window of requests and a monthly search allowance.",
    keyUrl: "https://synthetic.new/settings/api-keys",
    logoUrl: logo("synthetic"),
    baseUrl: "https://api.synthetic.new/openai/v1",
    agents: withAnthropic("https://api.synthetic.new/anthropic"),
    modelsDevProvider: "synthetic",
    defaultModel: "hf:moonshotai/Kimi-K3",
    usage: "synthetic",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    description:
      "DeepSeek's own platform. Pay-as-you-go, so no windows — the reading is the account balance, from the documented balance route.",
    keyUrl: "https://platform.deepseek.com/api_keys",
    logoUrl: logo("deepseek"),
    baseUrl: "https://api.deepseek.com",
    agents: withAnthropic("https://api.deepseek.com/anthropic"),
    modelsDevProvider: "deepseek",
    defaultModel: "deepseek-v4-pro",
    usage: "deepseek",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    description:
      "Every model through one key. Pay-as-you-go credits; the reading is the key's own spend and limit, from the documented key route.",
    keyUrl: "https://openrouter.ai/settings/keys",
    logoUrl: logo("openrouter"),
    baseUrl: "https://openrouter.ai/api/v1",
    agents: withAnthropic("https://openrouter.ai/api", true),
    modelsDevProvider: "openrouter",
    defaultModel: "anthropic/claude-sonnet-5",
    usage: "openrouter",
  },
];

export function getProfilePreset(id: string): ProfilePreset | undefined {
  return PROFILE_PRESETS.find((p) => p.id === id);
}

/**
 * The presets with their catalogs attached. One models.dev read serves every
 * preset (the catalog is cached in models-dev.ts), and an unreachable
 * models.dev answers every preset with `modelsUnavailable` rather than
 * failing the list — the URLs and the usage reader are still worth having.
 */
export async function resolveProfilePresets(): Promise<ResolvedProfilePreset[]> {
  return Promise.all(
    PROFILE_PRESETS.map(async (preset) => {
      try {
        const hits = await searchModelsDev("", { provider: preset.modelsDevProvider, limit: 200 });
        return { ...preset, models: hits.map(toCandidate), modelsUnavailable: false };
      } catch (err) {
        console.warn(`profile preset ${preset.id}: models.dev unavailable`, err);
        return { ...preset, models: [], modelsUnavailable: true };
      }
    }),
  );
}
