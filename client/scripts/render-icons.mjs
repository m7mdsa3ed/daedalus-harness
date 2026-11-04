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

// ── iOS launch images ──
// An installed iOS app opens on a flat frame of `background_color` until the
// page paints; `apple-touch-startup-image` is the one way to put the mark on
// it, and iOS wants one PNG per device size and orientation, matched by a
// media query, with no scaling. Light and dark each, because the boot splash
// in index.html is one colour per scheme and the launch frame should be the
// same colour, not a white flash before a dark app. The list is the logical
// size and scale of each device class; the raster is the product.
//
// vite.config.ts injects the <link> tags from the JSON written here, so
// index.html carries none of the 70-odd lines, and the images stay out of the
// service worker's precache (`globIgnores`) — iOS fetches them once when the
// app is added to the home screen and keeps them itself.
import { BOOT_COLORS } from "../src/lib/boot-colors.ts"

const SPLASH_DIR = "splash"
const DEVICES = [
  // [logical width, logical height, scale], portrait
  [440, 956, 3],  // iPhone 16 Pro Max
  [430, 932, 3],  // iPhone 14 Pro Max, 15 Plus/Pro Max, 16 Plus
  [402, 874, 3],  // iPhone 16 Pro
  [393, 852, 3],  // iPhone 14 Pro, 15, 15 Pro, 16
  [428, 926, 3],  // iPhone 12/13 Pro Max, 14 Plus
  [390, 844, 3],  // iPhone 12, 13, 14
  [375, 812, 3],  // iPhone X, XS, 11 Pro, 12/13 mini
  [414, 896, 3],  // iPhone XS Max, 11 Pro Max
  [414, 896, 2],  // iPhone XR, 11
  [414, 736, 3],  // iPhone 6/7/8 Plus
  [375, 667, 2],  // iPhone 6/7/8, SE 2/3
  [1032, 1376, 2], // iPad Pro 13" (M4)
  [1024, 1366, 2], // iPad Pro 12.9"
  [834, 1194, 2],  // iPad Pro 11"
  [820, 1180, 2],  // iPad Air 10.9", iPad 10th gen
  [810, 1080, 2],  // iPad 10.2"
  [768, 1024, 2],  // iPad 9.7", iPad mini 5
  [744, 1133, 2],  // iPad mini 6
]
const SCHEMES = [
  ["light", BOOT_COLORS.light, "#0f172a"],
  ["dark", BOOT_COLORS.dark, "#f8fafc"],
]
// The same three paths as /logo.svg and the inlined boot splash, drawn at the
// boot splash's own weight; the ring is a fifth of the short side, which puts
// it at about the size the HTML splash then animates over it.
const markSvg = (w, h, bg, fg) => {
  const size = Math.round(Math.min(w, h) * 0.2)
  const x = (w - size) / 2
  const y = (h - size) / 2
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <rect width="${w}" height="${h}" fill="${bg}"/>
  <g transform="translate(${x} ${y}) scale(${size / 64})" fill="none" stroke="${fg}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M38 8H46A10 10 0 0 1 56 18V46A10 10 0 0 1 46 56H18A10 10 0 0 1 8 46V18A10 10 0 0 1 18 8H26"/>
    <path d="M28 45H25A6 6 0 0 1 19 39V25A6 6 0 0 1 25 19H39A6 6 0 0 1 45 25V39A6 6 0 0 1 39 45H36"/>
    <path d="M32 31V33"/>
  </g>
</svg>`
}

const links = []
for (const [lw, lh, scale] of DEVICES) {
  for (const orientation of ["portrait", "landscape"]) {
    const [w, h] = orientation === "portrait" ? [lw * scale, lh * scale] : [lh * scale, lw * scale]
    for (const [scheme, bg, fg] of SCHEMES) {
      const name = `${SPLASH_DIR}/${lw}x${lh}-${scale}x-${orientation}-${scheme}.png`
      const buf = await sharp(Buffer.from(markSvg(w, h, bg, fg))).png({ palette: true }).toBuffer()
      await writeFile(pub(name), buf)
      links.push({
        href: `/${name}`,
        media:
          `screen and (device-width: ${lw}px) and (device-height: ${lh}px) ` +
          `and (-webkit-device-pixel-ratio: ${scale}) and (orientation: ${orientation}) ` +
          `and (prefers-color-scheme: ${scheme})`,
      })
    }
  }
}
await writeFile(here("src/lib/splash-images.json"), JSON.stringify(links, null, 2) + "\n")
console.log("wrote", links.length, "launch images")
