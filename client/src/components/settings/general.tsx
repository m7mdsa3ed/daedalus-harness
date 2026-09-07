import * as React from "react"
import { Plus } from "lucide-react"
import { useConfirm } from "@/components/confirm-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
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
import { PageHeader, Group, Row } from "./primitives"
import { errorText } from "@/lib/errors"
import { useAppMeta } from "@/lib/queries"
import { ChangelogDialog } from "@/components/changelog-dialog"
import { sectionMeta } from "./sections"
import { useSettingsPage } from "./layout"
import { EnhanceGroup } from "./enhance"

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
            <Plus className="size-4" /> Add server
          </Button>
        }
      />
      <ServersGroup active={settings} />
      <EnhanceGroup />
      <InstallGroup />
      <SecurityGroup />
      <SiteDataGroup />
      <AboutGroup />
    </>
  )
}

/* Switching re-boots the app against the newly-active connection in place —
   threads, the ACP sockets and the whole store belong to one server, and
   App.tsx ends and rebuilds all three off `setActiveServer`. Renaming the
   active server is still a hard navigation: its name is read from `settings`
   throughout the app. */
function ServersGroup({ active }: { active: ServerSettings }) {
  const confirm = useConfirm()
  const [servers, setServers] = React.useState(loadServers)
  const [renaming, setRenaming] = React.useState<ServerSettings | null>(null)
  const [renameValue, setRenameValue] = React.useState("")

  const switchTo = (server: ServerSettings) => {
    if (server.id === active.id) return
    setActiveServer(server.id)
  }
  const startRename = (server: ServerSettings) => {
    setRenaming(server)
    setRenameValue(server.name)
  }
  const saveRename = () => {
    if (!renaming) return
    const name = renameValue.trim()
    if (name && name !== renaming.name) {
      renameServer(renaming.id, name)
      if (renaming.id === active.id) {
        location.assign("/")
        return
      }
      setServers(loadServers())
    }
    setRenaming(null)
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

  return (
    <>
      <Group label="Servers">
        {servers.map((server) => {
          const isActive = server.id === active.id
          return (
            <div
              key={server.id}
              className="flex flex-col gap-3 px-3.5 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:px-4"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{server.name}</div>
                <div className="mt-0.5 break-all font-mono text-xs text-muted-foreground">{server.url}</div>
              </div>
              <div className="flex w-full shrink-0 flex-col gap-1.5 sm:w-auto sm:flex-row sm:items-center">
                {isActive ? (
                  <Badge
                    variant="secondary"
                    className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-md border px-3 text-sm sm:w-auto"
                  >
                    <span className="size-1.5 rounded-full bg-emerald-500" />
                    Connected
                  </Badge>
                ) : (
                  <Button variant="outline" size="sm" className="h-9 w-full sm:w-auto" onClick={() => switchTo(server)}>
                    Switch
                  </Button>
                )}
                <Button variant="outline" size="sm" className="h-9 w-full sm:w-auto" onClick={() => startRename(server)}>
                  Rename
                </Button>
                {isActive ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-9 w-full text-destructive sm:w-auto"
                    onClick={() => void forget(server)}
                  >
                    Disconnect
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-9 w-full text-destructive sm:w-auto"
                    onClick={() => void forget(server)}
                  >
                    Forget
                  </Button>
                )}
              </div>
            </div>
          )
        })}
      </Group>
      <ResponsiveDialog open={renaming !== null} onOpenChange={(open) => !open && setRenaming(null)}>
        <ResponsiveDialogContent className="sm:max-w-sm">
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle>Rename server</ResponsiveDialogTitle>
          </ResponsiveDialogHeader>
          <Input
            autoFocus
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveRename()
            }}
            placeholder={renaming ? serverName(renaming.url) : undefined}
          />
          <ResponsiveDialogFooter>
            <Button variant="outline" onClick={() => setRenaming(null)}>
              Cancel
            </Button>
            <Button onClick={saveRename} disabled={!renameValue.trim()}>
              Save
            </Button>
          </ResponsiveDialogFooter>
        </ResponsiveDialogContent>
      </ResponsiveDialog>
    </>
  )
}

/* ── About ──
   What is running where: the deployment's version from /api/meta and the build
   this device is running (a compile-time constant), shown apart because they
   can legitimately differ — the browser keeps serving a cached shell until its
   pending update is applied — plus the changelog both halves of a release are
   written into. */
function AboutGroup() {
  const meta = useAppMeta()
  const [changelogOpen, setChangelogOpen] = React.useState(false)
  return (
    <Group label="About">
      <Row title="Server version" subtitle="The harness deployed on the active connection.">
        {meta.data ? (
          <Badge variant="secondary">{meta.data.version}</Badge>
        ) : meta.isError ? (
          <span className="text-sm text-muted-foreground">{errorText(meta.error)}</span>
        ) : null}
      </Row>
      <Row title="Client version" subtitle="The build this device is running.">
        <Badge variant="secondary">{__APP_VERSION__}</Badge>
      </Row>
      <Row title="What's new" subtitle="Everything each version changed.">
        <Button
          variant="outline"
          size="sm"
          className="h-9 w-full sm:w-auto"
          disabled={!meta.data}
          onClick={() => setChangelogOpen(true)}
        >
          Changelog
        </Button>
      </Row>
      <ChangelogDialog open={changelogOpen} onOpenChange={setChangelogOpen} />
    </Group>
  )
}
