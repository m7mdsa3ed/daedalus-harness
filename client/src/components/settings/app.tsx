/* ── App settings ──
   The device side of the install: whether this app is installed, whether the
   browser considers the page secure enough to install it, and the two clears
   that repair it when it isn't. Nothing here talks to the harness server —
   it is all origin-local state, which is why it does not live on General. */
import * as React from "react"
import { toast } from "sonner"
import { AlertTriangle, CheckCircle2, Info } from "lucide-react"
import { useConfirm } from "@/components/confirm-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { promptInstall, useInstallStatus } from "@/lib/install"
import {
  clearAllSiteData,
  clearAppCache,
  inspectSecurity,
  type SecurityFinding,
  type SiteDataReport,
} from "@/lib/site-data"
import { PageHeader, Group, Row } from "./primitives"
import { sectionMeta } from "./sections"

export function AppPage() {
  const meta = sectionMeta("app")
  return (
    <>
      <PageHeader meta={meta} />
      <InstallGroup />
      <SecurityGroup />
      <SiteDataGroup />
    </>
  )
}

/* Chrome no longer surfaces an install offer on its own — see lib/install.ts —
   so without this row the app is installable and yet offers nobody a way to
   install it. Every state says something: the two that cannot act explain why
   rather than showing a button that does nothing. */
function InstallGroup() {
  const status = useInstallStatus()
  return (
    <Group label="Install">
      {status === "available" && (
        <Row
          title="Install Daedalus"
          subtitle="Add it to this device so it opens in its own window, without browser chrome."
        >
          <Button
            onClick={() => {
              void promptInstall().then((outcome) => {
                // "dismissed" needs no toast — the user just closed the dialog.
                // "unavailable" means the prompt went stale between render and
                // click, which is worth saying, since the button did nothing.
                if (outcome === "unavailable") {
                  toast("Install isn't available right now", {
                    description:
                      "Try the browser's own menu — look for Install or Add to Home screen.",
                  })
                }
              })
            }}
          >
            Install
          </Button>
        </Row>
      )}
      {status === "installed" && (
        <Row title="Install Daedalus" subtitle="Already installed on this device.">
          <Badge variant="secondary" className="gap-1.5">
            <span className="size-1.5 rounded-full bg-emerald-500" />
            Installed
          </Badge>
        </Row>
      )}
      {status === "manual" && (
        <Row
          title="Install Daedalus"
          subtitle="On iOS, open the Share menu in Safari and choose Add to Home Screen. Safari has no install button for a site to offer."
        />
      )}
      {status === "unavailable" && (
        <Row
          title="Install Daedalus"
          subtitle="Not offered on this device yet. Installing needs an https page and a browser that supports it — the checks below say which part is missing."
        />
      )}
    </Group>
  )
}

const FINDING_ICON: Record<SecurityFinding["level"], typeof Info> = {
  ok: CheckCircle2,
  warn: Info,
  error: AlertTriangle,
}

const FINDING_TONE: Record<SecurityFinding["level"], string> = {
  ok: "text-emerald-500",
  warn: "text-amber-500",
  error: "text-destructive",
}

/** Why the browser does or does not trust this page. Recomputed on mount rather
    than held in state: every input (protocol, server URL, SW controller) is
    already settled by the time the settings route renders. */
function SecurityGroup() {
  const findings = React.useMemo(() => inspectSecurity(), [])
  return (
    <Group label="Security">
      {findings.map((finding, index) => {
        const Icon = FINDING_ICON[finding.level]
        return (
          <Row
            key={index}
            title={
              <span className="flex items-center gap-2">
                <Icon className={`size-4 shrink-0 ${FINDING_TONE[finding.level]}`} />
                {finding.title}
              </span>
            }
            subtitle={finding.detail}
          />
        )
      })}
      <Row
        title="Certificates and site permissions"
        subtitle="A page cannot clear a certificate, a certificate exception or an HSTS entry — that state is the browser's, deliberately out of reach of the sites it protects. In Chrome: tap the icon left of the address bar → Permissions / Site settings, or Settings → Privacy and security."
      />
    </Group>
  )
}

function summarize(report: SiteDataReport): string {
  const parts = [
    `${report.caches} cache${report.caches === 1 ? "" : "s"}`,
    `${report.workers} service worker${report.workers === 1 ? "" : "s"}`,
  ]
  if (report.keys) parts.push(`${report.keys} stored key${report.keys === 1 ? "" : "s"}`)
  if (report.databases) parts.push(`${report.databases} database${report.databases === 1 ? "" : "s"}`)
  return `Removed ${parts.join(", ")}.`
}

function SiteDataGroup() {
  const confirm = useConfirm()
  const [busy, setBusy] = React.useState<"cache" | "all" | null>(null)

  /* Both clears end in a reload, and it has to be a real navigation rather than
     a re-render: an unregistered worker keeps controlling the page it already
     controls, so until the document goes away the shell on screen is still the
     one that was just thrown out. */
  const run = async (kind: "cache" | "all") => {
    setBusy(kind)
    try {
      const report = kind === "cache" ? await clearAppCache() : await clearAllSiteData()
      toast(kind === "cache" ? "App cache cleared" : "Site data cleared", {
        description: `${summarize(report)} Reloading…`,
      })
      // Long enough to read; the reload is the half that actually takes effect.
      window.setTimeout(() => location.assign("/"), 900)
    } catch (error) {
      setBusy(null)
      toast.error("Couldn't clear it", {
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return (
    <Group label="Site data">
      <Row
        title="Clear app cache"
        subtitle="Delete the offline shell and unregister the service worker, then reload. Fixes an app stuck on an old build. Your server, drafts, pins and themes are kept."
      >
        <Button
          variant="outline"
          disabled={busy !== null}
          onClick={() => {
            void run("cache")
          }}
        >
          {busy === "cache" ? "Clearing…" : "Clear cache"}
        </Button>
      </Row>
      <Row
        title="Clear all site data"
        subtitle="Everything above plus every byte this site stored — including the server URL and token, so this device is disconnected and has to be set up again."
      >
        <Button
          variant="destructive"
          disabled={busy !== null}
          onClick={() => {
            void confirm({
              title: "Clear all site data?",
              description:
                "This disconnects the device: the server URL and token, drafts, pinned threads and themes are all removed. Threads themselves live on the server and are not touched.",
              confirmLabel: "Clear everything",
              destructive: true,
            }).then((ok) => {
              if (ok) void run("all")
            })
          }}
        >
          {busy === "all" ? "Clearing…" : "Clear all"}
        </Button>
      </Row>
    </Group>
  )
}
