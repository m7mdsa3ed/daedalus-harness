import type { PopoverShell } from "@/components/session-config";
import * as React from "react";
import type * as acp from "@daedalus/acp";
import { useQuery } from "@tanstack/react-query";
import {
  BotIcon,
  ChevronRightIcon,
  GitBranchIcon,
  Loader2,
  RefreshCwIcon,
} from "lucide-react";
import {
  AgentIcon,
  EntityIcon,
  ModelIcon,
  ProfileIcon,
  ProjectIcon,
} from "@/components/entity-icon";
import { AvatarGroup } from "@/components/ui/avatar";
import { levelOf, withEffortIcons, withModeIcons } from "@/components/composer/option-icons";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  HelperModelRow,
  MenuAddItem,
  type ChoicePick,
  MenuRow,
  PILL,
  PillLabel,
  SessionSettingsSub,
  MenuSearchInput,
  menuFilter,
  selectChoices,
  type MenuAdd,
} from "@/components/config-menu";
import { useAddModel, useNewProfile, useNewProject } from "@/lib/catalog-add";
import {
  READING_MARK,
  READING_TRIGGER,
  READING_TRIGGER_ALWAYS,
  ReadingFace,
} from "@/components/composer/indicator";
import { SHELF_PAD } from "@/components/composer-strip";
import { ConfigDrawer, type DrawerRows } from "@/components/config-drawer";
import { useToolDrawerRows } from "@/components/thread-tools/drawer-rows";
import { useIsMobile } from "@/hooks/use-device";
import { McpSelected } from "@/components/composer/mcp-avatars";
import { ThreadToolsSections } from "@/components/thread-tools/menu";
import { cn } from "@/lib/utils";
import type { Actions } from "@/lib/actions";
import {
  optionKey,
  shownOptions,
  useAgentOptions,
  useProbeStatus,
} from "@/lib/agent-options";
import {
  currentChoiceLabel,
  partitionSessionOptions,
} from "@/lib/session-options";
import { useStoreSelect } from "@/lib/store";
import { profileSupports, type SessionMeta } from "@/lib/settings";
import {
  useActiveSpace,
  useAgents,
  useAgentsStatus,
  useProfiles,
  useProjects,
} from "@/lib/queries/catalog";
import { gitReposKey } from "@/lib/queries/keys";
import { useServer } from "@/lib/server-context";
import { gitRepos } from "@/lib/workspace/git-api";

const DEFAULT_CHOICE = "__default__";

/** The shared read of a draft's current configuration — both controls below
    need the same lookups, and they must not disagree about what is selected. */
function useDraft(meta: SessionMeta, actions: Actions, remember = true) {
  /* The four catalogs this menu lists, each on its own subscription rather
     than the whole state: these controls sit on the composer strip of a live
     pane, and a catalog is replaced only by its own action. */
  const projects = useProjects();
  const profiles = useProfiles();
  const agents = useAgents();
  const project = projects.find((p) => p.id === meta.projectId);
  const profile = profiles.find((p) => p.id === meta.profileId);
  // The draft's own agent, not the profile's: a profile may serve several.
  const agent = agents.find((a) => a.id === meta.agentId);
  /* The profiles this thread could run on — every *shown* one configured for
     its agent. The profile only overrides model and effort; the agent is what
     the rest of the menu belongs to, so switching profile keeps it. The draft's
     own profile stays listed even when it has been hidden or disabled since:
     the row must still read what the thread is actually on. */
  const agentProfiles = profiles.filter(
    (p) =>
      profileSupports(p, meta.agentId) &&
      (p.id === meta.profileId || (!p.hidden && !p.disabled)),
  );

  /* Every pick is published onto the thread's project — that is what makes the
     model a property of the workspace rather than of this device, and what
     `actions.configureDraft` does with it (one write, so the menus and the
     store cannot disagree about what a project holds).

     Not always, though. `remember: false` is for a caller that reuses these
     controls to configure something that is NOT the thread you are about to
     start (a routine's saved thread-start). Picking a profile there is a
     statement about that routine, and publishing it would mean editing a
     nightly job silently rewrote what the next thread in that project opens
     on — so the pick moves the draft/form and stops there. */
  const configure = (next: Parameters<Actions["configureDraft"]>[1]) => {
    /* The draft's own fields always move; only the *publication* is gated. */
    actions.configureDraft(meta.id, next, remember);
  };

  return {
    projects,
    profiles,
    agents,
    project,
    profile,
    agent,
    agentProfiles,
    configure,
  };
}

/**
 * Where this thread runs: the project and its checkout. What it carries is
 * the thread picker's Tools section.
 *
 * It outlives the draft. Both halves used to disappear at the moment they
 * started mattering — the row was rendered only while `meta.draft`, so the
 * project (the one fact that says *which directory these edits land in*) was
 * visible right up until the first message and never again. It is the same
 * question either side of that message; only the answer's editability changes.
 * A started thread's project is fixed (it IS the agent's cwd), so that half
 * becomes a read-out, exactly as the tools menu already did for itself.
 *
 * Who answers (the agent) is not here — it moved into `DraftConfigPopover`,
 * beside the model whose meaning it decides: see that component's doc.
 */
export function DraftScopeRow({
  meta,
  actions,
  remember = true,
  editable = true,
  trailing,
  showSelectedMcps = true,
}: {
  meta: SessionMeta;
  actions: Actions;
  /** False when these controls are editing a saved configuration rather than
      the draft you are about to send — see `useDraft`. */
  remember?: boolean;
  /** A draft may still pick; a started thread's project and links are already
      spawned, so the row reads them out instead. */
  editable?: boolean;
  /** Drawn at the row's own end. The composer's context ring goes here: how
      full the window is belongs with where the thread runs, not with the
      controls that send. */
  trailing?: React.ReactNode;
  /** Keep the scope path focused on location when the composer has its own
      selected-MCP readout beside model configuration. */
  showSelectedMcps?: boolean;
}) {
  const { projects, project, configure } = useDraft(meta, actions, remember);
  /* Only the space in front of you — plus the draft's own project, so the
     picker still marks what the thread is on. */
  const { id: spaceId } = useActiveSpace();
  const pickable = projects.filter(
    (p) => !spaceId || p.spaceId === spaceId || p.id === meta.projectId,
  );
  const newProject = useNewProject();
  return (
    /* py-1, not the shelf's py-1.5: every control in here is already h-6, so
       the padding is the only slack there is, and this row is under the pile on
       every thread — four pixels here is four pixels off the transcript for the
       whole life of the app. Half a step rather than none, because the row now
       carries four readings at its end and h-6 controls edge to edge read as a
       band rather than as a floor. */
    /* Two halves, two grammars. The start is a *path* — project, then its
       checkout, then what rides along — read left to right like a location,
       chevrons between and no frame, because it names a place and not a state.
       The end is a bare cluster of readings: no box around them, each
       trigger's own hover ground is the only frame it wears. */
    <div className={cn(SHELF_PAD, "flex min-w-0 items-center gap-3 py-1")}>
      <nav
        aria-label="Thread scope"
        className="flex min-w-0 flex-1 items-center gap-0.5"
      >
        {editable ? (
          <PickerMenu
            icon={<ProjectIcon project={project} className={READING_MARK} />}
            label={project?.name ?? "No project"}
            title="Project"
            value={project?.id ?? ""}
            options={pickable.map((p) => ({
              value: p.id,
              name: p.name,
              hint: p.cwd,
              icon: <ProjectIcon project={p} className="size-4" />,
            }))}
            onSelect={(id) => configure({ projectId: id })}
            add={{
              label: "New project…",
              onSelect: () => newProject((id) => configure({ projectId: id })),
            }}
          />
        ) : (
          <span
            title={project?.cwd}
            className={cn(
              READING_TRIGGER,
              READING_TRIGGER_ALWAYS,
              "flex h-6 items-center font-medium text-foreground/80",
            )}
          >
            <ReadingFace
              always
              icon={<ProjectIcon project={project} className={READING_MARK} />}
              label={project?.name ?? "No project"}
              labelClass="max-w-40"
            />
          </span>
        )}
        <WorktreeChip
          meta={meta}
          editable={editable && remember}
          onToggle={(isolate) => configure({ isolate })}
        />
        {showSelectedMcps && <McpSelected meta={meta} />}
      </nav>
      {trailing && <span className="flex shrink-0 items-center gap-0.5">{trailing}</span>}
    </div>
  );
}

/** The path's separator. Drawn by each optional segment in front of itself,
    so a segment that renders nothing leaves no dangling chevron. */
function PathSep() {
  return (
    <ChevronRightIcon
      aria-hidden
      className="size-3 shrink-0 text-foreground/25"
    />
  );
}

/**
 * "Isolate in a git worktree", on a draft whose project directory is a
 * repository — and, once the thread exists, the branch it was isolated on.
 *
 * Asked of `GET …/git/repos` (a root entry, `""`, is the project's own); the
 * server is still the one that decides, and refuses in git's words a project
 * nested in a larger checkout. A started thread's chip is a read-out, like the
 * project beside it: where the work lands is fixed once the agent runs there.
 */
function WorktreeChip({
  meta,
  editable,
  onToggle,
}: {
  meta: SessionMeta;
  editable: boolean;
  onToggle: (isolate: boolean) => void;
}) {
  const settings = useServer();
  const repos = useQuery({
    queryKey: gitReposKey(settings, meta.projectId),
    queryFn: ({ signal }) => gitRepos(settings, meta.projectId, signal),
    enabled: editable && !!meta.projectId,
    staleTime: 60_000,
  });
  const mark = <GitBranchIcon aria-hidden className={READING_MARK} />;
  if (!editable) {
    if (!meta.worktree) return null;
    const gone = meta.worktree.exists === false;
    return (
      <>
        <PathSep />
        <span
          title={
            gone
              ? `The worktree was removed; branch ${meta.worktree.branch} is kept`
              : `Isolated in ${meta.worktree.path}, on branch ${meta.worktree.branch}`
          }
          className={cn(
            READING_TRIGGER,
            "flex h-6 items-center text-muted-foreground",
            gone && "line-through opacity-70",
          )}
        >
          <ReadingFace
            icon={mark}
            label={meta.worktree.branch}
            labelClass="max-w-40"
          />
        </span>
      </>
    );
  }
  if (!repos.data?.some((repo) => repo.path === "")) return null;
  const on = meta.isolate === true;
  return (
    <>
      <PathSep />
      <Button
        variant="ghost"
        size="icon-xs"
        aria-pressed={on}
        title={
          on
            ? "Isolated: this thread gets its own git worktree and branch (click to run in the project instead)"
            : "Isolate in a git worktree — its own checkout and branch, so its edits never touch the project's"
        }
        onClick={() => onToggle(!on)}
        className={cn(
          READING_TRIGGER,
          on ? "text-primary" : "text-muted-foreground hover:text-foreground",
        )}
      >
        <ReadingFace icon={mark} label={on ? "Worktree" : "Isolate"} />
      </Button>
    </>
  );
}

/** One inline picker on the strip: icon, current value, menu. Exported for
    the build page's starter picker, which sits in this row's project slot and
    has to read as the same control. */
export function PickerMenu({
  icon,
  label,
  title,
  value,
  options,
  onSelect,
  add,
}: {
  icon: React.ReactNode;
  label: string;
  title: string;
  value: string;
  options: {
    value: string;
    name: string;
    hint?: string;
    icon?: React.ReactNode;
  }[];
  onSelect: (value: string) => void;
  /** The row that makes this catalog longer — see `MenuAdd`. */
  add?: MenuAdd;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  React.useEffect(() => {
    if (!open) setQuery("");
  }, [open]);
  /* Same rule as the config submenu's: a filter box over a handful of rows is
     a control asking to be used for nothing. */
  const searchable = options.length > 8;
  const shown = searchable ? menuFilter(options, query) : options;
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        render={
          /* The reading shape the rest of the footer wears — one 24px pill, a
             16px mark, and the value as a badge on a wide panel. The words are
             kept on every width: this picker names *where the work lands*, and
             a location that goes quiet on a narrow panel is the one thing in
             the row that must not. */
          <Button
            variant="ghost"
            size="icon-xs"
            title={title}
            className={cn(
              READING_TRIGGER,
              READING_TRIGGER_ALWAYS,
              "text-muted-foreground hover:text-foreground",
            )}
          >
            <ReadingFace
              always
              icon={icon}
              label={label}
              labelClass="max-w-40"
            />
          </Button>
        }
      />
      <DropdownMenuContent align="start" className="w-56">
        {/* DropdownMenuLabel is Base UI's Menu.GroupLabel: it reads its group
            from context and throws outside one, so the label and its items are
            wrapped together rather than sitting loose in the content. */}
        {/* Outside the group: `DropdownMenuLabel` is Base UI's GroupLabel and
            names the group's *items*, and a textbox is not one of them. */}
        {searchable && (
          <MenuSearchInput label={title} value={query} onChange={setQuery} />
        )}
        <DropdownMenuGroup>
          <DropdownMenuLabel>{title}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={value}
            onValueChange={(next) => next && next !== value && onSelect(next)}
          >
            {shown.map((option) => (
              <DropdownMenuRadioItem key={option.value} value={option.value}>
                {option.icon}
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{option.name}</span>
                  {option.hint && (
                    <span className="truncate font-mono text-[10px] text-muted-foreground">
                      {option.hint}
                    </span>
                  )}
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          {shown.length === 0 && (
            <DropdownMenuItem disabled className="text-xs">
              No match
            </DropdownMenuItem>
          )}
        </DropdownMenuGroup>
        {add && (
          <MenuAddItem
            add={{
              label: add.label,
              onSelect: () => {
                setOpen(false);
                add.onSelect();
              },
            }}
          />
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Who answers and how: agent, profile, model, effort, and — from the
 * agent's remembered `modes` — the permission mode it will start in.
 *
 * The agent leads the list because it decides what every row under it even
 * means (the profiles, models and efforts on offer are a different set per
 * agent) — merged into this one popover rather than a picker of its own on
 * the strip, since picking who answers and picking how it answers are one
 * decision on a draft, not two.
 *
 * Model and effort are placeholders in the agent's env template, filled at
 * spawn — so before the process exists they are ours to set freely, and the
 * profile catalog is the only place that knows what the choices are. The
 * moment the first message creates the session this control is replaced by
 * SessionConfigPopover and the agent's own ACP selectors take over — the
 * agent itself is fixed by then (it is the process that is running), so that
 * later popover has no agent row.
 */
export function DraftConfigPopover({
  meta,
  actions,
  remember = true,
  shell,
}: {
  meta: SessionMeta;
  actions: Actions;
  /** See `DraftScopeRow`. */
  remember?: boolean;
  /** Open state owned by `ConfigPopover`, so it survives the swap to the session body. */
  shell?: PopoverShell;
}) {
  const {
    agents,
    profiles,
    profile,
    agent,
    agentProfiles,
    configure,
  } = useDraft(meta, actions, remember);

  /* Switching agent keeps the profile when it serves the new agent too — that
     is the point of a profile naming several — and otherwise moves to the
     first that does (the agent's Default sorts first). Model and effort are
     cleared either way: the same profile catalog may be shared, but the agent
     reads its own env, and a pick made for one runtime is not a pick made for
     the other. */
  const chooseAgent = (agentId: string) => {
    const next =
      profile &&
      profileSupports(profile, agentId) &&
      !profile.hidden &&
      !profile.disabled
        ? profile
        : profiles.find(
            (p) => profileSupports(p, agentId) && !p.hidden && !p.disabled,
          );
    if (!next) return;
    configure({ agentId, profileId: next.id, model: "", effort: "" });
  };
  const models = profile?.models ?? [];
  const resolvedModel = models.find(
    (m) => m.id === (meta.model || profile?.defaultModel),
  );
  const newProfile = useNewProfile();
  const addModel = useAddModel();
  /* The measured install state Settings › Agents draws from (one shared,
     server-cached query) — read so a runtime that cannot start is marked
     before the first message is spent on finding out. `installed === false`
     only: an unanswered query says nothing, and a handshake `error` is not a
     missing binary. */
  const { status: agentsStatus } = useAgentsStatus();
  const missingAgents = new Set(
    (agentsStatus?.agents ?? []).filter((a) => !a.installed).map((a) => a.agentId),
  );

  /* What this profile's agent offered the last time one ran. A draft has no
     process to ask, so this is the only way its settings can be picked before
     the thread starts; `createSession` replays the picks once session/new
     answers. The remembered `modes` fold their config-option twin away below,
     as the live menu does — drawn as its own row, a twin pick went out as a
     config choice the server skips in favour of the mode channel. Siblings of the same agent stand in while this profile has no answer of
     its own — the profile only overrides model and effort, so the rest of the
     agent's options are the same set whichever profile is selected. */
  const known = useAgentOptions(
    optionKey(meta.profileId, meta.agentId),
    agentProfiles
      .filter((p) => p.id !== meta.profileId)
      .map((p) => optionKey(p.id, meta.agentId)),
  );
  /* Ask this agent on this profile directly, once ever — the action no-ops
     when its own set is already known or the question is in flight. A
     sibling's set above fills the menu meanwhile, but does not answer for this
     profile's env: a different endpoint can carry a different catalog. */
  React.useEffect(() => {
    void actions.learnAgentOptions(
      meta.profileId,
      meta.agentId,
      meta.projectId,
    );
  }, [actions, meta.profileId, meta.agentId, meta.projectId]);
  /* Which options exist can depend on which model is picked — opencode only
     offers `effort` on its reasoning models — so read the set recorded for the
     chosen model rather than the one that happened to be live when we looked. */
  const remembered = React.useMemo(
    () => shownOptions(known, meta.configChoices, meta.model, meta.effort),
    [known, meta.configChoices, meta.model, meta.effort],
  );
  const agentOptions = partitionSessionOptions(
    remembered,
    new Set(known.modes?.availableModes.map((m) => m.id) ?? []),
  );
  /* The permission modes, when the agent advertises them on the `modes`
     channel — which daedalus does, and an agent that does would otherwise be
     the one runtime you cannot start in plan mode. Same rule as the live
     menu: only worth a row when there is a choice to make. */
  const modes =
    known.modes && known.modes.availableModes.length > 1 ? known.modes : null;
  const modeId = modes ? meta.modeId || modes.currentModeId : undefined;
  const modeLabel = modes?.availableModes.find((m) => m.id === modeId)?.name;

  /* The profile owns the model list when it has one. Effort follows the model:
     the profile's efforts if that model declares any, otherwise the agent's own
     selector — a profile that says nothing about effort is not a profile that
     means "no effort control". Everything else is the agent's, always. */
  const overridden = models.length > 0;
  const spawnEfforts = resolvedModel?.reasoningEfforts ?? [];
  const profileEffort = overridden && spawnEfforts.length > 0;
  const liveEffort = !profileEffort ? agentOptions.effort : undefined;
  const optionValue = (option?: acp.SessionConfigOption) =>
    option?.type === "select" ? option.currentValue : "";

  /* `currentChoiceLabel`, the same reading the started menu draws with — the
     two chips must name the model identically or the pick looks like it moved
     the moment the thread starts. */
  const modelLabel = overridden
    ? (resolvedModel?.label ?? (meta.model || "Profile default"))
    : agentOptions.model
      ? currentChoiceLabel(agentOptions.model)
      : (profile?.name ?? "Agent");
  const effortLabel = profileEffort
    ? meta.effort || null
    : liveEffort
      ? currentChoiceLabel(liveEffort)
      : null;

  const choose = (configId: string, value: string | boolean) =>
    actions.chooseDraftConfigOption(meta.id, configId, value);
  const nothingYet = !overridden && remembered.length === 0 && !modes;
  /* Why the menu is empty, not just that it is: the probe above is a spawn, so
     "asking" is a real wait, and a failed one is worth a retry rather than a
     sentence that reads like a design decision. */
  const probeStatus = useProbeStatus(optionKey(meta.profileId, meta.agentId));
  const profilePick: ChoicePick = {
    label: "Profile",
    value: profile?.id ?? "",
    choices: agentProfiles.map((p) => ({
      value: p.id,
      name: p.name,
      icon: <ProfileIcon profile={p} agentId={meta.agentId} className="size-4" />,
    })),
    onSelect: (id) => configure({ profileId: id, model: "", effort: "" }),
    add: {
      /* Adding one selects it: the model and effort are the old profile's, so
         they are cleared. */
      label: "New profile…",
      onSelect: () =>
        newProfile((id) => configure({ profileId: id, model: "", effort: "" })),
    },
  };
  const effortPick: ChoicePick | null = profileEffort
    ? {
        label: "Effort",
        value: meta.effort || DEFAULT_CHOICE,
        choices: withEffortIcons([
          { value: DEFAULT_CHOICE, name: "Default" },
          ...spawnEfforts.map((effort) => ({ value: effort, name: effort })),
        ]),
        onSelect: (value) => configure({ effort: value === DEFAULT_CHOICE ? "" : value }),
      }
    : liveEffort
      ? {
          label: "Effort",
          value: optionValue(liveEffort),
          choices: withEffortIcons(selectChoices(liveEffort)),
          /* Effort travels the same channel as the model. */
          onSelect: (value) => configure({ effort: value }),
        }
      : null;
  // On a phone the whole menu is a sheet (`ConfigDrawer`).
  const isMobile = useIsMobile();
  const local = React.useState(false);
  const [drawerOpen, setDrawerOpen] = shell ? [shell.drawerOpen, shell.setDrawerOpen] : local;
  const toolRows = useToolDrawerRows(meta, actions, remember);
  /* One object for the row and the sheet it opens, so the two cannot disagree
     about what is listed. */
  const modelPick: ChoicePick | null = overridden
    ? {
        label: "Model",
        value: meta.model || DEFAULT_CHOICE,
        choices: [
          { value: DEFAULT_CHOICE, name: "Profile default" },
          ...models.map((m) => ({
            value: m.id,
            name: m.label,
            icon: <ModelIcon iconUrl={m.iconUrl} className="size-4" />,
            group: m.group || undefined,
          })),
        ],
        onSelect: (value) =>
          configure({
            model: value === DEFAULT_CHOICE ? "" : value,
            effort: "",
          }),
        /* Only on the overridden branch: appending one row to a profile that
           defers to the agent would silently flip it into overriding the
           agent. */
        add:
          profile && !profile.virtual
            ? {
                label: "Add model…",
                onSelect: () =>
                  addModel(profile.id, (id) => configure({ model: id, effort: "" })),
              }
            : undefined,
      }
    : agentOptions.model
      ? {
          label: "Model",
          value: optionValue(agentOptions.model),
          /* Agent-driven options carry no art — every row gets the neutral
             glyph so the list reads like the catalog one. */
          choices: selectChoices(agentOptions.model).map((c) => ({
            ...c,
            icon: <BotIcon className="size-4 text-muted-foreground" />,
          })),
          /* The row's own `model`, not a config choice: the agent's model has
             a channel of its own at spawn (`agentOwned`). */
          onSelect: (value) => configure({ model: value }),
        }
      : null;

  /* The same settings as the dropdown below, as the phone's sheet reads them. */
  const drawerRows: DrawerRows = [
    { type: "label", text: "Start this thread with" },
    {
      type: "pick",
      pick: {
        label: "Agent",
        value: agent?.id ?? "",
        choices: agents.map((a) => ({
          value: a.id,
          name: a.name,
          icon: <AgentIcon agentId={a.id} className="size-4" />,
          note: missingAgents.has(a.id) ? "Not installed" : undefined,
        })),
        onSelect: chooseAgent,
      },
    },
    { type: "pick", pick: profilePick },
    modelPick && { type: "pick", pick: modelPick },
    effortPick && { type: "pick", pick: effortPick },
    ...toolRows,
    { type: "label", text: "Session settings" },
    {
      type: "switch",
      label: "Suggest follow-ups",
      checked: meta.suggestFollowups !== false,
      onChange: (checked) => configure({ suggestFollowups: checked }),
    },
    {
      type: "switch",
      label: "Draw answers as UI",
      checked: meta.uiBlocks !== false,
      onChange: (checked) => configure({ uiBlocks: checked }),
    },
    (modes || agentOptions.rest.length > 0) && { type: "label", text: "Agent options" },
    modes && {
      type: "pick",
      pick: {
        label: "Mode",
        value: meta.modeId || modes.currentModeId,
        choices: withModeIcons(modes.availableModes.map((mode) => ({ value: mode.id, name: mode.name }))),
        onSelect: (modeId) => configure({ modeId }),
      },
    },
    ...agentOptions.rest.map(
      (option): NonNullable<DrawerRows[number]> =>
        option.type === "select"
          ? {
              type: "pick",
              pick: {
                label: option.name,
                value: option.currentValue,
                choices: selectChoices(option),
                onSelect: (value) => choose(option.id, value),
              },
            }
          : {
              type: "switch",
              label: option.name,
              checked: option.currentValue,
              onChange: (checked) => choose(option.id, checked),
            },
    ),
    (modes || agentOptions.rest.length > 0) && {
      type: "action",
      label: probeStatus === "asking" ? "Refreshing…" : "Refresh options",
      muted: true,
      onClick: () => void actions.learnAgentOptions(meta.profileId, meta.agentId, meta.projectId, true),
    },
  ];

  return (
    <>
    <DropdownMenu
      open={isMobile ? false : shell?.open}
      onOpenChange={(open) => {
        // A phone opens the sheet instead; the menu itself never shows.
        if (isMobile && open) setDrawerOpen(true);
        if (!isMobile) shell?.setOpen(open);
      }}
    >
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            /* Ellipsized rather than collapsed, on a phone as in a narrow dock
               panel — same rule as SessionConfigPopover's trigger, which
               replaces this one the moment the thread starts. */
            className={PILL}
            title={[modelLabel, effortLabel, modeLabel]
              .filter(Boolean)
              .join(" · ")}
          >
            {/* The model's own icon replaces the profile's logo in the pair —
                the two marks stay, it is only the second one that changes. A
                broken model icon falls back to the profile logo. */}
            {resolvedModel?.iconUrl ? (
              <AvatarGroup className="-space-x-1">
                <AgentIcon
                  agentId={agent?.id ?? meta.agentId}
                  className="size-4 ring-2 ring-surface"
                />
                <EntityIcon
                  src={resolvedModel.iconUrl}
                  fallback={
                    <ProfileIcon
                      profile={profile}
                      agentId={agent?.id ?? meta.agentId}
                      className="size-4 ring-2 ring-surface"
                    />
                  }
                  className="size-4 ring-2 ring-surface"
                />
              </AvatarGroup>
            ) : profile?.logoUrl ? (
              <AvatarGroup className="-space-x-1">
                <AgentIcon
                  agentId={agent?.id ?? meta.agentId}
                  className="size-4 ring-2 ring-surface"
                />
                <ProfileIcon
                  profile={profile}
                  agentId={agent?.id ?? meta.agentId}
                  className="size-4 ring-2 ring-surface"
                />
              </AvatarGroup>
            ) : (
              <ProfileIcon
                profile={profile}
                agentId={agent?.id ?? meta.agentId}
                className="size-4"
              />
            )}
            {/* Same words the started thread's trigger reads — the agent is
                named by its mark above. */}
            <PillLabel
              model={modelLabel}
              effort={effortLabel}
              effortLevel={
                profileEffort
                  ? levelOf(spawnEfforts, meta.effort)
                  : liveEffort
                    ? levelOf(selectChoices(liveEffort).map((c) => c.value), optionValue(liveEffort))
                    : null
              }
              mode={modeLabel}
              modeId={modeId}
            />
          </Button>
        }
      />
      <DropdownMenuContent align="start" className="w-60">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Start this thread with</DropdownMenuLabel>
          {/* First, because it decides what every row below it even means —
              switching it resets model and effort (`chooseAgent`). */}
          <MenuRow
            label="Agent"
            value={agent?.id ?? ""}
            choices={agents.map((a) => ({
              value: a.id,
              name: a.name,
              icon: <AgentIcon agentId={a.id} className="size-4" />,
              note: missingAgents.has(a.id) ? "Not installed" : undefined,
            }))}
            onSelect={chooseAgent}
          />
          {/* Drawn even on a single profile: the row is also the door to
              making another. */}
          <MenuRow {...profilePick} />
          {modelPick && (
            <MenuRow {...modelPick} />
          )}
          {effortPick && <MenuRow {...effortPick} />}
          {profile && <HelperModelRow profile={profile} />}
          {nothingYet &&
            (!profile ? (
              <DropdownMenuItem disabled className="whitespace-normal text-xs">
                Pick a profile to start this thread.
              </DropdownMenuItem>
            ) : probeStatus === "failed" ? (
              /* The one row here that is not disabled: a failed probe is the
                 only state the reader can do something about. */
              <DropdownMenuItem
                className="whitespace-normal text-xs"
                onSelect={(event) => {
                  event.preventDefault();
                  void actions.learnAgentOptions(
                    meta.profileId,
                    meta.agentId,
                    meta.projectId,
                    true,
                  );
                }}
              >
                <RefreshCwIcon className="size-4 text-muted-foreground" />
                Couldn't reach {agent?.name ?? "this agent"} — try again
              </DropdownMenuItem>
            ) : probeStatus === "asking" ? (
              <DropdownMenuItem disabled className="whitespace-normal text-xs">
                <Loader2 className="size-4 animate-spin" />
                Asking {agent?.name ?? "the agent"} what it supports…
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem disabled className="whitespace-normal text-xs">
                {agent?.name ?? "This agent"} offers nothing to configure before
                the thread starts.
              </DropdownMenuItem>
            ))}
        </DropdownMenuGroup>
        {/* What the thread will carry — still a choice on a draft. */}
        <ThreadToolsSections
          meta={meta}
          actions={actions}
          editable
          remember={remember}
        />
        <DropdownMenuSeparator />
        <SessionSettingsSub
          items={[
            {
              label: "Suggest follow-ups",
              checked: meta.suggestFollowups !== false,
              onChange: (checked) => configure({ suggestFollowups: checked }),
            },
            {
              label: "Draw answers as UI",
              checked: meta.uiBlocks !== false,
              onChange: (checked) => configure({ uiBlocks: checked }),
            },
          ]}
        />
        {/* Never touched by the profile: mode and the rest are the agent's. */}
        {(modes || agentOptions.rest.length > 0) && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>Agent options</DropdownMenuLabel>
              {/* Remembered on the draft rather than replayed as a config
                  choice, because a mode travels over `session/set_mode`. */}
              {modes && (
                <MenuRow
                  label="Mode"
                  value={meta.modeId || modes.currentModeId}
                  choices={withModeIcons(
                    modes.availableModes.map((mode) => ({
                      value: mode.id,
                      name: mode.name,
                    })),
                  )}
                  onSelect={(modeId) => configure({ modeId })}
                />
              )}
              {agentOptions.rest.map((option) =>
                option.type === "select" ? (
                  <MenuRow
                    key={option.id}
                    label={option.name}
                    value={option.currentValue}
                    choices={selectChoices(option)}
                    onSelect={(value) => choose(option.id, value)}
                  />
                ) : (
                  <DropdownMenuCheckboxItem
                    key={option.id}
                    checked={option.currentValue}
                    onCheckedChange={(checked) =>
                      choose(option.id, checked === true)
                    }
                  >
                    {option.name}
                  </DropdownMenuCheckboxItem>
                ),
              )}
              {/* The probe is cached on both ends, keyed on what the harness
                  can see — an upgraded binary or a new login is not in it. */}
              <DropdownMenuItem
                className="text-xs text-muted-foreground"
                disabled={probeStatus === "asking"}
                onSelect={(event) => {
                  event.preventDefault();
                  void actions.learnAgentOptions(
                    meta.profileId,
                    meta.agentId,
                    meta.projectId,
                    true,
                  );
                }}
              >
                {probeStatus === "asking" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <RefreshCwIcon className="size-4" />
                )}
                Refresh options
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
    {isMobile && (
      <ConfigDrawer open={drawerOpen} onOpenChange={setDrawerOpen} title="Start this thread with" rows={drawerRows} />
    )}
    </>
  );
}
