import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FakeConnection, fakeLink, reconnectingLink } from '../../../test/host-connection'
import { createHostFiles, hostArtifactUrl, windowArtifactUrl } from './files'
import type { HostLink } from './link'
import type * as P from './protocol'

const ROOT = resolve('/work dir/alpha')
const NOTE = resolve('/work dir/alpha/notes/a.md')
const PAGE = resolve('/work dir/alpha/pages/report.html')

const UNREACHABLE = 'No local host answered on its socket; turn off “Run sessions in the local host” in Settings.'

const HOST_URL = 'floti-artifact://tok123/report.html'
const WINDOW_URL = 'helm-content://artifact/tok123/report.html'

const encode = (text: string): Uint8Array => new TextEncoder().encode(text)
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

const written = (ok: boolean): P.WriteConfigResult =>
  ({
    ok,
    file: { path: NOTE, exists: true, content: 'x', hash: 'h2', mtimeMs: 0 },
    snapshotId: ok ? 7 : null,
    unchanged: false,
    conflict: null,
    error: ok ? null : 'refused'
  }) as unknown as P.WriteConfigResult

/** The host's answer for an artifact's bytes, served `size` bytes at a time. */
function servePieces(body: string, size: number) {
  const bytes = encode(body)
  return ({ offset }: P.ArtifactBytesRequest): P.ArtifactBytes => ({
    status: 200,
    headers: [
      { name: 'content-type', value: 'text/html; charset=utf-8' },
      { name: 'content-security-policy', value: "default-src 'none'" }
    ],
    totalBytes: bytes.length,
    body: bytes.slice(offset, offset + size)
  })
}

function world(connection: FakeConnection | null = new FakeConnection(), link?: HostLink) {
  connection
    ?.answer('content:scopes', () => [{ kind: 'project', path: ROOT, label: 'alpha' }])
    .answer('content:document', () => ({}) as unknown as P.ContentDocument)
    .answer('content:render', () => ({}) as unknown as P.RenderedMarkdown)
    .answer('content:search', () => ({}) as unknown as P.ContentSearchResult)
    .answer('content:write', () => written(true))
    .answer('content:snapshots', () => [])
    .answer('content:restore', () => written(false))
    .answer('content:artifact', () => ({ url: HOST_URL, token: 'tok123' }))
    .answer('content:wikilink', () => ({ path: NOTE }))
    .answer('editor:highlight', () => ({}) as unknown as P.EditorHighlight)
    .answer('files:dir', () => ({}) as unknown as P.ContentDirListing)
    .answer('files:status', () => ({
      root: ROOT,
      repo: ROOT,
      files: { 'notes/a.md': 'modified' as P.GitFileState, 'gone.md': undefined },
      error: null
    }))
    .answer('files:read', () => ({}) as unknown as P.FileView)
    .answer('files:list', () => ({}) as unknown as P.FileListing)
    .answer('files:watch', () => null)
  const emitted: Array<{ channel: string; payload: unknown }> = []
  const files = createHostFiles({
    link: link ?? fakeLink(connection, UNREACHABLE),
    emit: (channel, payload) => emitted.push({ channel, payload }),
    log: () => undefined
  })
  return { connection: connection ?? new FakeConnection(), files, emitted }
}

describe('the Files view through the local host', () => {
  it('reaches the host on each channel with the generated payload', async () => {
    const { connection, files } = world()
    await files.scopes()
    await files.document(ROOT, NOTE)
    await files.render(ROOT, NOTE, '# A')
    await files.search(ROOT, 'needle')
    await files.write({ scopePath: ROOT, path: NOTE, content: 'x', expectedHash: 'h1', reason: 'edit' })
    await files.snapshots(ROOT, NOTE)
    await files.restore(7, NOTE)
    await files.artifact(ROOT, PAGE)
    await files.wikilink(ROOT, 'a', NOTE)
    await files.highlight(NOTE, '# A')
    await files.dir(ROOT, 'notes')
    await files.status(ROOT)
    await files.read(ROOT, NOTE)
    await files.list(ROOT)
    await files.watch([ROOT])

    const p = (channel: string): unknown[] => connection.payloads(channel)
    expect(p('content:scopes')).toEqual([null])
    expect(p('content:document')).toEqual([{ scopePath: ROOT, path: NOTE }])
    expect(p('content:render')).toEqual([{ scopePath: ROOT, path: NOTE, source: '# A' }])
    expect(p('content:search')).toEqual([{ scopePath: ROOT, query: 'needle' }])
    expect(p('content:write')).toEqual([
      { scopePath: ROOT, path: NOTE, content: 'x', expectedHash: 'h1', reason: 'edit' }
    ])
    expect(p('content:snapshots')).toEqual([{ scopePath: ROOT, path: NOTE }])
    expect(p('content:restore')).toEqual([{ id: 7, path: NOTE }])
    expect(p('content:artifact')).toEqual([{ scopePath: ROOT, path: PAGE }])
    expect(p('content:wikilink')).toEqual([{ scopePath: ROOT, target: 'a', from: NOTE }])
    expect(p('editor:highlight')).toEqual([{ path: NOTE, source: '# A' }])
    expect(p('files:dir')).toEqual([{ root: ROOT, relPath: 'notes' }])
    expect(p('files:status')).toEqual([{ root: ROOT }])
    expect(p('files:read')).toEqual([{ root: ROOT, path: NOTE }])
    expect(p('files:list')).toEqual([{ root: ROOT }])
    expect(p('files:watch')).toEqual([{ roots: [ROOT] }])
  })

  it("answers in the window's shapes: an artifact on the window's scheme, a wikilink's path, a write's result", async () => {
    const { files } = world()
    expect(await files.artifact(ROOT, PAGE)).toEqual({ url: WINDOW_URL, token: 'tok123' })
    expect(await files.wikilink(ROOT, 'a', NOTE)).toBe(NOTE)
    expect(await files.status(ROOT)).toEqual({
      root: ROOT,
      repo: ROOT,
      files: { 'notes/a.md': 'modified' },
      error: null
    })
    const saved = await files.write({ scopePath: ROOT, path: NOTE, content: 'x', expectedHash: 'h1', reason: 'edit' })
    expect(saved).toEqual(expect.objectContaining({ ok: true, snapshotId: 7 }))
    expect(saved).not.toHaveProperty('conflict')
    expect(saved).not.toHaveProperty('error')
    expect(await files.restore(7, NOTE)).toEqual(expect.objectContaining({ ok: false, error: 'refused' }))
  })

  it('rejects with the sentence saying the host could not be reached, never an empty answer', async () => {
    const { files } = world(null)
    await expect(files.scopes()).rejects.toThrow(UNREACHABLE)
    await expect(files.snapshots(ROOT, NOTE)).rejects.toThrow(UNREACHABLE)
    await expect(files.dir(ROOT, '')).rejects.toThrow(UNREACHABLE)
    await expect(files.watch([ROOT])).rejects.toThrow(UNREACHABLE)
  })

  it('passes on what changed under a watched folder, and watches the same folders again after a reconnect', async () => {
    const first = new FakeConnection()
    const link = reconnectingLink(first)
    const { files, emitted } = world(first, link)
    await files.watch([ROOT])
    // The first connect knew of no folders yet, so the one watch is the window's.
    expect(first.payloads('files:watch')).toEqual([{ roots: [ROOT] }])

    first.push('files:changed', { root: ROOT, paths: [NOTE] } as P.FilesChange)
    expect(emitted).toEqual([{ channel: 'files:changed', payload: { root: ROOT, paths: [NOTE] } }])

    const second = new FakeConnection()
    second.answer('files:watch', () => null)
    await link.reconnect(second)
    expect(second.payloads('files:watch')).toEqual([{ roots: [ROOT] }])
    second.push('files:changed', { root: ROOT, paths: [] } as P.FilesChange)
    expect(emitted).toHaveLength(2)

    files.shutdown()
    second.push('files:changed', { root: ROOT, paths: [NOTE] } as P.FilesChange)
    expect(emitted).toHaveLength(2)
  })

  it("reassembles an artifact the host serves in pieces, with the host's headers", async () => {
    const { connection, files } = world()
    const page = '<!doctype html><p>' + 'x'.repeat(40) + '</p>'
    connection.answer('content:artifactBytes', servePieces(page, 16))
    const answer = await files.artifactBytes(WINDOW_URL)
    expect(answer.status).toBe(200)
    expect(decode(answer.body)).toBe(page)
    expect(answer.headers).toContainEqual(['content-type', 'text/html; charset=utf-8'])
    const offsets = connection.payloads('content:artifactBytes').map((sent) => (sent as P.ArtifactBytesRequest).offset)
    expect(offsets).toEqual([0, 16, 32, 48])
    expect(connection.payloads('content:artifactBytes')[0]).toEqual({ url: HOST_URL, offset: 0 })
  })

  it("keeps the host's refusal as it said it, and refuses an address that is not an artifact's itself", async () => {
    const { connection, files } = world()
    connection.answer('content:artifactBytes', () => ({
      status: 403,
      headers: [{ name: 'content-type', value: 'text/plain' }],
      totalBytes: 9,
      body: encode('Forbidden')
    }))
    const refused = await files.artifactBytes(WINDOW_URL.replace('report.html', '../secret.txt'))
    expect(refused.status).toBe(403)
    expect(decode(refused.body)).toBe('Forbidden')
    expect(connection.payloads('content:artifactBytes')).toHaveLength(1)

    const bad = await files.artifactBytes('helm-content://scope/elsewhere')
    expect(bad.status).toBe(400)
    expect(connection.payloads('content:artifactBytes')).toHaveLength(1)
  })

  it('ends a body where a file that shrank under the read ends', async () => {
    const { connection, files } = world()
    connection.answer('content:artifactBytes', ({ offset }) => ({
      status: 200,
      headers: [],
      totalBytes: 100,
      body: offset === 0 ? encode('short') : new Uint8Array()
    }))
    const answer = await files.artifactBytes(WINDOW_URL)
    expect(decode(answer.body)).toBe('short')
  })

  it("maps an artifact's address between the host's scheme and the window's", () => {
    expect(windowArtifactUrl(HOST_URL)).toBe(WINDOW_URL)
    expect(hostArtifactUrl(WINDOW_URL)).toBe(HOST_URL)
    expect(hostArtifactUrl('helm-content://scope/x')).toBeNull()
    expect(() => windowArtifactUrl('https://example.com/x')).toThrow(/cannot serve/)
  })
})
