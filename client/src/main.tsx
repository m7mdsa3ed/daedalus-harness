import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
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
    const intro = (window as { __bootIntro?: Promise<void> }).__bootIntro
    void (intro ?? Promise.resolve()).then(dismiss)
    // Backstop: a throttled background tab (or a browser that never fires the
    // event) must not leave the app stranded behind the splash.
    window.setTimeout(dismiss, 4000)
  }
}
