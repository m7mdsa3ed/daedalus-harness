/* ── The landing page ──
   `/` with no thread open, and it *is* a new-thread page: the same centred
   welcome and the same composer an empty thread has always drawn, because they
   are the same component. Every "New thread" gesture mints a draft thread of
   its own instead (`actions.startThreadIn`); this is what the dock lands on
   when the last tab closes, and the thread it starts begins to exist when it is
   sent.

   The draft is minted on arrival and forgotten on the way out if nothing was
   sent. That is the whole trick: a draft is a client-side row with a real id
   and no server behind it (`actions.newDraftThread`), so the composer gets a
   session to be keyed by — its text, its pastes, its attachments, its project
   and tool pickers all work — while the harness stays told nothing. No list
   draws it (`isListed`), which is what makes minting one per visit harmless.

   What was here before and is not coming back: a headline and a paragraph
   pitching the product to someone who has already connected a server; a band of
   four counts that were inventory rather than news; six feature cards whose
   whole function was to navigate to Settings; a 720px hero of glows and dot
   grid; and — briefly — a bespoke input that copied the composer's shape
   without its shelf, its scope row or any of its pickers. */
import * as React from "react"
import { useNavigate, useSearchParams } from "react-router"
import {
  BellIcon,
  MessageSquarePlusIcon,
  RepeatIcon,
  SettingsIcon,
  SquareKanbanIcon,
} from "lucide-react"

import { Composer } from "@/components/composer/composer"
import { useAttachmentDelivery } from "@/components/composer-attachments"
import { LandingSetup } from "@/components/landing/landing-setup"
import { LandingSkeleton } from "@/components/landing/landing-skeleton"
import { ThreadWelcome } from "@/components/thread-view/welcome"
import type { Actions } from "@/lib/actions"
import { KEYBOARD_CENTER_FLOW } from "@/lib/keyboard-inset"
import { useProfiles, useProjects } from "@/lib/queries/catalog"
import { requestComposerFocus } from "@/lib/composer-focus"
import { ProjectIcon } from "@/components/entity-icon"
import { Button } from "@/components/ui/button"
import { PageFrame } from "@/components/page-primitives"
import {
  automationsPath,
  boardPath,
  projectPath,
  settingsRootPath,
  threadPath,
} from "@/lib/router"
import { useSessionMeta, useThread } from "@/lib/store"
import { endVoiceCall } from "@/lib/voice-call"
import { emptyDefaults, loadThreadDefaults, resolveThreadStart } from "@/lib/thread-defaults"
import { cn } from "@/lib/utils"
import type { SettingsSectionId } from "@/components/settings/sections"

export function LandingPage({
  loading,
  ready,
  actions,
  onOpenSettings,
}: {
  loading: boolean
  ready: boolean
  actions: Actions
  onOpenSettings: (section?: SettingsSectionId) => void
}) {
  const projects = useProjects()
  const profiles = useProfiles()

  if (loading) return <LandingSkeleton />
  if (!ready) {
    /* Nothing can run yet, so there is no composer to draw: the page is the two
       things standing in the way. Its own container, because the setup list is
       a document to read and the composer below is a box to be centred. */
    return (
      <PageFrame width="form">
        <LandingSetup
          projects={projects.length}
          profiles={profiles.length}
          onOpenProjects={() => onOpenSettings("projects")}
          onOpenProfiles={() => onOpenSettings("profiles")}
        />
      </PageFrame>
    )
  }
  /* A component of its own, and this is the only reason: the draft-minting
     effect must not exist until there is a project to mint against, and hooks
     cannot be skipped. Mounting it behind the two gates above says that once,
     structurally, instead of every hook below re-stating it as a guard. */
  return <LandingComposer actions={actions} />
}

function LandingComposer({ actions }: { actions: Actions }) {
  const projects = useProjects()
  const profiles = useProfiles()
  const navigate = useNavigate()
  /* Which project this console's thread starts in, when the console was
     reached by a deep link that aims one (`?project=`, `landingPath`). A
     search param and not a remembered default, because aiming one console is
     not a statement about every thread you start after it — and it is only the
     *starting* project either way: the composer's own scope row moves it. */
  const wantedProject = useSearchParams()[0].get("project")
  // Memoized for `loadThreadDefaults`, which is a localStorage read and a parse.
  const projectId = React.useMemo(
    () =>
      projects.find((p) => p.id === wantedProject)?.id ??
      projects.find((p) => p.id === loadThreadDefaults().projectId)?.id ??
      projects[0]?.id,
    [projects, wantedProject]
  )

  /* A thread that has been sent is not this page's to forget. The send is what
     unmounts this component (`beforeSend` navigates), and it navigates *before*
     `actions.send` runs — so at cleanup the row is still flagged a draft and
     dropping it would delete the thread out from under the POST that was about
     to create it. A ref and not state: nothing renders differently, and the
     cleanup has to see the answer in the same tick it was written. */
  const sent = React.useRef(false)

  /* One draft per visit to the front door, dropped on the way out unless it was
     sent — `deleteThread` on a draft is a dispatch and no request at all
     (lib/actions.ts). Re-run on a change of project rather than re-pointing the
     existing draft: arriving from another project's + is a deliberate re-aim,
     and each id keeps its own composer text either way.

     Before paint (`useLayoutEffect`): the grid centres whatever is in the
     middle row, so a first frame with the welcome and no composer under it
     centres the welcome and then jerks it upward when the box arrives. */
  const [sessionId, setSessionId] = React.useState("")
  React.useLayoutEffect(() => {
    const project = projects.find((p) => p.id === projectId)
    if (!project) return
    /* The console's own project — the deep-linked one, else the remembered
       one, else the first — resolved against *that project's* start defaults,
       so the composer below draws the same agent and model ⌘N would open on. */
    const start = resolveThreadStart(project.defaults ?? emptyDefaults(), profiles)
    if (!start) return
    const id = actions.newDraftThread({ project, ...start })
    setSessionId(id)
    return () => {
      if (!sent.current) void actions.deleteThread(id)
    }
    // `projects`/`profiles` are query-cache arrays and change identity on every
    // refresh; what this depends on is which project it is minting against.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, actions])

  const meta = useSessionMeta(sessionId)
  const thread = useThread(sessionId)
  const delivery = useAttachmentDelivery(meta, thread)

  /* Voice mode is the composer's own (its bar rides beside the pill). A first
     message *spoken* reaches `actions.send` without the box's `beforeSend`, so
     nothing has navigated: the draft simply stops being one. That is a send
     like any other — mark it, so the cleanup below does not delete the thread
     it created, and open it, which is where the conversation is drawn. */
  const created = !!meta && !meta.draft
  React.useEffect(() => {
    if (!sessionId || !created || sent.current) return
    sent.current = true
    void navigate(threadPath(sessionId))
  }, [created, sessionId, navigate])

  /* The call goes with this console's draft — except on the way out of a send,
     where the thread view mounting in that same commit takes it over.
     `useVoiceCallLifetime` cannot be the one tying them: it counts mounted
     views of the thread, and the count would reach zero in the frame between
     this page unmounting and that one mounting, ending a call mid-send. */
  React.useEffect(() => {
    const id = sessionId
    return () => {
      if (!sent.current) endVoiceCall(id)
    }
  }, [sessionId])

  return (
    /* The empty thread's own centring, which is most of what this page is: two
       spacer rows of equal weight with the whole console — greeting, box and
       the quick actions under it — between them. `@container` because the
       composer and its shelf are written in the `@panel-*` queries the dock
       declares for them, and this page is not in the dock. */
    <div className="@container grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_auto_minmax(0,1fr)] pt-[var(--app-header-h)]">
      <span aria-hidden />
      {/* Nothing on this page scrolls, so the browser has nothing to scroll a
          focused box into view with — the composer rides the soft keyboard
          itself, and by half, because the rows above and below already put its
          middle at mid-pane (`KEYBOARD_CENTER_FLOW`, the same recipe the empty
          transcript uses). */}
      <div className={cn("relative min-w-0", KEYBOARD_CENTER_FLOW)}>
        <ThreadWelcome draft />
        {sessionId ? (
          <Composer
            sessionId={sessionId}
            actions={actions}
            thread={thread}
            meta={meta}
            delivery={delivery}
            /* The console draws the call above the box, so it asks for the
               button the same way a thread view does. */
            voiceCall
            /* This page is the box: nothing else on it can be typed into, and
               its draft is not the routed thread, so the composer's own rule
               (focus a routed draft) never fired here. */
            autoFocus
            /* Awaited after the words have been taken and before the send, so
               the route changes while `actions.send` is still in flight — the
               order `startThread` has always used: the thread is already
               spawning while its transcript is opening. `sent` first, because
               the navigation is what runs the cleanup that would otherwise
               throw this draft away mid-send. */
            beforeSend={async () => {
              sent.current = true
              void navigate(threadPath(sessionId))
              return true
            }}
          />
        ) : null}
      </div>
      <QuickActions
        projects={projects}
        onThread={() => sessionId && requestComposerFocus(sessionId)}
      />
    </div>
  )
}

/* ── The New tab page's quick actions ──
   A tab is an isolated outlet that can open anything, and this is the page a
   fresh one opens on. Each action navigates *this* tab, so whatever it opens stays
   in it — the same route can be open in as many tabs as you like. */
function QuickActions({
  projects,
  onThread,
}: {
  projects: ReturnType<typeof useProjects>
  onThread: () => void
}) {
  const navigate = useNavigate()
  const go = (path: string) => () => void navigate(path)
  const chip = (onClick: () => void, icon: React.ReactNode, label: React.ReactNode, key?: string) => (
    <Button key={key} variant="outline" onClick={onClick} className="text-muted-foreground">
      {icon}
      {label}
    </Button>
  )
  return (
    <div className="flex flex-wrap content-start items-start justify-center gap-2 px-4 pt-6">
      {chip(onThread, <MessageSquarePlusIcon data-icon="inline-start" />, "New thread")}
      {chip(go(boardPath()), <SquareKanbanIcon data-icon="inline-start" />, "Tasks")}
      {chip(go(automationsPath()), <RepeatIcon data-icon="inline-start" />, "Automations")}
      {chip(go("/notifications"), <BellIcon data-icon="inline-start" />, "Inbox")}
      {chip(go(settingsRootPath()), <SettingsIcon data-icon="inline-start" />, "Settings")}
      {projects.slice(0, 4).map((project) =>
        chip(
          go(projectPath(project.id)),
          // ProjectIcon does not forward props, so the slot the button spaces by is a wrapper.
          <span data-icon="inline-start" className="flex size-4 shrink-0 items-center justify-center">
            <ProjectIcon project={project} className="size-4" />
          </span>,
          project.name,
          project.id
        )
      )}
    </div>
  )
}
