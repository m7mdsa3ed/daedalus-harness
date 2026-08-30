import { Cpu } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { profileSupports } from "@/lib/settings"
import { useStore } from "@/lib/store"
import { PageHeader, Group, Row, EmptyCard } from "./primitives"
import { sectionMeta } from "./sections"

export function AgentsPage() {
  const meta = sectionMeta("agents")
  const { state } = useStore()
  return (
    <>
      <PageHeader meta={meta} />
      {state.agents.length === 0 ? (
        <EmptyCard icon={Cpu} text="The server has no agents registered." />
      ) : (
        <Group>
          {state.agents.map((agent) => {
            const uses = state.profiles.filter((p) => profileSupports(p, agent.id)).length
            return (
              <Row
                key={agent.id}
                icon={Cpu}
                title={agent.name}
                subtitle={<span className="font-mono">{agent.id}</span>}
              >
                <Badge variant="secondary">
                  {uses} profile{uses === 1 ? "" : "s"}
                </Badge>
              </Row>
            )
          })}
        </Group>
      )}
    </>
  )
}
