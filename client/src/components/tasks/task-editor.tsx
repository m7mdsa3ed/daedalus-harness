import { useEditor, EditorContent, type Editor } from "@tiptap/react"
import StarterKit from "@tiptap/starter-kit"
import Placeholder from "@tiptap/extension-placeholder"
import { TaskList, TaskItem } from "@tiptap/extension-list"
import { Markdown } from "tiptap-markdown"
import * as React from "react"
import { cn } from "@/lib/utils"
import {
  Bold,
  Italic,
  Strikethrough,
  Code,
  List,
  ListOrdered,
  ListChecks,
  TextQuote,
  SquareCode,
  FileCode,
  Link2,
  Minus,
  Sparkles,
} from "lucide-react"
import { Spinner } from "@/components/ui/spinner"
import { enhanceDraft, resolveEnhanceModelId, resolveEnhanceProfile } from "@/lib/enhance"
import { reportError } from "@/lib/errors"
import { useProfiles } from "@/lib/queries/catalog"
import { useServer } from "@/lib/server-context"

interface TaskEditorProps {
  value: string
  onChange: (markdown: string) => void
  placeholder?: string
  className?: string
  /** The task's title, handed to the AI draft as context. Present = the button is drawn. */
  title?: string
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

const Sep = () => <span className="mx-1 h-5 w-px bg-border" />

function HeadingButton({ editor, level }: { editor: Editor; level: 1 | 2 | 3 }) {
  return (
    <button
      type="button"
      title={`Heading ${level}`}
      aria-label={`Heading ${level}`}
      aria-pressed={editor.isActive("heading", { level })}
      onClick={() => editor.chain().focus().toggleHeading({ level }).run()}
      className={cn(
        "inline-flex h-7 min-w-7 items-center justify-center rounded-md px-1 text-xs font-semibold text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        editor.isActive("heading", { level }) && "bg-accent text-foreground",
      )}
    >
      H{level}
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

const getMarkdown = (editor: Editor) =>
  (editor.storage as unknown as { markdown: { getMarkdown: () => string } }).markdown.getMarkdown()

export function TaskEditor({ value, onChange, placeholder, className, title }: TaskEditorProps) {
  const [source, setSource] = React.useState(false)
  const settings = useServer()
  const profiles = useProfiles()
  // ponytail: the composer enhancer's device-local profile/model pick, reused rather than a second picker.
  const profile = resolveEnhanceProfile(profiles)
  const [drafting, setDrafting] = React.useState(false)
  const [raw, setRaw] = React.useState(value)
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        link: {
          openOnClick: false,
          autolink: true,
          HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" },
        },
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
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
        class: "prose prose-sm max-w-none min-h-[140px] px-4 py-3 focus:outline-none",
      },
    },
    onUpdate: ({ editor }) => onChange(getMarkdown(editor)),
  })

  if (!editor) {
    return <div className={cn("min-h-[180px] animate-pulse rounded-xl border bg-background", className)} />
  }

  const toggleSource = () => {
    if (source) editor.commands.setContent(raw)
    else setRaw(getMarkdown(editor))
    setSource(!source)
  }
  /* Draft or restructure the description from the title and whatever is there.
     The answer replaces the document as one undoable step (⌘Z takes it back). */
  const draftWithAi = async () => {
    if (!profile || drafting) return
    const current = source ? raw : getMarkdown(editor)
    setDrafting(true)
    try {
      const md = await enhanceDraft(settings, `Title: ${title ?? ""}\n\n${current}`.trim(), {
        profileId: profile.id,
        model: resolveEnhanceModelId(profile) || undefined,
        kind: "task",
      })
      if (source) setRaw(md)
      editor.commands.setContent(md)
      onChange(md)
    } catch (err) {
      reportError(err, "Couldn't draft the description")
    } finally {
      setDrafting(false)
    }
  }
  const run = (fn: () => boolean) => () => void fn()
  const chain = () => editor.chain().focus()

  return (
    <div
      className={cn(
        "task-editor rounded-xl border border-input bg-background transition-colors focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50",
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-0.5 border-b border-border/60 bg-muted/30 p-1">
        {!source && (
          <>
            <HeadingButton editor={editor} level={1} />
            <HeadingButton editor={editor} level={2} />
            <HeadingButton editor={editor} level={3} />
            <Sep />
            <ToolbarButton title="Bold" active={editor.isActive("bold")} onClick={run(() => chain().toggleBold().run())}>
              <Bold className="size-4" />
            </ToolbarButton>
            <ToolbarButton title="Italic" active={editor.isActive("italic")} onClick={run(() => chain().toggleItalic().run())}>
              <Italic className="size-4" />
            </ToolbarButton>
            <ToolbarButton title="Strikethrough" active={editor.isActive("strike")} onClick={run(() => chain().toggleStrike().run())}>
              <Strikethrough className="size-4" />
            </ToolbarButton>
            <ToolbarButton title="Inline code" active={editor.isActive("code")} onClick={run(() => chain().toggleCode().run())}>
              <Code className="size-4" />
            </ToolbarButton>
            <ToolbarButton title="Link" active={editor.isActive("link")} onClick={() => setLink(editor)}>
              <Link2 className="size-4" />
            </ToolbarButton>
            <Sep />
            <ToolbarButton title="Bulleted list" active={editor.isActive("bulletList")} onClick={run(() => chain().toggleBulletList().run())}>
              <List className="size-4" />
            </ToolbarButton>
            <ToolbarButton title="Numbered list" active={editor.isActive("orderedList")} onClick={run(() => chain().toggleOrderedList().run())}>
              <ListOrdered className="size-4" />
            </ToolbarButton>
            <ToolbarButton title="Task list" active={editor.isActive("taskList")} onClick={run(() => chain().toggleTaskList().run())}>
              <ListChecks className="size-4" />
            </ToolbarButton>
            <Sep />
            <ToolbarButton title="Quote" active={editor.isActive("blockquote")} onClick={run(() => chain().toggleBlockquote().run())}>
              <TextQuote className="size-4" />
            </ToolbarButton>
            <ToolbarButton title="Code block" active={editor.isActive("codeBlock")} onClick={run(() => chain().toggleCodeBlock().run())}>
              <SquareCode className="size-4" />
            </ToolbarButton>
            <ToolbarButton title="Divider" onClick={run(() => chain().setHorizontalRule().run())}>
              <Minus className="size-4" />
            </ToolbarButton>
          </>
        )}
        <span className="ml-auto flex items-center gap-0.5">
          {title !== undefined && profile && (
            <button
              type="button"
              onClick={() => void draftWithAi()}
              disabled={drafting}
              title={value.trim() ? "Restructure with AI" : "Draft with AI"}
              className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
            >
              {drafting ? <Spinner className="size-3.5" /> : <Sparkles className="size-3.5" />}
              {drafting ? "Writing…" : "AI"}
            </button>
          )}
          <ToolbarButton title={source ? "Rich text" : "Markdown source"} active={source} onClick={toggleSource}>
            <FileCode className="size-4" />
          </ToolbarButton>
        </span>
      </div>
      {source ? (
        <textarea
          value={raw}
          onChange={(e) => {
            setRaw(e.target.value)
            onChange(e.target.value)
          }}
          spellCheck={false}
          aria-label="Markdown source"
          className="block min-h-[140px] w-full resize-y bg-transparent px-4 py-3 font-mono text-xs leading-relaxed outline-none"
        />
      ) : (
        <EditorContent editor={editor} />
      )}
    </div>
  )
}
