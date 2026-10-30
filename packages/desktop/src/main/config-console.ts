import type {
  ConfigFileContent,
  ConfigRendered,
  ConfigScope,
  ConfigSnapshotMeta,
  ConfigTree,
  CreateConfigRequest,
  CreateConfigResult,
  DeleteConfigRequest,
  DeleteConfigResult,
  DoctorReport,
  EffectiveView,
  McpAddRequest,
  McpPreview,
  McpResult,
  McpScope,
  RenameConfigRequest,
  RenameConfigResult,
  WriteConfigRequest,
  WriteConfigResult
} from '@helm/core'
import type { EffectiveViewRequest, McpApproveRequest } from '../shared/ipc'
import type { ConfigService } from './config'

/**
 * What the config console asks of the agent's configuration, from wherever it
 * is read and written this run: Helm's own main process (`localConfigConsole`,
 * over `createConfigService`), or the local host when sessions run there
 * (`host/config.ts`). The `config:*` handlers answer through this and nothing
 * else.
 *
 * Every answer is a promise, because one of the two is across a socket. A read
 * that could not look rejects with the sentence saying why; none answers an
 * empty list in its place.
 */
export interface ConfigConsoleService {
  /** The scopes the switcher offers, user scope first. */
  scopes(): Promise<ConfigScope[]>
  tree(scopePath: string): Promise<ConfigTree>
  read(path: string): Promise<ConfigFileContent>
  /** The source as markdown rendered or code highlighted. */
  render(path: string, source: string): Promise<ConfigRendered>
  /** Snapshots the bytes it replaces first, and refuses when they are not the ones the editor read. */
  write(request: WriteConfigRequest): Promise<WriteConfigResult>
  /** Versions of one file, newest first, without their contents. */
  snapshots(scopePath: string, path: string): Promise<ConfigSnapshotMeta[]>
  snapshot(id: number): Promise<{ content: string } | null>
  restore(id: number, path: string): Promise<WriteConfigResult>
  /** The one file the editor has open, watched for changes made outside Helm; null for none. */
  watch(path: string | null): Promise<void>
  create(request: CreateConfigRequest): Promise<CreateConfigResult>
  rename(request: RenameConfigRequest): Promise<RenameConfigResult>
  remove(request: DeleteConfigRequest): Promise<DeleteConfigResult>
  effective(request: EffectiveViewRequest): Promise<EffectiveView>
  mcpPreview(request: McpAddRequest): Promise<McpPreview>
  mcpAdd(request: McpAddRequest): Promise<McpResult>
  mcpRemove(request: { name: string; scope: McpScope; cwd: string }): Promise<McpResult>
  mcpApprove(request: McpApproveRequest): Promise<WriteConfigResult>
  mcpList(cwd: string): Promise<McpResult>
  doctor(): Promise<DoctorReport>
}

/**
 * Helm's own: the config service in this process, with its snapshots in
 * `helm.db`. Each call is the service's, unchanged; a throw becomes the
 * rejection the window shows.
 */
export function localConfigConsole(config: ConfigService): ConfigConsoleService {
  return {
    scopes: async () => config.scopes(),
    tree: async (scopePath) => config.tree(scopePath),
    read: async (path) => config.read(path),
    render: (path, source) => config.render(path, source),
    write: async (request) => config.write(request),
    snapshots: async (scopePath, path) => config.snapshots(scopePath, path),
    snapshot: async (id) => config.snapshot(id),
    restore: async (id, path) => config.restore(id, path),
    watch: async (path) => {
      config.watch(path)
    },
    create: async (request) => config.create(request),
    rename: async (request) => config.rename(request),
    remove: async (request) => config.remove(request),
    effective: async (request) => config.effective(request),
    mcpPreview: async (request) => config.mcpPreview(request),
    mcpAdd: (request) => config.mcpAdd(request),
    mcpRemove: (request) => config.mcpRemove(request),
    mcpApprove: async (request) => config.mcpApprove(request),
    mcpList: (cwd) => config.mcpList(cwd),
    doctor: () => config.doctor()
  }
}
