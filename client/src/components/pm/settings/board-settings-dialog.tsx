/* ── Board settings ──
   One dialog over everything a board is configured with, as tabs. It owns no
   configuration of its own: each tab is either an inline editor
   (columns / labels / issue types — the three that are pure lists of rows) or
   a short summary plus the dialog that already exists for that entity
   (custom fields, sprints, milestones, automations).

   Why the split: fields, sprints, milestones and rules each have a create/edit
   form with its own validation, and those forms shipped as dialogs in earlier
   milestones. Re-implementing them inline would fork the validation; opening
   them from here keeps exactly one editor per entity, and the summary above the
   button is what a settings tab is actually for — telling you what is there.

   A nested dialog stacks on top of this one and returns to it on close, which
   is why the summary lists stay mounted underneath. */
import * as React from "react"
import { Flag, Plus, Settings2, Tag, Timer, Type, Workflow, Zap } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { AutomationDialog, ruleSummary } from "@/components/pm/settings/automation-builder"
import { ColumnsEditor } from "@/components/pm/settings/columns-editor"
import {
  CustomFieldDialog,
  customFieldSummary,
  sortCustomFields,
} from "@/components/pm/settings/custom-field-editor"
import { EditorHeader } from "@/components/pm/settings/editor-bits"
import { IssueTypesEditor } from "@/components/pm/settings/issue-types-editor"
import { LabelsEditor } from "@/components/pm/settings/labels-editor"
import {
  MilestoneDialog,
  milestoneDateLabel,
  sortMilestones,
} from "@/components/pm/settings/milestone-editor"
import { SprintDialog } from "@/components/pm/settings/sprint-editor"
import type { Actions } from "@/lib/actions"
import type { Board, CustomFieldDef, Milestone, Sprint, Task } from "@/lib/pm/types"
import { useStore } from "@/lib/store"

/** The tabs, in the order a board is usually set up. */
export const BOARD_SETTINGS_TABS = [
  { id: "columns", label: "Columns", icon: Settings2 },
  { id: "labels", label: "Labels", icon: Tag },
  { id: "types", label: "Types", icon: Type },
  { id: "fields", label: "Fields", icon: Workflow },
  { id: "sprints", label: "Sprints", icon: Timer },
  { id: "milestones", label: "Milestones", icon: Flag },
  { id: "automations", label: "Automations", icon: Zap },
] as const

export type BoardSettingsTab = (typeof BOARD_SETTINGS_TABS)[number]["id"]

const EMPTY_TASKS: Task[] = []

const SPRINT_STATE_LABEL: Record<Sprint["state"], string> = {
  planned: "Planned",
  active: "Active",
  completed: "Completed",
}

export interface BoardSettingsDialogProps {
  board: Board
  open: boolean
  onOpenChange(open: boolean): void
  actions: Actions
  /** Which tab to land on; defaults to Columns. */
  tab?: BoardSettingsTab
  /** Tasks for the counts; defaults to the board's cached tasks. */
  tasks?: Task[]
}

export function BoardSettingsDialog({
  board,
  open,
  onOpenChange,
  actions,
  tab: initialTab,
  tasks,
}: BoardSettingsDialogProps) {
  const { state } = useStore()
  const [tab, setTab] = React.useState<string>(initialTab ?? "columns")

  /* Every open lands where the caller asked — a settings dialog that reopens
     on the tab you left is a settings dialog you have to read before using. */
  React.useEffect(() => {
    if (open) setTab(initialTab ?? "columns")
  }, [open, initialTab])

  const boardTasks = tasks ?? state.pmTasks[board.id] ?? EMPTY_TASKS

  /* The four nested editors. `undefined` = closed; a value (possibly null, for
     "create") = open on that entity. */
  const [fieldEditor, setFieldEditor] = React.useState<CustomFieldDef | null | undefined>()
  const [sprintEditor, setSprintEditor] = React.useState<Sprint | null | undefined>()
  const [milestoneEditor, setMilestoneEditor] = React.useState<Milestone | null | undefined>()
  const [ruleEditor, setRuleEditor] = React.useState<string | null | undefined>()

  const fields = React.useMemo(() => sortCustomFields(board.customFields), [board.customFields])
  const milestones = React.useMemo(() => sortMilestones(board.milestones), [board.milestones])
  const rules = board.automations ?? []

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="w-full gap-0 overflow-hidden p-0 sm:max-w-3xl">
          <DialogHeader className="border-b px-4 py-3 pr-14">
            <DialogTitle>{board.name} settings</DialogTitle>
            <DialogDescription>
              Columns, labels, types, fields and the rules that run on every change.
            </DialogDescription>
          </DialogHeader>

          <Tabs
            value={tab}
            onValueChange={(value) => setTab(String(value))}
            className="flex max-h-[70vh] min-h-0 flex-col"
          >
            <TabsList className="mx-4 mt-3 shrink-0 self-start">
              {BOARD_SETTINGS_TABS.map((entry) => (
                <TabsTrigger key={entry.id} value={entry.id}>
                  <entry.icon className="size-3.5" />
                  <span className="hidden sm:inline">{entry.label}</span>
                </TabsTrigger>
              ))}
            </TabsList>

            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <TabsContent value="columns">
                <ColumnsEditor board={board} actions={actions} tasks={boardTasks} />
              </TabsContent>
              <TabsContent value="labels">
                <LabelsEditor board={board} actions={actions} tasks={boardTasks} />
              </TabsContent>
              <TabsContent value="types">
                <IssueTypesEditor board={board} actions={actions} tasks={boardTasks} />
              </TabsContent>

              <TabsContent value="fields">
                <SummaryTab
                  title="Custom fields"
                  hint="Extra fields on every task of this board, rendered generically from their type."
                  empty="No custom fields yet."
                  onNew={() => setFieldEditor(null)}
                  newLabel="New field"
                  rows={fields.map((field) => ({
                    id: field.id,
                    name: field.name,
                    detail: customFieldSummary(field),
                    onOpen: () => setFieldEditor(field),
                  }))}
                />
              </TabsContent>

              <TabsContent value="sprints">
                <SummaryTab
                  title="Sprints"
                  hint="Time boxes the backlog ranks into. One sprint is active at a time."
                  empty="No sprints yet."
                  onNew={() => setSprintEditor(null)}
                  newLabel="New sprint"
                  rows={board.sprints.map((sprint) => ({
                    id: sprint.id,
                    name: sprint.name,
                    detail: sprint.goal || "No goal set",
                    badge: SPRINT_STATE_LABEL[sprint.state],
                    onOpen: () => setSprintEditor(sprint),
                  }))}
                />
              </TabsContent>

              <TabsContent value="milestones">
                <SummaryTab
                  title="Milestones"
                  hint="Dates the board is measured against. A task carries at most one."
                  empty="No milestones yet."
                  onNew={() => setMilestoneEditor(null)}
                  newLabel="New milestone"
                  rows={milestones.map((milestone) => ({
                    id: milestone.id,
                    name: milestone.name,
                    detail: milestoneDateLabel(milestone) ?? "No date",
                    badge: milestone.reachedAt === null ? undefined : "Reached",
                    onOpen: () => setMilestoneEditor(milestone),
                  }))}
                />
              </TabsContent>

              <TabsContent value="automations">
                <SummaryTab
                  title="Automations"
                  hint="WHEN something happens, IF the task looks like this, THEN change it — server-side, on every mutation."
                  empty="No rules yet."
                  onNew={() => setRuleEditor(null)}
                  newLabel="New rule"
                  rows={rules.map((rule) => ({
                    id: rule.id,
                    name: rule.name || "Untitled rule",
                    detail: ruleSummary(rule, board),
                    badge: rule.enabled ? undefined : "Off",
                    onOpen: () => setRuleEditor(rule.id),
                  }))}
                />
              </TabsContent>
            </div>
          </Tabs>
        </DialogContent>
      </Dialog>

      {/* The four existing editors, opened on top. Each is the ONLY editor for
          its entity — this dialog never forks their validation. */}
      {fieldEditor !== undefined && (
        <CustomFieldDialog
          board={board}
          open
          onOpenChange={(next) => !next && setFieldEditor(undefined)}
          actions={actions}
          field={fieldEditor}
          tasks={boardTasks}
        />
      )}
      {sprintEditor !== undefined && (
        <SprintDialog
          board={board}
          open
          onOpenChange={(next) => !next && setSprintEditor(undefined)}
          sprint={sprintEditor}
          actions={actions}
        />
      )}
      {milestoneEditor !== undefined && (
        <MilestoneDialog
          board={board}
          open
          onOpenChange={(next) => !next && setMilestoneEditor(undefined)}
          actions={actions}
          milestone={milestoneEditor}
          tasks={boardTasks}
        />
      )}
      {ruleEditor !== undefined && (
        <AutomationDialog
          board={board}
          open
          onOpenChange={(next) => !next && setRuleEditor(undefined)}
          actions={actions}
          ruleId={ruleEditor}
          tasks={boardTasks}
        />
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// The summary tabs

interface SummaryRow {
  id: string
  name: string
  detail: string
  badge?: string
  onOpen(): void
}

/** A read-only list plus the way into the entity's own editor. Deliberately
    not editable in place: the forms that own these shapes live elsewhere. */
function SummaryTab({
  title,
  hint,
  empty,
  rows,
  newLabel,
  onNew,
}: {
  title: string
  hint: string
  empty: string
  rows: SummaryRow[]
  newLabel: string
  onNew(): void
}) {
  return (
    <div className="space-y-3">
      <EditorHeader
        title={title}
        hint={hint}
        action={
          <Button type="button" variant="outline" size="sm" onClick={onNew}>
            <Plus />
            {newLabel}
          </Button>
        }
      />
      {rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">{empty}</p>
      ) : (
        <div className="space-y-1.5">
          {rows.map((row) => (
            <button
              key={row.id}
              type="button"
              onClick={row.onOpen}
              className="flex w-full items-center gap-2 rounded-md border bg-card/40 px-2 py-1.5 text-left transition-colors hover:border-ring/50 hover:bg-accent/40"
            >
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium">{row.name}</span>
                <span className="truncate text-xs text-muted-foreground">{row.detail}</span>
              </div>
              {row.badge && (
                <Badge variant="outline" className="shrink-0 font-normal">
                  {row.badge}
                </Badge>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export default BoardSettingsDialog
