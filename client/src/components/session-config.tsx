import { Settings2Icon } from "lucide-react"
import { toast } from "sonner"
import { useConfirm } from "@/components/confirm-dialog"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { Actions } from "@/lib/actions"
import { useStore, type ThreadState } from "@/lib/store"

const DEFAULT_CHOICE = "__default__"

function flattenSelectOptions(
  options: import("@agentclientprotocol/sdk").SessionConfigSelectOptions
) {
  return options.flatMap((entry) => ("options" in entry ? entry.options : [entry]))
}

/**
 * Model + effort + profile, one compact trigger (reference: ModelEffortPopover).
 * Profile/model/effort changes respawn the agent process and restore the
 * conversation via session/load; "Agent options" apply live over ACP.
 */
export function SessionConfigPopover({
  sessionId,
  actions,
  thread,
}: {
  sessionId: string
  actions: Actions
  thread: ThreadState
}) {
  const { state } = useStore()
  const confirm = useConfirm()
  const meta = state.sessions.find((s) => s.id === sessionId)
  const profile = state.profiles.find((p) => p.id === meta?.profileId)
  if (!meta || !profile) return null

  // Some agents advertise the permission mode both as `modes` (rendered as the
  // composer's standalone select) and again as a select config option (the
  // newer ACP channel). Hide the config-option twin: same value set = same knob.
  const modeIds = new Set(thread.modes?.availableModes.map((m) => m.id) ?? [])
  const agentOptions = thread.configOptions.filter((option) => {
    if (option.type !== "select" || modeIds.size === 0) return true
    const values = flattenSelectOptions(option.options).map((c) => c.value)
    return !(values.length === modeIds.size && values.every((v) => modeIds.has(v)))
  })

  const agentProfiles = state.profiles.filter((p) => p.agentId === profile.agentId)
  const models = profile.models
  const resolvedModel = models.find((m) => m.id === (meta.model || profile.defaultModel))
  const efforts = resolvedModel?.reasoningEfforts ?? []
  const modelLabel = resolvedModel?.label ?? (meta.model || "Default")

  const change = async (next: { profileId?: string; model?: string; effort?: string }) => {
    if (
      thread.turnActive &&
      !(await confirm({
        title: "Restart the agent?",
        description: "A turn is running — switching stops it, then the conversation is restored.",
        confirmLabel: "Restart",
      }))
    )
      return
    actions.changeSession(meta, next).catch((err) => toast.error(String(err)))
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" className="h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground">
            <Settings2Icon className="size-3.5" />
            <span className="max-w-40 truncate">
              {modelLabel}
              {meta.effort && <span className="capitalize"> · {meta.effort}</span>}
            </span>
          </Button>
        }
      />
      <DropdownMenuContent align="start" className="w-60">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Session</DropdownMenuLabel>
          {agentProfiles.length > 1 && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <span className="flex-1">Profile</span>
                <span className="max-w-24 truncate text-xs text-muted-foreground">{profile.name}</span>
              </DropdownMenuSubTrigger>
              <DropdownMenuPortal>
                <DropdownMenuSubContent>
                  <DropdownMenuRadioGroup
                    value={profile.id}
                    onValueChange={(id) => id && id !== profile.id && change({ profileId: id })}
                  >
                    {agentProfiles.map((p) => (
                      <DropdownMenuRadioItem key={p.id} value={p.id}>
                        {p.name}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuPortal>
            </DropdownMenuSub>
          )}
          {models.length > 0 && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <span className="flex-1">Model</span>
                <span className="max-w-24 truncate text-xs text-muted-foreground">{modelLabel}</span>
              </DropdownMenuSubTrigger>
              <DropdownMenuPortal>
                <DropdownMenuSubContent>
                  <DropdownMenuRadioGroup
                    value={meta.model || DEFAULT_CHOICE}
                    onValueChange={(id) => {
                      if (!id || id === (meta.model || DEFAULT_CHOICE)) return
                      change({ model: id === DEFAULT_CHOICE ? "" : id, effort: "" })
                    }}
                  >
                    <DropdownMenuRadioItem value={DEFAULT_CHOICE}>
                      <span className="text-muted-foreground">Default model</span>
                    </DropdownMenuRadioItem>
                    {models.map((m) => (
                      <DropdownMenuRadioItem key={m.id} value={m.id}>
                        {m.label}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuPortal>
            </DropdownMenuSub>
          )}
          {efforts.length > 0 && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <span className="flex-1">Effort</span>
                <span className="max-w-24 truncate text-xs text-muted-foreground capitalize">
                  {meta.effort || "Default"}
                </span>
              </DropdownMenuSubTrigger>
              <DropdownMenuPortal>
                <DropdownMenuSubContent>
                  <DropdownMenuRadioGroup
                    value={meta.effort || DEFAULT_CHOICE}
                    onValueChange={(id) => {
                      if (!id || id === (meta.effort || DEFAULT_CHOICE)) return
                      change({ effort: id === DEFAULT_CHOICE ? "" : id })
                    }}
                  >
                    <DropdownMenuRadioItem value={DEFAULT_CHOICE}>
                      <span className="text-muted-foreground">Default effort</span>
                    </DropdownMenuRadioItem>
                    {efforts.map((effort) => (
                      <DropdownMenuRadioItem key={effort} value={effort}>
                        <span className="capitalize">{effort}</span>
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuPortal>
            </DropdownMenuSub>
          )}
        </DropdownMenuGroup>
        {agentOptions.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>Agent options</DropdownMenuLabel>
              {agentOptions.map((option) =>
                option.type === "select" ? (
                  <DropdownMenuSub key={option.id}>
                    <DropdownMenuSubTrigger>
                      <span className="flex-1">{option.name}</span>
                      <span className="max-w-24 truncate text-xs text-muted-foreground">
                        {flattenSelectOptions(option.options).find((c) => c.value === option.currentValue)?.name}
                      </span>
                    </DropdownMenuSubTrigger>
                    <DropdownMenuPortal>
                      <DropdownMenuSubContent>
                        <DropdownMenuRadioGroup
                          value={option.currentValue}
                          onValueChange={(value) =>
                            value &&
                            actions
                              .setConfigOption(sessionId, option.id, value)
                              .catch((err) => toast.error(String(err)))
                          }
                        >
                          {flattenSelectOptions(option.options).map((choice) => (
                            <DropdownMenuRadioItem key={choice.value} value={choice.value}>
                              {choice.name}
                            </DropdownMenuRadioItem>
                          ))}
                        </DropdownMenuRadioGroup>
                      </DropdownMenuSubContent>
                    </DropdownMenuPortal>
                  </DropdownMenuSub>
                ) : (
                  <DropdownMenuCheckboxItem
                    key={option.id}
                    checked={option.currentValue}
                    onCheckedChange={(checked) =>
                      actions
                        .setConfigOption(sessionId, option.id, checked === true)
                        .catch((err) => toast.error(String(err)))
                    }
                  >
                    {option.name}
                  </DropdownMenuCheckboxItem>
                )
              )}
            </DropdownMenuGroup>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
