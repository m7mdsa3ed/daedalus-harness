/* ── An agent's environment, drawn three ways ──
   The view over `lib/agent-env.ts`, which does the classifying and the merging
   (and is what the tests hold). Three readings, because the one textarea held
   three different things:

     - **Set by the profile** — read-only, and each key says in words what fills
       it. This is wiring, not a setting.
     - **Values you set** — rows of typed fields.
     - **Advanced** — JSON-object templates, folded, as text.

   Nothing here writes anything but `env`. */
import * as React from "react"
import { ChevronRightIcon } from "lucide-react"

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Textarea } from "@/components/ui/textarea"
import { KeyValueRows } from "@/components/settings/key-value-rows"
import { ENV_KEY, duplicateNames, invalidEnvNames, type KeyValueRow } from "@/lib/key-value-rows"
import { isConditional, mergeEnv, placeholdersOf, splitEnv } from "@/lib/agent-env"

/**
 * The three readings of one agent's env.
 *
 * `seeded` is the runtime's own env, so this can tell a key the profile drives
 * from one somebody typed; without it every key would be free text, which is
 * where this started.
 */
export function AgentEnvEditor({
  env,
  seeded,
  onChange,
}: {
  env: Record<string, string> | undefined
  /** What this runtime ships, by key — what makes "driven" knowable. */
  seeded: Record<string, string>
  /** The whole env as it now stands: the profile-driven wiring, the templates and
      the person's rows. Called on every edit, so the parent's Save never has to
      reconstruct what it just drew — and told about the problems in the same
      breath, because a Save that has to ask twice can be pressed in between. */
  onChange: (env: Record<string, string>, problems: { any: boolean }) => void
}) {
  const split = React.useMemo(() => splitEnv(env, seeded), [env, seeded])
  /* Seeded once from the split and never re-derived: a caller redrawing on every
     keystroke would fight the caret. */
  const [rows, setRows] = React.useState<KeyValueRow[]>(() => split.mine)
  const [advanced, setAdvanced] = React.useState(() => Object.fromEntries(split.advanced.map((e) => [e.name, e.value])))

  /* One door out. The env is always the three buckets merged, so a template edit
     and a row edit cannot disagree about what is stored. */
  const emit = (nextRows: KeyValueRow[], nextAdvanced: Record<string, string> = advanced) => {
    const bad = invalidEnvNames(nextRows)
    const dups = duplicateNames(nextRows, { caseInsensitive: true })
    onChange(mergeEnv(split, nextRows, nextAdvanced), { any: bad.size > 0 || dups.size > 0 })
  }

  const updateRows = (next: KeyValueRow[]) => {
    setRows(next)
    emit(next)
  }

  const advancedNames = Object.keys(advanced)

  return (
    <div className="space-y-5">
      {split.driven.length > 0 && (
        <div className="space-y-2">
          <div className="text-sm font-medium">Set by the profile</div>
          <p className="text-sm text-muted-foreground">
            These follow the profile a thread runs on — its key, endpoint, model and protocol. Nothing here is a
            setting on the agent; the second column says what fills it at spawn.
          </p>
          <ul className="divide-y rounded-lg bg-muted/40 px-3">
            {split.driven.map(({ name, value }) => (
              <li key={name} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2">
                <code className="font-mono text-xs text-foreground">{name}</code>
                <span className="text-xs text-muted-foreground">
                  {isConditional(value) && "only when set: "}
                  {placeholdersOf(value).join(", ")}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="space-y-2">
        <div className="text-sm font-medium">Values you set</div>
        <p className="text-sm text-muted-foreground">
          Passed to the process as written. A <code className="font-mono">{"{placeholder}"}</code> here is filled at
          spawn like any other.
        </p>
        <KeyValueRows
          rows={rows}
          onChange={updateRows}
          addLabel="Add variable"
          namePlaceholder="MY_FLAG"
          valuePlaceholder="1"
          nameValidator={(name) => ENV_KEY.test(name)}
          invalidHint="An environment name is letters, digits and underscores, and cannot start with a digit."
          duplicateHint="Two rows use this name — only the last one is kept."
        />
      </div>

      {advancedNames.length > 0 && (
        <div className="space-y-2">
          <div className="text-sm font-medium">Advanced</div>
          <p className="text-sm text-muted-foreground">
            Whole configuration objects this runtime reads out of one variable — a JSON merge, not a single value.
            Anything the profile drives inside them is still filled at spawn.
          </p>
          <div className="space-y-2">
            {advancedNames.map((name) => (
              <TemplateRow
                key={name}
                name={name}
                value={advanced[name]}
                onChange={(next) => {
                  const all = { ...advanced, [name]: next }
                  setAdvanced(all)
                  emit(rows, all)
                }}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/** One JSON template, folded — a lot of scroll for something most people never
    open, and its placeholders are named on the fold. */
function TemplateRow({ name, value, onChange }: { name: string; value: string; onChange: (next: string) => void }) {
  const filled = React.useMemo(() => placeholdersOf(value), [value])
  const lines = value.split("\n").length
  return (
    <Collapsible className="rounded-lg ring-1 ring-foreground/10">
      <CollapsibleTrigger className="group/trigger flex w-full items-center gap-2 px-3 py-2 text-start outline-none hover:bg-muted/40 focus-visible:ring-[3px] focus-visible:ring-ring/50">
        <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[panel-open]/trigger:rotate-90" />
        <code className="min-w-0 flex-1 truncate font-mono text-xs">{name}</code>
        <span className="shrink-0 text-xs text-muted-foreground">
          {lines > 1 ? `${lines} lines` : `${value.length} chars`}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t px-3 py-2">
        {filled.length > 0 && <p className="mb-2 text-xs text-muted-foreground">Filled at spawn from {filled.join(", ")}.</p>}
        <Textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={6}
          className="font-mono text-xs"
          spellCheck={false}
          aria-label={name}
        />
      </CollapsibleContent>
    </Collapsible>
  )
}
