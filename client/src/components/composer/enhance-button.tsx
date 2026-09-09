/* ── The prompt enhancer ──
   The button and everything behind it. It owns its own profile/model reads so
   the composer does not re-render every time the profile catalog moves: the
   rewrite is a device habit hanging off the toolbar, not a property of the
   thread. */
import * as React from "react"
import { Sparkles } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import {
  enhanceDraft,
  enhanceThread,
  resolveEnhanceModelId,
  resolveEnhanceProfile,
  useEnhanceModelId,
  useEnhanceProfileId,
} from "@/lib/enhance"
import { reportError } from "@/lib/errors"
import { useProfiles } from "@/lib/queries/catalog"
import { useServer } from "@/lib/server-context"
import type { SessionMeta } from "@/lib/settings"

/* Prompt enhancer: rewrites the draft through the AI SDK against a profile's
   own endpoint (`lib/enhance`). Which profile is the user's pick, remembered
   device-locally and defaulting to the thread's own; a draft sends its
   profile in the body because it has no server row yet. The rewrite replaces
   the box the way a history recall does — unsent, editable — and a failure
   toasts rather than landing in the transcript, because it never reached the
   agent. The box stays typable while it runs; only the button goes busy.

   Drawn whenever a profile exists that can do the rewrite — virtual Defaults
   carry no endpoint, so with nothing capable there is no button either. */
export function EnhanceButton({
  sessionId,
  meta,
  draft,
  text,
  disabled,
  gated,
  hasContent,
  size,
  onEnhanced,
}: {
  sessionId: string
  meta?: SessionMeta
  draft: boolean
  text: string
  disabled: boolean
  gated: boolean
  hasContent: boolean
  /** The row's one scale — 24px under a mouse, 32px under a finger. */
  size: React.ComponentProps<typeof Button>["size"]
  /** Put the rewrite in the box: replaced, unsent, caret at its end — the
      same landing a history recall makes. */
  onEnhanced: (enhanced: string) => void
}) {
  const settings = useServer()
  const profiles = useProfiles()
  /* Subscribed for the re-render: `resolveEnhanceProfile` reads the remembered
     pick out of the store, so without this a pick made in the menu below would
     not move the button until the next keystroke. */
  useEnhanceProfileId()
  useEnhanceModelId()
  const enhanceProfile = resolveEnhanceProfile(profiles, meta?.profileId)
  /* Explicit model pick for the rewrite, device-local like the profile pick.
     Validated against the profile doing the rewrite, so a stale id reads as
     no pick. "" means no pick — the thread's model when there is one, else
     the profile's own default (resolved server-side in `enhance.ts`). */
  const enhanceModel = resolveEnhanceModelId(enhanceProfile) || undefined
  const [enhancing, setEnhancing] = React.useState(false)
  const enhanceAbort = React.useRef<AbortController | null>(null)
  React.useEffect(() => () => enhanceAbort.current?.abort(), [sessionId])
  const enhance = () => {
    const value = text.trim()
    if (!value || enhancing || disabled || gated) return
    const profile = enhanceProfile
    if (!profile) {
      reportError(new Error("No profile with an endpoint to enhance with"), "Couldn't enhance the prompt")
      return
    }
    enhanceAbort.current?.abort()
    const controller = new AbortController()
    enhanceAbort.current = controller
    setEnhancing(true)
    /* The explicit enhance-model pick wins over the thread's model; with
       neither picked the server falls back to the profile's own default. A
       draft sends the rewrite's profile in the body (it has no server row);
       a thread sends it only when it differs from the thread's own. */
    const rewriteModel = enhanceModel || meta?.model || undefined
    const done = draft
      ? enhanceDraft(
          settings,
          value,
          { profileId: profile.id, agentId: meta?.agentId || undefined, model: rewriteModel },
          controller.signal
        )
      : enhanceThread(
          settings,
          sessionId,
          value,
          {
            // Send the pick only when it differs: the route defaults to the
            // thread's own profile, and the thread may have moved since.
            ...(profile.id !== meta?.profileId ? { profileId: profile.id } : {}),
            ...(rewriteModel ? { model: rewriteModel } : {}),
          },
          controller.signal
        )
    void done
      .then((enhanced) => {
        if (controller.signal.aborted) return
        onEnhanced(enhanced)
      })
      .catch((err) => {
        if (controller.signal.aborted) return
        reportError(err, "Couldn't enhance the prompt")
      })
      .finally(() => {
        if (enhanceAbort.current === controller) {
          enhanceAbort.current = null
          setEnhancing(false)
        }
      })
  }

  if (!enhanceProfile) return null

  return (
    <Button
      variant="ghost"
      size={size}
      className="shrink-0 rounded-lg text-muted-foreground hover:text-foreground [&_svg]:size-3.5"
      onClick={enhance}
      disabled={disabled || gated || !hasContent}
      title={
        enhancing
          ? "Enhancing…"
          : `Enhance with ${enhanceProfile.name}${enhanceModel ? ` · ${enhanceModel}` : ""} — rewrites the draft, sends nothing`
      }
      aria-label="Enhance the prompt"
    >
      {enhancing ? <Spinner className="size-3.5" /> : <Sparkles />}
    </Button>
  )
}
