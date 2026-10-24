/* ── Settings › Usage › Spend ──
   What the install's model calls added up to, grouped one way at a time
   (`GET /api/usage/calls`, the `model_calls` ledger). Billed figures only —
   cost is what a runtime reported, and a group with none says so. The one
   surface that lists spend (CLAUDE.md "Ops"); a thread's own reading is its
   Trace panel. */
import * as React from "react"

import { DataTable, TitleCell } from "@/components/ui/data-table"
import { ErrorNote } from "@/components/error-note"
import { inlineFromQuery } from "@/lib/errors"
import { SPEND_GROUPS, useSpend, type SpendGroup, type SpendGroupBy } from "@/lib/queries/model-calls"
import type { ColumnDef } from "@/lib/table"
import { formatTokens } from "@/lib/tokens"
import { Section, Segmented, StatStrip } from "./primitives"

const GROUP_LABEL: Record<SpendGroupBy, string> = {
  profile: "Profile",
  model: "Model",
  project: "Project",
  agent: "Agent",
  source: "Source",
}

const prompt = (g: SpendGroup) => g.input + g.cacheRead + g.cacheWrite

export function SpendTab() {
  const [groupBy, setGroupBy] = React.useState<SpendGroupBy>("profile")
  const spend = useSpend(groupBy)
  const groups = spend.data ?? []
  const total = groups.reduce(
    (sum, g) => ({
      calls: sum.calls + g.calls,
      prompt: sum.prompt + prompt(g),
      cacheRead: sum.cacheRead + g.cacheRead,
      output: sum.output + g.output,
      cost: g.costUsd === null ? sum.cost : (sum.cost ?? 0) + g.costUsd,
    }),
    { calls: 0, prompt: 0, cacheRead: 0, output: 0, cost: null as number | null }
  )

  const columns = React.useMemo<ColumnDef<SpendGroup, unknown>[]>(
    () => [
      {
        id: "group",
        header: GROUP_LABEL[groupBy],
        meta: { title: true, className: "min-w-40" },
        cell: ({ row }) => (
          <TitleCell
            title={row.original.name ?? row.original.key ?? "—"}
            subtitle={row.original.key && row.original.key !== row.original.name ? row.original.key : undefined}
          />
        ),
      },
      { id: "calls", header: "Calls", meta: { align: "end", className: "w-20" }, cell: ({ row }) => <span className="tabular-nums">{row.original.calls}</span> },
      {
        id: "prompt",
        header: "Prompt",
        meta: { align: "end", className: "w-24 whitespace-nowrap" },
        cell: ({ row }) => <span className="tabular-nums">{formatTokens(prompt(row.original))}</span>,
      },
      {
        id: "cache",
        header: "From cache",
        meta: { align: "end", className: "hidden @panel-md:table-cell w-24 whitespace-nowrap" },
        cell: ({ row }) => {
          const p = prompt(row.original)
          return <span className="tabular-nums text-muted-foreground">{p > 0 ? `${Math.round((row.original.cacheRead / p) * 100)}%` : "—"}</span>
        },
      },
      {
        id: "output",
        header: "Output",
        meta: { align: "end", className: "w-24 whitespace-nowrap" },
        cell: ({ row }) => (
          <span className="tabular-nums">
            {formatTokens(row.original.output)}
            {row.original.reasoning > 0 && <span className="text-muted-foreground"> +{formatTokens(row.original.reasoning)}</span>}
          </span>
        ),
      },
      {
        id: "cost",
        header: "Cost",
        meta: { align: "end", className: "hidden @panel-sm:table-cell w-24 whitespace-nowrap" },
        cell: ({ row }) => (
          <span className="tabular-nums text-muted-foreground">{row.original.costUsd === null ? "not reported" : `$${row.original.costUsd.toFixed(2)}`}</span>
        ),
      },
    ],
    [groupBy]
  )

  return (
    <>
      <StatStrip
        stats={[
          { label: "Calls", value: total.calls, loading: spend.isPending },
          { label: "Prompt", value: formatTokens(total.prompt), hint: total.prompt > 0 ? `${Math.round((total.cacheRead / total.prompt) * 100)}% from cache` : undefined, loading: spend.isPending },
          { label: "Output", value: formatTokens(total.output), loading: spend.isPending },
          { label: "Cost", value: total.cost === null ? "—" : `$${total.cost.toFixed(2)}`, hint: total.cost === null ? "No runtime reported a cost" : "Only what runtimes reported", loading: spend.isPending },
        ]}
      />
      <Section
        label="By"
        action={
          <Segmented
            label="Group spend by"
            value={groupBy}
            onChange={setGroupBy}
            options={SPEND_GROUPS.map((value) => ({ value, label: GROUP_LABEL[value] }))}
          />
        }
      >
        <ErrorNote error={inlineFromQuery(spend.error, "Reading spend")} onRetry={() => void spend.refetch()} />
        <DataTable
          columns={columns}
          data={groups}
          getRowId={(g) => g.key ?? "none"}
          isLoading={spend.isPending}
          emptyMessage="No model calls recorded yet."
          viewToggle={false}
        />
      </Section>
    </>
  )
}
