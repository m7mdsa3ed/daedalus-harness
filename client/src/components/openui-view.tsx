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
import { Renderer, type ActionEvent } from "@openuidev/react-lang"
import { InfoIcon, WandSparklesIcon } from "lucide-react"
import { Prose } from "@/components/prose"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useOpenuiActions } from "@/lib/openui/actions"
import { openuiLibrary } from "@/lib/openui/library"
import { positionalize } from "@/lib/openui/named-args"

type Verdict = "parse" | "empty"

/** A component's prop order — the order its signature prints in the prompt. */
const propOrder = (name: string): string[] | undefined => {
  const def = openuiLibrary.components[name]
  return def ? Object.keys(def.props.shape) : undefined
}

const WHY: Record<Verdict, React.ReactNode> = {
  parse: "This is an OpenUI Lang block that could not be read, so it is shown as source.",
  empty: (
    <>
      This OpenUI Lang block drew nothing, so it is shown as source. The usual cause is{" "}
      <span className="font-medium">named arguments</span> (
      <code className="rounded-md bg-muted px-1 font-mono">Stat(label="…", value="…")</code>) — this
      language takes positional arguments only, so every prop is dropped and the layout comes
      out empty.
    </>
  ),
}

/* ── What a click in a drawn answer does ──
   Two kinds arrive, and neither can do anything on its own:
   `continue_conversation` is a button asking for words, which land in the
   composer unsent (the reader still presses send); `open_url` is a link the
   model was given, opened in a real tab. Everything else an Action contains —
   `@Set`/`@Reset` — the renderer applies to its own store before this is
   reached, which is why a filter costs no round trip. No `toolProvider` is
   passed, so a `Query`/`Mutation` has no tool behind it to run. */
function messageOf(event: ActionEvent): string {
  /* Form fields arrive one level down, scoped by the form's name, and each
     value is `{ value, componentType }`. `$`-prefixed keys are the view's own
     state: worth carrying, but not twice, so one that repeats a field the
     reader actually answered is dropped. */
  const fields: [string, unknown][] = []
  /* A stored field is `{ value, componentType }` — which is an object, so it has
     to be told apart from the *bag of fields* a form stores under its own name,
     or an unwrapped field would come out as `value: 7d, componentType: …`. */
  const isCell = (raw: unknown): raw is { value: unknown } =>
    !!raw && typeof raw === "object" && "value" in raw && "componentType" in raw
  const unwrap = (raw: unknown) => (isCell(raw) ? raw.value : raw)
  for (const [key, raw] of Object.entries(event.formState ?? {})) {
    if (key.startsWith("$")) continue
    if (isCell(raw)) {
      fields.push([key, raw.value])
    } else if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [name, cell] of Object.entries(raw as Record<string, unknown>)) fields.push([name, unwrap(cell)])
    } else {
      fields.push([key, unwrap(raw)])
    }
  }
  const seen = new Set(fields.map(([, value]) => JSON.stringify(value)))
  for (const [key, raw] of Object.entries(event.formState ?? {})) {
    if (!key.startsWith("$")) continue
    const value = unwrap(raw)
    if (value == null || value === "") continue
    const json = JSON.stringify(value)
    if (seen.has(json)) continue
    seen.add(json)
    fields.push([key.slice(1), value])
  }
  const said = fields.filter(([, value]) => value != null && value !== "")
  if (said.length === 0) return event.humanFriendlyMessage
  return [
    event.humanFriendlyMessage,
    ...said.map(([name, value]) => `- ${name}: ${typeof value === "string" ? value : JSON.stringify(value)}`),
  ].join("\n")
}

export function OpenuiView({ code, streaming }: { code: string; streaming: boolean }) {
  const container = React.useRef<HTMLDivElement>(null)
  const [verdict, setVerdict] = React.useState<Verdict | null>(null)
  /* The program with its named arguments made positional, once the reader has
     asked for it. The message itself is never rewritten — the journal and the
     agent's own store both hold what the model wrote — so this is the view's
     reading of it, as `Recovered OpenUI view` is for an unfenced one. */
  const [repaired, setRepaired] = React.useState<string | null>(null)
  const program = repaired ?? code
  const fix = React.useMemo(() => (verdict === null ? null : positionalize(program, propOrder)), [verdict, program])
  /* The renderer's last word on whether the text parses. Held, not acted on,
     while the row streams: a chunk that ends mid-line is unparseable for one
     frame, and swapping the view for its source then (and back on the next
     chunk) was a flicker. The settle effect above reads it. */
  const unreadable = React.useRef(false)
  const actions = useOpenuiActions()

  /* A new program is a new verdict; without this the previous fence's failure
     would stick to the next one. */
  React.useEffect(() => {
    setVerdict(null)
    setRepaired(null)
  }, [code])

  /* The question only the painted result can answer: did anything appear?

     Only asked once the row has settled. A program is written top-down and the
     first statement is `root`, so a fence one line into its life renders a bare
     container and nothing else — legitimately, by the language's own design. A
     verdict taken then would be wrong, and it would be wrong in the most
     visible way possible: the source flashing over a view that is assembling.

     A parse failure is held the same way (`unreadable`): mid-stream it is as
     often a line cut in half as a real error, so it is only said once the row
     has settled. */
  React.useEffect(() => {
    if (verdict !== null || streaming) return
    if (unreadable.current) return setVerdict("parse")
    const text = container.current?.textContent?.replace(/\s+/g, "") ?? ""
    if (text.length === 0) setVerdict("empty")
  })

  if (verdict !== null) {
    /* The why rides the code block as a chip in its control corner, beside
       Copy (the slot Pretty takes is free: an unlabelled fence cannot be
       pretty-printed), and opens on a click. It used to be an amber Notice
       above the source, which read as the answer's own warning — the app's
       note about a fence and the model's words were the same box. Muted, not
       a tone: nothing went wrong that the reader has to act on. */
    return (
      <div className="relative min-w-0">
        <Prose text={"```\n" + program.replace(/\n$/, "") + "\n```"} />
        {/* The corner holds the chip and, when there is one, the fix — beside
            it rather than inside the popover, where nobody found it. */}
        <div className="absolute top-1 right-8 z-10 flex items-center gap-1">
        {fix && (
          <Button
            type="button"
            size="xs"
            title="Move the named arguments into their positional slots and draw the view"
            onClick={() => {
              unreadable.current = false
              setRepaired(fix)
              setVerdict(null)
            }}
          >
            <WandSparklesIcon aria-hidden data-icon="inline-start" />
            Fix and draw
          </Button>
        )}
        <Popover>
          <PopoverTrigger
            render={
              <Button
                type="button"
                variant="outline"
                size="xs"
                aria-label="Why this view is shown as source"
                className="bg-popover font-normal text-muted-foreground"
              />
            }
          >
            <InfoIcon aria-hidden data-icon="inline-start" />
            Not drawn
          </PopoverTrigger>
          <PopoverContent align="end" className="w-[min(20rem,calc(var(--float-w)-2rem))] space-y-1 text-sm">
            <p className="font-medium">{verdict === "parse" ? "Could not be read" : "Drew nothing"}</p>
            <p className="text-pretty text-muted-foreground">{WHY[verdict]}</p>
          </PopoverContent>
        </Popover>
        </div>
      </div>
    )
  }

  /* `data-live` turns on the blocks' one-shot fade-in (`.openui-flow` in
     index.css) only while the row is being written, so a reload or a scroll
     back through the transcript never replays it. */
  return (
    <div ref={container} data-live={streaming || undefined} className="w-full max-w-full min-w-0 [overflow-wrap:anywhere]">
      <Renderer
        library={openuiLibrary}
        response={program}
        /* A button in a half-written program belongs to a view that is still
           arriving: the renderer disables it, and a form's fields do not
           invent defaults while the props are still moving. */
        isStreaming={streaming}
        onAction={(event) => {
          if (event.type === "continue_conversation") {
            if (actions) actions.fill(messageOf(event))
            /* A view drawn where no thread is — a task card, a trace — has no
               composer to fill. Said out loud rather than swallowed. */
            else console.warn("[openui] a view asked for words with no composer to fill", event)
            return
          }
          if (event.type === "open_url") {
            const url = typeof event.params.url === "string" ? event.params.url : ""
            /* A tab is a navigation the reader started by clicking, so it is
               theirs to make — but only to a web address, never a scheme that
               runs something. */
            if (/^https?:\/\//i.test(url)) window.open(url, "_blank", "noopener,noreferrer")
            else console.warn("[openui] refused a url", url)
          }
        }}
        onError={(errors) => {
          /* Called with `[]` once resolved, so this is "has it anything wrong
             *now*", not "did it ever". Every error is logged; only the two that
             mean there is no tree at all are fatal, because a pruned draft
             still leaves a view worth drawing (and the measurement above is
             what decides if it left *nothing*). A throw inside one of the
             library's own renderers is caught by the boundary around this
             component — the other half of the same bargain. */
          for (const error of errors) console.warn("[openui]", error.code, error.message)
          unreadable.current = errors.some(
            (error) => error.code === "parse-failed" || error.code === "parse-exception"
          )
          if (unreadable.current && !streaming) setVerdict("parse")
        }}
      />
    </div>
  )
}
