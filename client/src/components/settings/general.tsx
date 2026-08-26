import { useStore } from "@/lib/store"
import { clearSettings } from "@/lib/settings"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { PageHeader, Group, Row } from "./primitives"
import { sectionMeta } from "./sections"
import { useSettingsPage } from "./layout"

export function GeneralPage() {
  const { settings } = useSettingsPage()
  const meta = sectionMeta("general")
  const { state } = useStore()
  return (
    <>
      <PageHeader meta={meta} />
      <Group>
        <Row title={settings.name} subtitle={<span className="font-mono">{settings.url}</span>}>
          <Badge variant="secondary" className="gap-1.5">
            <span className="size-1.5 rounded-full bg-emerald-500" />
            Connected
          </Badge>
        </Row>
        <Row title="Disconnect" subtitle="Forget this server's URL and token on this device. Other servers stay.">
          <Button
            variant="outline"
            size="lg"
            onClick={() => {
              clearSettings()
              location.assign("/")
            }}
          >
            Disconnect
          </Button>
        </Row>
      </Group>
      <Group label="Workspace">
        <Row title="Projects" subtitle="Workspaces threads can run in.">
          <Badge variant="secondary">{state.projects.length}</Badge>
        </Row>
        <Row title="Profiles" subtitle="Agent configurations available to new threads.">
          <Badge variant="secondary">{state.profiles.length}</Badge>
        </Row>
        <Row title="MCP servers" subtitle="Definitions projects can attach.">
          <Badge variant="secondary">{state.mcpServers.length}</Badge>
        </Row>
        <Row title="Skills" subtitle="Skill directories projects can attach.">
          <Badge variant="secondary">{state.skills.length}</Badge>
        </Row>
        <Row title="Threads" subtitle="Sessions currently held by the server.">
          <Badge variant="secondary">
            {state.sessions.filter((session) => !session.deletedAt).length}
          </Badge>
        </Row>
      </Group>
    </>
  )
}
