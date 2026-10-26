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
  MoreHorizontal,
  Sparkles,
  Unlink,
} from "lucide-react"
import { Button } from "@/components/ui/busy-button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { enhanceDraft, resolveEnhanceModelId, resolveEnhanceProfile } from "@/lib/enhance"
import { reportError } from "@/lib/errors"
import { useProfiles } from "@/lib/queries/catalog"
import { useServer } from "@/lib/server-context"
import { ICON_BTN } from "./fields"

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
  className,
  children,
  ...props
}: {
  active?: boolean
  onClick?: () => void
  title: string
  className?: string
  children?: React.ReactNode
} & Omit<React.ComponentProps<typeof Button>, "onClick" | "title" | "children">) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      title={title}
      aria-label={title}
      aria-pressed={active}
      onClick={onClick}
      {...props}
      className={cn("shrink-0 text-muted-foreground", ICON_BTN, active && "bg-muted text-foreground", className)}
    >
      {children}
    </Button>
  )
}

const Sep = ({ className }: { className?: string }) => <Separator orientation="vertical" className={cn("mx-1 h-5 shrink-0", className)} />

/** One toolbar entry. `core` ones stay in the row on a narrow panel; the rest
    move behind the ⋯ below `@panel-sm`. */
interface Tool {
  title: string
  icon: React.ReactNode
  core?: boolean
  active?: boolean
  run: () => void
}

/** The link's URL, asked for in place: an empty answer removes the link. */
function LinkButton({ editor }: { editor: Editor }) {
  const [open, setOpen] = React.useState(false)
  const [url, setUrl] = React.useState("")
  const apply = (href: string) => {
    const chain = editor.chain().focus().extendMarkRange("link")
    if (href.trim()) chain.setLink({ href: href.trim() }).run()
    else chain.unsetLink().run()
    setOpen(false)
  }
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setUrl((editor.getAttributes("link").href as string | undefined) ?? "https://")
        setOpen(next)
      }}
    >
      <PopoverTrigger render={<ToolbarButton title="Link" active={editor.isActive("link")} />}>
        <Link2 />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 gap-2 p-2">
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            apply(url)
          }}
        >
          <Input autoFocus type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" aria-label="Link URL" className="h-8 pointer-coarse:h-11" />
          <Button type="submit" size="sm" className="pointer-coarse:h-11">
            Apply
          </Button>
        </form>
        {editor.isActive("link") && (
          <Button type="button" variant="ghost" size="sm" className="justify-start text-muted-foreground pointer-coarse:h-11" onClick={() => apply("")}>
            <Unlink data-icon="inline-start" /> Remove link
          </Button>
        )}
      </PopoverContent>
    </Popover>
  )
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
    return <Skeleton className={cn("min-h-44 rounded-xl", className)} />
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
  const chain = () => editor.chain().focus()
  const heading = (level: 1 | 2 | 3): Tool => ({
    title: `Heading ${level}`,
    icon: <span className="text-xs font-medium">H{level}</span>,
    active: editor.isActive("heading", { level }),
    run: () => void chain().toggleHeading({ level }).run(),
  })
  const groups: Tool[][] = [
    [heading(1), heading(2), heading(3)],
    [
      { title: "Bold", icon: <Bold />, core: true, active: editor.isActive("bold"), run: () => void chain().toggleBold().run() },
      { title: "Italic", icon: <Italic />, core: true, active: editor.isActive("italic"), run: () => void chain().toggleItalic().run() },
      { title: "Strikethrough", icon: <Strikethrough />, active: editor.isActive("strike"), run: () => void chain().toggleStrike().run() },
      { title: "Inline code", icon: <Code />, core: true, active: editor.isActive("code"), run: () => void chain().toggleCode().run() },
      { title: "Link", icon: <Link2 />, core: true, run: () => {} },
    ],
    [
      { title: "Bulleted list", icon: <List />, core: true, active: editor.isActive("bulletList"), run: () => void chain().toggleBulletList().run() },
      { title: "Numbered list", icon: <ListOrdered />, active: editor.isActive("orderedList"), run: () => void chain().toggleOrderedList().run() },
      { title: "Task list", icon: <ListChecks />, core: true, active: editor.isActive("taskList"), run: () => void chain().toggleTaskList().run() },
    ],
    [
      { title: "Quote", icon: <TextQuote />, active: editor.isActive("blockquote"), run: () => void chain().toggleBlockquote().run() },
      { title: "Code block", icon: <SquareCode />, active: editor.isActive("codeBlock"), run: () => void chain().toggleCodeBlock().run() },
      { title: "Divider", icon: <Minus />, run: () => void chain().setHorizontalRule().run() },
    ],
  ]

  return (
    <div
      className={cn(
        "task-editor rounded-xl border border-input bg-transparent transition-colors focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50",
        className,
      )}
    >
      {/* One row that never wraps: below @panel-sm the core marks stay and the
          rest are behind the ⋯, so the box keeps its height on a phone. */}
      <div className="flex items-center gap-0.5 overflow-x-auto border-b bg-muted/50 p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {!source && (
          <>
            {groups.map((group, g) => (
              <React.Fragment key={g}>
                {g > 0 && (
                  <Sep
                    className={
                      group.every((t) => !t.core) || groups.slice(0, g).flat().every((t) => !t.core) ? "hidden @panel-sm:block" : undefined
                    }
                  />
                )}
                {group.map((tool) =>
                  tool.title === "Link" ? (
                    <LinkButton key="link" editor={editor} />
                  ) : (
                    <ToolbarButton
                      key={tool.title}
                      title={tool.title}
                      active={tool.active}
                      onClick={tool.run}
                      className={tool.core ? undefined : "hidden @panel-sm:inline-flex"}
                    >
                      {tool.icon}
                    </ToolbarButton>
                  ),
                )}
              </React.Fragment>
            ))}
            <DropdownMenu>
              <DropdownMenuTrigger render={<ToolbarButton title="More formatting" className="@panel-sm:hidden" />}>
                <MoreHorizontal />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-48">
                {groups.flat().filter((t) => !t.core).map((tool) => (
                  <DropdownMenuItem key={tool.title} onClick={tool.run} className={cn(tool.active && "bg-muted")}>
                    {tool.icon} {tool.title}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          {title !== undefined && profile && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void draftWithAi()}
              loading={drafting}
              title={value.trim() ? "Restructure with AI" : "Draft with AI"}
              className="text-muted-foreground pointer-coarse:h-11"
            >
              <Sparkles data-icon="inline-start" />
              AI
            </Button>
          )}
          <ToolbarButton title={source ? "Rich text" : "Markdown source"} active={source} onClick={toggleSource}>
            <FileCode />
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
          className="block min-h-[140px] w-full resize-y bg-transparent px-4 py-3 font-mono text-base md:text-sm leading-relaxed outline-none"
        />
      ) : (
        <EditorContent editor={editor} />
      )}
    </div>
  )
}
