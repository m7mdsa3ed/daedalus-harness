/* ── Routines ── the saved thread-starts that fire on their own.
   The upper half of the Automations tier. Its whole job is to be *distinct*
   from the lower half: a routine starts a NEW thread from nothing, a scheduled
   message speaks into one that already exists. They sit together because they
   are the same question ("what happens without me?") and they are labelled
   apart because the answer is not the same thing twice. */
import { Bot, MoreVertical, Pause, Pencil, Play, Plus, Trash2, Zap } from "lucide-react"
import { useNavigate } from "react-router"
import { reportError } from "@/lib/errors"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import { useConfirm } from "@/components/confirm-dialog"
import type { Actions } from "@/lib/actions"
import { newRoutinePath, routinePath, routinesPath } from "@/lib/router"
import type { Routine } from "@/lib/settings"
import { useStoreSelect } from "@/lib/store"
import { toast } from "@/lib/toast"
import { cn } from "@/lib/utils"
import { FoldableGroup, HEADER_BUTTON } from "./groups"
import { ACTION, MENU } from "./scale"

/** Routines, one row each: the name over what it will do without you.

    Shown even when empty for the reason the Scheduled half is: a section that
    hides itself is the one place nobody can find in order to create the first
    item. It never fetches — `routines` is loaded by `bootstrap()`, and
    the sidebar asking the server a question nobody posed is exactly what the
    old Usage row was removed for. Which is also why a row cannot say when it
    next fires: triggers are a separate read, owned by the routine's own page,
    and half a schedule printed here would be a guess. */
export function RoutinesGroup({ actions }: { actions: Actions }) {
  const projects = useStoreSelect((store) => store.projects)
  const routines = useStoreSelect((store) => store.routines)
  const navigate = useNavigate()
  const { isMobile, setOpenMobile } = useSidebar()
  const confirm = useConfirm()

  const go = (path: string) => {
    if (isMobile) setOpenMobile(false)
    void navigate(path)
  }

  const projectName = (id: string) =>
    projects.find((project) => project.id === id)?.name ?? "a project that no longer exists"

  const toggle = (routine: Routine) => {
    actions
      .updateRoutine(routine.id, { enabled: !routine.enabled })
      .catch((err) => reportError(err, "Couldn't update the routine"))
  }

  /* Deliberately the plain run and not the dry run: the forced-to-ask one is
     the *first* run you make, and it belongs on the routine's own page beside
     the sentence explaining what it is for. From here, "Run now" means the
     routine as configured — including whatever it has been granted. */
  const run = (routine: Routine) => {
    actions
      .runRoutine(routine.id, {})
      .then(() => toast.success(`${routine.name} started`))
      .catch((err) => reportError(err, "Couldn't run the routine"))
  }

  const remove = async (routine: Routine) => {
    if (
      !(await confirm({
        title: `Delete “${routine.name}”?`,
        description:
          "Its triggers stop firing and its run history goes with it. The threads its past runs created are ordinary threads and are left alone.",
        destructive: true,
        confirmLabel: "Delete routine",
      }))
    )
      return
    actions.deleteRoutine(routine.id).catch((err) => reportError(err, "Couldn't delete the routine"))
  }

  return (
    <FoldableGroup
      nested
      groupKey="__routines"
      label="Routines"
      icon={<Zap className="size-3 shrink-0" />}
      count={routines.length > 0 ? routines.length : undefined}
      action={
        <>
          {routines.length > 0 && (
            <button
              type="button"
              title="Manage routines"
              onClick={() => go(routinesPath())}
              className={HEADER_BUTTON}
            >
              <Pencil className="size-3" />
              <span className="sr-only">Manage routines</span>
            </button>
          )}
          <button
            type="button"
            title="New routine"
            onClick={() => go(newRoutinePath())}
            className={HEADER_BUTTON}
          >
            <Plus className="size-3.5" />
            <span className="sr-only">New routine</span>
          </button>
        </>
      }
    >
      {routines.length === 0 ? (
        <p className="px-2 py-2 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
          No routines. + saves a thread-start that fires on its own.
        </p>
      ) : (
        <SidebarMenu className={MENU}>
          {routines.map((routine) => (
            <SidebarMenuItem key={routine.id}>
              <SidebarMenuButton
                tooltip={`${routine.name} — starts a new thread in ${projectName(routine.projectId)}${routine.enabled ? "" : " (disabled)"}`}
                onClick={() => go(routinePath(routine.id))}
                className="h-auto min-h-8 px-2 py-1 text-[13px]"
              >
                {/* Two lines, and the second one is the whole reason this half
                    is labelled apart from Scheduled: it says *starts a new
                    thread*, in a named project, which is the difference. */}
                <span className="min-w-0 flex-1">
                  <span
                    className={cn(
                      "block truncate text-[13px] leading-tight",
                      !routine.enabled && "text-muted-foreground"
                    )}
                  >
                    {routine.name}
                  </span>
                  <span className="block truncate text-[10px] leading-tight text-muted-foreground">
                    {routine.enabled ? "" : "Disabled · "}
                    Starts a new thread in {projectName(routine.projectId)}
                  </span>
                </span>
              </SidebarMenuButton>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <SidebarMenuAction showOnHover title="Routine actions" className={ACTION}>
                      <MoreVertical />
                      <span className="sr-only">Routine actions</span>
                    </SidebarMenuAction>
                  }
                />
                <DropdownMenuContent side="right" align="start" className="w-48">
                  <DropdownMenuItem onClick={() => run(routine)}>
                    <Bot />
                    Run now
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => toggle(routine)}>
                    {routine.enabled ? <Pause /> : <Play />}
                    {routine.enabled ? "Disable" : "Enable"}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => go(routinePath(routine.id))}>
                    <Pencil />
                    Open…
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onClick={() => void remove(routine)}>
                    <Trash2 />
                    Delete routine
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      )}
    </FoldableGroup>
  )
}
