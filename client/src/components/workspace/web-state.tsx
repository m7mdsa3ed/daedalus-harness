/* ── Why the Browser is not showing a page ──
   Every way a preview can come up empty, said once, in one place. The panel used
   to carry these as a tail of stacked `Notice`s above a blank frame — "start the
   dev server", "some sites refuse to be framed", and a mixed-content line that
   stated the problem and offered nothing to do about it. A reader who hit the
   last one had to work out for themselves that the app being https was the
   cause, that the frame would never load, and that the only way out was the
   toolbar button. This file is the answer to each of them, with the way out
   attached.

   The states are exclusive and derived in `web-panel` — one failure is what is
   happening, not three at once — so this is a switch rather than a stack. Each
   one names the address it is about, offers the controls that actually resolve
   it, and carries a **Copy** (the rule every drawn error follows): a preview
   that will not load is the kind of thing worth pasting into an issue or
   handing to another agent, and there is nothing on screen to select by hand.

   `Empty` is for the one state that is not a failure — no address typed yet,
   which is instruction rather than news. Everything else is a `Notice`. */
import * as React from "react"
import {
  ExternalLinkIcon,
  GlobeIcon,
  PencilIcon,
  PlayIcon,
  RefreshCwIcon,
  ShieldAlertIcon,
  WifiOffIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { CopyButton } from "@/components/ui/copy-button"
import { Empty } from "@/components/empty"
import { Notice } from "@/components/notice"
import type { WebTrust } from "@/lib/workspace/panels"

/** What the panel knows about why there is no page. Exactly one of these is
    what is happening; `null` is a page that is up (or trying to be). */
export type WebProblem =
  /** Nothing typed yet — instruction, not a failure. */
  | { kind: "empty" }
  /** The app is https and the address is http: the browser will never frame it. */
  | { kind: "mixed"; url: string }
  /** The project's own probe says nothing is listening on the configured URL. */
  | { kind: "unreachable"; url: string }
  /** An address was given, the frame was asked for, and nothing came back. */
  | { kind: "timeout"; url: string }

/** The report a **Copy** hands over. One shape for every state so the button is
    built the same way each time, and so a paste into an issue names the address,
    the app's own protocol (which is the whole cause of the mixed-content case)
    and what the panel concluded. */
function reportOf(problem: WebProblem, where: string): string {
  const facts = [
    where,
    `Page protocol: ${window.location.protocol}`,
    typeof window !== "undefined" ? `User agent: ${navigator.userAgent}` : "",
  ].filter(Boolean)
  const what =
    problem.kind === "mixed"
      ? "The address is http and this app is https, so the browser refuses to frame it (mixed content)."
      : problem.kind === "unreachable"
        ? "Nothing answered on the configured preview address."
        : problem.kind === "timeout"
          ? "The request was made and no page came back before the timeout."
          : "No address has been entered."
  return [`Browser panel: ${what}`, ...facts].join("\n")
}

/** The address itself, on its own line in the monospace voice the rest of the
    app gives a URL. Wraps rather than truncates: a long address is the thing
    being diagnosed. */
function Address({ url }: { url: string }) {
  return (
    <p className="font-mono text-xs break-all text-foreground">{url}</p>
  )
}

export function WebProblemView({
  problem,
  trust,
  starting,
  previewHelperName,
  onReload,
  onEditAddress,
  onOpenExternal,
  onStartPreview,
}: {
  problem: WebProblem
  trust: WebTrust
  /** A preview command is running; the probe's fast lane will pick it up. */
  starting: boolean
  /** The helper "Start" would run, when the project has one marked as preview. */
  previewHelperName?: string
  onReload: () => void
  onEditAddress: () => void
  onOpenExternal: () => void
  onStartPreview?: () => void
}) {
  /* ── Nothing typed yet ── the one state that is not a failure. */
  if (problem.kind === "empty") {
    return (
      <div className="p-4">
        <Empty size="lg" icon={GlobeIcon}>
          {trust === "external" ? (
            <>
              Enter an address above, or follow a source from a thread — the pages an agent read
              open here.
            </>
          ) : (
            <>
              Enter this project's development server above —{" "}
              <code className="font-mono">localhost:5173</code>, or whatever its{" "}
              <code className="font-mono">dev</code> script prints.
            </>
          )}
        </Empty>
      </div>
    )
  }

  const where = `Address: ${problem.url}`
  const copy = <CopyButton text={reportOf(problem, where)} label="Copy details" />

  /* ── The app is https and the page is http ──
     The one failure with no in-panel fix, so it is said plainly and the two
     real ways out are the two buttons. The blank frame the old build left
     behind was the worst version of this: nothing on screen even said the
     address had been refused. */
  if (problem.kind === "mixed") {
    return (
      <div className="p-4">
        <Notice
          tone="error"
          size="md"
          icon={<ShieldAlertIcon />}
          title="An https page is not allowed to show an http one"
          action={
            <Button size="sm" variant="outline" onClick={onOpenExternal}>
              <ExternalLinkIcon /> Open in a browser
            </Button>
          }
        >
          <p>
            This app is served over <span className="font-mono">https</span>, and the browser will
            not frame an <span className="font-mono">http://</span> address inside it — the frame
            stays blank however long it waits. There are two ways out:
          </p>
          <Address url={problem.url} />
          <ul className="ml-4 list-disc space-y-0.5 text-pretty">
            <li>Open it in a browser tab, which has no such rule.</li>
            <li>
              Or serve the dev server over https — for a Vite server,{" "}
              <span className="font-mono">server.https</span>, or a tunnel in front of it — then
              enter that address here.
            </li>
          </ul>
          <div className="flex flex-wrap items-center gap-1.5 pt-1">
            <Button size="sm" variant="ghost" onClick={onEditAddress}>
              <PencilIcon /> Change the address
            </Button>
            {copy}
          </div>
        </Notice>
      </div>
    )
  }

  if (problem.kind === "unreachable") {
    return (
      <div className="p-4">
        <Notice
          tone="warn"
          size="md"
          icon={<WifiOffIcon />}
          title="Nothing is answering at this address"
          action={
            previewHelperName && onStartPreview ? (
              <Button size="sm" variant="outline" onClick={onStartPreview} loading={starting}>
                <PlayIcon data-icon="inline-start" />
                {`Start ${previewHelperName}`}
              </Button>
            ) : undefined
          }
        >
          <p>
            The address is reachable from the machine running the server, and nothing is listening on
            it. {previewHelperName ? "Starting it will reload this panel on its own." : "Start the dev server, then reload."}
          </p>
          <Address url={problem.url} />
          <div className="flex flex-wrap items-center gap-1.5 pt-1">
            <Button size="sm" variant="ghost" onClick={onReload}>
              <RefreshCwIcon /> Reload
            </Button>
            <Button size="sm" variant="ghost" onClick={onEditAddress}>
              <PencilIcon /> Change the address
            </Button>
            <Button size="sm" variant="ghost" onClick={onOpenExternal}>
              <ExternalLinkIcon /> Open in a browser
            </Button>
            {copy}
          </div>
        </Notice>
      </div>
    )
  }

  /* ── Asked for, and nothing came back ──
     The one thing this can honestly say: the request was made and no page
     arrived. Whether that is a wrong port, a host that is not up, or a frame the
     server hung on is exactly what cannot be read from a cross-origin frame —
     so it is not claimed. */
  return (
    <div className="p-4">
      <Notice
        tone="warn"
        size="md"
        icon={<WifiOffIcon />}
        title="No page came back"
        action={
          <Button size="sm" variant="outline" onClick={onReload}>
            <RefreshCwIcon /> Reload
          </Button>
        }
      >
        <p>
          The address was requested and nothing answered in time. Check that the address and its
          port are right, and that the server is running.
        </p>
        <Address url={problem.url} />
        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          <Button size="sm" variant="ghost" onClick={onEditAddress}>
            <PencilIcon /> Change the address
          </Button>
          <Button size="sm" variant="ghost" onClick={onOpenExternal}>
            <ExternalLinkIcon /> Open in a browser
          </Button>
          {copy}
        </div>
      </Notice>
    </div>
  )
}

/** The one hint that is not a failure and cannot be detected: whatever pasted
    the address served a page whose headers forbid framing. The refusal is the
    publisher's and enforced by the browser, so nothing crosses the boundary to
    be read here — a blocked frame and a slow one look identical from in here.
    Said once, up front, and dismissible; the button that always works is in the
    toolbar and in every failure above. */
export function WebFrameHint({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div className="px-2 pt-2">
      <Notice
        icon={<ShieldAlertIcon />}
        action={
          <Button type="button" variant="ghost" size="xs" onClick={onDismiss}>
            Got it
          </Button>
        }
      >
        Some sites refuse to be shown inside another page. If this stays blank, use{" "}
        <span className="text-foreground">Open in your browser</span>.
      </Notice>
    </div>
  )
}
