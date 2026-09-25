/* ── The composer's box ──
   A Tiptap editor standing where the textarea stood, so the things riding
   along with a message are drawn *in* it: a long paste is an inline chip, an
   excerpt picked with "Ask about this" is a quote card. The model is still the
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
  Node,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  mergeAttributes,
  useEditor,
  type NodeViewProps,
} from "@tiptap/react"
import StarterKit from "@tiptap/starter-kit"
import Placeholder from "@tiptap/extension-placeholder"
import { ClipboardListIcon, MessageSquareQuoteIcon, XIcon } from "lucide-react"

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { pasteToken, type Paste } from "@/lib/pastes"
import { cn } from "@/lib/utils"
import {
  blocksToText,
  docToText,
  offsetToPos,
  posToOffset,
  textToContent,
} from "@/components/composer/editor-text"

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

const chipButton =
  "inline-flex items-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground [&_svg]:pointer-events-none"

function PasteChipView({ node, deleteNode, selected }: NodeViewProps) {
  const n = node.attrs.n as number
  const paste = React.useContext(PastesContext).find((p) => p.n === n)
  return (
    <NodeViewWrapper
      as="span"
      contentEditable={false}
      className={cn(
        "mx-0.5 inline-flex max-w-full items-center gap-0.5 rounded-md border border-border/70 bg-muted/60 py-px ps-1.5 pe-0.5 align-baseline text-[0.9em] leading-snug",
        selected && "ring-2 ring-ring/60"
      )}
    >
      <Popover>
        <PopoverTrigger
          render={
            <button
              type="button"
              className="inline-flex min-w-0 items-center gap-1 text-foreground [&_svg]:pointer-events-none"
              aria-label={`Preview ${pasteToken(n)}`}
            />
          }
        >
          <ClipboardListIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
          <span className="truncate">Pasted text #{n}</span>
          {paste && (
            <span className="shrink-0 text-muted-foreground">
              · {paste.lines.toLocaleString()} line{paste.lines === 1 ? "" : "s"}
            </span>
          )}
        </PopoverTrigger>
        <PopoverContent className="w-[min(32rem,calc(100vw-2rem))] p-0">
          <div className="border-b px-3 py-2 text-xs text-muted-foreground">
            {paste
              ? `${paste.chars.toLocaleString()} chars — sent in place of the chip, fenced.`
              : "This paste is no longer on this device."}
          </div>
          <pre className="max-h-72 overflow-auto p-3 text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">
            {paste?.text}
          </pre>
        </PopoverContent>
      </Popover>
      <button
        type="button"
        className={cn(chipButton, "p-0.5")}
        aria-label={`Remove ${pasteToken(n)}`}
        title="Remove"
        onClick={() => deleteNode()}
      >
        <XIcon aria-hidden className="size-3" />
      </button>
    </NodeViewWrapper>
  )
}

function QuoteView({ node, deleteNode, selected }: NodeViewProps) {
  const text = node.attrs.text as string
  return (
    <NodeViewWrapper
      contentEditable={false}
      className={cn(
        "my-1 flex items-start gap-2 rounded-md border-s-2 border-primary/60 bg-muted/50 py-1.5 ps-2.5 pe-1",
        selected && "ring-2 ring-ring/60"
      )}
    >
      <MessageSquareQuoteIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      <p
        title={text}
        className="line-clamp-4 min-w-0 flex-1 whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]"
      >
        {text}
      </p>
      <button
        type="button"
        className={cn(chipButton, "shrink-0 p-0.5")}
        aria-label="Remove quote"
        title="Remove quote"
        onClick={() => deleteNode()}
      >
        <XIcon aria-hidden className="size-3.5" />
      </button>
    </NodeViewWrapper>
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

const Quote = Node.create({
  name: "quote",
  group: "block",
  atom: true,
  selectable: true,
  addAttributes: () => ({
    text: {
      default: "",
      parseHTML: (el) => el.getAttribute("data-text") ?? "",
      renderHTML: (attrs) => ({ "data-text": attrs.text }),
    },
  }),
  parseHTML: () => [{ tag: "div[data-quote]" }],
  renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-quote": "" })],
  addNodeView: () => ReactNodeViewRenderer(QuoteView),
})

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
  pastes,
  placeholder,
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
  pastes: Paste[]
  placeholder: string
  disabled?: boolean
  ariaLabel: string
  className?: string
  ref?: React.Ref<TextSurface>
}) {
  /* The last string the document and the caller agreed on. A `value` that is
     not it came from outside (a pick, a recall, a quote) and is loaded; one
     that is, is the editor's own echo and is left alone. */
  const agreed = React.useRef(value)
  const latest = React.useRef({ onChange, onSelect, onPaste, placeholder })
  latest.current = { onChange, onSelect, onPaste, placeholder }
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
      Quote,
      LineBreaks,
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

  // The placeholder is a decoration; a new one needs a transaction to redraw.
  React.useEffect(() => {
    editor.view.dispatch(editor.state.tr.setMeta("addToHistory", false))
  }, [editor, placeholder])

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
        editor={editor}
        onKeyDownCapture={onKeyDown}
        className={cn("composer-editor overflow-y-auto", disabled && "opacity-50", className)}
      />
    </PastesContext.Provider>
  )
}
