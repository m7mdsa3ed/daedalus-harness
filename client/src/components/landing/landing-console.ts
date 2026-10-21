/* What the New tab page hands the thread view it hosts. The page is a draft
   thread inside a thread dock (so its panels open before a first message), and
   the view is the same one every thread draws — this is the console's three
   differences: the greeting's larger dress, the launcher strip under the box,
   and the navigation that runs before the first send. A context and not props,
   because the dock builds its panels once per thread and a prop on them would
   remount the transcript whenever the strip's identity changed. */
import * as React from "react"

export interface LandingConsole {
  /** The launcher strip, drawn under the composer while the thread is empty. */
  strip: React.ReactNode
  /** The composer's `beforeSend`: the route changes while the send is in flight. */
  beforeSend: (text: string) => Promise<boolean>
}

export const LandingConsoleContext = React.createContext<LandingConsole | null>(null)
