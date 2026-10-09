/* ── AI helpers ──
 *
 * The model calls the harness makes *for you* rather than *as a thread*: the
 * composer's Enhance button, and source control's two drafts. They were one
 * group buried at the top of General, between the servers this device knows and
 * the browser's idea of the page's security — which is where the first one
 * landed when it was the only one, and no longer says what it is.
 *
 * They get a section because they are now a family with a rule: each of these
 * is a habit of the hand typing, not a property of a thread, so each keeps its
 * own device-local pick (`lib/ai-picks.ts`) and every one of them is one
 * side-effect-free completion on the server (`server/src/ai.ts`) rather than a
 * turn on a thread's agent. Nothing here is journaled, queued or billed to a
 * thread; the API key never leaves the server.
 */
import { FileJson2, GitBranchIcon, Sparkles } from "lucide-react"

import { ProfileIcon } from "@/components/entity-icon"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Notice } from "@/components/notice"
import { aiCapable, enhancePick, formBuilderPick, gitPick, modelPickLabel, type AiPick } from "@/lib/ai-picks"
import { useProfiles } from "@/lib/queries/catalog"
import { PageHeader, Group, Row } from "./primitives"
import { sectionMeta } from "./sections"

export function AiPage() {
  const meta = sectionMeta("ai")
  const profiles = useProfiles()
  const capable = aiCapable(profiles)

  return (
    <>
      <PageHeader meta={meta} />
      {capable.length === 0 ? (
        /* Absence with a reason, not an empty page: these need a profile with a
           real endpoint behind it, and a virtual Default has none — which is
           also why the buttons themselves stay hidden until one exists. */
        <Notice tone="neutral" title="No profile can run these yet">
          They run against a stored profile's own OpenAI-compatible endpoint. Add one under
          Settings › Profiles and it will be offered here.
        </Notice>
      ) : (
        <>
          <PickGroup
            label="Composer"
            icon={Sparkles}
            pick={enhancePick}
            title="Enhance prompts with"
            subtitle="The profile whose endpoint rewrites the composer's drafts. The box is replaced, unsent — sending is still yours."
            modelTitle="Enhance model"
          />
          <PickGroup
            label="Forms"
            icon={FileJson2}
            pick={formBuilderPick}
            title="Build forms with"
            subtitle="The model that chats through schema-backed forms and drafts values for review. Applied values remain an unsaved draft until you save the form."
            modelTitle="Form builder model"
          />
          <PickGroup
            label="Source control"
            icon={GitBranchIcon}
            pick={gitPick}
            title="Draft commits and branch names with"
            subtitle="The profile that reads a repository's diff to write a commit message or name a branch — in the composer's branch popover and the source-control panel. The diff is read on the server; nothing is sent to the thread."
            modelTitle="Source control model"
          />
        </>
      )}
    </>
  )
}

/** One helper's pair of picks. Every one of these is the same two questions —
    which profile, which of its models — so there is one component and not one
    per helper; what differs is only what the rows are called. */
function PickGroup({
  label,
  icon,
  pick,
  title,
  subtitle,
  modelTitle,
}: {
  label: string
  icon: typeof Sparkles
  pick: AiPick
  title: string
  subtitle: string
  modelTitle: string
}) {
  const profiles = useProfiles()
  /* Subscribed for the re-render: the picks live in module stores, so without
     these a pick made here would not move the row until something else did. */
  pick.useProfileId()
  pick.useModelId()
  const picked = pick.resolveProfile(profiles)
  const modelId = pick.resolveModelId(picked)
  const capable = aiCapable(profiles)

  return (
    <Group label={label}>
      <Row icon={icon} title={title} subtitle={subtitle}>
        <Select value={picked?.id} onValueChange={(id) => pick.setProfileId(id)}>
          <SelectTrigger className="h-9 w-full @panel-sm:w-56">
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
          icon={icon}
          title={modelTitle}
          subtitle="The model it runs on — or the profile's own default when nothing is picked."
        >
          <Select
            value={modelId || "__default__"}
            onValueChange={(id) => pick.setModelId(!id || id === "__default__" ? "" : id)}
          >
            <SelectTrigger className="h-9 w-full @panel-sm:w-56">
              <SelectValue>{modelPickLabel(picked, modelId)}</SelectValue>
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
