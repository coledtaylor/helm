import { join, resolve } from 'node:path'

/**
 * What a host answers for a fixture, recorded once and kept beside the
 * tests that draw it (`fixtures/*.fixture.json`). The window renders what the
 * host sends and never computes it, so its tests start from an answer rather
 * than from a renderer of their own.
 *
 * Every path in a recording is written `<root>/a/b`, forward-slashed, so one
 * recording serves every OS: `recorded` puts each back as this OS writes a
 * path under `FIXTURE_ROOT`, wherever it appears, an HTML attribute included.
 * Nothing is read from or written to that folder; it need not exist.
 */
export const FIXTURE_ROOT = resolve('/helm-fixture')

const ROOTED = /<root>((?:\/[^"'<>\s)/]+)*)/g

function placed(text: string): string {
  return text.replace(ROOTED, (_match, rest: string) => join(FIXTURE_ROOT, ...rest.split('/').filter(Boolean)))
}

function walk(value: unknown): unknown {
  if (typeof value === 'string') return placed(value)
  if (Array.isArray(value)) return value.map(walk)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [placed(key), walk(inner)]))
  }
  return value
}

/** A recording, with its paths placed under `FIXTURE_ROOT`. */
export function recorded<T>(recording: unknown): T {
  return walk(recording) as T
}

/** `FIXTURE_ROOT` joined with forward-slashed `segments`, as a recording's paths are placed. */
export function fixturePath(...segments: string[]): string {
  return join(FIXTURE_ROOT, ...segments.flatMap((segment) => segment.split('/')).filter(Boolean))
}
