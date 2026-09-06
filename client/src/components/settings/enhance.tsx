import { Sparkles } from "lucide-react"
import { ProfileIcon } from "@/components/entity-icon"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  enhanceCapable,
  enhanceModelLabel,
  resolveEnhanceModelId,
  resolveEnhanceProfile,
  setEnhanceModelId,
  setEnhanceProfileId,
  useEnhanceModelId,
  useEnhanceProfileId,
} from "@/lib/enhance"
import { useProfiles } from "@/lib/queries/catalog"
import { Group, Row } from "./primitives"

/* ── Prompt enhancer ──
   Which profile the composer's Enhance button rewrites through. Device-local
   like the thread defaults: the provider you trust with a rewrite is a habit
   of the hand typing, not a property of the thread. Only stored profiles with
   a real endpoint are offered — virtual Defaults carry none, so the button
   hides itself while nothing here is picked. */
export function EnhanceGroup() {
  const profiles = useProfiles()
  /* Subscribed for the re-render: the pick lives in a module store, so without
     this a pick made here would not move the row until something else did. */
  useEnhanceProfileId()
  useEnhanceModelId()
  const capable = enhanceCapable(profiles)
  const picked = resolveEnhanceProfile(profiles)
  const pickedModelId = resolveEnhanceModelId(picked)
  if (capable.length === 0) return null
  return (
    <Group label="Composer">
      <Row
        icon={Sparkles}
        title="Enhance prompts with"
        subtitle="The profile whose endpoint rewrites the composer's drafts. The box is replaced, unsent — sending is still yours."
      >
        <Select value={picked?.id} onValueChange={(id) => setEnhanceProfileId(id)}>
          <SelectTrigger className="w-full max-sm:h-9 sm:w-56">
            <SelectValue>{picked?.name ?? "Pick a profile"}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {capable.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                <span className="flex items-center gap-2 min-w-0">
                  <ProfileIcon profile={p} className="size-4 shrink-0" />
                  <span className="truncate">{p.name}</span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>
      {picked && picked.models.length > 0 && (
        <Row
          icon={Sparkles}
          title="Enhance model"
          subtitle="The model the rewrite runs on — or the profile default when nothing is picked."
        >
          <Select
            value={pickedModelId || "__default__"}
            onValueChange={(id) => setEnhanceModelId(!id || id === "__default__" ? "" : id)}
          >
            <SelectTrigger className="w-full max-sm:h-9 sm:w-56">
              <SelectValue>{enhanceModelLabel(picked, pickedModelId)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__default__">Profile default</SelectItem>
              {picked.models.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  <span className="truncate">{m.label}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>
      )}
    </Group>
  )
}
