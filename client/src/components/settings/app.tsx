/* ── Device groups of the General page ──
   The device side of the install: whether this app is installed, whether the
   browser considers the page secure enough to install it, and the two clears
   that repair it when it isn't. Nothing here talks to the harness server —
   it is all origin-local state. These used to be their own "App" section;
   they sit under General now, below the server list, since both halves are
   "this device" and one page is easier to find than two. */
import * as React from "react"
import { toast } from "@/lib/toast"
import { reportPromise } from "@/lib/errors"
import { useConfirm } from "@/components/confirm-dialog"
import { Button } from "@/components/ui/button"
import { promptInstall, useInstallStatus } from "@/lib/install"
import {
  clearAllSiteData,
  clearAppCache,
  inspectSecurity,
  type SecurityFinding,
  type SiteDataReport,
} from "@/lib/site-data"
import { FormSection, StatusBadge, type StatusTone } from "./primitives"

/* One device panel is a `FormSection`: a heading with its status at the end,
   the words inside the card, the actions along the foot. */
function DevicePanel({
  title,
  hint,
  status,
  actions,
  children,
}: {
  title: string
  hint?: React.ReactNode
  status?: React.ReactNode
  actions?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <FormSection label={title} hint={hint} action={status}>
      <div className="space-y-3 text-xs/relaxed text-muted-foreground">{children}</div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </FormSection>
  )
}

/* Chrome no longer surfaces an install offer on its own — see lib/install.ts —
   so without this tile the app is installable and yet offers nobody a way to
   install it. Every state says something: the two that cannot act explain why
   rather than showing a button that does nothing. */
export function InstallGroup({ hint }: { hint?: React.ReactNode } = {}) {
  const status = useInstallStatus()
  return (
    <DevicePanel
      title="Install"
      hint={hint}
      status={
        status === "installed" ? (
          <StatusBadge tone="ok">Installed</StatusBadge>
        ) : status === "available" ? (
          <StatusBadge tone="ok">Ready</StatusBadge>
        ) : (
          <StatusBadge tone={status === "manual" ? "info" : "neutral"}>
            {status === "manual" ? "Manual" : "Not offered"}
          </StatusBadge>
        )
      }
      actions={
        status === "available" && (
          <Button
            className="w-full pointer-coarse:h-11 @panel-sm:w-auto"
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
            Install Daedalus
          </Button>
        )
      }
    >
      <p>
        {status === "available" &&
          "Add it to this device so it opens in its own window, without browser chrome."}
        {status === "installed" && "Already installed on this device."}
        {status === "manual" &&
          "On iOS, open the Share menu in Safari and choose Add to Home Screen. Safari has no install button for a site to offer."}
        {status === "unavailable" &&
          "Not offered on this device yet. Installing needs an https page and a browser that supports it — the security checks say which part is missing."}
      </p>
    </DevicePanel>
  )
}

const FINDING_TONE: Record<SecurityFinding["level"], StatusTone> = {
  ok: "ok",
  warn: "warn",
  error: "bad",
}

const FINDING_LABEL: Record<SecurityFinding["level"], string> = {
  ok: "OK",
  warn: "Check",
  error: "Problem",
}

/** Why the browser does or does not trust this page. Recomputed on mount rather
    than held in state: every input (protocol, server URL, SW controller) is
    already settled by the time the settings route renders. */
export function SecurityGroup() {
  const findings = React.useMemo(() => inspectSecurity(), [])
  const errors = findings.filter((f) => f.level === "error").length
  const warns = findings.filter((f) => f.level === "warn").length
  return (
    <DevicePanel
      title="Security"
      status={
        errors ? (
          <StatusBadge tone="bad">
            {errors} problem{errors === 1 ? "" : "s"}
          </StatusBadge>
        ) : warns ? (
          <StatusBadge tone="warn">{warns} to check</StatusBadge>
        ) : (
          <StatusBadge tone="ok">All clear</StatusBadge>
        )
      }
    >
      <ul className="space-y-2.5">
        {findings.map((finding, index) => (
          <li key={index} className="flex items-start gap-2.5">
            <StatusBadge tone={FINDING_TONE[finding.level]}>{FINDING_LABEL[finding.level]}</StatusBadge>
            <div className="min-w-0">
              <div className="text-sm font-medium break-words text-foreground">{finding.title}</div>
              <div className="break-words">{finding.detail}</div>
            </div>
          </li>
        ))}
      </ul>
      <p className="border-t border-border/60 pt-3 text-[11px]/relaxed">
        <span className="font-medium text-foreground/80">Certificates and site permissions.</span> A page cannot
        clear a certificate, a certificate exception or an HSTS entry — that state is the browser's, deliberately
        out of reach of the sites it protects. In Chrome: tap the icon left of the address bar → Permissions /
        Site settings, or Settings → Privacy and security.
      </p>
    </DevicePanel>
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

export function SiteDataGroup() {
  const confirm = useConfirm()
  const [busy, setBusy] = React.useState<"cache" | "all" | null>(null)

  /* Both clears end in a reload, and it has to be a real navigation rather than
     a re-render: an unregistered worker keeps controlling the page it already
     controls, so until the document goes away the shell on screen is still the
     one that was just thrown out. */
  const run = (kind: "cache" | "all") => {
    setBusy(kind)
    void reportPromise(kind === "cache" ? clearAppCache() : clearAllSiteData(), {
      loading: kind === "cache" ? "Clearing the app cache…" : "Clearing every byte this site stored…",
      success: (report) => {
        // Long enough to read; the reload is the half that actually takes effect.
        window.setTimeout(() => location.assign("/"), 900)
        return {
          title: kind === "cache" ? "App cache cleared" : "Site data cleared",
          description: `${summarize(report)} Reloading…`,
        }
      },
      context: "Couldn't clear it",
    }).catch(() => setBusy(null))
  }

  return (
    <DevicePanel title="Site data">
      <div className="space-y-2">
        <div>
          <p className="text-sm font-medium text-foreground">Clear app cache</p>
          <p>
            Delete the offline shell and unregister the service worker, then reload. Fixes an app stuck on an old
            build. Your server, drafts, pins and themes are kept.
          </p>
        </div>
        <Button
          variant="outline"
          className="w-full pointer-coarse:h-11 @panel-sm:w-auto"
          disabled={busy !== null}
          onClick={() => {
            void run("cache")
          }}
        >
          {busy === "cache" ? "Clearing…" : "Clear cache"}
        </Button>
      </div>
      <div className="space-y-2 border-t border-border/60 pt-3">
        <div>
          <p className="text-sm font-medium text-foreground">Clear all site data</p>
          <p>
            Everything above plus every byte this site stored — including the server URL and token, so this device
            is disconnected and has to be set up again.
          </p>
        </div>
        <Button
          variant="destructive"
          className="w-full pointer-coarse:h-11 @panel-sm:w-auto"
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
      </div>
    </DevicePanel>
  )
}
