/* A model call's prompt, by part — the same parts, words and swatches as the
   Tokens panel (`lib/token-breakdown.ts`), read from the span itself
   (`daedalus.prompt_parts`). Drawn for any runtime whose request the server could
   divide: Claude Code's raw API body over OTLP, or our agent's GenAI attributes.
   Each static part opens onto what it was made of. */
import * as React from "react"
import { ChevronRightIcon } from "lucide-react"
import type { TraceSpan } from "@daedalus/protocol"

import { PROMPT_PARTS, spanPromptParts, type PromptKey } from "@/lib/token-breakdown"
import { formatTokens } from "@/lib/tokens"
import { cn } from "@/lib/utils"

const pct = (n: number, total: number) => (total > 0 ? `${Math.round((n / total) * 100)}%` : "—")
/** Rows of one part drawn before "N more". */
const ITEMS_MAX = 12

export function PromptParts({ span }: { span: TraceSpan }) {
  const [more, setMore] = React.useState<PromptKey | null>(null)
  const prompt = spanPromptParts(span.attributes)
  if (!prompt) return null
  const { total, parts, items } = prompt
  const rows = PROMPT_PARTS.filter((part) => parts[part.key] > 0)
  return (
    <div className="space-y-2">
      <span role="img" aria-label="Prompt by part" className="flex h-2.5 w-full gap-px overflow-hidden rounded-full bg-muted">
        {rows.map((part) => (
          <span key={part.key} className={cn("block", part.swatch)} style={{ width: `${(parts[part.key] / total) * 100}%` }} />
        ))}
      </span>
      <div className="space-y-1 text-xs tabular-nums">
        {rows.map((part) => {
          const list = part.key === "system" || part.key === "tools" || part.key === "mcp" ? [...items[part.key]].sort((a, b) => b.tokens - a.tokens) : []
          const head = (
            <span className="grid grid-cols-[0.75rem_auto_1fr_auto] items-center gap-x-2">
              <span className="flex h-4 items-center text-muted-foreground">
                {list.length > 0 && <ChevronRightIcon aria-hidden className="size-3 transition-transform group-open/part:rotate-90" />}
              </span>
              <span className={cn("size-2 rounded-sm", part.swatch)} />
              <span className="min-w-0 truncate">{part.label}</span>
              <span className="text-right">
                ~{formatTokens(parts[part.key])} <span className="inline-block w-8 text-muted-foreground">{pct(parts[part.key], total)}</span>
              </span>
            </span>
          )
          return list.length ? (
            <details key={part.key} className="group/part">
              <summary className="-mx-1 cursor-pointer list-none rounded-md px-1 py-0.5 hover:bg-muted">{head}</summary>
              <ul className="space-y-1 py-1 pl-6 text-muted-foreground">
                {(more === part.key ? list : list.slice(0, ITEMS_MAX)).map((item, i) => (
                  <li key={i} className="grid grid-cols-[1fr_auto_2rem] items-baseline gap-x-2">
                    <span className="min-w-0 truncate" title={item.name}>{item.name}</span>
                    <span className="text-right">~{formatTokens(item.tokens)}</span>
                    <span className="text-right">{pct(item.tokens, parts[part.key])}</span>
                  </li>
                ))}
                {list.length > ITEMS_MAX && (
                  <li>
                    <button type="button" className="underline-offset-2 hover:text-foreground hover:underline" onClick={() => setMore(more === part.key ? null : part.key)}>
                      {more === part.key ? "Show fewer" : `${list.length - ITEMS_MAX} more`}
                    </button>
                  </li>
                )}
              </ul>
            </details>
          ) : (
            <div key={part.key} className="-mx-1 px-1 py-0.5">
              {head}
            </div>
          )
        })}
        <div className="grid grid-cols-[0.75rem_auto_1fr_auto] items-center gap-x-2 border-t pt-1 font-medium">
          <span />
          <span />
          <span>Total</span>
          <span className="text-right">~{formatTokens(total)}</span>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Counted from the request itself and scaled to what the provider billed for it, so the parts add up; the proportions are the claim.
      </p>
    </div>
  )
}
