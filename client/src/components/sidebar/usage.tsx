/* ── Plan usage, in the footer ──
   What is left of the plans this machine spends: one row — the gauge and the
   name — and everything the row has no room for behind it. No percentage on
   the row: with several plans reporting, one number names the wrong account,
   so each plan carries its own fullest-window percentage in the popover.

   The popover is the "full" this surface can hold: one card per provider —
   two Z.AI keys share one Z.AI card, three Command Code seats one Command
   Code card — each account a named section with its own bars and resets. A
   provider plan is an *account* (one profile's own plan API, shared by every
   runtime it serves); a runtime login is the machine's own `claude`/`codex
   login`, one card per runtime. Clicking through goes to Settings › Usage,
   which is the same reading at a page's measure — windows, credits and the
   raw report.

   Drawn away when nothing reports a plan, and it holds no timer: it reads the
   list route the Usage page already reads (`useAllQuotaQuery`), on React
   Query's own freshness, over a server that caches and coalesces the probes.
   That is one bounded read per launch, and it replaces the ten-minute poll this
   row used to run rather than adding to it — see the note in `nav.tsx`. */
import * as React from "react"
import { useNavigate } from "react-router"
import { ChevronRightIcon, GaugeIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useSidebar } from "@/components/ui/sidebar"
import { FOOTER_ICON } from "./scale"
import { formatReset, providerKindLabel, quotaTone, windowTitle } from "@/lib/quota"
import type { QuotaSnapshot } from "@/lib/quota"
import { GLASS_SURFACE } from "@/lib/header-chrome"
import { settingsPath } from "@/lib/router"
import { useAgents, useProfiles } from "@/lib/queries/catalog"
import { useAllQuotaQuery } from "@/lib/queries/surfaces"
import { cn } from "@/lib/utils"

type Tone = ReturnType<typeof quotaTone>

/** One window, read the way every surface reads it: a clamped percentage, the
    tone for it, and when it rolls over. */
type WindowReading = {
  id: string
  label: string
  percent: number
  tone: Tone
  reset: string | null
}

type PlanReading = {
  key: string
  /** A plan the profile's provider sells, rather than a runtime's own probe. */
  provider: boolean
  /** Which card this account files under: the provider's `usage.kind` for an
      account (`zai`, `command-code`, …), the agent id for a runtime login. */
  groupKey: string
  name: string
  /** The fullest window — what each popover block summarises with. */
  peak: WindowReading
  windows: WindowReading[]
}

const readingOf = (usedPercent: number, id: string, label: string, reset: string | null): WindowReading => {
  const percent = Math.min(100, Math.max(0, Math.round(usedPercent)))
  return { id, label, percent, tone: quotaTone(percent), reset }
}

/** A plan's windows, one bar each — the same reading the composer's glance
    draws, at the density a popover beside the sidebar can hold. */
function WindowReadingRow({ plan, window }: { plan: string; window: WindowReading }) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-[11px]">
        <span className="min-w-0 truncate text-muted-foreground">{window.label}</span>
        <span className={cn("shrink-0 font-medium tabular-nums", window.tone.text)}>{window.percent}%</span>
      </div>
      <div
        role="progressbar"
        aria-label={`${plan}: ${window.label}`}
        aria-valuenow={window.percent}
        aria-valuemin={0}
        aria-valuemax={100}
        className="mt-1 h-1 w-full overflow-hidden rounded-pill bg-muted"
      >
        <div
          className={cn("h-full rounded-pill transition-all", window.tone.bar)}
          style={{ width: `${window.percent}%` }}
        />
      </div>
      {window.reset && <p className="mt-0.5 text-[10px] text-muted-foreground">Resets {window.reset}</p>}
    </div>
  )
}

/** One plan as a section inside its kind's card: the name with its fullest
    window beside it, then each window with its own bar. The summary lives
    here and not on the sidebar row — with several plans reporting, one number
    on the row names the wrong account. */
function PlanReadingBlock({ plan }: { plan: PlanReading }) {
  return (
    <div className="px-3 py-2">
      <div className="flex items-baseline justify-between gap-2">
        <p className="min-w-0 truncate text-[13px] leading-5 font-medium">{plan.name}</p>
        <span className={cn("shrink-0 text-xs font-medium tabular-nums", plan.peak.tone.text)}>
          {plan.peak.percent}%
        </span>
      </div>
      <div className="mt-1.5 space-y-1.5">
        {plan.windows.map((window) => (
          <WindowReadingRow key={window.id} plan={plan.name} window={window} />
        ))}
      </div>
    </div>
  )
}

/** The plans this machine can read, above the account row. */
export function SidebarUsage() {
  const navigate = useNavigate()
  const { isMobile, setOpenMobile } = useSidebar()
  const profiles = useProfiles()
  const agents = useAgents()
  const { quotas } = useAllQuotaQuery()
  const [open, setOpen] = React.useState(false)

  const plans = React.useMemo<PlanReading[]>(() => {
    const profileOf = (id: string) => profiles.find((p) => p.id === id)
    const agentName = (id: string) => agents.find((a) => a.id === id)?.name
    return (quotas ?? []).flatMap((quota: QuotaSnapshot) => {
      if (quota.status === "unsupported") return []
      const windows = quota.windows.map((window) =>
        readingOf(window.usedPercent, window.id, windowTitle(window), formatReset(window))
      )
      /* A plan with no windows has nothing a bar can say — "metered per token"
         is prose, and prose is the page's. */
      if (windows.length === 0) return []
      const peak = windows.reduce((worst, window) => (window.percent >= worst.percent ? window : worst))
      /* Which card the reading files under. A provider plan carries its
         provider's `usage.kind` (`zai`, `command-code`, …) — two Z.AI keys land
         on one Z.AI card, each still naming its own account. A runtime probe is
         the machine's own login, so it files under its agent. A provider whose
         profile the catalog has not named yet keeps its raw kind rather than an
         empty label. */
      const provider = quota.source === "profile"
      const profile = profileOf(quota.profileId)
      const groupKey = provider
        ? (profile?.usage?.kind && profile.usage.kind !== "none" ? profile.usage.kind : quota.profileId)
        : quota.agentId || "runtime"
      /* Which account the reading belongs to. A provider plan is the profile's
         — one account, shared by every runtime it serves, and no agent to name.
         An agent's own probe is the machine's login under its virtual
         `default:<agent>` profile, where the *agent's* name is the honest one;
         under any other profile the credentials are that profile's. Each falls
         back to the raw id rather than to an empty label: a catalog that has not
         landed yet should still name the plan. */
      const name = provider
        ? profile?.name ?? quota.profileId
        : quota.profileId.startsWith("default:")
          ? agentName(quota.agentId) ?? quota.agentId
          : profile?.name ?? agentName(quota.agentId) ?? quota.profileId
      return [
        {
          key: `${quota.source ?? "agent"}:${quota.profileId}:${quota.agentId}`,
          provider,
          groupKey,
          name,
          peak,
          windows,
        },
      ]
    })
  }, [quotas, profiles, agents])

  /* One card per provider, runtimes last: somebody configured the first kind on
     purpose, and the machine's logins are whatever it happens to have. Each
     plan is a named section inside its card — not a heading per account, which
     read as that many unrelated plans. Absent providers are skipped, so a
     machine with one Z.AI key and one login draws two cards. */
  const groups = React.useMemo(() => {
    const byKey = new Map<string, { label: string; provider: boolean; plans: PlanReading[] }>()
    for (const plan of plans) {
      const label = plan.provider ? providerKindLabel(plan.groupKey) : (agents.find((a) => a.id === plan.groupKey)?.name ?? plan.name)
      const group = byKey.get(plan.groupKey) ?? { label, provider: plan.provider, plans: [] }
      group.plans.push(plan)
      byKey.set(plan.groupKey, group)
    }
    return [...byKey.values()].sort((a, b) =>
      a.provider === b.provider ? a.label.localeCompare(b.label) : a.provider ? -1 : 1
    )
  }, [plans, agents])

  /* Drawn away when nothing reports — after every hook, never between them. */
  if (plans.length === 0) return null

  const openSettings = () => {
    setOpen(false)
    if (isMobile) setOpenMobile(false)
    void navigate(settingsPath("usage"))
  }

  const label = `Plan usage — ${plans.length} ${plans.length === 1 ? "plan" : "plans"} reporting`

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            title={label}
            aria-label={label}
            className={FOOTER_ICON}
          >
            <GaugeIcon />
          </Button>
        }
      />
      {/* Upward on the rail, downward on a phone. On a desk the footer is the
          last thing in the sidebar, so a card below it has nowhere to go — but
          the phone's sidebar is a sheet anchored at the screen's top, and its
          footer is mid-screen, where opening upward would push the card off the
          top (and into the keyboard's way when one is up). `align="start"` puts
          its left edge on the icon's, which is the edge that is always on
          screen — the rail collapses, the sheet is 18rem wide, and the
          22rem card's right edge is kept in view by collision handling. Frosted
          like the bell's glance (`GLASS_SURFACE`): one recipe for the cards the
          app raises over the shell. */}
      <PopoverContent
        align="start"
        side={isMobile ? "bottom" : "top"}
        sideOffset={8}
        className={cn(GLASS_SURFACE, "w-[min(22rem,calc(100vw-1rem))] p-0")}
      >
        {/* `overflow-hidden` on the column, not the popup: the header rule,
            the rows' hover and the footer's ground would otherwise paint
            square corners over the card's rounded ones. The list is the
            half that scrolls, so the header and the way out stay put. */}
        <div className="flex max-h-[min(26rem,var(--panel-h,100svh))] flex-col overflow-hidden rounded-2xl">
          <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2.5">
            <GaugeIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] leading-5 font-semibold">Plan usage</p>
              <p className="text-[11px] leading-4 text-muted-foreground">
                {plans.length} {plans.length === 1 ? "plan" : "plans"} reporting
              </p>
            </div>
          </div>
          {/* One card per provider: the bordered panel is the unit, with the
              provider as its header and each account a section divided off
              from the next — the same shape the Usage page draws at full
              measure. */}
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
            {groups.map((group) => (
              <section
                key={group.label}
                className="overflow-hidden rounded-xl border border-border/60 bg-card/40"
              >
                <p className="border-b border-border/60 px-3 py-1.5 text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
                  {group.label}
                </p>
                <div className="divide-y divide-border/40">
                  {group.plans.map((plan) => (
                    <PlanReadingBlock key={plan.key} plan={plan} />
                  ))}
                </div>
              </section>
            ))}
          </div>
          <div className="border-t border-border/60 p-1">
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-between text-muted-foreground"
              onClick={openSettings}
            >
              Open Settings
              <ChevronRightIcon />
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
