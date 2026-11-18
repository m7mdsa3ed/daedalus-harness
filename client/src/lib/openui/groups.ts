/* ── The component groups ──
   Which components a thread's `uiGroups` switches on and off, as plain data: the
   picker imports it, the library builds its `componentGroups` from it, and the
   server mirrors the ids (`personas.ts`). No React and no library import on
   purpose — the picker must never pull the lazy `openui-view` chunk just to list
   a group. A group's `label` is its `### Heading` in the generated prompt, so it
   is unique and the generator splits on it (`scripts/gen-openui.mjs`). `layout` is
   required: `root = Stack(...)` lives there, so an empty set is the lane off and
   any other set includes it. */
export type UiGroup = { id: string; label: string; caption: string; components: string[] }

export const UI_GROUPS: UiGroup[] = [
  { id: "layout", label: "Layout", caption: "Containers and structure. Required: turning it off turns drawn answers off.", components: ["Stack", "Grid", "Card", "Divider", "Tabs", "Accordion", "Heading", "Text"] },
  { id: "text", label: "Text", caption: "Markdown, tables, lists, badges and callouts for prose-shaped answers.", components: ["Markdown", "Table", "List", "Badges", "Callout"] },
  {
    id: "interactive",
    label: "Interactive",
    caption: "Buttons, form fields, dates, rankings and editable tables. A pick fills the reader's composer; nothing runs on its own.",
    components: ["Button", "Form", "FormControl", "Input", "Textarea", "Select", "SelectItem", "Checkbox", "Switch", "RadioGroup", "Slider", "DatePicker", "Rank", "EditableTable"],
  },
  { id: "dev", label: "Developer", caption: "Code, shell sessions and diffs, copyable.", components: ["Code"] },
  { id: "diagrams", label: "Diagrams", caption: "Flowcharts and sequence diagrams.", components: ["Flowchart", "Sequence"] },
  { id: "numbers", label: "Numbers", caption: "Metrics with trends, charts and meters.", components: ["Stat", "Chart", "Progress"] },
  { id: "media", label: "Media", caption: "Images and galleries. Remote images load only on a click.", components: ["Image"] },
]

export const DEFAULT_UI_GROUPS = UI_GROUPS.map((group) => group.id)

/** A set cut to known ids, in registry order. Empty stays empty (drawn answers
    off); anything else gets `layout` forced in (the root lives there). Mirrors
    the server's `normalizeUiGroups`. */
export function normalizeUiGroups(groups: readonly string[] | undefined | null): string[] {
  const asked = new Set(groups ?? [])
  if (asked.size === 0) return []
  return DEFAULT_UI_GROUPS.filter((id) => id === "layout" || asked.has(id))
}

/** Two sets are the same set: order ignored, null/undefined reads as all of
    them (the server's own reading of an absent set). */
export function sameUiGroups(
  a: readonly string[] | undefined | null,
  b: readonly string[] | undefined | null
): boolean {
  return normalizeUiGroups(a ?? DEFAULT_UI_GROUPS).join() === normalizeUiGroups(b ?? DEFAULT_UI_GROUPS).join()
}
