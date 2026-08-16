import { relative, resolve, sep } from 'node:path'
import {
  configUnit,
  createTemplate,
  deleteTemplate,
  importIntoTemplate,
  makeSubstitutable,
  previewFolderAsTemplate,
  readTemplateDetail,
  renameTemplate,
  saveFolderAsTemplate,
  writeTemplateMetadata,
  type ConfigScope,
  type FolderTemplateKind,
  type FolderTemplatePreview,
  type SaveFolderAsTemplateResult,
  type TemplateDeleteResult,
  type TemplateDetail,
  type TemplateImportFile,
  type TemplateImportResult,
  type TemplateWriteResult
} from '@helm/core'
import type { ConfigService } from './config'
import { templatesDir } from './paths'
import type { Services } from './services'

/**
 * The main-process half of template authoring.
 *
 * Thin on purpose: every decision is in `core/discovery/template-authoring.ts`,
 * and what is left here is the two things the engine cannot know - where the
 * templates directory is, and what a path the *renderer* named actually is.
 *
 * That second one is the whole of `resolveImport` below, and it is the reason
 * this file exists rather than the handlers calling core directly. The import
 * picker sends paths out of `config:tree`; what those paths *mean* - that a
 * skill is a directory and not one file, that `~/.claude` has no `.claude/`
 * segment in its relative paths because the scope's base directory already is
 * one - is a fact about the disk, and the console's own `configUnit` and
 * `ConfigScope` are what answer it. A renderer that sent its own idea of the
 * unit could ask for one file of a skill, or for a path in another scope.
 */

export interface TemplateService {
  detail: (template: string) => Promise<TemplateDetail>
  create: (req: {
    name: string
    label?: string | undefined
    description?: string | undefined
  }) => Promise<TemplateWriteResult>
  rename: (req: { template: string; name: string }) => Promise<TemplateWriteResult>
  remove: (template: string) => Promise<TemplateDeleteResult>
  metadata: (req: {
    template: string
    label: string
    description: string
  }) => Promise<TemplateWriteResult>
  substitute: (req: { template: string; path: string }) => Promise<TemplateWriteResult>
  importFiles: (req: {
    template: string
    scopePath: string
    paths: string[]
  }) => Promise<TemplateImportResult>
  folderPreview: (req: {
    dir: string
    kind: FolderTemplateKind
  }) => Promise<FolderTemplatePreview>
  fromFolder: (req: {
    dir: string
    kind: FolderTemplateKind
    name: string
    label: string
    description: string
    include: string[]
  }) => Promise<SaveFolderAsTemplateResult>
}

export function createTemplateService(
  services: Services,
  config: ConfigService
): TemplateService {
  /**
   * Turns the paths the picker sent into copies the engine can make.
   *
   * The tree is re-read here rather than trusted from the request, which is the
   * same rule `entryIn` in `config.ts` follows and for the same reason: what a
   * path is decides what gets copied, and that is a fact about the disk.
   */
  function resolveImport(
    scopePath: string,
    paths: readonly string[]
  ): { files: TemplateImportFile[]; problems: string[] } {
    const { scope, files: tree } = config.tree(scopePath)
    const files: TemplateImportFile[] = []
    const problems: string[] = []
    const seen = new Set<string>()

    for (const path of paths) {
      const wanted = resolve(path)
      const file = tree.find((candidate) => resolve(candidate.path) === wanted)
      if (!file) {
        problems.push(`${path} is not in ${scope.label} any more. Re-read the scope and try again.`)
        continue
      }
      // A skill is its whole directory - the same expansion the console's own
      // rename and delete make, so "copy this skill" means the same thing here
      // as it does there and a bundled reference file travels with it.
      for (const member of configUnit(tree, file)) {
        const source = resolve(member.path)
        if (seen.has(source.toLowerCase())) continue
        const target = targetFor(scope, source)
        if (target === null) {
          problems.push(`${member.relPath} is not somewhere a template can hold it, so it was skipped.`)
          continue
        }
        seen.add(source.toLowerCase())
        files.push({ source, target })
      }
    }
    return { files, problems }
  }

  return {
    detail: (template) => readTemplateDetail(templatesDir, template),
    create: (req) =>
      createTemplate(services.store, {
        templatesDir,
        name: req.name,
        ...(req.label !== undefined ? { label: req.label } : {}),
        ...(req.description !== undefined ? { description: req.description } : {})
      }),
    rename: (req) => renameTemplate({ templatesDir, template: req.template, name: req.name }),
    remove: (template) => deleteTemplate({ templatesDir, template }),
    metadata: (req) =>
      writeTemplateMetadata(services.store, {
        templatesDir,
        template: req.template,
        label: req.label,
        description: req.description
      }),
    substitute: (req) =>
      makeSubstitutable({ templatesDir, template: req.template, path: req.path }),
    importFiles: async (req) => {
      const { files, problems } = resolveImport(req.scopePath, req.paths)
      if (files.length === 0) {
        return {
          ok: false,
          created: [],
          replaced: [],
          problems: problems.length > 0 ? problems : ['Nothing was selected.']
        }
      }
      const result = await importIntoTemplate({
        templatesDir,
        template: req.template,
        files
      })
      return { ...result, problems: [...problems, ...result.problems] }
    },
    folderPreview: (req) => previewFolderAsTemplate(req),
    fromFolder: (req) =>
      saveFolderAsTemplate(services.store, {
        dir: req.dir,
        templatesDir,
        name: req.name,
        label: req.label,
        description: req.description,
        include: req.include
      })
  }
}

/**
 * Where one config file lands inside a template.
 *
 * Two shapes, because a `.claude` tree has two. Everything under the scope's
 * `.claude` directory keeps its layout under a literal `.claude/` - written
 * out rather than aliased, since the alias exists for tooling that drops dot
 * directories and a template Helm writes itself has no such problem. A
 * `CLAUDE.md` or `.mcp.json` sits *beside* `.claude` rather than in it, so it
 * lands at the template's root.
 *
 * The user scope is why this cannot be a single `relative` call:
 * `~/.claude` **is** its own `claudeDir`, so a skill there has the relative
 * path `skills/think/SKILL.md` with no `.claude/` in it at all, and copying
 * that verbatim would put a `skills/` directory at the root of the template
 * where nothing resolves it.
 */
function targetFor(scope: ConfigScope, path: string): string | null {
  const inClaude = relative(resolve(scope.claudeDir), path)
  if (inClaude !== '' && !inClaude.startsWith('..') && !inClaude.startsWith(sep)) {
    return ['.claude', ...inClaude.split(sep)].join('/')
  }
  const inScope = relative(resolve(scope.path), path)
  if (inScope !== '' && !inScope.startsWith('..') && inScope.split(sep).length === 1) {
    return inScope
  }
  return null
}
