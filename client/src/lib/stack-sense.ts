/* ── Stack sensing ──
 *
 * The build page used to open on a starter picker: three cards, one selected
 * by default, and a prompt that said "a Flask API for my inventory" was still
 * scaffolded from React + Hono unless the user noticed. This module reads the
 * prompt and answers the question the picker asked: *which starter, or none*.
 *
 * Pure, so it runs on every keystroke against the cached template list and
 * needs no route. Two vocabularies decide:
 *
 *   - **Stacks no starter ships** (`FOREIGN_STACKS`, here — they are about the
 *     world, not about any one template). A prompt naming one is answered
 *     `scratch` with the stack's display name, and the server writes it into
 *     the project's AGENTS.md so the agent starts on that stack.
 *   - **Each starter's `signals`** (in its `template.json` — the template's
 *     author owns what points at it). Every hit scores; a multi-word phrase
 *     scores double because it is the more specific claim ("landing page"
 *     beats "page"). Highest total wins; a tie goes to the lower `sortOrder`,
 *     which is also the fallback when nothing matched — the list's first card
 *     is the harness's own default, as it was before sensing existed.
 *
 * A foreign stack outranks any signal score: "a Next.js landing page" is a
 * Next.js project, not a static site with the word "Next.js" in the brief.
 * Matching is on word boundaries, case-insensitive, so "reacting" is not
 * "react" and "godot" is not "go".
 *
 * The answer is a *suggestion*, drawn as such: `reason` is the one line the
 * page shows under the sensed card ("matched: api, login"), and the user's
 * explicit pick always wins over it (`build-page.tsx`).
 */
import type { Template } from "@/lib/settings"

export type StackSense =
  | { kind: "template"; template: Template; matched: string[]; reason: string }
  | { kind: "scratch"; stack: string | null; matched: string[]; reason: string }

/**
 * Stacks the harness has no starter for, by display name. The first entry of
 * each list is the display name written into AGENTS.md; the rest are the
 * spellings a prompt might use. Order matters only for the reason line.
 */
const FOREIGN_STACKS: readonly (readonly string[])[] = [
  ["Next.js", "next.js", "nextjs", "next js"],
  ["Nuxt", "nuxt", "nuxt.js", "nuxtjs"],
  ["Vue", "vue", "vue.js", "vuejs"],
  ["SvelteKit", "sveltekit", "svelte kit"],
  ["Svelte", "svelte"],
  ["Astro", "astro"],
  ["Angular", "angular"],
  ["SolidJS", "solid.js", "solidjs", "solid js"],
  ["Qwik", "qwik"],
  ["Remix", "remix"],
  ["React Router", "react router"],
  ["TanStack Start", "tanstack start"],
  ["Express", "express", "express.js", "expressjs"],
  ["Fastify", "fastify"],
  ["NestJS", "nestjs", "nest.js"],
  ["Elysia", "elysia"],
  ["Bun", "bun"],
  ["Deno", "deno"],
  ["Electron", "electron"],
  ["Tauri", "tauri"],
  ["React Native", "react native"],
  ["Expo", "expo"],
  ["Flutter", "flutter", "dart"],
  ["Django", "django"],
  ["Flask", "flask"],
  ["FastAPI", "fastapi", "fast api"],
  ["Streamlit", "streamlit"],
  ["Python", "python", "python3", "py"],
  ["Go", "golang", "go"],
  ["Rust", "rust", "axum", "actix", "cargo"],
  ["Ruby on Rails", "rails", "ruby on rails"],
  ["Ruby", "ruby", "sinatra"],
  ["Laravel", "laravel"],
  ["PHP", "php", "symfony", "wordpress"],
  ["Spring Boot", "spring boot", "spring"],
  ["Java", "java", "kotlin"],
  [".NET", ".net", "dotnet", "asp.net", "blazor", "c#"],
  ["Elixir", "elixir", "phoenix"],
  ["Swift", "swift", "swiftui"],
  ["a CLI", "cli", "command line", "command-line", "terminal app"],
  ["a browser extension", "browser extension", "chrome extension", "firefox extension"],
  ["a Discord bot", "discord bot"],
  ["a Telegram bot", "telegram bot"],
  ["a Slack bot", "slack bot", "slack app"],
]

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Word-boundary match that also works for terms ending in punctuation
    (".net", "c#") — `\b` alone fails after a non-word character. */
function matches(haystack: string, term: string): boolean {
  const body = escape(term.toLowerCase()).replace(/\s+/g, "\\s+")
  const lead = /^\w/.test(term) ? "(?<![\\w-])" : "(?<!\\S)"
  const tail = /\w$/.test(term) ? "(?![\\w-])" : "(?!\\S)"
  return new RegExp(`${lead}${body}${tail}`).test(haystack)
}

/** The foreign stack a prompt names, if any — the first in the table order
    whose spelling appears, longest spelling first so "react native" is seen
    before a starter's "react" ever is. */
export function foreignStack(prompt: string): { name: string; term: string } | null {
  const text = prompt.toLowerCase()
  for (const [name, ...terms] of FOREIGN_STACKS) {
    const spellings = terms.length ? terms : [name.toLowerCase()]
    for (const term of spellings.slice().sort((a, b) => b.length - a.length)) {
      if (matches(text, term)) return { name, term }
    }
  }
  return null
}

function score(prompt: string, template: Template): { total: number; matched: string[] } {
  const text = prompt.toLowerCase()
  const matched: string[] = []
  let total = 0
  for (const signal of template.signals) {
    if (!matches(text, signal)) continue
    matched.push(signal)
    total += /\s/.test(signal.trim()) ? 2 : 1
  }
  return { total, matched }
}

const bySort = (a: Template, b: Template) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)

/**
 * Which starter a prompt wants, or that none does. Never null when there is
 * at least one template: an empty prompt is the first starter with an empty
 * `matched`, which is what the page draws as "default".
 */
export function senseStack(prompt: string, templates: Template[]): StackSense | null {
  const sorted = templates.slice().sort(bySort)
  const trimmed = prompt.trim()

  const foreign = trimmed ? foreignStack(trimmed) : null
  if (foreign) {
    return {
      kind: "scratch",
      stack: foreign.name,
      matched: [foreign.term],
      reason: `${foreign.name} has no starter here — the agent sets it up`,
    }
  }
  if (sorted.length === 0) {
    return {
      kind: "scratch",
      stack: null,
      matched: [],
      reason: "this server ships no starters",
    }
  }

  let best: { template: Template; total: number; matched: string[] } | null = null
  for (const template of sorted) {
    const { total, matched } = score(trimmed, template)
    if (!best || total > best.total) best = { template, total, matched }
  }
  const pick = best!
  return {
    kind: "template",
    template: pick.template,
    matched: pick.matched,
    reason: pick.matched.length
      ? `matched ${pick.matched.slice(0, 3).join(", ")}`
      : trimmed
        ? "nothing specific in the prompt — the default starter"
        : "the default starter",
  }
}
