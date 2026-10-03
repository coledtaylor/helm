import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EMPTY_INVENTORY,
  type EffectiveEntry,
  type EffectiveMcpServer,
  type Profile,
  type ProfileDraft,
  type Project
} from '@helm/core/types'
import { ProfileEditor, type ProfileEditorProps, type ProfilePrediction } from './ProfileEditor'

const HUB = 'C:\\work\\hub'
const TOOLS = 'C:\\work\\hub\\repos\\tools'
const DOCS = 'C:\\work\\hub\\repos\\docs'

const project = (path: string, name: string, kind: Project['kind']): Project => ({
  path,
  name,
  kind,
  harnessPath: HUB,
  hasClaudeDir: true,
  inventory: EMPTY_INVENTORY,
  git: null
})

/** What a scan of a harness with two repositories hands the form. */
const PROJECTS = [project(HUB, 'hub', 'harness'), project(TOOLS, 'tools', 'repo'), project(DOCS, 'docs', 'repo')]

const BLANK: ProfileDraft = {
  name: '',
  root: '',
  overlays: [],
  access: [],
  model: null,
  effort: null,
  permissionMode: null,
  agent: null,
  mcp: [],
  openingPrompt: null,
  pinnedOrder: null
}

const agent = (invocation: string, namespace: string | null): EffectiveEntry => ({
  invocation,
  name: invocation.split(':').at(-1) ?? invocation,
  source: namespace === null ? 'cwd' : 'overlay',
  namespace,
  origin: namespace === null ? HUB : TOOLS,
  path: '',
  description: null
})

const server = (name: string): EffectiveMcpServer => ({
  name,
  scope: 'project',
  file: `${HUB}\\.mcp.json`,
  config: '{}',
  transport: 'stdio',
  approved: true,
  approvedBy: null,
  shadowedBy: null
})

/**
 * The effective view, as `config:effective` would answer it: the root's own
 * agent, the composed overlay's under its namespace, and the root's servers.
 */
function predictor(): ProfileEditorProps['predict'] {
  return vi.fn((_root: string, overlays: string[]): Promise<ProfilePrediction> =>
    Promise.resolve({
      agents: [agent('planner', null), ...(overlays.includes(TOOLS) ? [agent('tools:reviewer', 'tools')] : [])],
      mcpServers: [server('docs-search'), server('tracker')]
    })
  )
}

function renderEditor(overrides: Partial<ProfileEditorProps> = {}) {
  const props: ProfileEditorProps = {
    initial: BLANK,
    projects: PROJECTS,
    predict: predictor(),
    onSave: vi.fn(),
    onCancel: vi.fn(),
    ...overrides
  }
  render(<ProfileEditor {...props} />)
  return props
}

/** Lets the editor's debounced prediction run and land. */
const settle = (): Promise<void> =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(300)
  })

/*
 * Interactions go through `fireEvent` rather than `user-event`: the prediction
 * is debounced on a timer, the clock here is fake, and Testing Library's async
 * wrapper around every `user-event` call waits on a real `setTimeout(0)`.
 */
const type = (name: string, value: string): void => {
  fireEvent.change(screen.getByRole('textbox', { name }), { target: { value } })
}
const choose = (name: string, value: string): void => {
  fireEvent.change(screen.getByRole('combobox', { name }), { target: { value } })
}
const tick = (name: string): void => {
  fireEvent.click(screen.getByRole('checkbox', { name }))
}
const checked = (name: string): boolean => (screen.getByRole('checkbox', { name }) as HTMLInputElement).checked

const optionsOf = (name: string): string[] =>
  within(screen.getByRole('combobox', { name })).getAllByRole('option').map((option) => option.textContent ?? '')

describe('ProfileEditor', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('offers every discovered project to compose or grant, with the harness root marked', () => {
    renderEditor()
    expect(screen.getByRole('dialog', { name: 'New profile' })).toBeTruthy()
    for (const name of ['hub', 'tools', 'docs']) {
      expect(screen.getByRole('checkbox', { name: `Compose ${name}` })).toBeTruthy()
      expect(screen.getByRole('checkbox', { name: `Grant access to ${name}` })).toBeTruthy()
    }
    expect(screen.getAllByText('harness root')).toHaveLength(1)
  })

  it('saves the name, root, model, opening prompt, overlays and access it was given', () => {
    const props = renderEditor()

    type('Profile name', '  hub dev ')
    type('Root directory', HUB)
    tick('Compose tools')
    tick('Grant access to docs')
    choose('Model', 'sonnet')
    type('Opening prompt', '/recap')
    fireEvent.click(screen.getByRole('button', { name: 'Save and start' }))

    expect(props.onSave).toHaveBeenCalledWith({
      ...BLANK,
      name: 'hub dev',
      root: HUB,
      overlays: [TOOLS],
      access: [TOOLS, DOCS],
      model: 'sonnet',
      openingPrompt: '/recap'
    })
  })

  it('ticks Access when Compose is ticked, and Access can be unticked after', () => {
    renderEditor()
    expect(checked('Grant access to tools')).toBe(false)

    tick('Compose tools')
    expect(checked('Grant access to tools')).toBe(true)

    tick('Grant access to tools')
    expect(checked('Grant access to tools')).toBe(false)
    expect(checked('Compose tools')).toBe(true)
  })

  it('asks for a root before offering agents or MCP servers, rather than an empty list', async () => {
    const props = renderEditor()
    await settle()

    expect(screen.getByText('Set a root to see which servers resolve here.')).toBeTruthy()
    expect(screen.getByText('Set a root to see which agents resolve here.')).toBeTruthy()
    expect(screen.queryAllByRole('checkbox', { name: /^MCP server/ })).toEqual([])
    expect(optionsOf('Agent')).toEqual(['Default'])
    expect(props.predict).not.toHaveBeenCalled()
  })

  it('offers the root’s agents, and a composed overlay’s under its namespace', async () => {
    const props = renderEditor({ initial: { ...BLANK, root: HUB } })
    await settle()
    expect(optionsOf('Agent')).toEqual(['Default', 'planner'])

    tick('Compose tools')
    await settle()
    expect(optionsOf('Agent')).toEqual(['Default', 'planner', 'tools:reviewer'])
    expect(props.predict).toHaveBeenLastCalledWith(HUB, [TOOLS])
  })

  it('lists the root’s MCP servers as checkboxes, and has no free-text MCP field', async () => {
    renderEditor({ initial: { ...BLANK, root: HUB } })
    await settle()

    expect(screen.getAllByRole('checkbox', { name: /^MCP server/ }).map((box) => box.getAttribute('aria-label'))).toEqual([
      'MCP server docs-search',
      'MCP server tracker'
    ])
    expect(screen.getAllByRole('textbox').map((box) => box.getAttribute('aria-label'))).toEqual([
      'Profile name',
      'Root directory',
      'Filter projects',
      'Opening prompt'
    ])
  })

  it('saves the agent picked and the servers ticked', async () => {
    const props = renderEditor({ initial: { ...BLANK, name: 'hub dev', root: HUB } })
    tick('Compose tools')
    await settle()

    choose('Agent', 'tools:reviewer')
    tick('MCP server tracker')
    fireEvent.click(screen.getByRole('button', { name: 'Save and start' }))

    expect(props.onSave).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'tools:reviewer', mcp: ['tracker'], overlays: [TOOLS] })
    )
  })

  it('keeps a saved agent and server the root cannot resolve, selected and marked unresolved', async () => {
    const saved: Profile = {
      ...BLANK,
      id: 7,
      name: 'old',
      root: HUB,
      agent: 'ghost:helper',
      mcp: ['gone-server'],
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z'
    }
    const props = renderEditor({ initial: saved, onDelete: vi.fn() })
    await settle()

    expect((screen.getByRole('combobox', { name: 'Agent' }) as HTMLSelectElement).value).toBe('ghost:helper')
    expect(optionsOf('Agent')).toContain('ghost:helper - unresolved')
    expect(screen.getByText(/Nothing at this root resolves/).textContent).toBe(
      'Nothing at this root resolves ghost:helper. It is still saved.'
    )
    const gone = screen.getByRole('checkbox', { name: 'MCP server gone-server' })
    expect((gone as HTMLInputElement).checked).toBe(true)
    expect(within(gone.closest('label') as HTMLElement).getByText('unresolved')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(props.onSave).toHaveBeenCalledWith(expect.objectContaining({ agent: 'ghost:helper', mcp: ['gone-server'] }))
  })
})
