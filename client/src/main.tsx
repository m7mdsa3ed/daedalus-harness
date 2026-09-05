import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { BrowserRouter } from 'react-router'
import App from './App.tsx'
import { ErrorBoundary } from './components/error-boundary.tsx'
import { installGlobalErrorReporting } from './lib/errors.ts'
import { installDesktopNotifications, installNotificationTestHelper } from './lib/notifications.ts'
import { registerPwa } from './lib/pwa'
import { watchInstallability } from './lib/install.ts'
import { startKeyboardInset } from './lib/keyboard-inset.ts'
import { startCaretKeeper } from './lib/keyboard-caret.ts'
import { installWindowControlsOverlay } from './hooks/use-windows-controls-overlay.ts'

// The floor under everything else: a promise nobody caught, or a listener that
// threw outside React's tree, would otherwise vanish into the console. The
// ErrorBoundary only sees failures that happen during a render.
installGlobalErrorReporting()
// `daedalus.notify()` in the console — the only way to look at a notification
// without arranging for a turn to finish in a window you are not watching.
installNotificationTestHelper()
// The desktop shell's notifications are the main process's, so a click on one
// arrives over IPC rather than on a Notification object (electron/main.cjs).
installDesktopNotifications()
// Service worker: the offline shell, the install, and the push notifications
// that arrive when no tab is attached. Silent no-op off https or in a browser
// without support.
registerPwa()
// `--keyboard-inset`: the page no longer resizes when the soft keyboard opens
// (index.html's `interactive-widget=overlays-content`), so the one surface that
// has to stay above it reads how tall it is from here. Installed before render
// because the variable is read on the first paint of a focused composer.
startKeyboardInset()
// The other half of the same trade: the browser's own scroll-into-view on focus
// is driven by the visual viewport shrinking, which `overlays-content` stops,
// so a field on an ordinary scrolling form is left under the keys. This scrolls
// the one that is covered, after the surfaces that ride the keyboard have moved.
startCaretKeeper()
// `html[data-window-controls-overlay]`: the PWA's equivalent of Electron's
// frameless window. In `window-controls-overlay` mode (installed Chromium on
// Windows) the OS title bar is gone and the app's top strip is draggable; the
// attribute flips on the first read, so the drag regions are live before paint.
installWindowControlsOverlay()
// `beforeinstallprompt` fires within moments of load and only once, so the
// listener has to be up before anything renders — a component that mounts later
// has already missed it, and the app then has no way to offer an install at all.
watchInstallability()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Last-resort boundary: it sits outside the providers, so it still renders
        if one of them throws. Per-region boundaries live in the app shell. */}
    <ErrorBoundary>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>,
)

// Fade out #boot-splash (inlined in index.html so it paints before the bundle
// parses) only once its intro has played out — `window.__bootIntro` resolves on
// the `boot-hold` animation, which spans the whole mark-draw + wordmark sequence.
{
  const splash = document.getElementById('boot-splash')
  if (splash) {
    const dismiss = () => {
      if (!splash.isConnected) return
      splash.classList.add('is-leaving')
      window.setTimeout(() => splash.remove(), 300)
    }
    // A missing latch means the inline script in index.html never ran (blocked
    // or threw) — the CSS sequence still plays, so hold for its length rather
    // than dismissing on the next microtask, which erased the splash entirely.
    const intro = (window as { __bootIntro?: Promise<void> }).__bootIntro
    void (intro ?? new Promise((resolve) => window.setTimeout(resolve, 1700))).then(dismiss)
    // Backstop: a throttled background tab (or a browser that never fires the
    // event) must not leave the app stranded behind the splash. Armed only once
    // the page is actually on screen — index.html holds the sequence until
    // then (prerender/background-tab), and a backstop counting through that
    // hold would dismiss the splash before anyone saw it.
    const armBackstop = () => window.setTimeout(dismiss, 4000)
    const doc = document as Document & { prerendering?: boolean }
    if (!doc.prerendering && doc.visibilityState === 'visible') {
      armBackstop()
    } else {
      const onShown = () => {
        if (doc.prerendering || doc.visibilityState !== 'visible') return
        doc.removeEventListener('prerenderingchange', onShown)
        doc.removeEventListener('visibilitychange', onShown)
        armBackstop()
      }
      doc.addEventListener('prerenderingchange', onShown)
      doc.addEventListener('visibilitychange', onShown)
    }
  }
}
