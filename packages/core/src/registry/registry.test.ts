import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  joinSessionRegistry,
  newClaudeSessionId,
  parseRegistryRecord,
  readSessionRegistry,
  sessionRegistryDir,
  type RegistryWorld
} from './registry'
import type { SessionRegistryEntry } from '../types'

/**
 * A record verbatim from the measurement, so the fixtures in this file are the
 * shape the CLI actually writes rather than the shape this parser expects.
 *
 * Taken on **2.1.238**, from a session driven into each status while the
 * directory was polled every 150ms. The `waiting` ones are the two that were
 * provoked deliberately: a slash command that renders a UI, and a Write tool
 * call in a session whose permission mode is `manual`.
 */
const MEASURED = {
  registering:
    '{"pid":28160,"sessionId":"e9227e28-600c-43a5-a28b-b27d4a1aae30","cwd":"C:\\\\probe","startedAt":1787270375972,"procStart":"134317439745798131","version":"2.1.238","peerProtocol":1,"peerFeatures":["notify_idle"],"kind":"interactive","entrypoint":"cli","name":"registry-probe","nameSince":1787270375975,"updatedAt":1787270375975}',
  idle: '{"pid":28160,"sessionId":"e9227e28-600c-43a5-a28b-b27d4a1aae30","cwd":"C:\\\\probe","startedAt":1787270375972,"procStart":"134317439745798131","version":"2.1.238","kind":"interactive","entrypoint":"cli","name":"registry-probe","updatedAt":1787270376185,"status":"idle","statusUpdatedAt":1787270376185}',
  busy: '{"pid":28160,"sessionId":"e9227e28-600c-43a5-a28b-b27d4a1aae30","cwd":"C:\\\\probe","startedAt":1787270375972,"procStart":"134317439745798131","version":"2.1.238","kind":"interactive","entrypoint":"cli","name":"registry-probe","updatedAt":1787270381870,"status":"busy","statusUpdatedAt":1787270381870}',
  dialog:
    '{"pid":28160,"sessionId":"e9227e28-600c-43a5-a28b-b27d4a1aae30","cwd":"C:\\\\probe","startedAt":1787270375972,"procStart":"134317439745798131","version":"2.1.238","kind":"interactive","entrypoint":"cli","name":"registry-probe","updatedAt":1787270379404,"status":"waiting","statusUpdatedAt":1787270379404,"waitingFor":"dialog open"}',
  permission:
    '{"pid":28160,"sessionId":"e9227e28-600c-43a5-a28b-b27d4a1aae30","cwd":"C:\\\\probe","startedAt":1787270375972,"procStart":"134317439745798131","version":"2.1.238","kind":"interactive","entrypoint":"cli","name":"registry-probe","updatedAt":1787270385104,"status":"waiting","statusUpdatedAt":1787270385104,"waitingFor":"permission prompt"}',
  shell:
    '{"pid":28160,"sessionId":"e9227e28-600c-43a5-a28b-b27d4a1aae30","cwd":"C:\\\\probe","startedAt":1787270375972,"procStart":"134317439745798131","version":"2.1.238","kind":"interactive","entrypoint":"cli","name":"registry-probe","updatedAt":1787270392657,"status":"shell","statusUpdatedAt":1787270392657}'
}

const dirs: string[] = []
function tempRegistry(files: Record<string, string>): string {
  const home = mkdtempSync(join(tmpdir(), 'helm-registry-'))
  dirs.push(home)
  const dir = sessionRegistryDir(home)
  mkdirSync(dir, { recursive: true })
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
  return dir
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

/** Everything alive, and this machine booted a long time ago. */
const allAlive: RegistryWorld = { probe: () => 'alive', bootAtMs: 0 }

describe('parseRegistryRecord', () => {
  it('reads every status the CLI publishes, from records it actually wrote', () => {
    expect(parseRegistryRecord('a.json', MEASURED.idle)?.activity).toBe('idle')
    expect(parseRegistryRecord('a.json', MEASURED.busy)?.activity).toBe('busy')
    expect(parseRegistryRecord('a.json', MEASURED.shell)?.activity).toBe('shell')
    expect(parseRegistryRecord('a.json', MEASURED.dialog)?.activity).toBe('waiting')
    expect(parseRegistryRecord('a.json', MEASURED.permission)?.activity).toBe('waiting')
  })

  it('carries waitingFor verbatim rather than interpreting it', () => {
    expect(parseRegistryRecord('a.json', MEASURED.dialog)?.waitingFor).toBe('dialog open')
    expect(parseRegistryRecord('a.json', MEASURED.permission)?.waitingFor).toBe('permission prompt')
    expect(parseRegistryRecord('a.json', MEASURED.busy)?.waitingFor).toBeNull()
  })

  it('accepts the first record of a session, which carries no status at all', () => {
    // Measured: the file is written when the process registers, and the field
    // arrives when the interactive loop publishes one. This must be a usable
    // record with nothing to say, not a parse failure.
    const entry = parseRegistryRecord('a.json', MEASURED.registering)
    expect(entry).not.toBeNull()
    expect(entry?.activity).toBeNull()
    expect(entry?.rawStatus).toBeNull()
    expect(entry?.pid).toBe(28160)
    expect(entry?.sessionId).toBe('e9227e28-600c-43a5-a28b-b27d4a1aae30')
  })

  it('carries an unrecognised status as unknown rather than coercing it', () => {
    const entry = parseRegistryRecord('a.json', '{"pid":7,"status":"thinking"}')
    // Both halves matter: `activity` is null so nothing paints a guess, and
    // `rawStatus` keeps what was said so a diagnostic can report it.
    expect(entry?.activity).toBeNull()
    expect(entry?.rawStatus).toBe('thinking')
  })

  it('skips a record with no usable pid, and nothing else', () => {
    expect(parseRegistryRecord('a.json', '{"status":"busy"}')).toBeNull()
    expect(parseRegistryRecord('a.json', '{"pid":"28160","status":"busy"}')).toBeNull()
    expect(parseRegistryRecord('a.json', '{"pid":0}')).toBeNull()
    expect(parseRegistryRecord('a.json', '{"pid":7}')).not.toBeNull()
  })

  it('degrades a field of the wrong type to null instead of throwing', () => {
    const entry = parseRegistryRecord(
      'a.json',
      '{"pid":7,"status":42,"cwd":null,"sessionId":[],"startedAt":"soon","procStart":{}}'
    )
    expect(entry).not.toBeNull()
    expect(entry?.rawStatus).toBeNull()
    expect(entry?.cwd).toBeNull()
    expect(entry?.sessionId).toBeNull()
    expect(entry?.startedAt).toBeNull()
    expect(entry?.procStart).toBeNull()
  })

  it('refuses text that is not an object', () => {
    expect(parseRegistryRecord('a.json', 'not json at all')).toBeNull()
    expect(parseRegistryRecord('a.json', '[]')).toBeNull()
    expect(parseRegistryRecord('a.json', 'null')).toBeNull()
    expect(parseRegistryRecord('a.json', '"a string"')).toBeNull()
  })
})

describe('readSessionRegistry', () => {
  it('answers empty for a directory that is not there', () => {
    expect(readSessionRegistry(join(tmpdir(), 'helm-no-such-registry-dir'), allAlive)).toEqual([])
  })

  it('skips an unusable file rather than failing the pass', () => {
    // The CLI writes these without locking, so a read landing mid-write is an
    // ordinary event. It must cost one record, never the poll.
    const dir = tempRegistry({
      '1.json': MEASURED.busy,
      '2.json': '{"pid":29,"status":"idl',
      '3.json': 'not json',
      'notes.txt': 'ignored - not a .json'
    })
    const entries = readSessionRegistry(dir, allAlive)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.activity).toBe('busy')
  })

  it('drops a record whose process cannot be proved alive', () => {
    const dir = tempRegistry({ '1.json': MEASURED.busy })
    // A hard kill leaves the file behind, still claiming `busy`. Painting that
    // is the failure this filter exists for.
    expect(readSessionRegistry(dir, { probe: () => 'gone', bootAtMs: 0 })).toEqual([])
  })

  it('drops a record the probe cannot answer about', () => {
    // The **opposite** of `cleanStaleShims`, deliberately. There, `unknown`
    // means leave the directory alone because deleting live plugins is
    // unrecoverable. Here nothing is deleted and the unrecoverable outcome is
    // telling somebody their agent is working when it died.
    const dir = tempRegistry({ '1.json': MEASURED.busy })
    expect(readSessionRegistry(dir, { probe: () => 'unknown', bootAtMs: 0 })).toEqual([])
  })

  it('keeps a record whose process answers EPERM', () => {
    // `probeProcess` maps EPERM to `alive`: the process exists and belongs to
    // somebody this one may not signal. A session started by another account is
    // still a session.
    const dir = tempRegistry({ '1.json': MEASURED.busy })
    expect(readSessionRegistry(dir, allAlive)).toHaveLength(1)
  })

  it('drops a record claimed before this boot however the pid probes', () => {
    // Pids do not survive a restart, so that number now belongs to somebody
    // else or to nobody - and the probe would happily say `alive` about the
    // stranger holding it.
    const dir = tempRegistry({ '1.json': MEASURED.busy })
    const afterTheClaim = 1787270375972 + 1
    expect(readSessionRegistry(dir, { probe: () => 'alive', bootAtMs: afterTheClaim })).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The join
// ---------------------------------------------------------------------------

function entry(over: Partial<SessionRegistryEntry>): SessionRegistryEntry {
  return {
    file: '1.json',
    pid: 1,
    procStart: null,
    sessionId: null,
    cwd: null,
    name: null,
    version: null,
    entrypoint: null,
    startedAt: null,
    activity: null,
    rawStatus: null,
    waitingFor: null,
    statusUpdatedAt: null,
    ...over
  }
}

describe('joinSessionRegistry', () => {
  const mine = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'

  it('finds a session by the conversation id Helm assigned', () => {
    const entries = [entry({ pid: 10, sessionId: 'someone-else' }), entry({ pid: 11, sessionId: mine })]
    const found = joinSessionRegistry(entries, {
      claudeSessionId: mine,
      ptyPid: 999,
      pinned: null
    })
    expect(found?.pid).toBe(11)
  })

  it('finds a session by the pty pid where there is no assigned id', () => {
    // The only route open to a CLI with no `--session-id` flag, and correct for
    // a direct spawn - which is what such a CLI's users have.
    const entries = [entry({ pid: 10 }), entry({ pid: 11 })]
    const found = joinSessionRegistry(entries, {
      claudeSessionId: null,
      ptyPid: 11,
      pinned: null
    })
    expect(found?.pid).toBe(11)
  })

  it('joins through a .cmd shim, where the pty pid is not the CLI pid', () => {
    // Measured: pty 23496 was `cmd.exe`, and `claude.exe` registered as 4068.
    // The assigned id is the only thing that connects the two.
    const entries = [entry({ pid: 4068, sessionId: mine })]
    const found = joinSessionRegistry(entries, {
      claudeSessionId: mine,
      ptyPid: 23496,
      pinned: null
    })
    expect(found?.pid).toBe(4068)
  })

  it('follows the process after a /clear has changed the conversation id', () => {
    // Measured on 2.1.238: `/clear` re-registers the same process under a new
    // sessionId with the pid and procStart unchanged. A join that only knew the
    // id would lose the session at exactly the moment somebody cleared it.
    const entries = [entry({ pid: 4068, procStart: '1343174', sessionId: 'a-different-one' })]
    const found = joinSessionRegistry(entries, {
      claudeSessionId: mine,
      ptyPid: 23496,
      pinned: { pid: 4068, procStart: '1343174' }
    })
    expect(found?.sessionId).toBe('a-different-one')
  })

  it('refuses a reused pid whose procStart disagrees', () => {
    // Claude Code's own registry sweep does not compare procStart and is
    // therefore blind to this. A reader joining on pid should not be.
    const entries = [entry({ pid: 4068, procStart: 'a-later-process' })]
    const found = joinSessionRegistry(entries, {
      claudeSessionId: mine,
      ptyPid: null,
      pinned: { pid: 4068, procStart: '1343174' }
    })
    expect(found).toBeNull()
  })

  it('answers null rather than guessing when nothing matches', () => {
    expect(
      joinSessionRegistry([entry({ pid: 10, sessionId: 'other' })], {
        claudeSessionId: mine,
        ptyPid: 11,
        pinned: null
      })
    ).toBeNull()
    expect(
      joinSessionRegistry([], { claudeSessionId: null, ptyPid: null, pinned: null })
    ).toBeNull()
  })
})

describe('newClaudeSessionId', () => {
  it('is a fresh uuid every time', () => {
    // Never reused, because the CLI refuses a uuid that already exists:
    // `Error: Session ID <uuid> is already in use.` and exit 1, measured on
    // 2.1.238. Two launches sharing one would be a launch that fails.
    const ids = new Set(Array.from({ length: 64 }, () => newClaudeSessionId()))
    expect(ids.size).toBe(64)
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    }
  })
})
