/**
 * Draws the placeholder ship's-wheel icon and packs it into `build/icon.ico`.
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
 * ## Why each size is drawn rather than downscaled
 *
 * A 16px icon downscaled from 256 turns to mush, and 16px is the size Windows
 * shows most often - the taskbar, the title bar, Explorer's list view. Every
 * size is drawn at its own resolution, and the strokes have a floor in device
 * pixels so they cannot thin out to nothing: at 16px the wheel's spokes would
 * otherwise be four tenths of a pixel wide.
 *
 * Below 32px the spokes are dropped entirely. Eight of them inside a 16px
 * circle is noise, not detail, and the mark reads better as a rim with handles.
 * This is the ordinary practice of drawing small sizes as their own artwork.
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

const BUILD = join(dirname(fileURLToPath(import.meta.url)), '..', 'build')

/** 256 must be present - electron-builder rejects an icon without it. */
const SIZES = [16, 24, 32, 48, 64, 128, 256]

const NAVY = [0x0f, 0x18, 0x26]
const BRASS = [0xe3, 0xa9, 0x4c]
const BRASS_DARK = [0xb9, 0x82, 0x2f]

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

function sdRoundedRect(px, py, w, h, r) {
  const qx = Math.abs(px - w / 2) - (w / 2 - r)
  const qy = Math.abs(py - h / 2) - (h / 2 - r)
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r
}

/**
 * Coverage from a distance, anti-aliased across one pixel.
 *
 * Clamped rather than smoothstepped: a linear ramp across the boundary keeps
 * thin strokes at their intended weight, where smoothstep visibly thins them.
 */
const coverage = (d) => Math.max(0, Math.min(1, 0.5 - d))

/** Source-over, with both sides straight (non-premultiplied) alpha. */
function over(dst, i, rgb, a) {
  if (a <= 0) return
  const da = dst[i + 3] / 255
  const outA = a + da * (1 - a)
  if (outA <= 0) return
  for (let c = 0; c < 3; c++) {
    dst[i + c] = Math.round((rgb[c] * a + dst[i + c] * da * (1 - a)) / outA)
  }
  dst[i + 3] = Math.round(outA * 255)
}

// ---------------------------------------------------------------------------
// The mark
// ---------------------------------------------------------------------------

function draw(size) {
  const s = size / 256
  const px = new Uint8Array(size * size * 4)

  // Stroke weights carry a floor in device pixels so the small sizes survive.
  const detailed = size >= 32
  const corner = 56 * s
  const rimR = 62 * s
  const rimHalf = Math.max(8 * s, 1.15)
  const spokeHalf = Math.max(6.5 * s, 1.0)
  const spokeLen = 101 * s
  const knobR = Math.max(13 * s, size >= 32 ? 1.8 : 2.0)
  const hubR = detailed ? Math.max(21 * s, 2.6) : Math.max(14 * s, 1.9)
  const hubDarkR = 8 * s

  const c = size / 2
  const spokes = []
  const knobs = []
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4
    const ex = c + spokeLen * Math.cos(a)
    const ey = c + spokeLen * Math.sin(a)
    spokes.push([ex, ey])
    knobs.push([ex, ey])
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      const cx = x + 0.5
      const cy = y + 0.5

      over(px, i, NAVY, coverage(sdRoundedRect(cx, cy, size, size, corner)))

      let brass = 0
      if (detailed) {
        for (const [ex, ey] of spokes) {
          brass = Math.max(brass, coverage(sdCapsule(cx, cy, c, c, ex, ey, spokeHalf)))
        }
      }
      for (const [kx, ky] of knobs) {
        brass = Math.max(brass, coverage(sdCircle(cx, cy, kx, ky, knobR)))
      }
      // A ring is the circle's distance folded about its own edge.
      brass = Math.max(brass, coverage(Math.abs(sdCircle(cx, cy, c, c, rimR)) - rimHalf))
      brass = Math.max(brass, coverage(sdCircle(cx, cy, c, c, hubR)))
      over(px, i, BRASS, brass)

      if (detailed) {
        over(px, i, BRASS_DARK, coverage(sdCircle(cx, cy, c, c, hubDarkR)))
      }
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

function encodePng(px, size) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr.writeUInt8(8, 8) // bit depth
  ihdr.writeUInt8(6, 9) // truecolour with alpha
  ihdr.writeUInt8(0, 10)
  ihdr.writeUInt8(0, 11)
  ihdr.writeUInt8(0, 12)

  // One filter byte per scanline; filter 0 (None) compresses fine at this size.
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    const at = y * (size * 4 + 1)
    raw[at] = 0
    Buffer.from(px.buffer, px.byteOffset + y * size * 4, size * 4).copy(raw, at + 1)
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

writeFileSync(join(BUILD, 'icon.ico'), buildIco(entries))
// electron-builder's Linux target and the runtime window icon both want a PNG.
writeFileSync(join(BUILD, 'icon.png'), entries[entries.length - 1].png)
process.stdout.write(`icon.ico written with ${String(entries.length)} sizes\n`)
