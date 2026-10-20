/* eslint-disable react-refresh/only-export-components */
/* ── Growing a catalog from the menu that reads it ──

   The composer's pickers list projects, profiles and a profile's models. Each
   of those lists used to be read-only here: adding one meant leaving the
   thread for Settings, naming the thing, and coming back to find the picker
   where you left it. These are the three "…and one more" doors, in one file
   because they share the rule: the picker asks for the thing, and what it
   opens is the editor that already exists.

   - A project and a profile are **the settings form, in a dialog** — the same
     component the settings route renders (`ProjectForm`, `ProfileForm`), with
     `dialog` taking the page header off. A menu that asked its own smaller
     question was two forms for one record: the picker's copy could only set a
     directory, so every project made from the composer had to be opened in
     Settings anyway to get a description, a logo or a preview URL. One form,
     one set of inputs, one place the rules live.
   - A model on a profile is still one question — an id and a label that
     defaults to it — because that is a row appended to a catalog, not a
     record, and `useAddProfileModel` is the route that appends it without the
     credentials the client does not hold.

   The dialog is mounted once at the root (`CatalogFormProvider`, beside
   `PromptProvider`) rather than beside each picker, for the reason the prompt
   dialog is: three surfaces ask this and a copy each is three places for the
   invalidation and the "select what you just made" rule to drift apart. The
   two forms are `React.lazy`, so the settings chunk stays out of the main
   bundle for a reader who never opens one.
*/
import * as React from "react"

import { usePrompt } from "@/components/prompt-dialog"
import { Button } from "@/components/ui/button"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { GroupRowsSkeleton } from "@/components/ui/skeletons"
import { dropAgentOptions } from "@/lib/agent-options"
import { reportError } from "@/lib/errors"
import {
  useAddProfileModel,
  useAgents,
  useInvalidateCatalog,
  useInvalidateProfileCatalog,
} from "@/lib/queries/catalog"
import { useServer } from "@/lib/server-context"

const ProjectForm = React.lazy(() =>
  import("@/components/settings/projects").then((m) => ({ default: m.ProjectForm }))
)
const ProfileForm = React.lazy(() =>
  import("@/components/settings/profiles").then((m) => ({ default: m.ProfileForm }))
)

/** Opens the form and resolves with the new row's id, or null if cancelled. */
type CatalogFormFn = (kind: "project" | "profile") => Promise<string | null>

/** The dialog's form, which its footer's Save submits. */
const FORM_ID = "catalog-form"

const CatalogFormCtx = React.createContext<CatalogFormFn>(() => Promise.resolve(null))

const COPY = {
  project: {
    title: "New project",
    description: "The directory this project's threads run in, and how it is drawn.",
  },
  profile: {
    title: "New profile",
    description:
      "Credentials, model catalog, which agents run on it, and what every thread on it brings along.",
  },
} as const

export function CatalogFormProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = React.useState<{
    kind: "project" | "profile"
    resolve: (id: string | null) => void
  } | null>(null)
  /* The form's own save is running: the footer's Save is this form's submit
     (`form=FORM_ID`), so it says so and refuses a second click. */
  const [busy, setBusy] = React.useState(false)
  const settings = useServer()
  const agents = useAgents()
  const invalidate = useInvalidateCatalog()
  const invalidateProfiles = useInvalidateProfileCatalog()

  const open = React.useCallback<CatalogFormFn>(
    (kind) => new Promise((resolve) => setPending({ kind, resolve })),
    []
  )

  const settle = (id: string | null) => {
    pending?.resolve(id)
    setPending(null)
    setBusy(false)
  }

  /* The catalog is refreshed before the caller is told, so the picker that
     selects the new id is reading a list that already holds it. */
  const done = async (id: string | null) => {
    if (id) await (pending?.kind === "profile" ? invalidateProfiles() : invalidate("projects"))
    settle(id)
  }

  const copy = pending ? COPY[pending.kind] : null

  return (
    <CatalogFormCtx.Provider value={open}>
      {children}
      {/* `tall`: these are the settings forms, which is exactly the rich
          editing surface that escape hatch exists for. */}
      <ResponsiveDialog open={pending !== null} onOpenChange={(isOpen) => !isOpen && settle(null)} tall>
        <ResponsiveDialogContent className="sm:max-w-2xl">
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle>{copy?.title}</ResponsiveDialogTitle>
            <ResponsiveDialogDescription>{copy?.description}</ResponsiveDialogDescription>
          </ResponsiveDialogHeader>
          <React.Suspense fallback={<GroupRowsSkeleton rows={4} />}>
            {pending?.kind === "project" && (
              <ProjectForm
                project={null}
                settings={settings}
                dialog
                formId={FORM_ID}
                onBusyChange={setBusy}
                onDone={(saved) => void done(saved?.id ?? null)}
              />
            )}
            {pending?.kind === "profile" && (
              <ProfileForm
                profile={null}
                agents={agents}
                settings={settings}
                dialog
                formId={FORM_ID}
                onBusyChange={setBusy}
                onDone={(saved) => {
                  /* Same eviction the settings route makes: what this device
                     remembered about a profile's agents was read from its
                     credentials and endpoint. A new profile has nothing
                     cached, but the id is real the moment it is saved. */
                  if (saved) dropAgentOptions(saved.id)
                  void done(saved?.id ?? null)
                }}
              />
            )}
          </React.Suspense>
          <ResponsiveDialogFooter>
            <Button type="button" variant="outline" onClick={() => settle(null)}>
              Cancel
            </Button>
            <Button type="submit" form={FORM_ID} loading={busy}>
              Save
            </Button>
          </ResponsiveDialogFooter>
        </ResponsiveDialogContent>
      </ResponsiveDialog>
    </CatalogFormCtx.Provider>
  )
}

/** Open the project form, and hand back its id so the caller can select it —
    picking is why you added it. */
export function useNewProject(): (onCreated: (projectId: string) => void) => void {
  const open = React.useContext(CatalogFormCtx)
  return React.useCallback(
    (onCreated) => {
      void open("project").then((id) => id && onCreated(id))
    },
    [open]
  )
}

/** The same door for a provider. */
export function useNewProfile(): (onCreated: (profileId: string) => void) => void {
  const open = React.useContext(CatalogFormCtx)
  return React.useCallback(
    (onCreated) => {
      void open("profile").then((id) => id && onCreated(id))
    },
    [open]
  )
}

/** Ask for a model id and append it to the profile's catalog, then hand it
    back to be selected. The label is the id: a model you typed the id of is a
    model you already know the name of, and the editor is where the numbers,
    the art and the effort levels go. */
export function useAddModel(): (profileId: string, onAdded: (modelId: string) => void) => void {
  const prompt = usePrompt()
  const add = useAddProfileModel()
  return React.useCallback(
    (profileId, onAdded) => {
      void (async () => {
        const id = await prompt({
          title: "Add a model",
          description: "The id your provider serves it under. It is added to this profile's catalog.",
          placeholder: "anthropic/claude-sonnet-4.5",
          confirmLabel: "Add",
        })
        if (!id) return
        try {
          await add.mutateAsync({ profileId, id, label: id })
          onAdded(id)
        } catch (err) {
          reportError(err, "Couldn't add that model")
        }
      })()
    },
    [prompt, add]
  )
}
