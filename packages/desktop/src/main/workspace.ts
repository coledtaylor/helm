import {
  createHarness,
  forgetProjects,
  isWithin,
  listTemplates,
  orphanedProjectPaths,
  previewTemplate,
  suggestRoots,
  type AppSettings
} from '@helm/core'
import type { ClaudeStatus, EventChannel, EventPayload, IpcRequests } from '../shared/ipc'
import { setClaudeOverride } from './claude-cli'
import { templatesDir } from './paths'
import { cachedProjects, runScan, updateSettings, type Services } from './services'
import { verifyClaudeAt } from './setup'
import type { TemplateService } from './templates'

/**
 * Discovery, scan roots, harnesses, setup, templates and the settings the
 * window reads, as the window reaches them: from Helm's own main process
 * (`localWorkspace` below), or - when sessions run in the local host - from
 * the host (`host/workspace.ts`). The pickers stay in `ipc.ts` either way;
 * what the user chose is all that is handed here.
 */

type Request<K extends keyof IpcRequests> = IpcRequests[K]['request']
type Response<K extends keyof IpcRequests> = IpcRequests[K]['response']

export interface WorkspaceTemplates extends TemplateService {
  list(): Promise<Response<'template:list'>>
  preview(request: Request<'template:preview'>): Promise<Response<'template:preview'>>
}

export interface WorkspaceService {
  /** The settings as the window sees them. */
  settings(): Promise<AppSettings>
  /** Writes a patch to wherever each key lives, and answers the settings after. */
  writeSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  cached(): Promise<Response<'discovery:cached'>>
  /** A scan; the window is told it is running, its result and that it stopped. */
  scan(includeGit: boolean): Promise<Response<'discovery:scan'>>
  suggestRoots(): Promise<string[]>
  /** Adds each path that is not a root already; answers the roots after. */
  acceptRoots(paths: readonly string[]): Promise<string[]>
  removeRoot(path: string): Promise<string[]>
  setupStatus(): Promise<ClaudeStatus>
  /** Checks a picked executable, keeps it when it answers, and says what setup finds after. */
  locateClaude(path: string): Promise<ClaudeStatus>
  completeSetup(): Promise<AppSettings>
  createHarness(request: Request<'harness:create'>): Promise<Response<'harness:create'>>
  templates: WorkspaceTemplates
}

export interface LocalWorkspaceDeps {
  services: Services
  emit: <K extends EventChannel>(channel: K, payload: EventPayload<K>) => void
  /** The CLI status, read against the setup pane's config directory, for `picked` when given. */
  claudeStatus: (picked?: string) => Promise<ClaudeStatus>
  templates: TemplateService
}

/** Today's workspace: Helm's own settings, scan, roots, setup and templates. */
export function localWorkspace({ services, emit, claudeStatus, templates }: LocalWorkspaceDeps): WorkspaceService {
  /** Adds paths that are not already roots, and tells the window. */
  const addRoots = (paths: readonly string[]): string[] => {
    const merged = [...services.settings.scanRoots]
    for (const path of paths) {
      if (!merged.some((existing) => existing.toLowerCase() === path.toLowerCase())) {
        merged.push(path)
      }
    }
    if (merged.length === services.settings.scanRoots.length) return services.settings.scanRoots
    const next = updateSettings(services, { scanRoots: merged })
    emit('settings:changed', next)
    return next.scanRoots
  }

  return {
    settings: () => Promise.resolve(services.settings),

    writeSettings: (patch) => Promise.resolve(updateSettings(services, patch)),

    cached: () => Promise.resolve(cachedProjects(services)),

    async scan(includeGit) {
      emit('scan:status', { running: true })
      try {
        const result = await runScan(services, { includeGit })
        emit('discovery:updated', result)
        return result
      } finally {
        emit('scan:status', { running: false })
      }
    },

    suggestRoots: () => suggestRoots(),

    acceptRoots: (paths) => Promise.resolve(addRoots(paths)),

    removeRoot(path) {
      const merged = services.settings.scanRoots.filter((existing) => existing.toLowerCase() !== path.toLowerCase())
      const next = updateSettings(services, { scanRoots: merged })
      // The rows this root put in the discovery cache go with it. Nothing else
      // can take them: the next scan does not walk a root that is no longer a
      // root, so a row left here would go on painting at every start, in a tree
      // that no longer holds it once the scan lands - the flicker being the
      // small half of it, and "Helm still lists a folder I removed" the rest.
      // Rows a *remaining* root still covers are kept; see `orphanedProjectPaths`.
      forgetProjects(
        services.store,
        orphanedProjectPaths(
          cachedProjects(services).map((project) => project.path),
          path,
          next.scanRoots
        )
      )
      emit('settings:changed', next)
      return Promise.resolve(next.scanRoots)
    },

    setupStatus: () => claudeStatus(),

    async locateClaude(picked) {
      // Verified before it is saved. A setting that points at the wrong program
      // is a launch failure two screens later with nothing to connect it to.
      const check = await verifyClaudeAt(picked)
      if (!check.ok) {
        const status = await claudeStatus()
        return { ...status, error: check.problem }
      }
      const next = updateSettings(services, { claudePath: picked })
      setClaudeOverride(picked)
      emit('settings:changed', next)
      return claudeStatus(picked)
    },

    completeSetup() {
      const next = updateSettings(services, {
        firstRunCompletedAt: new Date().toISOString()
      })
      emit('settings:changed', next)
      return Promise.resolve(next)
    },

    async createHarness(request) {
      const result = await createHarness({
        mode: request.mode,
        dir: request.dir,
        templatesDir,
        ...(request.name !== undefined ? { name: request.name } : {}),
        // 'new' only. The contract says so and `createHarness` enforces it, but
        // dropping it here as well means a renderer that sent one by mistake
        // cannot even reach the code that would have to ignore it.
        ...(request.template !== undefined && request.mode === 'new' ? { template: request.template } : {})
      })
      if (result.path === null) {
        return { ...result, roots: services.settings.scanRoots }
      }
      // A harness the launcher cannot see is not one the user created, so the
      // root goes in with it - unless a root already covers it, in which case
      // adding the harness itself would list it twice.
      const created = result.path
      const covered = services.settings.scanRoots.some((root) => isWithin(root, created))
      const roots = covered ? services.settings.scanRoots : addRoots([created])
      return { ...result, roots }
    },

    templates: {
      ...templates,
      list: () => Promise.resolve(listTemplates(templatesDir)),
      preview: ({ template, mode }) =>
        Promise.resolve(
          previewTemplate({
            templatesDir,
            template,
            ...(mode !== undefined ? { mode } : {})
          })
        )
    }
  }
}
