/* ── A thread in a window of its own (desktop shell) ──
   `electron/main.cjs` opens `/t/<id>?popout=1` on the main window's origin, so
   the popout shares every device-local store with it. That is the danger as
   much as the point: the dock layout, the draft rows and the boot prune are
   the main window's, and a second shell writing them would close its tabs.
   So a popout draws the one transcript (`App.tsx` → `PopoutThread`), mounts no
   dock, never saves a layout (`saveLayout`), never restores or prunes drafts
   (`bootstrap`), and raises no notifications — the main window already does.

   Read once, at load: the flag is the window's identity, not a route. The
   shell's own answer (`desktop.popout`, a process argument) is what survives a
   reload after something in the transcript navigated the URL off `?popout=1`. */
export const IS_POPOUT =
  typeof window !== "undefined" &&
  (!!window.desktop?.popout || new URLSearchParams(window.location.search).has("popout"))
