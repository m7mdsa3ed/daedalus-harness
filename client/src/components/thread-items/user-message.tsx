/* ── What the user typed ── the prose of a user bubble, with any pasted-text
   block folded into a toggle. A leaf: it draws no rows and recurses into
   nothing, so it lives apart from the mutually recursive cluster in
   `rows.tsx`, which imports it for the `user` case. The composer's queue
   draws it too, through the `thread-items` barrel. */
import * as React from "react"
import { CheckIcon, ChevronRightIcon, ClipboardListIcon, CopyIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Prose } from "@/components/tool-parts"
import { copyText } from "@/components/step-row"
import { cn } from "@/lib/utils"

/**
 * Renders user message text, collapsing any pasted text blocks into interactive
 * toggles that can be opened/closed to view the pasted content.
 */
export function UserMessageText({ text }: { text: string }) {
  const parts = React.useMemo(() => parseUserMessageParts(text), [text])
  if (parts.length === 1 && parts[0].type === "prose") {
    return <Prose text={parts[0].text} mentions />
  }
  return (
    <div className="space-y-2">
      {parts.map((part, index) =>
        part.type === "prose" ? (
          <Prose key={index} text={part.text} mentions />
        ) : (
          <PastedTextItem key={index} n={part.n} content={part.content} />
        )
      )}
    </div>
  )
}

function parseUserMessageParts(text: string): Array<
  | { type: "prose"; text: string }
  | { type: "paste"; n?: string; content: string }
> {
  const regex = /(?:^|\n)(`{3,})pasted-text(?: #?(\d+))?[^\n]*\n([\s\S]*?)\n\1(?=\n|$)/g
  const parts: Array<{ type: "prose"; text: string } | { type: "paste"; n?: string; content: string }> = []
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = regex.exec(text)) !== null) {
    const before = text.slice(lastIndex, match.index)
    if (before.trim()) {
      parts.push({ type: "prose", text: before.trim() })
    }
    parts.push({
      type: "paste",
      n: match[2],
      content: match[3],
    })
    lastIndex = match.index + match[0].length
  }

  const after = text.slice(lastIndex)
  if (after.trim()) {
    parts.push({ type: "prose", text: after.trim() })
  }

  return parts.length > 0 ? parts : [{ type: "prose", text }]
}

function PastedTextItem({
  n,
  content,
}: {
  n?: string
  content: string
}) {
  const [open, setOpen] = React.useState(false)
  const [copied, setCopied] = React.useState(false)
  const lines = content.split("\n").length
  const chars = content.length

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation()
    void copyText(content)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    /* The card geometry the error and task notices keep — same margin, same
       radius, same border. The padding is on the header and the body rather
       than the box, because the two are separated by a rule. */
    <div className="my-2 overflow-hidden rounded-xl border border-border/50 bg-background/50 text-foreground">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-start text-xs transition-colors hover:bg-muted/40"
      >
        <div className="flex items-center gap-2 min-w-0">
          <ClipboardListIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="font-medium truncate">
            {n ? `Pasted text #${n}` : "Pasted text"}
          </span>
          <span className="text-[11px] text-muted-foreground shrink-0">
            ({lines.toLocaleString()} line{lines === 1 ? "" : "s"} · {chars.toLocaleString()} chars)
          </span>
        </div>
        {/* The chevron turns the way every other disclosure in the transcript
            turns — right, then down — rather than flipping a caret. */}
        <div className="flex items-center gap-1 shrink-0 text-muted-foreground">
          <span className="text-[11px]">{open ? "Hide" : "Show"}</span>
          <ChevronRightIcon
            className={cn("size-3.5 transition-transform duration-200", open && "rotate-90")}
          />
        </div>
      </button>
      {open && (
        <div className="border-t border-border/50 bg-muted/40 px-2.5 py-2">
          <div className="mb-1.5 flex justify-end">
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={handleCopy}
              className="h-6 gap-1 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
              title="Copy pasted text"
            >
              {/* The theme's affirmative, not a raw palette green — every other
                  tick in the transcript (a todo, a chosen option) is primary. */}
              {copied ? <CheckIcon className="size-3 text-primary" /> : <CopyIcon className="size-3" />}
              <span>{copied ? "Copied" : "Copy"}</span>
            </Button>
          </div>
          <pre className="max-h-72 overflow-auto text-xs whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-muted-foreground">
            {content}
          </pre>
        </div>
      )}
    </div>
  )
}
