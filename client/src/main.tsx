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
// parses). Min hold keeps the mark from flash-cutting on a fast load.
{
  const splash = document.getElementById('boot-splash')
  if (splash) {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const wait = reduced ? 0 : Math.max(0, 500 - performance.now())
    window.setTimeout(() => {
      splash.classList.add('is-leaving')
      window.setTimeout(() => splash.remove(), 300)
    }, wait)
  }
}
