import { watch, type FSWatcher } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import {
  addMcpServer,
  computeEffectiveView,
  createConfigFile,
  deleteConfigEntry,
  hashContent,
  insertConfigSnapshot,
  listMcpServers,
  listProfiles,
  mcpTargetFile,
  previewMcpAdd,
  projectConfigScope,
  readConfigFileContent,
  readConfigSnapshot,
  readConfigSnapshots,
  readConfigTree,
  readProfile,
  removeMcpServer,
  renameConfigEntry,
  restoreConfigSnapshot,
  runDoctor,
  snapshotKey,
  userConfigScope,
  writeConfigFile,
  type ClaudeCommand,
  type ConfigScope,
  type ConfigSnapshotMeta,
  type CreateConfigRequest,
  type CreateConfigResult,
  type DeleteConfigRequest,
  type DeleteConfigResult,
  type DoctorReport,
  type EffectiveView,
  type McpAddRequest,
  type McpPreview,
  type McpResult,
  type McpScope,
  type RenameConfigRequest,
  type RenameConfigResult,
  type WriteConfigRequest,
  type WriteConfigResult
} from '@helm/core'
import { resolveClaudeCommand } from './claude-cli'
import type { Services } from './services'
import type { ConfigExternalChange, EffectiveViewRequest, McpApproveRequest } from '../shared/ipc'

/**
 * The config console's main-process half.
 *
 * Everything here exists because the renderer cannot do it: the filesystem, the
 * snapshot table, the `claude` subprocess, and a watch on the file the editor
 * has open. The last one is the interesting one - the other three are plumbing.
 *
 * External-edit detection is deliberately two mechanisms, not one, because they
 * fail differently and only one of them is allowed to fail. The **watch** is a
 * courtesy: it tells the editor a file moved under it while the user is still
 * typing, which is the difference between a warning and a lost afternoon. The
 * **hash check inside `writeConfigFile`** is the guarantee: it runs on every
 * write whether or not a watcher ever fired, on a filesystem where `fs.watch`
 * is silent, and after a change made while Helm was not running.
 */

export interface ConfigService {
  scopes: () => ConfigScope[]
  tree: (scopePath: string) => ReturnType<typeof readConfigTree>
  read: (path: string) => ReturnType<typeof readConfigFileContent>
  write: (req: WriteConfigRequest) => WriteConfigResult
  snapshots: (scopePath: string, path: string) => ConfigSnapshotMeta[]
  snapshot: (id: number) => { content: string } | null
  restore: (id: number, path: string) => WriteConfigResult
  create: (req: CreateConfigRequest) => CreateConfigResult
  rename: (req: RenameConfigRequest) => RenameConfigResult
  remove: (req: DeleteConfigRequest) => DeleteConfigResult
  /** Watch one file, or stop watching. */
  watch: (path: string | null) => void
  effective: (req: EffectiveViewRequest) => EffectiveView
  mcpPreview: (req: McpAddRequest) => McpPreview
  mcpAdd: (req: McpAddRequest) => Promise<McpResult>
  mcpRemove: (req: { name: string; scope: McpScope; cwd: string }) => Promise<McpResult>
  mcpApprove: (req: McpApproveRequest) => WriteConfigResult
  mcpList: (cwd: string) => Promise<McpResult>
  doctor: () => Promise<DoctorReport>
  stop: () => void
}

export interface ConfigServiceDeps {
  services: Services
  /** Pushes `config:externalChange` at the window. */
  onExternalChange: (change: ConfigExternalChange) => void
  /** Overridden by `--config-check` to browse a fixture tree as the user scope. */
  userHome?: string | undefined
}

/** Long enough for an editor's write-truncate-write to settle into one event. */
const WATCH_DEBOUNCE_MS = 120

function claudeCommand(): ClaudeCommand {
  const command = resolveClaudeCommand()
  if (!command) {
    throw new Error(
      'Claude Code CLI not found. Install it (or put `claude` on PATH) and restart Helm.'
    )
  }
  return { file: command.file, prefixArgs: command.prefixArgs }
}

export function createConfigService({
  services,
  onExternalChange,
  userHome
}: ConfigServiceDeps): ConfigService {
  let watcher: FSWatcher | null = null
  let watched: string | null = null
  let debounce: NodeJS.Timeout | null = null
  /**
   * The hash Helm last saw. Every write updates it, which is what stops the
   * app's own save from arriving back as an "external" change a moment later.
   */
  let watchedHash: string | null = null

  function stopWatching(): void {
    if (debounce) clearTimeout(debounce)
    debounce = null
    watcher?.close()
    watcher = null
    watched = null
    watchedHash = null
  }

  function watchFile(path: string | null): void {
    const target = path === null ? null : resolve(path)
    if (target === watched) return
    stopWatching()
    if (target === null) return

    watched = target
    watchedHash = readConfigFileContent(target).hash

    try {
      // The containing directory, not the file. A file replaced rather than
      // appended to - which is what most editors do, and what `writeFileSync`
      // does on some filesystems - breaks a watch on the inode and never
      // reports again.
      watcher = watch(dirname(target), { persistent: false }, (_event, name) => {
        if (name !== null && basename(String(name)) !== basename(target)) return
        if (debounce) clearTimeout(debounce)
        debounce = setTimeout(() => {
          debounce = null
          if (watched !== target) return
          const now = readConfigFileContent(target)
          if (now.hash === watchedHash) return
          watchedHash = now.hash
          onExternalChange({
            path: target,
            hash: now.hash,
            exists: now.exists,
            mtimeMs: now.mtimeMs
          })
        }, WATCH_DEBOUNCE_MS)
      })
      watcher.on('error', () => {
        watcher?.close()
        watcher = null
      })
    } catch {
      // Left to the hash check at save time, which is the guarantee anyway.
    }
  }

  /**
   * The scopes the switcher offers: the user's, every harness discovery found,
   * every project under them, and any directory a saved profile points at.
   *
   * Built from the last scan rather than from a fresh one - the console is
   * opened from a window that has already painted a tree, and a scope list that
   * disagreed with the sidebar would be a second answer to a question the app
   * has already answered.
   *
   * The profiles are why this is not simply the scan. A profile's root and its
   * overlays are directories whose configuration decides what a session sees,
   * and neither has to be inside a scanned root - so a profile built against a
   * folder the user never added would have an effective view and no way to open
   * the files behind it.
   */
  function scopes(): ConfigScope[] {
    const user = userConfigScope(userHome)
    const out: ConfigScope[] = [user]
    const seen = new Set<string>([user.path.toLowerCase()])

    const add = (path: string, kind: ConfigScope['kind'], label?: string): void => {
      const key = resolve(path).toLowerCase()
      if (seen.has(key)) return
      seen.add(key)
      out.push(projectConfigScope(path, kind, label))
    }

    const projects = services.lastScan?.projects ?? []
    for (const project of projects) {
      if (project.kind === 'harness') add(project.path, 'harness', project.name)
    }
    for (const project of projects) {
      if (project.kind !== 'harness') add(project.path, 'project', project.name)
    }
    for (const profile of listProfiles(services.store)) {
      add(profile.root, 'project')
      for (const overlay of profile.overlays) add(overlay, 'project')
    }
    return out
  }

  function scopeFor(scopePath: string): ConfigScope {
    const known = scopes().find(
      (scope) => scope.path.toLowerCase() === resolve(scopePath).toLowerCase()
    )
    if (known) return known
    // A directory the last scan did not include - a profile root outside every
    // scanned root, most plausibly. Still a scope; just not one in the list.
    return projectConfigScope(scopePath)
  }

  /**
   * The effective view for a profile, or for a directory chosen by hand.
   *
   * A profile is read from the store rather than taken from the request: the
   * point of the view is what *that saved composition* would produce, and a
   * renderer that sent its own copy of the overlays could show a prediction for
   * a profile nobody has.
   */
  function effective(req: EffectiveViewRequest): EffectiveView {
    if (req.profileId !== null && req.profileId !== undefined) {
      const profile = readProfile(services.store, req.profileId)
      if (!profile) throw new Error('That profile no longer exists.')
      return computeEffectiveView({
        cwd: profile.root,
        overlays: profile.overlays,
        profileId: profile.id,
        profileName: profile.name,
        userHome
      })
    }

    const cwd = req.cwd?.trim()
    if (cwd === undefined || cwd === '') {
      throw new Error('An effective view needs either a profile or a working directory.')
    }
    return computeEffectiveView({ cwd, overlays: req.overlays ?? [], userHome })
  }

  /**
   * Runs `claude mcp add-json`, having first put the file it is about to
   * rewrite into the snapshot table.
   *
   * The snapshot is taken here rather than left to `writeConfigFile`, because
   * this write is not Helm's - the CLI does it. The rule that every change to a
   * config file has a version behind it does not get an exemption for the
   * changes Helm delegates.
   */
  async function mcpAdd(req: McpAddRequest): Promise<McpResult> {
    const file = mcpTargetFile(req.scope, req.cwd)
    const before = readConfigFileContent(file)
    // `~/.claude.json` is not under any scope, so it is snapshotted against its
    // own directory rather than a project's. The key is still the file name,
    // which is what the history is listed by.
    const scopePath = req.scope === 'project' ? resolve(req.cwd) : dirname(file)
    const snapshotId = insertSnapshotFor(scopePath, file, before.exists ? before.content : '', before.exists ? before.hash : hashContent(''))

    const result = await addMcpServer(claudeCommand(), req)
    const after = readConfigFileContent(file)
    if (watched !== null && watched === resolve(file)) watchedHash = after.hash

    return {
      ok: result.ok,
      output: result.output,
      exitCode: result.exitCode,
      after: after.exists ? after.content : '',
      snapshotId
    }
  }

  function insertSnapshotFor(
    scopePath: string,
    file: string,
    content: string,
    contentHash: string
  ): number {
    return insertConfigSnapshot(services.store, {
      scopePath,
      filePath: snapshotKey(scopePath, file),
      content,
      contentHash,
      reason: 'mcp'
    })
  }

  async function mcpRemove(req: {
    name: string
    scope: McpScope
    cwd: string
  }): Promise<McpResult> {
    const file = mcpTargetFile(req.scope, req.cwd)
    const before = readConfigFileContent(file)
    const scopePath = req.scope === 'project' ? resolve(req.cwd) : dirname(file)
    const snapshotId = before.exists
      ? insertSnapshotFor(scopePath, file, before.content, before.hash)
      : null

    const result = await removeMcpServer(claudeCommand(), req)
    const after = readConfigFileContent(file)
    if (watched !== null && watched === resolve(file)) watchedHash = after.hash

    return {
      ok: result.ok,
      output: result.output,
      exitCode: result.exitCode,
      after: after.exists ? after.content : '',
      snapshotId
    }
  }

  /**
   * Approves - or un-approves - a `.mcp.json` server for a project.
   *
   * Written into `settings.local.json` rather than `settings.json`: approval is
   * a decision about this machine, and putting it in the file a repo commits
   * would approve somebody else's server on somebody else's checkout.
   */
  function mcpApprove(req: McpApproveRequest): WriteConfigResult {
    const scopePath = resolve(req.cwd)
    const file = join(scopePath, '.claude', 'settings.local.json')
    const current = readConfigFileContent(file)

    let document: Record<string, unknown> = {}
    if (current.exists && current.content.trim() !== '') {
      const parsed: unknown = JSON.parse(current.content)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {
          ok: false,
          file: current,
          snapshotId: null,
          unchanged: false,
          error: `${file} is not a JSON object, so Helm will not add a key to it.`
        }
      }
      document = parsed as Record<string, unknown>
    }

    const listOf = (key: string): string[] => {
      const value = document[key]
      return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
    }
    const enabled = new Set(listOf('enabledMcpjsonServers'))
    const disabled = new Set(listOf('disabledMcpjsonServers'))
    if (req.approved) {
      enabled.add(req.name)
      disabled.delete(req.name)
    } else {
      enabled.delete(req.name)
      disabled.add(req.name)
    }

    document['enabledMcpjsonServers'] = [...enabled].sort((a, b) => a.localeCompare(b))
    if (disabled.size > 0) {
      document['disabledMcpjsonServers'] = [...disabled].sort((a, b) => a.localeCompare(b))
    } else {
      delete document['disabledMcpjsonServers']
    }

    return write({
      scopePath,
      path: file,
      content: `${JSON.stringify(document, null, 2)}\n`,
      expectedHash: current.exists ? current.hash : null,
      reason: 'approve'
    })
  }

  function write(req: WriteConfigRequest): WriteConfigResult {
    const result = writeConfigFile(services.store, req)
    // Helm's own write must not come back as somebody else's.
    if (result.ok && watched !== null && watched === resolve(req.path)) {
      watchedHash = result.file.hash
    }
    return result
  }

  /**
   * The same courtesy for a path this process just changed by some other route.
   *
   * The watch is on a *directory*, so creating, moving or removing the file the
   * editor has open fires it - and an "edited outside Helm" banner over a
   * rename the user just asked for would be the app reporting itself as a third
   * party. Re-reading is enough: the hash of whatever is there now, including
   * the empty hash of a file that is not.
   */
  function noteChanged(...paths: readonly string[]): void {
    if (watched === null) return
    if (!paths.some((path) => resolve(path) === watched)) return
    watchedHash = readConfigFileContent(watched).hash
  }

  // -------------------------------------------------------------------------
  // Create, rename, delete
  // -------------------------------------------------------------------------
  /**
   * The entry is resolved from the tree rather than taken from the request.
   *
   * What a path *is* - a skill whose directory carries its name, a command
   * whose path is its namespace - decides what a rename moves and what a delete
   * removes, and that is a fact about the disk. A renderer that sent its own
   * copy of the kind could ask for a skill's directory to be moved by naming a
   * settings file.
   */
  function entryIn(scopePath: string, path: string): { scope: ConfigScope; files: ReturnType<typeof readConfigTree>['files']; file: ReturnType<typeof readConfigTree>['files'][number] } {
    const scope = scopeFor(scopePath)
    const { files } = readConfigTree(scope)
    const target = resolve(path)
    const file = files.find((candidate) => resolve(candidate.path) === target)
    if (!file) {
      throw new Error(
        `${target} is not a configuration file in ${scope.label}. Re-read the scope and try again.`
      )
    }
    return { scope, files, file }
  }

  function create(req: CreateConfigRequest): CreateConfigResult {
    const result = createConfigFile(services.store, scopeFor(req.scopePath), {
      kind: req.kind,
      name: req.name
    })
    if (result.path !== null) noteChanged(result.path)
    return result
  }

  function rename(req: RenameConfigRequest): RenameConfigResult {
    const { scope, files, file } = entryIn(req.scopePath, req.path)
    const result = renameConfigEntry(services.store, scope, files, file, req.name)
    noteChanged(...result.moved.flatMap((move) => [move.from, move.to]))
    return result
  }

  function remove(req: DeleteConfigRequest): DeleteConfigResult {
    const { scope, files, file } = entryIn(req.scopePath, req.path)
    const result = deleteConfigEntry(services.store, scope, files, file)
    noteChanged(...result.removed.map((row) => row.path))
    return result
  }

  return {
    scopes,
    tree: (scopePath) => readConfigTree(scopeFor(scopePath)),
    read: (path) => readConfigFileContent(path),
    write,
    snapshots: (scopePath, path) =>
      readConfigSnapshots(services.store, resolve(scopePath), snapshotKey(scopePath, path)),
    snapshot: (id) => {
      const row = readConfigSnapshot(services.store, id)
      return row ? { content: row.content } : null
    },
    restore: (id, path) => {
      const result = restoreConfigSnapshot(services.store, id, path)
      if (result.ok && watched !== null && watched === resolve(path)) {
        watchedHash = result.file.hash
      }
      return result
    },
    create,
    rename,
    remove,
    watch: watchFile,
    effective,
    mcpPreview: previewMcpAdd,
    mcpAdd,
    mcpRemove,
    mcpApprove,
    mcpList: async (cwd) => {
      const result = await listMcpServers(claudeCommand(), cwd)
      return { ...result, after: '', snapshotId: null }
    },
    doctor: () => runDoctor(claudeCommand()),
    stop: stopWatching
  }
}
