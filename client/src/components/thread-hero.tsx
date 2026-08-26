import * as React from "react"
import { ShaderBackground } from "@/components/ui/shader-background"
import { useTheme } from "@/lib/theme"

/** Must match the opacity transition in styles/thread-hero.css. */
const FADE_MS = 320

/* The ramp the shader mixes through, darkest first. Tokens, not literals: a
   palette from the theme builder is the same token set as a built-in one, so
   this follows whatever the user is looking at rather than shipping one
   hardcoded scheme that fights every theme but the one it was drawn for. */
const HERO_TOKENS = ["--background", "--muted", "--primary", "--accent"]

/**
 * Resolve CSS custom properties to sRGB triplets the shader can take.
 *
 * The tokens are `oklch()`, which no string parse handles honestly, so the
 * browser does the conversion: a probe element inherits the token, and a 1×1
 * canvas paints the computed value and reads the bytes back. Anything the
 * browser cannot resolve is skipped rather than guessed at.
 */
function readThemeColors(): [number, number, number][] {
  const probe = document.createElement("span")
  probe.style.cssText = "position:fixed;width:0;height:0;opacity:0;pointer-events:none"
  document.body.appendChild(probe)
  const canvas = document.createElement("canvas")
  canvas.width = 1
  canvas.height = 1
  const ctx = canvas.getContext("2d", { willReadFrequently: true })
  const colors: [number, number, number][] = []
  try {
    for (const token of HERO_TOKENS) {
      probe.style.color = ""
      probe.style.color = `var(${token})`
      const resolved = getComputedStyle(probe).color
      if (!resolved || !ctx) continue
      // Clear first: an unparseable fillStyle leaves the previous one in place,
      // which would silently repeat the last colour instead of skipping this one.
      ctx.clearRect(0, 0, 1, 1)
      ctx.fillStyle = "#000"
      ctx.fillStyle = resolved
      ctx.fillRect(0, 0, 1, 1)
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
      colors.push([r / 255, g / 255, b / 255])
    }
  } catch {
    // A tainted or unavailable 2D context costs the theme, not the background:
    // an empty result leaves the shader on its own defaults.
    return []
  } finally {
    probe.remove()
  }
  return colors
}

/**
 * The backdrop behind an empty thread.
 *
 * The canvas is mounted only while it is wanted: a WebGL context that nothing
 * is looking at should not exist, and this one would otherwise sit behind every
 * full transcript in the app burning frames. Two pieces of timing make that
 * invisible — mount a frame before fading in, because a transition needs a
 * starting opacity to move away from, and unmount a beat after fading out, so
 * the canvas does not vanish mid-fade.
 *
 * It is painted at the root of the shell, under the sidebar as well as the
 * header, so the whole window is one surface while a thread is empty. The
 * surfaces above it go translucent to let it through — see styles/thread-hero.css.
 */
export function ThreadHero({ visible }: { visible: boolean }) {
  const { resolved, colorTheme } = useTheme()
  const [mounted, setMounted] = React.useState(false)
  const [shown, setShown] = React.useState(false)

  // Re-read on every theme change, and once on mount. Reading during render
  // would measure the DOM mid-commit; this runs after the tokens have landed.
  const [colors, setColors] = React.useState<[number, number, number][]>([])
  React.useEffect(() => {
    if (!mounted) return
    setColors(readThemeColors())
  }, [mounted, resolved, colorTheme])

  React.useEffect(() => {
    if (visible) {
      setMounted(true)
      // Next frame, so the element exists at opacity 0 first and the browser
      // has something to transition from.
      const frame = requestAnimationFrame(() => setShown(true))
      return () => cancelAnimationFrame(frame)
    }
    setShown(false)
    const timer = setTimeout(() => setMounted(false), FADE_MS)
    return () => clearTimeout(timer)
  }, [visible])

  if (!mounted) return null

  return (
    <div aria-hidden className="thread-hero" data-visible={shown || undefined}>
      <ShaderBackground className="absolute inset-0" colors={colors} />
    </div>
  )
}
