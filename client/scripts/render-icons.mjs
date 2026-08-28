// One-off: regenerates every rasterised icon (Electron + PWA) from
// build/icon.svg — a single SVG that's the mark on a slate tile. Run:
// `node scripts/render-icons.mjs` (also wired as `pnpm icons`).
//
// Why both Electron and the PWA come from the same file: the icon lives in
// three places (taskbar/dock, browser tab, installed PWA) and they have to
// match. They differ only in shape: Windows .ico needs several square
// bitmaps packed together, the PWA wants 192/512 plus a maskable variant
// with a safe-zone tile, and Apple wants its 180×180 touch icon.
//
// ImageMagick's bundled SVG renderer drops the strokes here (only the
// tile colour survives), so the SVG goes through sharp/librsvg — that's
// the only path that produces a faithful raster. The final .ico for
// Windows is built from those PNGs with `magick`, which handles raster
// packaging correctly.
import sharp from "sharp"
import { execFileSync } from "node:child_process"
import { readFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { mkdtemp, rm } from "node:fs/promises"

const here = (f) => fileURLToPath(new URL(`../${f}`, import.meta.url))
const pub = (f) => fileURLToPath(new URL(`../public/${f}`, import.meta.url))

const ICON_SVG = here("build/icon.svg")
const PNG_OUT = here("build/icon.png")
const ICO_OUT = here("build/icon.ico")

const PWA = [
  ["icon-192.png", 192, { rx: 14 }],
  ["icon-512.png", 512, { rx: 14 }],
  ["icon-512-maskable.png", 512, { rx: 0 }],
  ["apple-touch-icon.png", 180, { rx: 0 }],
]

// The Android status-bar glyph (NotificationOptions.badge) must be monochrome —
// white on transparent — or Android renders nothing (a white square at best).
// That is just the mark, no tile, so drop the rect and keep the white strokes.
const BADGE = ["icon-badge.png", 96]

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
const DENSITY = 384

const svgString = (await readFile(ICON_SVG)).toString()
const badgeSvg = svgString.replace(/<rect[^>]*\/>/, "")
const isMaskable = (rx) => rx === 0
// Maskable / Apple: the OS clips the tile to its own shape, so any
// rounded corners here would vanish — drop the SVG's rounded rect and
// draw a flat tile for the platform to mask.
const tileSvg = (rx) =>
  isMaskable(rx)
    ? svgString.replace(/<rect[^>]*fill="#0f172a"[^>]*\/>/, `<rect width="64" height="64" fill="#0f172a"/>`)
    : svgString

// build/icon.png — the 1024 master. electron-builder reads this for mac/linux
// and dev-mode Electron loads it via the path in main.cjs.
const master = await sharp(Buffer.from(svgString), { density: DENSITY })
  .resize(1024, 1024, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png()
  .toBuffer()
await writeFile(PNG_OUT, master)
console.log("wrote", PNG_OUT)

for (const [name, size, opts] of PWA) {
  const buf = await sharp(Buffer.from(tileSvg(opts.rx)), { density: DENSITY })
    .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer()
  await writeFile(pub(name), buf)
  console.log("wrote", pub(name))
}

// Monochrome badge: white mark on transparency, no tile.
const badgeBuf = await sharp(Buffer.from(badgeSvg), { density: DENSITY })
  .resize(BADGE[1], BADGE[1], { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png()
  .toBuffer()
await writeFile(pub(BADGE[0]), badgeBuf)
console.log("wrote", pub(BADGE[0]))

// .ico = a folder of bitmaps. Render each size from the master, then let
// ImageMagick pack them — that's its one job here and it does it fine.
const tmpDir = await mkdtemp("/tmp/daedalus-icons-")
const tmpFiles = await Promise.all(
  ICO_SIZES.map(async (s) => {
    const p = `${tmpDir}/${s}.png`
    const buf = await sharp(master)
      .resize(s, s, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer()
    await writeFile(p, buf)
    return p
  }),
)
execFileSync("magick", [...tmpFiles, ICO_OUT])
await rm(tmpDir, { recursive: true, force: true })
console.log("wrote", ICO_OUT)
