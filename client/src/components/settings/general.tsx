import * as React from "react"
import { Plus, Server, Trash2, Pencil, ArrowRightLeft, Unplug } from "lucide-react"
import { useConfirm } from "@/components/confirm-dialog"
import { Button } from "@/components/ui/button"
import { Empty } from "@/components/empty"
import { usePrompt } from "@/components/prompt-dialog"
import { teardownPush } from "@/lib/push"
import {
  loadServers,
  removeServer,
  renameServer,
  serverName,
  setActiveServer,
  type ServerSettings,
} from "@/lib/settings"
import { InstallGroup, SecurityGroup, SiteDataGroup } from "./app"
import { DataTable, TitleCell } from "@/components/ui/data-table"
import type { ColumnDef } from "@/lib/table"
import type { TableAction } from "@/components/ui/data-table"
import { Group, PageHeader, Row, Section, StatusBadge } from "./primitives"
import { errorText } from "@/lib/errors"
import { useAppMeta } from "@/lib/queries"
import { SERVER_UPDATE_COMMAND } from "@/lib/compat"
import { ChangelogDialog } from "@/components/changelog-dialog"
import { CopyButton } from "@/components/ui/copy-button"
import { sectionMeta } from "./sections"
import { useSettingsPage } from "./layout"
import { useTableFilter } from "@/lib/use-table-filter"

/* ── General ──
   The servers this device knows (lib/settings stores several side by side),
   then the device side of the install. Managing servers lives here and not
   in the sidebar any more: switching, renaming and forgetting are settings —
   rare, deliberate, and worth a page with room to say what each does — and
   the sidebar footer now just names the active server and links here. */
export function GeneralPage() {
  const { settings, onAddServer } = useSettingsPage()
  const meta = sectionMeta("general")
  return (
    <>
      <PageHeader
        meta={meta}
        action={
          <Button onClick={onAddServer}>
            <Plus data-icon="inline-start" /> Add server
          </Button>
        }
      />
      <ServersGroup active={settings} onAdd={onAddServer} />
      <InstallGroup hint="This device: origin-local state, nothing here talks to the server. Install it, check the browser trusts the page, and repair it when it doesn't." />
      <SecurityGroup />
      <SiteDataGroup />
      <AboutStrip />
    </>
  )
}

/* Switching re-boots the app against the newly-active connection in place —
   threads, the ACP sockets and the whole store belong to one server, and
   App.tsx ends and rebuilds all three off `setActiveServer`. Renaming the
   active server is still a hard navigation: its name is read from `settings`
   throughout the app. */
function ServersGroup({ active, onAdd }: { active: ServerSettings; onAdd: () => void }) {
  const confirm = useConfirm()
  const prompt = usePrompt()
  const [servers, setServers] = React.useState(loadServers)

  const switchTo = (server: ServerSettings) => {
    if (server.id === active.id) return
    setActiveServer(server.id)
  }
  const startRename = async (server: ServerSettings) => {
    const name = await prompt({
      title: "Rename server",
      value: server.name,
      placeholder: serverName(server.url),
      confirmLabel: "Save",
    })
    if (name && name !== server.name) {
      renameServer(server.id, name)
      if (server.id === active.id) {
        location.assign("/")
        return
      }
      setServers(loadServers())
    }
  }
  /* Forgetting the active server has to drop this device from its push list
     first — the token outlives the connection, so a server nobody is connected
     to any more would go on notifying this device with no way left in the UI
     to stop it. The navigation waits, but only briefly, since an unreachable
     server is one of the reasons to disconnect. A stored-but-inactive server
     was never registered for push from this session, so it just goes. */
  const forget = async (server: ServerSettings) => {
    const isActive = server.id === active.id
    const ok = await confirm({
      title: isActive ? `Disconnect from ${server.name}?` : `Forget ${server.name}?`,
      description: isActive
        ? "Forgets this server's URL and token on this device and reloads. Threads live on the server and are not touched; other stored servers stay."
        : "Forgets this server's URL and token on this device. Nothing on the server is touched.",
      confirmLabel: isActive ? "Disconnect" : "Forget",
      destructive: true,
    })
    if (!ok) return
    if (isActive) {
      void Promise.race([teardownPush(active), new Promise((resolve) => setTimeout(resolve, 2000))]).finally(
        () => {
          removeServer(server.id)
          location.assign("/")
        }
      )
      return
    }
    removeServer(server.id)
    setServers(loadServers())
  }

  const meta = useAppMeta()
  const version = meta.data?.version

  const columns = React.useMemo<ColumnDef<ServerSettings, unknown>[]>(
    () => [
      {
        id: "name",
        header: "Server",
        meta: { title: true },
        cell: ({ row }) => <TitleCell title={row.original.name} subtitle={<span className="font-mono">{row.original.url}</span>} />,
      },
      {
        id: "version",
        header: "Version",
        meta: { className: "hidden @panel-md:table-cell" },
        cell: ({ row }) =>
          row.original.id === active.id && version ? (
            <span className="font-mono text-sm">{version}</span>
          ) : (
            <span className="hidden text-muted-foreground @panel-md:inline">—</span>
          ),
      },
      {
        id: "status",
        header: "Status",
        meta: { align: "end" },
        cell: ({ row }) =>
          row.original.id === active.id ? (
            <StatusBadge tone="ok">Connected</StatusBadge>
          ) : (
            <StatusBadge tone="neutral" dot={false}>Saved</StatusBadge>
          ),
      },
    ],
    [active.id, version]
  )

  /* Memoised: the table memoises each row against its actions. The handlers close over
     `active` and `confirm` only (the rest is setState), so those are the deps. */
  /* eslint-disable react-hooks/exhaustive-deps */
  const actions = React.useMemo<TableAction<ServerSettings>[]>(() => [
    { id: "switch", label: "Switch", icon: <ArrowRightLeft />, onClick: switchTo, hidden: (s) => s.id === active.id, position: "left" },
    { id: "rename", label: "Rename", icon: <Pencil />, onClick: (s) => void startRename(s), position: "left" },
    { id: "disconnect", label: "Disconnect", icon: <Unplug />, tone: "danger", onClick: (s) => void forget(s), hidden: (s) => s.id !== active.id },
    { id: "forget", label: "Forget", icon: <Trash2 />, tone: "danger", onClick: (s) => void forget(s), hidden: (s) => s.id === active.id },
  ], [active, confirm, prompt])
  /* eslint-enable react-hooks/exhaustive-deps */

  const f = useTableFilter(servers, {
    text: (s) => `${s.name} ${s.url}`,
    placeholder: "Search servers…",
    fields: [{ id: "status", label: "Status", of: (s) => (s.id === active.id ? "Connected" : "Saved") }],
  })

  return (
    <Section
      label="Servers"
      count={servers.length}
      hint="Each server keeps its own threads; this device stores the URL and token of every one it knows."
    >
      {servers.length === 0 ? (
        <Empty
          size="lg"
          icon={Server}
          action={
            <Button className="pointer-coarse:h-11" onClick={onAdd}>
              <Plus data-icon="inline-start" /> Add server
            </Button>
          }
        >
          No servers stored on this device.
        </Empty>
      ) : (
        <DataTable
          columns={columns}
          data={f.rows}
          filtering={f.filtering}
          getRowId={(s) => s.id}
          mark={() => <Server />}
          actions={actions}
          rowClassName={(s) => (s.id === active.id ? "bg-muted [&>td:first-child]:bg-muted" : undefined)}
          emptyIcon={<Server />}
        />
      )}
    </Section>
  )
}

/* ── About ──
   What is running where: the deployment's version from /api/meta and the build
   this device is running (a compile-time constant), shown apart because they
   can legitimately differ — the browser keeps serving a cached shell until its
   pending update is applied — plus the changelog both halves of a release are
   written into. */
function AboutStrip() {
  const meta = useAppMeta()
  const [changelogOpen, setChangelogOpen] = React.useState(false)
  return (
    <>
      <Group label="About" hint="The deployment's version and the build this device is running can differ until a pending update is applied.">
        <Row title="Server" subtitle="The harness deployed on the active connection.">
          {meta.data ? (
            <StatusBadge tone="info" dot={false}>{meta.data.version}</StatusBadge>
          ) : meta.isError ? (
            <span title={errorText(meta.error)}>
              <StatusBadge tone="bad">Unavailable</StatusBadge>
            </span>
          ) : null}
        </Row>
        <Row title="Client" subtitle="The build this device is running.">
          <StatusBadge tone="info" dot={false}>{__APP_VERSION__}</StatusBadge>
        </Row>
        <Row title="Update the server" subtitle="Run on the server host, in the harness checkout.">
          <span className="flex min-w-0 items-center gap-1">
            <code className="min-w-0 truncate rounded-md bg-muted px-2 py-0.5 font-mono text-sm">{SERVER_UPDATE_COMMAND}</code>
            <CopyButton text={SERVER_UPDATE_COMMAND} size="icon-sm" className="shrink-0 pointer-coarse:size-11" />
          </span>
        </Row>
        <Row title="Changelog" subtitle="What changed in each release.">
          <Button
            variant="outline"
            size="sm"
            className="pointer-coarse:h-11"
            disabled={!meta.data}
            onClick={() => setChangelogOpen(true)}
          >
            What's new · Changelog
          </Button>
        </Row>
      </Group>
      <ChangelogDialog open={changelogOpen} onOpenChange={setChangelogOpen} />
    </>
  )
}
