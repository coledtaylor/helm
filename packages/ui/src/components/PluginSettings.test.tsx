import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { PluginInfo, PluginLogLine, PluginMetrics } from '@helm/core/types'
import { PluginPage, PluginsPage, type PluginPageProps } from './PluginSettings'

/**
 * Settings > Plugins and a plugin's own page.
 *
 * The list says which plugins are on and which failed; the page says what a
 * plugin is allowed - hosts, programs, secrets - before anything about how it
 * looks, writes its settings back one edit at a time, and removes it only after
 * asking, offering the secrets nobody else uses.
 */

const plugin = (overrides: Partial<PluginInfo> = {}): PluginInfo => ({
  path: 'C:\\plugins\\sample',
  id: 'sample',
  name: 'Sample',
  version: '1.0.0',
  description: 'Items from a small API.',
  enabled: true,
  error: null,
  warnings: [],
  revision: 3,
  icon: null,
  rail: { title: 'Sample', panel: 'main' },
  panels: {},
  tabs: {},
  background: null,
  commands: [],
  settings: [],
  settingValues: {},
  network: ['http://127.0.0.1:4790'],
  secrets: [],
  exec: [],
  service: null,
  runsPrograms: false,
  status: null,
  badge: null,
  ...overrides
})

describe('PluginsPage', () => {
  it('says there are none, and adds a folder', () => {
    const onAdd = vi.fn()
    render(<PluginsPage plugins={[]} addError={null} onAdd={onAdd} onOpen={vi.fn()} />)
    expect(screen.getByText('No plugins')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Add folder' }))
    expect(onAdd).toHaveBeenCalledTimes(1)
  })

  it('says nothing about plugins before main has answered', () => {
    render(<PluginsPage plugins={null} addError={null} onAdd={vi.fn()} onOpen={vi.fn()} />)
    expect(screen.queryByText('No plugins')).toBeNull()
  })

  it('lists each folder with its version and path, says Off or Not loaded, and opens one', () => {
    const onOpen = vi.fn()
    render(
      <PluginsPage
        plugins={[
          plugin(),
          plugin({ path: 'C:\\plugins\\off', id: 'off', name: 'Off one', enabled: false }),
          plugin({ path: 'C:\\plugins\\broken', id: null, name: 'C:\\plugins\\broken', version: null, error: 'no manifest' })
        ]}
        addError={null}
        onAdd={vi.fn()}
        onOpen={onOpen}
      />
    )
    const on = screen.getByRole('button', { name: /^Sample/ })
    expect(on.textContent).toContain('1.0.0')
    expect(on.textContent).toContain('C:\\plugins\\sample')
    expect(on.querySelector('[data-plugin-state]')).toBeNull()
    expect(screen.getByRole('button', { name: /^Off one/ }).querySelector('[data-plugin-state="off"]')?.textContent).toBe('Off')
    const broken = document.querySelector('[data-plugin-row="C:\\\\plugins\\\\broken"]')!
    expect(broken.querySelector('[data-plugin-state="error"]')?.textContent).toBe('Not loaded')
    fireEvent.click(on)
    expect(onOpen).toHaveBeenCalledWith('C:\\plugins\\sample')
  })

  it('says why the last folder picked was not added', () => {
    render(<PluginsPage plugins={[]} addError="That folder holds no helm-plugin.json." onAdd={vi.fn()} onOpen={vi.fn()} />)
    expect(screen.getByText('That folder holds no helm-plugin.json.')).toBeTruthy()
  })
})

function renderPage(overrides: Partial<PluginPageProps> = {}): PluginPageProps {
  const props = pageProps(overrides)
  render(<PluginPage {...props} />)
  return props
}

const group = (name: string): HTMLElement => document.querySelector<HTMLElement>(`[data-settings-group="${name}"]`)!

describe('PluginPage: what it is', () => {
  it('is on, with its folder, id, version and what it costs', () => {
    const metrics: PluginMetrics = { path: 'C:\\plugins\\sample', plugin: 'sample', memoryKb: 2048, cpuPercent: 1.25, processes: 2 }
    renderPage({ metrics })
    expect(document.querySelector('[data-plugin-verdict="on"]')?.textContent).toBe('On')
    const status = group('plugin-status').textContent ?? ''
    expect(status).toContain('C:\\plugins\\sample')
    expect(status).toContain('sample')
    expect(status).toContain('1.0.0')
    expect(status).toContain('2.0 MB memory · 1.3% CPU · 2 processes')
  })

  it('says Unknown when it could not look', () => {
    renderPage({ metrics: { path: 'p', plugin: 'sample', memoryKb: null, cpuPercent: null, processes: 0 } })
    expect(group('plugin-status').textContent).toContain('Unknown')
  })

  it('is off: says so, and says nothing of what it uses', () => {
    renderPage({ plugin: plugin({ enabled: false }) })
    expect(document.querySelector('[data-plugin-verdict="off"]')?.textContent).toContain('Turned off')
    expect(group('plugin-status').textContent).not.toContain('Uses')
    expect(screen.getByRole('button', { name: 'Turn on' })).toBeTruthy()
  })

  it('failed to load: says why, with no settings, network or programs to show', () => {
    renderPage({
      plugin: plugin({ error: 'apiVersion 2 is not supported', settings: [{ key: 'a', type: 'toggle', label: 'A' }], runsPrograms: true })
    })
    expect(document.querySelector('[data-plugin-verdict="error"]')?.textContent).toBe('Not loaded: apiVersion 2 is not supported')
    expect(document.querySelector('[data-settings-group="plugin-settings"]')).toBeNull()
    expect(document.querySelector('[data-settings-group="plugin-network"]')).toBeNull()
    expect(document.querySelector('[data-settings-group="plugin-programs"]')).toBeNull()
  })

  it('lists what the manifest got wrong without failing', () => {
    renderPage({ plugin: plugin({ warnings: ['unknown field "colour"', 'unknown field "size"'] }) })
    const warnings = document.querySelector('[data-plugin-warnings]')!
    expect([...warnings.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      'unknown field "colour"',
      'unknown field "size"'
    ])
  })

  it('says how its background page is, a crash with its reason as a clause', () => {
    renderPage({
      plugin: plugin({
        background: { url: 'helm-plugin://sample/bg.html', state: 'crashed', error: 'The page ended unexpectedly.' }
      })
    })
    expect(document.querySelector('[data-plugin-background="crashed"]')?.textContent).toBe(
      'Its background page stopped: the page ended unexpectedly. Reload starts it again.'
    )
  })

  it('reloads and turns off from its own buttons', () => {
    const props = renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    fireEvent.click(screen.getByRole('button', { name: 'Turn off' }))
    expect(props.onReload).toHaveBeenCalledTimes(1)
    expect(props.onSetEnabled).toHaveBeenCalledWith(false)
  })
})

describe('PluginPage: what it may reach', () => {
  it('lists its origins, or says it makes no requests', () => {
    renderPage({ plugin: plugin({ network: ['https://api.example.com', 'https://*.example.org'] }) })
    expect([...document.querySelectorAll('[data-plugin-network] li')].map((li) => li.textContent)).toEqual([
      'https://api.example.com',
      'https://*.example.org'
    ])
  })

  it('says None when it has no origins', () => {
    renderPage({ plugin: plugin({ network: [] }) })
    expect(group('plugin-network').textContent).toContain('None. It makes no requests.')
  })

  it('says it runs programs only when it does, with each program and its service', () => {
    renderPage({
      plugin: plugin({
        runsPrograms: true,
        exec: [{ name: 'echo', command: 'node', args: ['programs/echo.mjs'] }],
        service: {
          kind: 'node',
          command: 'service/main.mjs',
          start: 'demand',
          state: 'crashed',
          pid: 4100,
          port: 51234,
          restarts: 2,
          error: 'it exited with code 1'
        }
      })
    })
    const programs = group('plugin-programs')
    expect(within(programs).getByText('Runs programs on this computer, with your rights.')).toBeTruthy()
    expect(programs.querySelector('[data-plugin-exec] li')?.textContent).toBe('echonode programs/echo.mjs')
    const service = programs.querySelector('[data-plugin-service="crashed"]')!
    expect(service.textContent).toContain('service/main.mjs')
    expect(service.textContent).toContain('on its first request')
    expect(service.textContent).toContain('4100')
    expect(service.textContent).toContain('51234')
    expect(service.textContent).toContain('Crashes2')
    expect(service.textContent).toContain('it exited with code 1')
  })

  it('has no programs group for a plugin that runs nothing', () => {
    renderPage()
    expect(screen.queryByText('Runs programs on this computer, with your rights.')).toBeNull()
  })
})

describe('PluginPage: its settings', () => {
  const settings: PluginInfo['settings'] = [
    { key: 'server', type: 'text', label: 'Server', default: 'http://127.0.0.1:4790' },
    { key: 'limit', type: 'number', label: 'Items shown', min: 1, max: 100 },
    { key: 'unreadOnly', type: 'toggle', label: 'Unread only' },
    {
      key: 'order',
      type: 'select',
      label: 'Order',
      options: [
        { value: 'new', label: 'Newest first' },
        { value: 'old', label: 'Oldest first' }
      ]
    },
    { key: 'token', type: 'secret', label: 'Token', secret: 'sample-token', description: 'Sent as a bearer token.' }
  ]
  const withSettings = plugin({
    settings,
    settingValues: { server: 'http://127.0.0.1:4790', limit: 20, unreadOnly: false, order: 'new' },
    secrets: [{ key: 'sample-token', state: 'missing' }]
  })

  it('writes text once, when the field is left, and an emptied field as null', () => {
    const props = renderPage({ plugin: withSettings })
    const server = screen.getByRole('textbox', { name: 'Server' })
    fireEvent.change(server, { target: { value: 'http://127.0.0.1:47' } })
    fireEvent.change(server, { target: { value: 'http://127.0.0.1:4791' } })
    expect(props.onSetSetting).not.toHaveBeenCalled()
    fireEvent.blur(server)
    expect(props.onSetSetting).toHaveBeenCalledWith('server', 'http://127.0.0.1:4791')
    fireEvent.change(server, { target: { value: '' } })
    fireEvent.keyDown(server, { key: 'Enter' })
    expect(props.onSetSetting).toHaveBeenLastCalledWith('server', null)
  })

  it('puts an edit back on Escape', () => {
    const props = renderPage({ plugin: withSettings })
    const server = screen.getByRole('textbox', { name: 'Server' }) as HTMLInputElement
    fireEvent.change(server, { target: { value: 'typo' } })
    fireEvent.keyDown(server, { key: 'Escape' })
    expect(server.value).toBe('http://127.0.0.1:4790')
    expect(props.onSetSetting).not.toHaveBeenCalled()
  })

  it('clamps a number to its bounds, and puts back what is not a number', () => {
    const props = renderPage({ plugin: withSettings })
    const limit = screen.getByRole('textbox', { name: 'Items shown' }) as HTMLInputElement
    fireEvent.change(limit, { target: { value: '500' } })
    fireEvent.blur(limit)
    expect(props.onSetSetting).toHaveBeenCalledWith('limit', 100)
    expect(limit.value).toBe('100')
    fireEvent.change(limit, { target: { value: 'many' } })
    fireEvent.blur(limit)
    expect(limit.value).toBe('20')
    expect(props.onSetSetting).toHaveBeenCalledTimes(1)
  })

  it('writes a toggle and a choice at once', () => {
    const props = renderPage({ plugin: withSettings })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Unread only' }))
    expect(props.onSetSetting).toHaveBeenCalledWith('unreadOnly', true)
    fireEvent.change(screen.getByRole('combobox', { name: 'Order' }), { target: { value: 'old' } })
    expect(props.onSetSetting).toHaveBeenCalledWith('order', 'old')
  })

  it('shows what main refused', async () => {
    const props = renderPage({ plugin: withSettings })
    vi.mocked(props.onSetSetting).mockResolvedValueOnce('Items shown is at most 100')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Unread only' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Items shown is at most 100')
  })

  it('draws a secret setting with its state, and its button opens the dialog for this plugin', () => {
    renderPage({ plugin: withSettings })
    const row = document.querySelector('[data-plugin-secret="Token"]')!
    expect(row.textContent).toContain('Not stored yet. Sent as a bearer token.')
    fireEvent.click(within(row as HTMLElement).getByRole('button', { name: 'Add value' }))
    expect(screen.getByRole('dialog', { name: 'Sample needs sample-token' })).toBeTruthy()
    // A secret drawn as a setting is not drawn again under Secrets.
    expect(document.querySelector('[data-settings-group="plugin-secrets"]')).toBeNull()
  })

  it('lists a declared secret no setting names under Secrets, as stored', () => {
    renderPage({ plugin: plugin({ secrets: [{ key: 'api-key', state: 'ready' }] }) })
    const row = group('plugin-secrets').querySelector('[data-plugin-secret="api-key"]')!
    expect(row.textContent).toContain('Stored')
    expect(within(row as HTMLElement).getByRole('button', { name: 'Change' })).toBeTruthy()
  })
})

describe('PluginPage: its log', () => {
  it('says it is reading, then that there is nothing, then the lines with a time each', () => {
    const { rerender } = render(<PluginPage {...pageProps({ log: null })} />)
    expect(group('plugin-log').textContent).toContain('Reading…')
    rerender(<PluginPage {...pageProps({ log: [] })} />)
    expect(group('plugin-log').textContent).toContain('Nothing yet.')
    const log: PluginLogLine[] = [
      { at: '2026-10-05T16:14:46.000Z', stream: 'helm', text: 'reloaded from Settings' },
      { at: '2026-10-05T16:14:47.000Z', stream: 'out', text: 'listening on 51384' },
      { at: '2026-10-05T16:14:48.000Z', stream: 'err', text: 'it broke' }
    ]
    rerender(<PluginPage {...pageProps({ log })} />)
    const lines = [...document.querySelectorAll('[data-plugin-log] > div')]
    expect(lines.map((line) => line.lastElementChild?.textContent)).toEqual([
      'reloaded from Settings',
      'listening on 51384',
      'it broke'
    ])
    expect(lines[2]!.lastElementChild?.className).toContain('text-danger')
    expect(lines[0]!.firstElementChild?.textContent).not.toBe('')
  })
})

describe('PluginPage: removing it', () => {
  it('asks first, offering the secrets only it uses unticked, and passes on the ones ticked', async () => {
    const props = renderPage({ ownSecrets: vi.fn(async () => ['sample-token', 'other-key']) })
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    const confirm = await screen.findByRole('alertdialog', { name: 'Remove Sample' })
    // The safe answer has the focus.
    expect(document.activeElement).toBe(within(confirm).getByRole('button', { name: 'Cancel' }))
    const boxes = within(confirm).getAllByRole('checkbox') as HTMLInputElement[]
    expect(boxes.map((box) => [box.getAttribute('aria-label'), box.checked])).toEqual([
      ['sample-token', false],
      ['other-key', false]
    ])
    fireEvent.click(within(confirm).getByRole('checkbox', { name: 'other-key' }))
    fireEvent.click(within(confirm).getByRole('button', { name: 'Remove' }))
    expect(props.onRemove).toHaveBeenCalledWith(['other-key'])
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  })

  it('removes nothing when cancelled, and asks without secrets when it has none', async () => {
    const props = renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    const confirm = await screen.findByRole('alertdialog', { name: 'Remove Sample' })
    expect(within(confirm).queryAllByRole('checkbox')).toHaveLength(0)
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }))
    expect(props.onRemove).not.toHaveBeenCalled()
  })
})

function pageProps(overrides: Partial<PluginPageProps>): PluginPageProps {
  return {
    plugin: plugin(),
    plugins: [plugin()],
    metrics: null,
    log: [],
    secrets: { available: true, secrets: [] },
    onSetEnabled: vi.fn(),
    onReload: vi.fn(),
    ownSecrets: vi.fn(async () => []),
    onRemove: vi.fn(),
    onSetSetting: vi.fn(async () => null),
    onSaveSecret: vi.fn(async () => null),
    onRemoveSecret: vi.fn(async () => null),
    ...overrides
  }
}
