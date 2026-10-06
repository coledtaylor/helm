/**
 * Draws the ship's-wheel icon and packs it into `build/icon.ico`.
 *
 * Run with `pnpm icon`. The .ico is committed, so this is not part of the
 * build - run it when the artwork changes and commit the result.
 *
 * ## Why it draws rather than renders a file
 *
 * There is no rasteriser on this machine to lean on. ImageMagick is not
 * installed, and on Windows `convert` resolves to the filesystem tool in
 * System32 rather than to ImageMagick even when it is. Electron carries a
 * browser engine and was the obvious candidate, but `capturePage()` fails with
 * `UnknownVizError` headlessly here, with or without hardware acceleration -
 * and an ESM main script deadlocks on `app.whenReady()` before reaching it, so
 * that route costs a CommonJS entry point as well. This script runs under plain
 * `node`, which is why it can stay ESM like the others in this directory.
 *
 * So the shapes are signed distance fields evaluated per pixel, which
 * anti-aliases better than a supersampled scanline fill and needs nothing
 * outside `node:zlib`.
 *
 * ## Why it is one drawing at every size
 *
 * A 16px icon downscaled from 256 turns to mush, and 16px is the size Windows
 * shows most often - the taskbar, the title bar, Explorer's list view. So every
 * size is drawn at its own resolution, with a floor of one device pixel on
 * every stroke so nothing thins out to nothing.
 *
 * It is the same drawing at each of them, though, and that is what the
 * proportions are for. A wheel at 16px is a rim, a hub and handles, and the
 * rim has to be most of it: the first version drew a small rim with long
 * knobbed handles, which at 256 is a fine ship's wheel and at 16 to 20 is a
 * snowflake, and the 2026-08 fix for that - four spokes below 24px - read as
 * a crosshair. A rim at two thirds of the radius, short round-capped handles
 * and a hollow hub stay a wheel from 16px up, so no size needs a drawing of
 * its own. `build/preview.png` shows 16 through 48 magnified, so this is a
 * thing that can be looked at rather than assumed.
 *
 * `HelmMarkIcon` (packages/ui) draws the same wheel as a vector, from the
 * same `wheel.json`. Its spokes are thinner than the rim and handles so the
 * hub's ring stays open between them; at the rim's weight they close it into
 * a blot.
 *
 * ## Why there is no tile behind it
 *
 * The wheel is the icon, on a transparent ground, as VS Code's mark is. It
 * used to sit on a navy rounded square, which on the taskbar read as a generic
 * app tile with a picture on it rather than as Helm. Without the tile the
 * wheel fills the icon, and it is drawn in the purple the title-bar mark
 * wears, so the window and the taskbar button show the same thing.
 * `build/preview.png` shows it on a dark and a light taskbar, since a
 * transparent icon is only ever seen on one of the two.
 *
 * When real artwork replaces this, none of the above applies - export a
 * 1024px PNG from a vector tool and use an icon generator. See the README of
 * this directory or ask; this file is a placeholder's scaffolding, not a
 * pipeline anyone should have to maintain.
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
// The wheel on the 16-unit grid `HelmMarkIcon` draws on: radii from the
// centre, widths across. One file for both, so the two cannot drift apart.
import WHEEL from '../../ui/src/components/wheel.json' with { type: 'json' }

const BUILD = join(dirname(fileURLToPath(import.meta.url)), '..', 'build')

/** 256 must be present - electron-builder rejects an icon without it. */
const SIZES = [16, 24, 32, 48, 64, 128, 256]

/**
 * Nocturne's `accent` (core/theme/themes.ts), the colour the title-bar mark is
 * drawn in out of the box. Fixed rather than following the theme: there is one
 * icon file for every user, and the taskbar is not themed by Helm.
 */
const PURPLE = [0x91, 0x84, 0xd9]

/**
 * The 16-unit box as a share of the icon: the handles' caps end 18px inside a
 * 256 icon's edge. The pixel snapping below was tuned at this share. At the
 * whole box, 24 and 32px land on the wrong side of a rounding - a two-pixel
 * spoke and a hub with no hole - and close up into a cross, and the 16px
 * handles run off the edge.
 */
const FILL = 0.92

// ---------------------------------------------------------------------------
// Signed distance fields. Negative inside, positive outside, in pixels.
// ---------------------------------------------------------------------------

const sdCircle = (px, py, cx, cy, r) => Math.hypot(px - cx, py - cy) - r

/** A line segment with round caps - the shape a round-capped stroke makes. */
function sdCapsule(px, py, ax, ay, bx, by, r) {
  const pax = px - ax
  const pay = py - ay
  const bax = bx - ax
  const bay = by - ay
  const denom = bax * bax + bay * bay
  const h = denom === 0 ? 0 : Math.max(0, Math.min(1, (pax * bax + pay * bay) / denom))
  return Math.hypot(pax - bax * h, pay - bay * h) - r
}

/**
 * Coverage from a distance, anti-aliased across one pixel.
 *
 * Clamped rather than smoothstepped: a linear ramp across the boundary keeps
 * thin strokes at their intended weight, where smoothstep visibly thins them.
 */
const coverage = (d) => Math.max(0, Math.min(1, 0.5 - d))

// ---------------------------------------------------------------------------
// The mark
// ---------------------------------------------------------------------------

function draw(size) {
  const px = new Uint8Array(size * size * 4)
  const unit = (size * FILL) / 16

  // Up to 48px the drawing is snapped to the pixel grid. Every width is a
  // whole number of pixels, the centre sits where the spokes' width needs it -
  // on a pixel's centre for an odd width, on the line between two for an even
  // one - and each ring's radius puts its line on whole pixels where it crosses
  // the axes. Unsnapped, a one-pixel upright spoke is two half-strength pixels
  // and a small wheel is a smudge. Half a pixel off centre is invisible; the
  // smudge is not.
  const snap = unit < 3
  /**
   * A width in pixels, never under `floor`. The rim and handles take a floor
   * of two: they are the outline, and the outline is what is left of a wheel
   * at 16px. At one pixel the diagonal handles are a single pixel each, lost
   * against the rim, and what is left is a crosshair in a circle.
   */
  const width = (w, floor = 1) => (snap ? Math.max(floor, Math.round(w * unit)) : Math.max(w * unit, floor))
  const spokeWidth = width(WHEEL.spokeWidth)
  const c = snap && Math.round(spokeWidth) % 2 === 1 ? size / 2 - 0.5 : size / 2
  const radius = (r, w) => {
    if (!snap) return r * unit
    // Where the ring's line should fall: a pixel's centre for an odd width,
    // the line between two for an even one.
    const target = w % 2 === 1 ? 0.5 : 0
    return Math.round(c + r * unit - target) + target - c
  }

  const rimWidth = width(WHEEL.rimWidth, 2)
  const hubWidth = width(WHEEL.hubWidth)
  const rimR = radius(WHEEL.rim, rimWidth)
  const hubR = radius(WHEEL.hub, hubWidth)
  const rimHalf = rimWidth / 2
  const hubHalf = hubWidth / 2
  const spokeHalf = spokeWidth / 2
  const handleHalf = width(WHEEL.handleWidth, 2) / 2

  // Eight spokes need room between them inside the rim, or the diagonals and
  // the rim close into four solid corners - which is the 16px wheel. Where the
  // clear space between two spokes halfway out is under two pixels, only the
  // upright and level spokes are drawn inside; all eight handles still are,
  // and they are what say "wheel" from outside.
  const gap = (2 * Math.PI * ((hubR + rimR) / 2)) / 8 - spokeWidth
  const inner = gap < 2 ? 4 : 8

  // Each spoke runs from the hub's ring to the rim, and its handle on from the
  // rim to a round cap - two widths, so they are two capsules.
  const spokes = Array.from({ length: 8 }, (_, n) => {
    const a = (n * 2 * Math.PI) / 8
    const at = (r) => [c + r * Math.cos(a), c + r * Math.sin(a)]
    return { inside: inner === 8 || n % 2 === 0, hub: at(hubR), rim: at(rimR), end: at(WHEEL.handleEnd * unit) }
  })

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = x + 0.5
      const cy = y + 0.5

      let ink = 0
      for (const { inside, hub, rim, end } of spokes) {
        if (inside) ink = Math.max(ink, coverage(sdCapsule(cx, cy, hub[0], hub[1], rim[0], rim[1], spokeHalf)))
        ink = Math.max(ink, coverage(sdCapsule(cx, cy, rim[0], rim[1], end[0], end[1], handleHalf)))
      }
      // A ring is the circle's distance folded about its own edge.
      ink = Math.max(ink, coverage(Math.abs(sdCircle(cx, cy, c, c, rimR)) - rimHalf))
      ink = Math.max(ink, coverage(Math.abs(sdCircle(cx, cy, c, c, hubR)) - hubHalf))

      // One colour on a transparent ground: the coverage is the alpha.
      const i = (y * size + x) * 4
      px.set(PURPLE, i)
      px[i + 3] = Math.round(ink * 255)
    }
  }

  return px
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

function encodePng(px, width, height = width) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr.writeUInt8(8, 8) // bit depth
  ihdr.writeUInt8(6, 9) // truecolour with alpha
  ihdr.writeUInt8(0, 10)
  ihdr.writeUInt8(0, 11)
  ihdr.writeUInt8(0, 12)

  // One filter byte per scanline; filter 0 (None) compresses fine at this size.
  const stride = width * 4
  const raw = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y++) {
    const at = y * (stride + 1)
    raw[at] = 0
    Buffer.from(px.buffer, px.byteOffset + y * stride, stride).copy(raw, at + 1)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// ---------------------------------------------------------------------------
// ICO: a 6-byte header, a 16-byte entry per image, then the payloads.
// Entries carry PNG rather than BMP, which every Windows since Vista reads.
// ---------------------------------------------------------------------------

function buildIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)

  const dir = Buffer.alloc(16 * entries.length)
  let offset = 6 + 16 * entries.length
  entries.forEach(({ size, png }, i) => {
    const at = i * 16
    // 256 is written as 0: the field is one byte and 256 does not fit in it.
    dir.writeUInt8(size >= 256 ? 0 : size, at)
    dir.writeUInt8(size >= 256 ? 0 : size, at + 1)
    dir.writeUInt8(0, at + 2)
    dir.writeUInt8(0, at + 3)
    dir.writeUInt16LE(1, at + 4)
    dir.writeUInt16LE(32, at + 6)
    dir.writeUInt32LE(png.length, at + 8)
    dir.writeUInt32LE(offset, at + 12)
    offset += png.length
  })

  return Buffer.concat([header, dir, ...entries.map((e) => e.png)])
}

const entries = SIZES.map((size) => {
  const png = encodePng(draw(size), size)
  writeFileSync(join(BUILD, `icon-${String(size)}.png`), png)
  process.stdout.write(`  ${String(size).padStart(3)}px  ${String(png.length).padStart(6)} bytes\n`)
  return { size, png }
})

/**
 * The small sizes, nearest-neighbour magnified, on a dark taskbar and a light
 * one.
 *
 * Not shipped - it exists so the sizes that actually get looked at can be
 * looked at. Judging a 16px icon by opening the 256px one is how the small
 * version ended up reading as a flower, and an icon with no ground of its own
 * has to hold up on both of the grounds Windows puts under it.
 */
function writePreview() {
  const shown = [16, 24, 32, 48]
  // Windows 11's taskbar, dark and light.
  const grounds = [
    [0x20, 0x20, 0x20],
    [0xf3, 0xf3, 0xf3]
  ]
  const zoom = 8
  const pad = 12
  const cell = 48 * zoom
  const w = shown.length * cell + (shown.length + 1) * pad
  const h = grounds.length * cell + (grounds.length + 1) * pad
  const out = new Uint8Array(w * h * 4)

  grounds.forEach((ground, row) => {
    const top = row * (cell + pad)
    for (let y = top; y < top + cell + 2 * pad; y++) {
      for (let x = 0; x < w; x++) out.set([...ground, 0xff], (y * w + x) * 4)
    }
    shown.forEach((size, n) => {
      const src = draw(size)
      const scale = (48 * zoom) / size
      const ox = pad + n * (cell + pad)
      const oy = top + pad
      for (let y = 0; y < cell; y++) {
        for (let x = 0; x < cell; x++) {
          const sx = Math.min(size - 1, Math.floor(x / scale))
          const sy = Math.min(size - 1, Math.floor(y / scale))
          const si = (sy * size + sx) * 4
          const di = ((oy + y) * w + (ox + x)) * 4
          const alpha = src[si + 3] / 255
          for (let ch = 0; ch < 3; ch++) {
            out[di + ch] = Math.round(src[si + ch] * alpha + ground[ch] * (1 - alpha))
          }
        }
      }
    })
  })

  writeFileSync(join(BUILD, 'preview.png'), encodePng(out, w, h))
}

writeFileSync(join(BUILD, 'icon.ico'), buildIco(entries))
writePreview()
// electron-builder's Linux target and the runtime window icon both want a PNG.
writeFileSync(join(BUILD, 'icon.png'), entries[entries.length - 1].png)
process.stdout.write(`icon.ico written with ${String(entries.length)} sizes\n`)
