/* ── The composer's box ──
   A Tiptap editor standing where the textarea stood, so the things riding
   along with a message are drawn *in* it, as one kind of inline chip: a long
   paste, an excerpt picked with "Ask about this", and a finished `@` mention. The model is still the
   string (`editor-text.ts`): `value`/`onChange` are the textarea's contract,
   and the ref is a `TextSurface` — the four textarea members the completers,
   the history walk and the "+" menu's insertions read — so none of them had
   to learn about ProseMirror.

   Keys are taken in the *capture* phase and ProseMirror is told to honour a
   `preventDefault` (`handleDOMEvents.keydown`): the completers and Enter-to-
   send decide first, exactly as they did on the textarea, and only a key they
   left alone becomes an edit. Pastes are always the caller's — a long one is
   parked as a chip, and a short one goes in as plain text rather than as
   whatever HTML the clipboard carried. */
import * as React from "react"
import {
  EditorContent,
  Extension,
  InputRule,
  Node,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  mergeAttributes,
  useEditor,
  type NodeViewProps,
} from "@tiptap/react"
import StarterKit from "@tiptap/starter-kit"
import Placeholder from "@tiptap/extension-placeholder"
import { Plugin } from "@tiptap/pm/state"
import { Decoration, DecorationSet } from "@tiptap/pm/view"
import { ClipboardListIcon, TextQuoteIcon, XIcon } from "lucide-react"

import {
  ChipBody,
  ChipPreview,
  chipClass,
  linesLabel,
  quoteFace,
  useLinkFace,
  useMentionFace,
  type ChipFace,
} from "@/components/inline-chip"
import { pasteToken, type Paste } from "@/lib/pastes"
import { cn } from "@/lib/utils"
import {
  blocksToText,
  docToText,
  offsetToPos,
  posToOffset,
  textToContent,
} from "@/components/composer/editor-text"

/** A suggestion the composer draws but does not hold: `text` at offset `at`,
    in the same offsets `TextSurface` speaks. The ghost is never part of the
    string — Tab is what puts it there (`composer/fim-completion.ts`). */
export interface ComposerGhost {
  at: number
  text: string
}

/** What the composer's helpers read off the box — a textarea's shape. */
export interface TextSurface {
  readonly value: string
  readonly selectionStart: number
  readonly selectionEnd: number
  setSelectionRange(start: number, end: number): void
  focus(): void
}

/* The parked bodies, for the chips to preview. Node views render through
   portals inside `EditorContent`, so context reaches them. */
const PastesContext = React.createContext<Paste[]>([])

/* The chip is `components/inline-chip.tsx`'s, shared with the sent bubble;
   what the box adds is the node view around it and a ✕ — the mouse's delete
   (Backspace already takes an atom whole). */
function Chip({
  selected,
  onRemove,
  removeLabel,
  title,
  ...body
}: ChipFace & {
  title?: string
  preview?: React.ReactNode
  selected: boolean
  onRemove: () => void
  removeLabel: string
}) {
  return (
    <NodeViewWrapper
      as="span"
      contentEditable={false}
      title={title}
      className={chipClass({ selected, trailing: true })}
    >
      <ChipBody {...body} />
      <button
        type="button"
        className="inline-flex shrink-0 items-center self-center rounded-sm p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground [&_svg]:pointer-events-none"
        aria-label={removeLabel}
        title="Remove"
        onClick={onRemove}
      >
        <XIcon aria-hidden className="size-3" />
      </button>
    </NodeViewWrapper>
  )
}

function PasteChipView({ node, deleteNode, selected }: NodeViewProps) {
  const n = node.attrs.n as number
  const paste = React.useContext(PastesContext).find((p) => p.n === n)
  return (
    <Chip
      icon={ClipboardListIcon}
      label={`Pasted text #${n}`}
      aside={paste ? linesLabel(paste.lines) : undefined}
      selected={selected}
      onRemove={deleteNode}
      removeLabel={`Remove ${pasteToken(n)}`}
      preview={
        <ChipPreview
          caption={
            paste
              ? `${paste.chars.toLocaleString()} chars — sent in place of the chip, fenced.`
              : "This paste is no longer on this device."
          }
          text={paste?.text ?? ""}
        />
      }
    />
  )
}

function QuoteView({ node, deleteNode, selected }: NodeViewProps) {
  const text = node.attrs.text as string
  return (
    <Chip
      icon={TextQuoteIcon}
      {...quoteFace(text)}
      selected={selected}
      onRemove={deleteNode}
      removeLabel="Remove quote"
      preview={<ChipPreview caption="Quote" text={text} />}
    />
  )
}

function MentionView({ node, deleteNode, selected }: NodeViewProps) {
  const path = node.attrs.path as string
  return (
    <Chip
      {...useMentionFace(path)}
      title={`@${path}`}
      selected={selected}
      onRemove={deleteNode}
      removeLabel={`Remove @${path}`}
    />
  )
}

/* A link typed or pasted is drawn as a chip — the page's title over its host,
   fetched server-side (`link-preview.ts`). The string keeps the literal URL, so
   copying out and sending are unchanged. */
function LinkView({ node, deleteNode, selected }: NodeViewProps) {
  const url = node.attrs.url as string
  return (
    <Chip
      {...useLinkFace(url)}
      title={url}
      selected={selected}
      onRemove={deleteNode}
      removeLabel={`Remove ${url}`}
    />
  )
}

const PasteToken = Node.create({
  name: "pasteToken",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes: () => ({
    n: {
      default: 0,
      parseHTML: (el) => Number(el.getAttribute("data-n")),
      renderHTML: (attrs) => ({ "data-n": attrs.n }),
    },
  }),
  parseHTML: () => [{ tag: "span[data-paste-token]" }],
  renderHTML: ({ HTMLAttributes }) => ["span", mergeAttributes(HTMLAttributes, { "data-paste-token": "" })],
  renderText: ({ node }) => pasteToken(node.attrs.n as number),
  addNodeView: () => ReactNodeViewRenderer(PasteChipView),
})

const Mention = Node.create({
  name: "mention",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes: () => ({
    path: {
      default: "",
      parseHTML: (el) => el.getAttribute("data-path") ?? "",
      renderHTML: (attrs) => ({ "data-path": attrs.path }),
    },
  }),
  parseHTML: () => [{ tag: "span[data-mention]" }],
  renderHTML: ({ HTMLAttributes }) => ["span", mergeAttributes(HTMLAttributes, { "data-mention": "" })],
  renderText: ({ node }) => `@${node.attrs.path as string}`,
  addNodeView: () => ReactNodeViewRenderer(MentionView),
})

const Quote = Node.create({
  name: "quote",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes: () => ({
    text: {
      default: "",
      parseHTML: (el) => el.getAttribute("data-text") ?? "",
      renderHTML: (attrs) => ({ "data-text": attrs.text }),
    },
  }),
  parseHTML: () => [{ tag: "span[data-quote]" }],
  renderHTML: ({ HTMLAttributes }) => ["span", mergeAttributes(HTMLAttributes, { "data-quote": "" })],
  addNodeView: () => ReactNodeViewRenderer(QuoteView),
})

/* A URL. Live chipping is a node *input rule*: a URL typed and then terminated
   by whitespace becomes the atom in place, of the same characters, so the caret
   stays at its end and no remap is needed. A *paste* does not reach here — the
   composer takes a URL-bearing paste through `setText`, which reparses into the
   same atoms (`textToContent`). The load path and the paste path are therefore
   one parser, and the input rule is only the keyboard's. */
const LINK_END = /https?:\/\/[^\s<>()]+[.,;:!?)\]}'"]?\s$/
const Link = Node.create({
  name: "link",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes: () => ({
    url: {
      default: "",
      parseHTML: (el) => el.getAttribute("data-url") ?? "",
      renderHTML: (attrs) => ({ "data-url": attrs.url }),
    },
  }),
  parseHTML: () => [{ tag: "span[data-link]" }],
  renderHTML: ({ HTMLAttributes }) => ["span", mergeAttributes(HTMLAttributes, { "data-link": "" })],
  renderText: ({ node }) => node.attrs.url as string,
  addNodeView: () => ReactNodeViewRenderer(LinkView),
  addInputRules() {
    return [
      new InputRule({
        find: LINK_END,
        handler: ({ state, range, match }) => {
          const url = match[0].replace(/[.,;:!?)\]}'"]?\s$/, "")
          if (!url) return
          /* Replace the URL's own characters only — the typed whitespace that
             triggered the rule, and any sentence punctuation, stay as text. */
          state.tr.replaceWith(
            range.from,
            Math.min(range.from + url.length, range.to),
            state.schema.nodes.link.create({ url }),
          )
        },
      }),
    ]
  },
})

/* ── The ghost ──
   A completion drawn at the caret as a widget decoration, which is what keeps it
   out of the document: `text` is the exact message sent (`editor-text.ts`), so a
   suggestion must never be a node. It reads from a box the component owns rather
   than from the document — the same reason the placeholder is a decoration and
   needs a transaction to redraw. `side: 1` puts it after the character at the
   caret, which is where a completion belongs. */
const ghostPlacement = (
  doc: Parameters<typeof offsetToPos>[0],
  ghost: ComposerGhost,
  onAccept: (() => void) | null
): DecorationSet => {
  const span = document.createElement("span")
  span.className = cn(
    "select-none whitespace-pre-wrap text-muted-foreground/60",
    onAccept ? "cursor-pointer" : "pointer-events-none"
  )
  span.setAttribute("aria-hidden", "true")
  span.setAttribute("contenteditable", "false")
  span.textContent = ghost.text
  if (onAccept) {
    /* A tap takes the suggestion, where there is no Tab to do it. The press is
       held back from the editor so the soft keyboard stays up and the caret
       stays where the gap goes. */
    span.addEventListener("pointerdown", (event) => event.preventDefault())
    span.addEventListener("click", (event) => {
      event.preventDefault()
      onAccept()
    })
  }
  return DecorationSet.create(doc, [Decoration.widget(offsetToPos(doc, ghost.at), span, { side: 1 })])
}

/* The "asking" mark, drawn where the ghost will land: the caret the request was
   made at, so the indicator sits on the line being typed on rather than in the
   toolbar three rows down. A spinning ring, pure CSS, so it animates without a
   transaction — ProseMirror never redraws it. */
const pendingPlacement = (doc: Parameters<typeof offsetToPos>[0], at: number): DecorationSet => {
  const ring = document.createElement("span")
  ring.className =
    "pointer-events-none ml-0.5 inline-block size-2.5 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground align-middle"
  ring.setAttribute("aria-hidden", "true")
  ring.setAttribute("contenteditable", "false")
  return DecorationSet.create(doc, [Decoration.widget(offsetToPos(doc, at), ring, { side: 1 })])
}

/* A line break is a new paragraph whichever key made it: the string has one
   kind of newline, so the document does too. */
const LineBreaks = Extension.create({
  name: "composerLineBreaks",
  addKeyboardShortcuts() {
    const split = () => this.editor.commands.splitBlock()
    return { "Shift-Enter": split, "Alt-Enter": split }
  },
})

export function ComposerEditor({
  value,
  onChange,
  onSelect,
  onPaste,
  onKeyDown,
  onOverflowChange,
  expanded,
  coarse,
  pastes,
  placeholder,
  ghost,
  onAcceptGhost,
  pending,
  disabled,
  ariaLabel,
  className,
  ref,
}: {
  value: string
  onChange: (text: string) => void
  /** The caret moved — the `@` completer's cue. */
  onSelect: () => void
  /** Return true when the paste was taken; otherwise it goes in as plain text. */
  onPaste: (event: ClipboardEvent) => boolean
  onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void
  onOverflowChange: (overflowing: boolean) => void
  expanded: boolean
  coarse: boolean
  pastes: Paste[]
  placeholder: string
  /** A completion to draw at the caret, or null. Drawn from editor state, never
      written into `text`. */
  ghost?: ComposerGhost | null
  /** Makes the drawn ghost tappable (a touch screen has no Tab). Omit to leave it
      inert, as on a keyboard. */
  onAcceptGhost?: () => void
  /** Where the completion lane is still working, as an offset: the spinner sits
      at that caret. Null when nothing is on the wire. */
  pending?: number | null
  disabled?: boolean
  ariaLabel: string
  className?: string
  ref?: React.Ref<TextSurface>
}) {
  /* The last string the document and the caller agreed on. A `value` that is
     not it came from outside (a pick, a recall, a quote) and is loaded; one
     that is, is the editor's own echo and is left alone. */
  const agreed = React.useRef(value)
  const latest = React.useRef({ onChange, onSelect, onPaste, placeholder, onAcceptGhost })
  latest.current = { onChange, onSelect, onPaste, placeholder, onAcceptGhost }
  const editorContentRef = React.useRef<HTMLDivElement>(null)
  /* What the decorations read. A ref, not state: the plugin asks on every
     redraw, and the effect below is what redraws it. */
  const markRef = React.useRef<{ ghost: ComposerGhost | null; pending: number | null }>({
    ghost: ghost ?? null,
    pending: pending ?? null,
  })
  const Ghost = React.useMemo(
    () =>
      Extension.create({
        name: "composerGhost",
        addProseMirrorPlugins() {
          return [
            new Plugin({
              props: {
                decorations: (state) => {
                  const current = markRef.current
                  if (current.ghost?.text) return ghostPlacement(
                      state.doc,
                      current.ghost,
                      latest.current.onAcceptGhost ? () => latest.current.onAcceptGhost?.() : null
                    )
                  if (current.pending !== null) return pendingPlacement(state.doc, current.pending)
                  return null
                },
              },
            }),
          ]
        },
      }),
    []
  )
  const pasteIds = new Set(pastes.map((p) => p.n))
  const pasteIdsRef = React.useRef(pasteIds)
  pasteIdsRef.current = pasteIds

  const editor = useEditor({
    immediatelyRender: true,
    extensions: [
      StarterKit.configure({
        blockquote: false,
        bold: false,
        bulletList: false,
        code: false,
        codeBlock: false,
        hardBreak: false,
        heading: false,
        horizontalRule: false,
        italic: false,
        listItem: false,
        listKeymap: false,
        link: false,
        orderedList: false,
        strike: false,
        underline: false,
      }),
      Placeholder.configure({ placeholder: () => latest.current.placeholder }),
      PasteToken,
      Mention,
      Quote,
      Link,
      LineBreaks,
      Ghost,
    ],
    content: textToContent(value, pasteIds),
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": ariaLabel,
        class: "min-h-9 px-2 py-1.5 leading-relaxed outline-none whitespace-pre-wrap [overflow-wrap:anywhere]",
      },
      // Registering a keydown handler is what makes ProseMirror skip a key the
      // capture-phase handler already `preventDefault`ed.
      handleDOMEvents: { keydown: () => false },
      handlePaste: (view, event) => {
        if (latest.current.onPaste(event)) return true
        const plain = event.clipboardData?.getData("text/plain")
        if (!plain) return false
        view.dispatch(view.state.tr.insertText(plain.replace(/\r\n?/g, "\n")))
        return true
      },
      clipboardTextSerializer: (slice) => blocksToText(slice.content),
    },
    onUpdate: ({ editor }) => {
      const text = docToText(editor.state.doc)
      if (text === agreed.current) return
      agreed.current = text
      latest.current.onChange(text)
    },
    onSelectionUpdate: () => latest.current.onSelect(),
  })

  React.useEffect(() => {
    if (value === agreed.current) return
    agreed.current = value
    editor.commands.setContent(textToContent(value, pasteIdsRef.current), { emitUpdate: false })
  }, [editor, value])

  React.useEffect(() => {
    editor.setEditable(!disabled, false)
  }, [editor, disabled])

  React.useEffect(() => {
    const content = editorContentRef.current
    const tiptap = content?.querySelector<HTMLElement>(".tiptap")
    if (!content || !tiptap) return

    const measure = () => {
      onOverflowChange(tiptap.scrollHeight > 161)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(content)
    observer.observe(tiptap)
    window.addEventListener("resize", measure)
    return () => {
      observer.disconnect()
      window.removeEventListener("resize", measure)
    }
  }, [editor, expanded, onOverflowChange, value, coarse])

  // The placeholder is a decoration; a new one needs a transaction to redraw.
  React.useEffect(() => {
    editor.view.dispatch(editor.state.tr.setMeta("addToHistory", false))
  }, [editor, placeholder])

  /* The ghost: the box moves first, then one no-op transaction draws or clears
     it, `addToHistory: false` so a suggestion is never an undo step.

     The caret is put back in the same breath, and that is the whole of this
     effect's complexity. The widget lands *at* the caret — inside a
     contenteditable — and Chrome re-guesses the selection around a non-editable
     node unreliably, so the reader's caret drifts and they have to point it at
     the end of their sentence again. Two things keep it still: the redraw only
     happens when the ghost actually changed (typing with no suggestion draws
     nothing, so it dispatches nothing), and the caret is restated on the next
     frame — after the browser has finished its own correction — to the offset it
     had before, but only while it still holds that offset. A keystroke in
     between wins: the guard compares offsets and declines. */
  React.useEffect(() => {
    const next = { ghost: ghost ?? null, pending: pending ?? null }
    const previous = markRef.current
    if (
      previous.ghost?.at === next.ghost?.at &&
      previous.ghost?.text === next.ghost?.text &&
      previous.pending === next.pending
    ) {
      return
    }
    markRef.current = next

    /* Only a caret, never a selection: restating a position would collapse text
       the reader had chosen. */
    const selection = editor.state.selection
    const held = editor.isFocused && selection.empty ? posToOffset(editor.state.doc, selection.head) : null
    editor.view.dispatch(editor.state.tr.setMeta("addToHistory", false))
    if (held === null) return

    const frame = requestAnimationFrame(() => {
      if (editor.isDestroyed || !editor.isFocused) return
      if (posToOffset(editor.state.doc, editor.state.selection.head) !== held) return
      editor.commands.setTextSelection(offsetToPos(editor.state.doc, held))
    })
    return () => cancelAnimationFrame(frame)
  }, [editor, ghost, pending])

  React.useImperativeHandle(
    ref,
    () => ({
      get value() {
        return docToText(editor.state.doc)
      },
      get selectionStart() {
        return posToOffset(editor.state.doc, editor.state.selection.from)
      },
      get selectionEnd() {
        return posToOffset(editor.state.doc, editor.state.selection.to)
      },
      setSelectionRange(start, end) {
        const doc = editor.state.doc
        editor.commands.setTextSelection({ from: offsetToPos(doc, start), to: offsetToPos(doc, end) })
      },
      focus() {
        editor.commands.focus()
      },
    }),
    [editor]
  )

  return (
    <PastesContext.Provider value={pastes}>
      <EditorContent
        ref={editorContentRef}
        editor={editor}
        onKeyDownCapture={onKeyDown}
        className={cn("composer-editor overflow-y-auto", disabled && "opacity-50", className)}
      />
    </PastesContext.Provider>
  )
}
