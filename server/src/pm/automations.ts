import type {
  AutomationAction,
  AutomationCondition,
  AutomationContext,
  AutomationRule,
} from "./schema.js";

/*
 * Automation matching — PURE. No db import, no clock, no randomness: everything
 * a rule may look at arrives in the AutomationContext that tasks.ts assembles,
 * and everything a rule may do leaves as a patch for applyMutation to apply.
 * That split is the whole safety story: an action can only set whitelisted
 * fields (AutomationActionSchema is the whitelist), and the recursion that
 * applies the patches is bounded by MAX_CHAIN_DEPTH plus per-chain rule dedup,
 * so A→B→A cycles terminate structurally.
 */

/** Hard cap on automation-triggered applyMutation recursion (tasks.ts passes
    depth; a chain longer than this is dropped, not an error). */
export const MAX_CHAIN_DEPTH = 4;

/** What a matched rule wants applied — the union of every whitelisted action,
    flattened. tasks.ts feeds this back through applyMutation (columnId appends
    at the target column's end; `archive` maps to stamping archivedAt). */
export interface AutomationPatch {
  columnId?: string;
  priority?: number;
  assignees?: string[];
  labelIds?: string[];
  sprintId?: string | null;
  milestoneId?: string | null;
  typeId?: string;
  dueDate?: number | null;
  archive?: boolean;
}

export interface AutomationEffect {
  ruleId: string;
  patch: AutomationPatch;
}

// ---------------------------------------------------------------------------
// WHEN

function triggerMatches(rule: AutomationRule, ctx: AutomationContext): boolean {
  const changed = (field: string) => ctx.changes.some((c) => c.field === field);
  switch (rule.when.type) {
    case "task_created":
      return ctx.before === null;
    case "task_moved":
      // A create lands in a column too, but "moved" means moved FROM somewhere.
      return ctx.before !== null && changed("columnId");
    case "task_completed":
      // The transition INTO done — not every later edit of an already-done task.
      return ctx.after.completedAt !== null && (ctx.before?.completedAt ?? null) === null && changed("completedAt");
    case "field_changed":
      // Label edits surface as a "labelIds" ChangeRecord (labels live in a join
      // table; tasks.ts records the membership diff under that pseudo-field).
      return changed(rule.when.field);
  }
}

// ---------------------------------------------------------------------------
// IF — conditions read the task AFTER the patch

/** Field access with the two pseudo-fields conditions need but the row lacks:
    `labelIds` (join table, post-mutation) and `columnCategory` (the current
    column's open/active/done — what "is it in a done column" actually asks). */
function readField(ctx: AutomationContext, field: string): unknown {
  if (field === "labelIds") return ctx.labelIds;
  if (field === "columnCategory") {
    return ctx.columns.find((c) => c.id === ctx.after.columnId)?.category ?? null;
  }
  return (ctx.after as Record<string, unknown>)[field];
}

/** Scalar-vs-array equality doubles as membership: `labelIds eq <id>` is
    "has label", `assignees eq "mo"` is "assigned to mo". */
function looseEq(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(actual)) {
    if (Array.isArray(expected)) return JSON.stringify(actual) === JSON.stringify(expected);
    return actual.includes(expected);
  }
  return actual === expected;
}

function conditionHolds(cond: AutomationCondition, ctx: AutomationContext): boolean {
  const actual = readField(ctx, cond.field);
  switch (cond.op) {
    case "eq":
      return looseEq(actual, cond.value);
    case "neq":
      return !looseEq(actual, cond.value);
    case "gte":
      return typeof actual === "number" && typeof cond.value === "number" && actual >= cond.value;
    case "lte":
      return typeof actual === "number" && typeof cond.value === "number" && actual <= cond.value;
    case "set":
      return Array.isArray(actual) ? actual.length > 0 : actual !== null && actual !== undefined;
    case "unset":
      return Array.isArray(actual) ? actual.length === 0 : actual === null || actual === undefined;
  }
}

/** Does the rule's WHEN trigger fire for this mutation AND do all its IF
    conditions hold against the post-patch task? Disabled rules never match. */
export function matchRule(rule: AutomationRule, ctx: AutomationContext): boolean {
  if (!rule.enabled) return false;
  if (!triggerMatches(rule, ctx)) return false;
  return rule.if.every((cond) => conditionHolds(cond, ctx));
}

// ---------------------------------------------------------------------------
// THEN

/** Fold one action into the rule's patch. Actions naming board config that no
    longer exists are dropped: the automations json column has no FK, so a rule
    can outlive the column/label/sprint it points at — stale, not fatal. */
function applyAction(action: AutomationAction, ctx: AutomationContext, patch: AutomationPatch): void {
  switch (action.type) {
    case "set_column":
      if (ctx.columns.some((c) => c.id === action.columnId)) patch.columnId = action.columnId;
      return;
    case "set_priority":
      patch.priority = action.priority;
      return;
    case "set_assignees":
      patch.assignees = action.assignees;
      return;
    case "add_label": {
      if (!ctx.labels.some((l) => l.id === action.labelId)) return;
      const ids = patch.labelIds ?? [...ctx.labelIds];
      if (!ids.includes(action.labelId)) ids.push(action.labelId);
      patch.labelIds = ids;
      return;
    }
    case "remove_label":
      patch.labelIds = (patch.labelIds ?? ctx.labelIds).filter((id) => id !== action.labelId);
      return;
    case "set_sprint":
      if (action.sprintId === null || ctx.sprints.some((s) => s.id === action.sprintId)) {
        patch.sprintId = action.sprintId;
      }
      return;
    case "set_milestone":
      if (action.milestoneId === null || ctx.milestones.some((m) => m.id === action.milestoneId)) {
        patch.milestoneId = action.milestoneId;
      }
      return;
    case "set_type":
      if (ctx.issueTypes.some((t) => t.id === action.typeId)) patch.typeId = action.typeId;
      return;
    case "set_due_date":
      patch.dueDate = action.dueDate;
      return;
    case "archive":
      patch.archive = true;
      return;
  }
}

/** Strip patch fields that already hold — applying them would diff to nothing,
    but pruning here spares a whole applyMutation recursion per no-op rule.
    The depth cap and chain dedup stay the correctness guarantees. */
function pruneNoOps(patch: AutomationPatch, ctx: AutomationContext): AutomationPatch {
  const t = ctx.after;
  const out: AutomationPatch = { ...patch };
  if (out.columnId === t.columnId) delete out.columnId;
  if (out.priority === t.priority) delete out.priority;
  if (out.assignees && JSON.stringify(out.assignees) === JSON.stringify(t.assignees)) delete out.assignees;
  if (out.labelIds && JSON.stringify([...out.labelIds].sort()) === JSON.stringify([...ctx.labelIds].sort())) {
    delete out.labelIds;
  }
  if (out.sprintId !== undefined && out.sprintId === t.sprintId) delete out.sprintId;
  if (out.milestoneId !== undefined && out.milestoneId === t.milestoneId) delete out.milestoneId;
  if (out.typeId !== undefined && out.typeId === t.typeId) delete out.typeId;
  if (out.dueDate !== undefined && out.dueDate === t.dueDate) delete out.dueDate;
  if (out.archive && t.archivedAt !== null) delete out.archive;
  return out;
}

/**
 * Evaluate every rule against one mutation. NEVER applies anything: returns
 * the patches for tasks.ts to recurse through applyMutation, one at a time
 * (each application rebuilds the context, so a later effect sees the earlier
 * one's result). `chain` is the set of ruleIds already fired on this chain —
 * a rule fires at most once per chain, which is what kills A→B→A cycles.
 */
export function runAutomations(
  rules: AutomationRule[],
  ctx: AutomationContext,
  chain: ReadonlySet<string>,
): AutomationEffect[] {
  const effects: AutomationEffect[] = [];
  for (const rule of rules) {
    if (chain.has(rule.id)) continue;
    if (!matchRule(rule, ctx)) continue;
    const patch: AutomationPatch = {};
    for (const action of rule.then) applyAction(action, ctx, patch);
    const pruned = pruneNoOps(patch, ctx);
    if (Object.keys(pruned).length === 0) continue;
    effects.push({ ruleId: rule.id, patch: pruned });
  }
  return effects;
}
