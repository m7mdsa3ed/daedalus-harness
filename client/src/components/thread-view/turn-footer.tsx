/* The readings a finished turn leaves under its answer: sources, usage and
   suggestions. Kept together so the transcript owns one turn-tail layout while
   each part keeps its own component and entrance timing. */
import * as React from "react"
import type * as acp from "@daedalus/acp"
import type { TurnGeneration } from "@daedalus/protocol"

import { SuggestionGroup } from "@/components/suggestion-group"
import { SourcesStrip } from "@/components/thread-cards"
import { TokenSummary, TurnTime } from "@/components/token-usage"
import type { TurnSources } from "@/lib/sources"
import type { SuggestGroup } from "@/lib/suggestions"
import { stagger } from "@/lib/utils"

/* Memoised: one per row, and the transcript re-renders on every streamed token. */
export const TurnFooter = React.memo(function TurnFooter({
  sources,
  usage,
  durationMs,
  toolDurationMs,
  generation,
  suggestions,
  onPick,
}: {
  sources?: TurnSources
  usage?: acp.Usage
  durationMs?: number
  toolDurationMs?: number
  generation?: TurnGeneration
  /** One group per kind the answer carried, already filtered to rows that name
      something real (`SuggestKindDef.keep`). */
  suggestions?: SuggestGroup[]
  /** Fill the composer with a picked row's words. */
  onPick: (text: string) => void
}) {
  if (!sources && !usage && durationMs === undefined && !suggestions?.length) return null

  return (
    <div className="min-w-0">
      {sources && (
        <div className="harness-item-in" style={stagger(1)}>
          <SourcesStrip turn={sources} />
        </div>
      )}
      {usage && (
        <div className="harness-item-in -ml-1" style={stagger(2)}>
          <TokenSummary
            usage={usage}
            label="This turn"
            durationMs={durationMs}
            toolDurationMs={toolDurationMs}
            generation={generation}
          />
        </div>
      )}
      {!usage && durationMs !== undefined && (
        <div className="harness-item-in -ml-1" style={stagger(2)}>
          <TurnTime durationMs={durationMs} />
        </div>
      )}
      {suggestions?.map((group, index) => (
        <div key={group.kind.id} className="harness-item-in mt-1" style={stagger(3 + index)}>
          <SuggestionGroup group={group} onPick={onPick} />
        </div>
      ))}
    </div>
  )
})
