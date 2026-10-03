import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { listTemplates } from '@helm/core'
import { createWorld, disposeWorld, type World } from '../../test/world'
import type { ConfigService } from './config'
import type { Services } from './services'
import type { TemplateService } from './templates'

vi.mock('electron', async () => (await import('../../test/electron')).electronFake())

/**
 * The template manager's main-process half: what each of its buttons does to
 * the templates directory the New Harness picker reads, and where a copied-in
 * skill comes from.
 */
describe('template service', () => {
  let world: World
  let services: Services
  let config: ConfigService
  let templates: TemplateService
  let templatesDir: string

  beforeAll(async () => {
    world = createWorld()
    Object.assign(process.env, { PORTABLE_EXECUTABLE_DIR: world.portableDir, USERPROFILE: world.home, HOME: world.home })
    const { createServices } = await import('./services')
    const { createConfigService } = await import('./config')
    const { createTemplateService } = await import('./templates')
    services = createServices()
    config = createConfigService({ services, onExternalChange: () => undefined, userHome: world.claudeDir })
    templates = createTemplateService(services, config)
    templatesDir = join(world.dataDir, 'templates')

    // A skill of the user's own, with a file bundled beside its SKILL.md.
    const skill = join(world.claudeDir, 'skills', 'think')
    mkdirSync(skill, { recursive: true })
    writeFileSync(join(skill, 'SKILL.md'), '---\nname: think\ndescription: Think it through.\n---\nUse {{NAME}} as written.\n')
    writeFileSync(join(skill, 'reference.md'), '# reference\n')
  })

  afterAll(() => {
    config.watch(null)
    services.store.close()
    disposeWorld(world)
  })

  const listed = async (): Promise<{ id: string; label: string; description: string | null }[]> =>
    (await listTemplates(templatesDir)).templates
      .filter((choice) => !choice.builtIn)
      .map(({ id, label, description }) => ({ id, label, description }))

  it('offers the user ~/.claude scope to copy from, and copies a skill as its whole folder', async () => {
    const user = config.scopes().find((scope) => scope.kind === 'user')
    expect(user?.path).toBe(world.claudeDir)
    if (user === undefined) return

    expect((await templates.create({ name: 'kit' })).ok).toBe(true)
    const skill = config.tree(user.path).files.find((file) => file.kind === 'skill' && file.name === 'think')
    expect(skill).toBeDefined()

    const result = await templates.importFiles({ template: 'kit', scopePath: user.path, paths: [skill?.path ?? ''] })

    expect(result.problems).toEqual([])
    expect([...result.created].sort()).toEqual(['.claude/skills/think/SKILL.md', '.claude/skills/think/reference.md'])
    const copied = join(templatesDir, 'kit', '.claude', 'skills', 'think')
    expect(readFileSync(join(copied, 'SKILL.md'))).toEqual(readFileSync(join(world.claudeDir, 'skills', 'think', 'SKILL.md')))
    expect(readFileSync(join(copied, 'reference.md'), 'utf8')).toBe('# reference\n')
  })

  it('creates, describes, renames and deletes a template in the folder the picker reads', async () => {
    const created = await templates.create({ name: 'draft' })
    expect(created).toEqual({ ok: true, template: 'draft', problems: [] })
    expect(readdirSync(join(templatesDir, 'draft'))).toEqual(['template.yaml'])

    expect((await templates.metadata({ template: 'draft', label: 'Draft kit', description: 'For drafts.' })).ok).toBe(true)
    expect(await listed()).toContainEqual({ id: 'draft', label: 'Draft kit', description: 'For drafts.' })

    expect(await templates.rename({ template: 'draft', name: 'final' })).toEqual({
      ok: true,
      template: 'final',
      problems: []
    })
    const afterRename = await listed()
    expect(afterRename).toContainEqual({ id: 'final', label: 'Draft kit', description: 'For drafts.' })
    expect(afterRename.map((choice) => choice.id)).not.toContain('draft')

    expect((await templates.remove('final')).ok).toBe(true)
    expect(existsSync(join(templatesDir, 'final'))).toBe(false)
    expect((await listed()).map((choice) => choice.id)).not.toContain('final')
  })
})
