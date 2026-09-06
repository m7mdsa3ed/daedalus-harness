import { useEditor, EditorContent, type Editor } from "@tiptap/react"
import StarterKit from "@tiptap/starter-kit"
import Placeholder from "@tiptap/extension-placeholder"
import { Markdown } from "tiptap-markdown"
import { cn } from "@/lib/utils"
import {
  Bold,
  Italic,
  Strikethrough,
  Code,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  Quote,
  Undo2,
  Redo2,
  Link2,
  Minus,
} from "lucide-react"

interface TaskEditorProps {
  value: string
  onChange: (markdown: string) => void
  placeholder?: string
  className?: string
}

function ToolbarButton({
  active,
  onClick,
  title,
  children,
}: {
  active?: boolean
  onClick: () => void
  title: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active && "bg-accent text-foreground",
      )}
    >
      {children}
    </button>
  )
}

function setLink(editor: Editor) {
  const previous = editor.getAttributes("link").href as string | undefined
  const url = window.prompt("Link URL", previous ?? "https://")
  if (url === null) return
  if (url === "") {
    editor.chain().focus().extendMarkRange("link").unsetLink().run()
    return
  }
  editor
    .chain()
    .focus()
    .extendMarkRange("link")
    .setLink({ href: url })
    .run()
}

export function TaskEditor({ value, onChange, placeholder, className }: TaskEditorProps) {
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3] },
        link: {
          openOnClick: false,
          autolink: true,
          HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" },
        },
      }),
      Placeholder.configure({ placeholder: placeholder ?? "Describe this task…" }),
      Markdown.configure({
        html: false,
        transformPastedText: true,
        transformCopiedText: true,
        tightLists: true,
      }),
    ],
    content: value,
    editorProps: {
      attributes: {
        class:
          "prose prose-sm max-w-none min-h-[140px] px-3 py-2 focus:outline-none",
      },
    },
    onUpdate: ({ editor }) =>
      onChange(
        (editor.storage as unknown as { markdown: { getMarkdown: () => string } }).markdown.getMarkdown(),
      ),
  })

  if (!editor) {
    return (
      <div
        className={cn(
          "min-h-[180px] rounded-lg border bg-background animate-pulse",
          className,
        )}
      />
    )
  }

  return (
    <div
      className={cn(
        "task-editor rounded-xl border border-input bg-input/30 transition-colors focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50",
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-0.5 border-b border-border/60 p-1">
        <ToolbarButton
          title="Bold"
          active={editor.isActive("bold")}
          onClick={() => editor.chain().focus().toggleBold().run()}
        >
          <Bold className="size-4" />
        </ToolbarButton>
        <ToolbarButton
          title="Italic"
          active={editor.isActive("italic")}
          onClick={() => editor.chain().focus().toggleItalic().run()}
        >
          <Italic className="size-4" />
        </ToolbarButton>
        <ToolbarButton
          title="Strikethrough"
          active={editor.isActive("strike")}
          onClick={() => editor.chain().focus().toggleStrike().run()}
        >
          <Strikethrough className="size-4" />
        </ToolbarButton>
        <ToolbarButton
          title="Inline code"
          active={editor.isActive("code")}
          onClick={() => editor.chain().focus().toggleCode().run()}
        >
          <Code className="size-4" />
        </ToolbarButton>
        <ToolbarButton
          title="Link"
          active={editor.isActive("link")}
          onClick={() => setLink(editor)}
        >
          <Link2 className="size-4" />
        </ToolbarButton>
        <span className="mx-1 h-5 w-px bg-border" />
        <ToolbarButton
          title="Heading"
          active={editor.isActive("heading", { level: 2 })}
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        >
          <Heading2 className="size-4" />
        </ToolbarButton>
        <ToolbarButton
          title="Subheading"
          active={editor.isActive("heading", { level: 3 })}
          onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
        >
          <Heading3 className="size-4" />
        </ToolbarButton>
        <ToolbarButton
          title="Quote"
          active={editor.isActive("blockquote")}
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
        >
          <Quote className="size-4" />
        </ToolbarButton>
        <ToolbarButton
          title="Bulleted list"
          active={editor.isActive("bulletList")}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
        >
          <List className="size-4" />
        </ToolbarButton>
        <ToolbarButton
          title="Numbered list"
          active={editor.isActive("orderedList")}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
        >
          <ListOrdered className="size-4" />
        </ToolbarButton>
        <ToolbarButton
          title="Divider"
          onClick={() => editor.chain().focus().setHorizontalRule().run()}
        >
          <Minus className="size-4" />
        </ToolbarButton>
        <span className="mx-1 h-5 w-px bg-border" />
        <ToolbarButton
          title="Undo"
          onClick={() => editor.chain().focus().undo().run()}
        >
          <Undo2 className="size-4" />
        </ToolbarButton>
        <ToolbarButton
          title="Redo"
          onClick={() => editor.chain().focus().redo().run()}
        >
          <Redo2 className="size-4" />
        </ToolbarButton>
      </div>
      <EditorContent editor={editor} />
    </div>
  )
}
