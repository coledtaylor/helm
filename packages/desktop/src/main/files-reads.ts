import type { IpcRequests } from '../shared/ipc'
import { highlightForEditor, type ContentService } from './content'
import type { FilesService } from './files'

/**
 * What the Files view and the note viewer read, write and watch, as the
 * window reaches them: Helm's own content and files services
 * (`localFilesReads`), or - when sessions run in the local host - the host's
 * (`host/files.ts`). Opening a file in an editor stays Helm's own either way:
 * it acts on this computer's shell.
 */

type Response<K extends keyof IpcRequests> = IpcRequests[K]['response']

export interface FilesReads {
  scopes(): Promise<Response<'content:scopes'>>
  document(scopePath: string, path: string): Promise<Response<'content:document'>>
  render(scopePath: string, path: string, source: string): Promise<Response<'content:render'>>
  search(scopePath: string, query: string): Promise<Response<'content:search'>>
  /** The one write: a note, snapshotted first and refused on a hash conflict. */
  write(request: IpcRequests['content:write']['request']): Promise<Response<'content:write'>>
  snapshots(scopePath: string, path: string): Promise<Response<'content:snapshots'>>
  restore(id: number, path: string): Promise<Response<'content:restore'>>
  /** The address a sandboxed frame may load an HTML artifact from. */
  artifact(scopePath: string, path: string): Promise<Response<'content:artifact'>>
  wikilink(scopePath: string, target: string, from: string): Promise<string | null>
  highlight(path: string, source: string): Promise<Response<'editor:highlight'>>
  dir(root: string, relPath: string): Promise<Response<'files:dir'>>
  status(root: string): Promise<Response<'files:status'>>
  read(root: string, path: string): Promise<Response<'files:read'>>
  list(root: string): Promise<Response<'files:list'>>
  /** Every root the window has on screen; any other is let go. */
  watch(roots: readonly string[]): Promise<void>
}

/** Today's: Helm's own content and files services. */
export function localFilesReads(content: ContentService, files: FilesService): FilesReads {
  return {
    scopes: () => Promise.resolve(content.scopes()),
    document: (scopePath, path) => content.document(scopePath, path),
    render: (scopePath, path, source) => content.render(scopePath, path, source),
    search: (scopePath, query) => Promise.resolve(content.search(scopePath, query)),
    write: (request) => Promise.resolve(content.write(request)),
    snapshots: (scopePath, path) => Promise.resolve(content.snapshots(scopePath, path)),
    restore: (id, path) => Promise.resolve(content.restore(id, path)),
    artifact: (scopePath, path) => Promise.resolve(content.artifact(scopePath, path)),
    wikilink: (scopePath, target, from) => Promise.resolve(content.wikilink(scopePath, target, from)),
    // A free function rather than a method on either service: one editor, one
    // highlighter, and nothing about a draft in a box belongs to a scope.
    highlight: (path, source) => highlightForEditor(path, source),
    dir: (root, relPath) => files.dir(root, relPath),
    status: (root) => files.status(root),
    read: (root, path) => files.read(root, path),
    list: (root) => files.list(root),
    watch: (roots) => {
      files.watch(roots)
      return Promise.resolve()
    }
  }
}
