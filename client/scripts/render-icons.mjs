// One-off: renders public/logo.svg to the PWA PNG icons. Run: node scripts/render-icons.mjs
import sharp from "sharp"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

const pub = (f) => fileURLToPath(new URL(`../public/${f}`, import.meta.url))
const logo = (await readFile(pub("logo.svg"))).toString()

// The mark itself is a bare teal glyph; app icons need a plate, so recolor the
// glyph white and drop it on a brand-teal tile. `rx=0` for maskable/apple —
// the OS rounds those corners itself and the glyph sits inside the safe zone.
const white = logo.replaceAll("#007595", "#ffffff")
const onTeal = (rx) =>
  Buffer.from(white.replace(/(<svg[^>]*>)/, `$1<rect width="64" height="64" rx="${rx}" fill="#007595"/>`))

for (const [src, name, size] of [
  [onTeal(14), "icon-192.png", 192],
  [onTeal(14), "icon-512.png", 512],
  [onTeal(0), "icon-512-maskable.png", 512],
  [onTeal(0), "apple-touch-icon.png", 180],
]) {
  await sharp(src, { density: (72 * size) / 64 }).resize(size, size).png().toFile(pub(name))
  console.log("wrote", name)
}
