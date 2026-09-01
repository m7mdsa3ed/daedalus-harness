import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.js";
import type { ModelDef } from "./db/schema.js";

/**
 * A profile's model catalog, in the shape Codex reads.
 *
 * Codex does not take a model's context window as a number and stop asking: it
 * looks the *slug* up in its own built-in catalog, and a slug it has never heard
 * of — which is every id a gateway serves — falls through to
 *
 *   Model metadata for `cmc/MiniMaxAI/MiniMax-M3` not found. Defaulting to
 *   fallback metadata; this can degrade performance and cause issues.
 *
 * That is not cosmetic. The fallback carries a made-up context window, so
 * compaction fires at the wrong point, and it carries no reasoning levels, which
 * is exactly the "an unknown gateway model id yields no effort selector at all"
 * problem CLAUDE.md describes. Setting `model_context_window` does NOT silence
 * it — the lookup happens first and warns either way (verified against
 * codex-cli 0.148.0).
 *
 * The one thing that does is `model_catalog_json`: a path to a catalog file that
 * *replaces* the built-in one. So a profile that overrides the agent's models
 * gets its catalog written out here and pointed at, and the profile becomes the
 * whole catalog — which is what a profile with a `models[]` already means.
 *
 * The notice itself can additionally be *hidden* where the catalog cannot reach
 * codex (a build with no `debug models`: the warning then means "the file the
 * profile would describe could not be written", which no user action fixes):
 * a profile's `suppressModelMetadataWarning` flag asks the bridge to drop the
 * matching update before it is journaled (acp-bridge.ts). That is a cosmetic
 * on/off for humans, not metadata — the lookup and the fallback still happen.
 *
 * An entry has to carry far more than metadata (`base_instructions` is
 * mandatory, and it is Codex's entire system prompt), so we do not invent one:
 * `codex debug models` prints the built-in catalog, and each entry is that
 * catalog's own flagship model with the identity and the numbers swapped. The
 * gateway model is then described to Codex exactly as Codex describes itself.
 */

/** Where the generated catalogs go — beside the database, in the gitignored data dir. */
const CATALOG_DIR = join(DATA_DIR, "model-catalogs");

/**
 * The Codex CLI to ask for the built-in catalog. Not the agent's own command:
 * that is `codex-acp`, the ACP adapter, which has no `debug models`. If `codex`
 * is not on PATH there is no template, and we write no catalog and change
 * nothing — the warning stays, which is where we started.
 */
const CODEX_CLI = process.env.DAEDALUS_CODEX_CLI ?? "codex";

interface ReasoningLevel {
  effort: string;
  description?: string;
}

interface CodexModel {
  slug: string;
  priority?: number;
  supported_in_api?: boolean;
  supported_reasoning_levels?: ReasoningLevel[];
  [key: string]: unknown;
}

/** null = asked and there is none; undefined = not asked yet. Cached for the
    process because it costs a spawn and only changes when the binary does. */
let template: CodexModel | null | undefined;

function codexTemplate(): CodexModel | null {
  if (template !== undefined) return template;
  template = null;
  try {
    const raw = execFileSync(CODEX_CLI, ["debug", "models"], {
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const models = (JSON.parse(raw).models ?? []) as CodexModel[];
    template =
      models
        .filter((m) => m.supported_in_api !== false)
        .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))[0] ?? null;
  } catch {
    template = null; // no codex on PATH, or a version with no `debug models`
  }
  return template;
}

/** The template's own wording for an effort level, so "high" reads the way it
    reads everywhere else in Codex. An effort the template does not have (a
    gateway's own name for one) falls back to the bare name. */
function entryFor(base: CodexModel, model: ModelDef, index: number): CodexModel {
  const described = new Map(
    (base.supported_reasoning_levels ?? []).map((l) => [l.effort, l.description]),
  );
  const efforts = model.reasoningEfforts ?? [];
  /* Dropped rather than copied: these are the built-in model's *promotional*
     fields — the upgrade nudge, the "what's new" blurb, the speed tiers and
     service tiers the endpoint behind a gateway does not sell. */
  const { upgrade, availability_nux, additional_speed_tiers, service_tiers, ...rest } = base;
  void upgrade;
  void availability_nux;
  void additional_speed_tiers;
  void service_tiers;
  return {
    ...rest,
    slug: model.id,
    display_name: model.label,
    // A models.dev-enriched profile carries a real blurb; otherwise the label
    // is still better than nothing.
    description: model.description ?? model.label,
    visibility: "list",
    supported_in_api: true,
    // The profile's order is the menu's order.
    priority: index + 1,
    ...(model.contextWindow
      ? { context_window: model.contextWindow, max_context_window: model.contextWindow }
      : {}),
    supported_reasoning_levels: efforts.map((effort) => ({
      effort,
      description: described.get(effort) ?? effort,
    })),
    // No efforts listed is a real answer: this model has no reasoning control.
    default_reasoning_level: efforts[0] ?? null,
    // The flagship runs its MCP servers in *code mode* (`tool_mode:
    // "code_mode_only"`, codex-cli 0.148+): the tools are folded into a
    // namespace the model drives through `codex-code-mode-host`, not offered
    // as `mcp__<server>__<tool>` functions. That is a contract with GPT-5.6
    // and the real Responses API; a gateway model gets the namespace, calls
    // it as a function and codex answers `unsupported call: mcp__web_search`
    // — the harness's own web search, linked and running, unreachable. Every
    // non-flagship built-in carries `null` here, which is plain function
    // calling; a gateway model is described like those.
    tool_mode: null,
  };
}

/**
 * Write a profile's models out as a Codex catalog and return its path, or
 * undefined when there is nothing to say — a profile with no `models[]` defers
 * to the agent (see CLAUDE.md), and a missing `codex` binary leaves us with no
 * template to build from. Either way the caller's placeholder resolves empty and
 * the whole `model_catalog_json` key prunes out of CODEX_CONFIG.
 *
 * One file per profile, rewritten on every spawn: it is derived state, and the
 * profile is what it is derived from.
 */
export function writeCodexModelCatalog(profileId: string, models: ModelDef[]): string | undefined {
  if (!models.length) return undefined;
  const base = codexTemplate();
  if (!base) return undefined;
  mkdirSync(CATALOG_DIR, { recursive: true });
  const path = join(CATALOG_DIR, `${profileId.replace(/[^\w.-]/g, "_")}.json`);
  writeFileSync(path, JSON.stringify({ models: models.map((m, i) => entryFor(base, m, i)) }));
  // The path is substituted into a JSON string, so a Windows backslash would
  // escape its way out of it. Codex takes forward slashes on every platform.
  return path.replace(/\\/g, "/");
}
