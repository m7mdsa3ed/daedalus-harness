import type { ModelDef, ProfileUsageKind } from "./db/index.js";
import type { PeakSchedule } from "./peak.js";
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
  /** The models.dev provider whose catalog is the plan's. Empty for a provider
      models.dev does not list at all (a decision-only one), where `seedModels`
      is the whole catalog. */
  modelsDevProvider: string;
  /** Models models.dev cannot describe — decision and completion entries, whose
      kind and wire ARE the point. They come first, and a models.dev hit with the
      same id never overwrites one: a provider's catalog calls jev a chat model
      because that is the only shape it has a word for. */
  seedModels?: ModelDef[];
  /** Preferred default, when the catalog has it. */
  defaultModel: string;
  /** Model for the agent's cheap side-jobs, when the plan serves one worth
      naming (see `profiles.smallModel`). */
  smallModel?: string;
  /** The usage reader. `none` for a plan whose provider exposes no account API;
      the row is still worth a preset for the URLs alone. */
  usage: ProfileUsageKind;
  /** A time-of-day rate card the plan bills by, stamped onto every model the
      preset fills (`peak.ts`). The listed `pricing` is the off-peak rate, so
      the schedule says when it doubles. */
  peak?: PeakSchedule;
}

/** What `GET /api/profile-presets` answers: the preset plus its catalog. A
    seeded entry has no models.dev provenance to carry, which is why the array
    is the union rather than the enriched shape. */
export interface ResolvedProfilePreset extends ProfilePreset {
  models: (ModelDef | ModelsDevCandidate)[];
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
    /* Peak is Mon-Fri 14:00-18:00 Singapore time and everything else — nights,
       weekends, holidays — bills at 50% of the standard credit rate. Written in
       the zone the notice is published in rather than converted to UTC, so a
       reader comparing it with the docs sees the same numbers. */
    peak: {
      windows: "Mon-Fri 14:00-18:00 Asia/Singapore",
      when: "peak",
      multiplier: 2,
    },
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
    /* The same plan, the same windows (docs.z.ai and bigmodel.cn publish one
       schedule), read against the global platform's endpoints. */
    peak: {
      windows: "Mon-Fri 14:00-18:00 Asia/Singapore",
      when: "peak",
      multiplier: 2,
    },
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
      "DeepSeek's own platform. Pay-as-you-go, billed by the clock: the listed rate is off-peak and doubles inside two weekday UTC windows. The reading is the account balance, from the documented balance route.",
    keyUrl: "https://platform.deepseek.com/api_keys",
    logoUrl: logo("deepseek"),
    baseUrl: "https://api.deepseek.com",
    agents: withAnthropic("https://api.deepseek.com/anthropic"),
    modelsDevProvider: "deepseek",
    defaultModel: "deepseek-v4-pro",
    usage: "deepseek",
    /* models.dev lists the off-peak rate, so the schedule is the multiplier on
       top of it. Peak windows are 01:00-04:00 and 06:00-10:00 UTC, Monday to
       Friday; weekends and Chinese public holidays are off-peak all day. */
    peak: {
      windows: "Mon-Fri 01:00-04:00, 06:00-10:00 UTC",
      when: "peak",
      multiplier: 2,
    },
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
  /* ── Providers that are not chat at all (docs/plans/model-kinds.md) ──
     Both are ordinary profiles with `kind`/`wire` on their models, which is the
     point: a model that cannot drive a turn still belongs in a catalogue, and
     the thread's own pickers filter it out on `kind`. Nothing special-cases the
     provider, and nothing calls these models yet — the row is the artifact. */
  {
    id: "typesafe-jev",
    name: "TypeSafe (Jev)",
    description:
      "Jev answers typed questions with probabilities and generates no text, so it can never drive a thread. Kev serves the same contract locally: point baseUrl at your own server and keep the wire.",
    keyUrl: "https://typesafe.ai",
    logoUrl: "",
    baseUrl: "https://api.typesafe.ai",
    agents: { [DAEDALUS]: {}, [OPENCODE]: {} },
    modelsDevProvider: "",
    seedModels: [
      {
        id: "jev-1.13.0",
        label: "Jev 1.13",
        reasoningEfforts: [],
        kind: "decision",
        wire: "systemone",
        description: "System One classifier: noul, choice and score questions.",
      },
    ],
    defaultModel: "jev-1.13.0",
    usage: "none",
  },
  {
    id: "deepseek-fim",
    name: "DeepSeek (fill-in-the-middle)",
    description:
      "DeepSeek's FIM endpoint on the /beta base: prompt and suffix in, the text between them out. A completion model is not a thread's model, so it never appears in a thread's picker.",
    keyUrl: "https://platform.deepseek.com/api_keys",
    logoUrl: logo("deepseek"),
    baseUrl: "https://api.deepseek.com/beta",
    agents: { [DAEDALUS]: {} },
    modelsDevProvider: "",
    seedModels: [
      {
        id: "deepseek-v4-pro",
        label: "DeepSeek V4 Pro (FIM)",
        reasoningEfforts: [],
        kind: "completion",
        wire: "openai-completions",
        description: "Fill-in-the-middle completion: prompt + suffix.",
        /* The same rate card as the chat endpoint — one provider, one clock. */
        peak: { windows: "Mon-Fri 01:00-04:00, 06:00-10:00 UTC", when: "peak", multiplier: 2 },
      },
    ],
    defaultModel: "deepseek-v4-pro",
    usage: "none",
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
      const seeds = preset.seedModels ?? [];
      let hits: ModelsDevCandidate[] = [];
      let unreadable = false;
      if (preset.modelsDevProvider) {
        try {
          hits = (await searchModelsDev("", { provider: preset.modelsDevProvider, limit: 200 })).map(toCandidate);
        } catch (err) {
          console.warn(`profile preset ${preset.id}: models.dev unavailable`, err);
          unreadable = true;
        }
      }
      const seeded = new Set(seeds.map((model) => model.id));
      const models = [...seeds, ...hits.filter((hit) => !seeded.has(hit.id))].map((model) =>
        /* The plan's rate card is the plan's, not models.dev's: stamped here so
           a preset-filled profile badges without the user retyping it. */
        preset.peak ? { ...model, peak: preset.peak } : model,
      );
      return {
        ...preset,
        models,
        /* "Unavailable" is only a failure to read when there is nothing to show
           instead — a preset that carries its own models is complete without
           models.dev. */
        modelsUnavailable: unreadable && models.length === 0,
      };
    }),
  );
}
