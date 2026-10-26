/* ── A sent message's chips ──
   The bubble draws what the composer drew: a quote, a long paste and an `@`
   mention as the one inline chip (`components/inline-chip.tsx`), in the line
   of text, not as a blockquote, a card and a link.

   `remarkUserChips` does it on the markdown tree, so nothing inside a code span
   or a fence is touched:
     — a top-level blockquote becomes a quote chip at the start of the paragraph
       after it, where the composer put it (the string always has a blank line
       there, so markdown sees two blocks);
     — `[pasted text #n]` becomes a paste chip. The bubble's text is the *sent*
       one, with each paste expanded into a fence; `collapsePastes` folds those
       back into their tokens first and hands the bodies over by context;
     — `@path` becomes a mention chip, on the composer's rule: a path-looking
       token (a `/`, `.` or `~` in it), trailing sentence punctuation left out;
     — `@KEY-12` becomes a task chip whose popover is what the agent was sent
       about it (`splitTaskContext` folds the block out first, as pastes are);
     — `@kind:ref` (a known kind, `lib/mentions/grammar.ts`) becomes a kind chip
       whose popover is what the agent was sent for it
       (`splitMentionContext` folds the `<context>` block out first). */
import * as React from "react"
import { ClipboardListIcon, SquareCheckIcon, TextQuoteIcon } from "lucide-react"

import {
  ChipBody,
  ChipPreview,
  chipClass,
  linesLabel,
  quoteFace,
  useMentionFace,
} from "@/components/inline-chip"
import { FilePreviewContext, projectPath } from "@/lib/file-preview"
import { TASK_KEY } from "@/lib/task-mentions"
import { readsAsMarkdown } from "@/lib/paste-markdown"
import { useKindFace, parseKindToken, parseRangeToken } from "@/lib/mentions"

type MdNode = {
  type: string
  value?: string
  children?: MdNode[]
  data?: object
  position?: { start: { offset?: number }; end: { offset?: number } }
}

const chip = (hName: string, hProperties: Record<string, string>): MdNode => ({
  type: "text",
  value: "",
  data: { hName, hProperties },
})

/** A paste token, or a mention after a boundary. */
const INLINE = /\[pasted text #(\d+)\]|(^|[\s(])@([^\s@]+)/g
const TRAILING = /[.,;:!?)\]}'"]+$/
const PATH_LIKE = /[/.~]/

function splitText(value: string): MdNode[] {
  const out: MdNode[] = []
  let last = 0
  for (const match of value.matchAll(INLINE)) {
    let start: number
    let node: MdNode
    let end: number
    if (match[1] !== undefined) {
      start = match.index
      end = start + match[0].length
      node = chip("paste-chip", { n: match[1] })
    } else {
      const path = match[3].replace(TRAILING, "")
      const task = TASK_KEY.test(path)
      const kind = parseKindToken(path) !== null
      if (!path || !(task || kind || PATH_LIKE.test(path))) continue
      start = match.index + match[2].length
      end = start + 1 + path.length
      node = task
        ? chip("task-mention", { task: path })
        : kind
          ? chip("kind-mention", { token: path })
          : chip("file-mention", { path })
    }
    if (start > last) out.push({ type: "text", value: value.slice(last, start) })
    out.push(node)
    last = end
  }
  if (last === 0) return [{ type: "text", value }]
  if (last < value.length) out.push({ type: "text", value: value.slice(last) })
  return out
}

function walk(node: MdNode) {
  if (!node.children) return
  node.children = node.children.flatMap((child) => {
    if (child.type === "text" && !child.data && child.value) return splitText(child.value)
    walk(child)
    return [child]
  })
}

export function remarkUserChips() {
  return (tree: MdNode, file: { value?: unknown }) => {
    const source = typeof file.value === "string" ? file.value : ""
    const blocks = tree.children ?? []
    const out: MdNode[] = []
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i]
      const from = block.position?.start.offset
      const to = block.position?.end.offset
      if (block.type !== "blockquote" || from === undefined || to === undefined) {
        out.push(block)
        continue
      }
      const quote = source
        .slice(from, to)
        .split("\n")
        .map((line) => line.replace(/^\s*> ?/, ""))
        .join("\n")
      const node = chip("quote-chip", { quote })
      const next = blocks[i + 1]
      if (next?.type === "paragraph") {
        next.children = [node, ...(next.children ?? [])]
      } else {
        out.push({ type: "paragraph", children: [node] })
      }
    }
    tree.children = out
    walk(tree)
  }
}

/* ── pastes ── */

const PastesContext = React.createContext<ReadonlyMap<string, string>>(new Map())

/* The fence `expandPastes` writes, with the newline it puts in front; the one
   it puts after is taken too, so the token lands back where it was typed. */
const PASTE_FENCE = /(?:^|\n)(`{3,})pasted-text(?: #?(\d+))?[^\n]*\n([\s\S]*?)\n\1(?:\n|$)/g

/** The sent text with each pasted fence folded back into its token. */
export function collapsePastes(text: string): { text: string; pastes: Map<string, string> } {
  const pastes = new Map<string, string>()
  let unnamed = 0
  const collapsed = text.replace(PASTE_FENCE, (_all, _fence, n: string | undefined, body: string) => {
    // Older messages fenced a paste without its number.
    const key = n ?? `0${++unnamed}`
    pastes.set(key, body)
    return `[pasted text #${key}]`
  })
  return { text: collapsed, pastes }
}

export function UserPastes({
  pastes,
  children,
}: {
  pastes: ReadonlyMap<string, string>
  children: React.ReactNode
}) {
  return <PastesContext.Provider value={pastes}>{children}</PastesContext.Provider>
}

/* ── tasks ── */

const TasksContext = React.createContext<ReadonlyMap<string, string>>(new Map())

export function UserTasks({
  tasks,
  children,
}: {
  tasks: ReadonlyMap<string, string>
  children: React.ReactNode
}) {
  return <TasksContext.Provider value={tasks}>{children}</TasksContext.Provider>
}

/* ── typed mentions ── */

const MentionsContext = React.createContext<ReadonlyMap<string, string>>(new Map())

export function UserMentions({
  mentions,
  children,
}: {
  mentions: ReadonlyMap<string, string>
  children: React.ReactNode
}) {
  return <MentionsContext.Provider value={mentions}>{children}</MentionsContext.Provider>
}

/* ── the chips, as markdown components ── */

type Hast = { node?: unknown; children?: React.ReactNode }

function PasteChip({ n }: Hast & { n?: string }) {
  const body = React.useContext(PastesContext).get(n ?? "")
  // A token typed as words, with no paste behind it, stays words.
  if (body === undefined) return <>{`[pasted text #${n}]`}</>
  const lines = body.split("\n").length
  return (
    <span className={chipClass()}>
      <ChipBody
        icon={ClipboardListIcon}
        label={/^0/.test(n ?? "") ? "Pasted text" : `Pasted text #${n}`}
        aside={linesLabel(lines)}
        preview={
          <ChipPreview
            caption={`${body.length.toLocaleString()} chars`}
            text={body}
            markdown={readsAsMarkdown(body)}
          />
        }
      />
    </span>
  )
}

function QuoteChip({ quote = "" }: Hast & { quote?: string }) {
  return (
    <span className={chipClass()}>
      <ChipBody icon={TextQuoteIcon} {...quoteFace(quote)} preview={<ChipPreview caption="Quote" text={quote} />} />
    </span>
  )
}

/* Opens in the Preview panel when it resolves into the thread's project, the
   way the plain link did. */
function MentionChip({ path = "" }: Hast & { path?: string }) {
  const face = useMentionFace(path)
  const ctx = React.useContext(FilePreviewContext)
  /* `@src/a.ts:40-80` names lines: the file is what opens, and the lines the
     agent was sent (`file:` + the token, from the `<context>` block) are what
     the chip previews. */
  const range = parseRangeToken(path)
  const lines = React.useContext(MentionsContext).get(`file:${path}`)
  const target = ctx ? projectPath(range?.path ?? path, ctx.scope) : null
  return (
    <span className={chipClass()} title={target ? `Preview ${target}` : `@${path}`}>
      <ChipBody
        {...face}
        preview={lines === undefined ? undefined : <ChipPreview caption="Sent to the agent" text={lines} />}
        onClick={ctx && target && lines === undefined ? () => ctx.open(target) : undefined}
      />
    </span>
  )
}

/* What the agent was sent about the task, as it was at send — not a live read
   of the board, which may have moved on since. */
function TaskChip({ task = "" }: Hast & { task?: string }) {
  const body = React.useContext(TasksContext).get(task)
  // Sent without the block (no Harness MCP): it went as words, so it stays words.
  if (body === undefined) return <>{`@${task}`}</>
  return (
    <span className={chipClass()}>
      <ChipBody
        icon={SquareCheckIcon}
        label={task}
        preview={<ChipPreview caption="Sent to the agent" text={body} />}
      />
    </span>
  )
}

/* What the agent was sent for `@kind:ref`, as it was at send. Without a body
   (an older server, a ref nothing resolved) the chip is the face alone. */
function KindChip({ token = "" }: Hast & { token?: string }) {
  const body = React.useContext(MentionsContext).get(token)
  const face = useKindFace(token)
  if (!face) return <>{`@${token}`}</>
  return (
    <span className={chipClass()} title={`@${token}`}>
      <ChipBody
        {...face}
        preview={body === undefined ? undefined : <ChipPreview caption="Sent to the agent" text={body} />}
      />
    </span>
  )
}

export const USER_CHIP_COMPONENTS = {
  "kind-mention": KindChip,
  "task-mention": TaskChip,
  "paste-chip": PasteChip,
  "quote-chip": QuoteChip,
  "file-mention": MentionChip,
}
