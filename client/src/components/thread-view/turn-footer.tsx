/* The readings a finished turn leaves under its answer: sources, usage and
   follow-ups. Kept together so the transcript owns one turn-tail layout while
   each part keeps its own component and entrance timing. */
import * as React from "react"
import type * as acp from "@daedalus/acp"

import { CommandSuggestions } from "@/components/command-suggestions"
import { PromptSuggestions } from "@/components/prompt-suggestions"
import { SourcesStrip } from "@/components/thread-cards"
import { TokenSummary } from "@/components/token-usage"
import type { TurnSources } from "@/lib/sources"
import { stagger } from "@/lib/utils"

/* Memoised: one per row, and the transcript re-renders on every streamed token. */
export const TurnFooter = React.memo(function TurnFooter({
  sources,
  usage,
  durationMs,
  toolDurationMs,
  suggestions,
  commands,
  onPick,
  onPickCommand,
}: {
  sources?: TurnSources
  usage?: acp.Usage
  durationMs?: number
  toolDurationMs?: number
  suggestions?: string[]
  /** The project commands the answer recommended, already filtered to the ones
      the project defines (`keepDefinedCommands`). */
  commands?: string[]
  onPick: (prompt: string) => void
  onPickCommand: (command: string) => void
}) {
  if (!sources && !usage && !suggestions?.length && !commands?.length) return null

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
          />
        </div>
      )}
      {suggestions && suggestions.length > 0 && (
        <div className="harness-item-in mt-1" style={stagger(3)}>
          <PromptSuggestions suggestions={suggestions} onPick={onPick} />
        </div>
      )}
      {commands && commands.length > 0 && (
        <div className="harness-item-in mt-1" style={stagger(4)}>
          <CommandSuggestions commands={commands} onPick={onPickCommand} />
        </div>
      )}
    </div>
  )
})
