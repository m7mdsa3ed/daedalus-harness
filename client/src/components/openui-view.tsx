/* ── Drawing one generated view ──
   The component a fenced `openui` block becomes. It is deliberately tiny and
   deliberately its own module: it is the only file that reaches the OpenUI
   parser and the component library, and it is loaded lazily
   (`tool-parts.tsx`), so a transcript that never holds a fence never pays for
   any of it.

   A fence can fail to draw in three ways, and only two of them look alike:

   — **nothing parses** (`parse-failed` / `parse-exception`). The source is
     handed back under a line saying so.
   — **it parses and draws nothing.** This is the failure that produced the
     check at the bottom of this file, and it is the one worth understanding: a
     program that writes named arguments — `Stat(label="a", value="1")`, which
     is how every *other* structured lane in this harness spells a field — is
     read as a call with extra positional arguments. Every required prop comes
     out null, every component is dropped, and `Stack` renders as an empty
     `flex` box: markup, no text, no error the reader can see. It is
     indistinguishable on screen from an answer that never came.
   — **it parses and draws *something*.** The parser pruned a component it could
     not place and drew the rest. That is the language working as designed, so
     it draws, and the detail goes to the console rather than the transcript.

   The middle case is why this measures the rendered result rather than trusting
   the parser's own verdict: the parser is *right* to drop what it cannot place,
   and there is no error code that means "the whole thing came out empty". Only
   having drawn it can answer that — and only once the row has settled, because
   while the program is still being written an empty shell is the *correct*
   intermediate state (see the effect below). */
import * as React from "react"
import { Renderer } from "@openuidev/react-lang"
import { Notice } from "@/components/notice"
import { Prose } from "@/components/tool-parts"
import { openuiLibrary } from "@/lib/openui/library"

type Verdict = "parse" | "empty"

const WHY: Record<Verdict, React.ReactNode> = {
  parse: "This is an OpenUI Lang block that could not be read, so it is shown as source.",
  empty: (
    <>
      This OpenUI Lang block drew nothing, so it is shown as source. The usual cause is{" "}
      <span className="font-medium">named arguments</span> (
      <code className="rounded bg-muted/60 px-1">Stat(label="…", value="…")</code>) — this
      language takes positional arguments only, so every prop is dropped and the layout comes
      out empty.
    </>
  ),
}

export function OpenuiView({ code, streaming }: { code: string; streaming: boolean }) {
  const container = React.useRef<HTMLDivElement>(null)
  const [verdict, setVerdict] = React.useState<Verdict | null>(null)

  /* A new program is a new verdict; without this the previous fence's failure
     would stick to the next one. */
  React.useEffect(() => setVerdict(null), [code])

  /* The question only the painted result can answer: did anything appear?

     Only asked once the row has settled. A program is written top-down and the
     first statement is `root`, so a fence one line into its life renders a bare
     container and nothing else — legitimately, by the language's own design. A
     verdict taken then would be wrong, and it would be wrong in the most
     visible way possible: the source flashing over a view that is assembling.

     A parse failure still short-circuits this through `onError`, which is a
     statement about the text rather than about the paint, and is true mid-stream
     as much as after it. */
  React.useEffect(() => {
    if (verdict !== null || streaming) return
    const text = container.current?.textContent?.replace(/\s+/g, "") ?? ""
    if (text.length === 0) setVerdict("empty")
  })

  if (verdict !== null) {
    return (
      <div className="min-w-0 space-y-2">
        <Notice tone="warn" size="sm">
          {WHY[verdict]}
        </Notice>
        <Prose text={"```\n" + code.replace(/\n$/, "") + "\n```"} />
      </div>
    )
  }

  return (
    <div ref={container} className="min-w-0">
      <Renderer
        library={openuiLibrary}
        response={code}
        onError={(errors) => {
          /* Called with `[]` once resolved, so this is "has it anything wrong
             *now*", not "did it ever". Every error is logged; only the two that
             mean there is no tree at all are fatal, because a pruned draft
             still leaves a view worth drawing (and the measurement above is
             what decides if it left *nothing*). A throw inside one of the
             library's own renderers is caught by the boundary around this
             component — the other half of the same bargain. */
          for (const error of errors) console.warn("[openui]", error.code, error.message)
          if (
            errors.some(
              (error) => error.code === "parse-failed" || error.code === "parse-exception"
            )
          ) {
            setVerdict("parse")
          }
        }}
      />
    </div>
  )
}
