import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { HostChoice } from './HostSwitch'
import { HostSwitch } from './HostSwitch'
import { FilesRootPicker } from './FilesTree'
import { PluginsPage } from './PluginSettings'
import { UsageStatus } from './UsageStatus'

const HOSTS = [
  { id: 'local', name: 'This PC', remote: false },
  { id: 'h1', name: 'build-box', remote: true }
] as const

const choice = (host: string, onHostChange = vi.fn()): HostChoice => ({ hosts: HOSTS, host, onHostChange })

describe('HostSwitch', () => {
  it('draws nothing while this PC is the only host', () => {
    const { container } = render(
      <HostSwitch surface="History" hosts={[HOSTS[0]]} host="local" onHostChange={vi.fn()} />
    )
    expect(container.innerHTML).toBe('')
    const none = render(<HostSwitch surface="History" />)
    expect(none.container.innerHTML).toBe('')
  })

  it('names the host shown, this PC first, a remote host in mono, and switches to another', async () => {
    const onHostChange = vi.fn()
    render(<HostSwitch surface="History" {...choice('local', onHostChange)} />)
    const group = screen.getByRole('radiogroup', { name: 'History host' })
    const options = within(group).getAllByRole('radio')
    expect(options.map((each) => each.textContent)).toEqual(['This PC', 'build-box'])
    expect(options[0]?.getAttribute('aria-checked')).toBe('true')
    expect(options[1]?.getAttribute('aria-checked')).toBe('false')
    expect(options[1]?.className).toContain('font-mono')
    expect(group?.getAttribute('title')).toBe('Showing This PC’s history')

    await userEvent.click(options[0]!)
    expect(onHostChange).not.toHaveBeenCalled()
    await userEvent.click(options[1]!)
    expect(onHostChange).toHaveBeenCalledWith('h1')
  })
})

describe('Files root picker on more than one host', () => {
  it('lists one host’s folders and says which host, with a switch', async () => {
    const onHostChange = vi.fn()
    render(
      <FilesRootPicker
        roots={[{ kind: 'project', path: '/home/you/work/infra', label: 'infra' }]}
        value="/home/you/work/infra"
        onChange={vi.fn()}
        hostChoice={choice('h1', onHostChange)}
      />
    )
    const group = screen.getByRole('radiogroup', { name: 'Files host' })
    expect(within(group).getByRole('radio', { checked: true })?.textContent).toContain('build-box')
    expect(screen.getByRole('button', { name: 'Project' })?.textContent).toContain('infra')
    await userEvent.click(within(group).getByRole('radio', { name: 'This PC' }))
    expect(onHostChange).toHaveBeenCalledWith('local')
  })

  it('has no switch with only this PC', () => {
    render(<FilesRootPicker roots={[]} value={null} onChange={vi.fn()} />)
    expect(screen.queryByRole('radiogroup')).toBeNull()
  })
})

describe('Usage on more than one host', () => {
  it('names the host whose usage it shows, with a switch', async () => {
    const onHostChange = vi.fn()
    render(
      <UsageStatus snapshot={null} mode="percent" onModeChange={vi.fn()} hostChoice={choice('local', onHostChange)} />
    )
    const group = screen.getByRole('radiogroup', { name: 'Usage host' })
    expect(within(group).getByRole('radio', { checked: true })?.textContent).toContain('This PC')
    await userEvent.click(within(group).getByRole('radio', { name: 'build-box' }))
    expect(onHostChange).toHaveBeenCalledWith('h1')
  })

  it('says Unknown and why while the shown host’s usage cannot be read, never a figure', () => {
    render(
      <UsageStatus
        snapshot={null}
        mode="percent"
        onModeChange={vi.fn()}
        error="build-box is not connected."
        hostChoice={choice('h1')}
      />
    )
    const segment = document.querySelector('[data-usage-segment]')
    expect(segment?.getAttribute('data-usage-segment')).toBe('unknown')
    expect(segment?.textContent).toContain('Unknown')
    expect(segment?.getAttribute('title')).toBe('Usage could not be read: build-box is not connected.')
  })

  it('looks as it always has with only this PC', () => {
    render(<UsageStatus snapshot={null} mode="percent" onModeChange={vi.fn()} />)
    expect(screen.queryByRole('radiogroup')).toBeNull()
    expect(document.querySelector('[data-usage-segment]')?.textContent).toContain('Usage')
  })
})

describe('Settings > Plugins on more than one host', () => {
  it('lists one host’s plugins and says which host, with a switch', async () => {
    const onHostChange = vi.fn()
    render(
      <PluginsPage plugins={[]} addError={null} onAdd={vi.fn()} onOpen={vi.fn()} hostChoice={choice('local', onHostChange)} />
    )
    const group = screen.getByRole('radiogroup', { name: 'Plugins host' })
    expect(within(group).getByRole('radio', { checked: true })?.textContent).toContain('This PC')
    await userEvent.click(within(group).getByRole('radio', { name: 'build-box' }))
    expect(onHostChange).toHaveBeenCalledWith('h1')
  })

  it('adds a folder on a host on another computer by its typed path, not this PC’s picker', async () => {
    const onAdd = vi.fn()
    render(
      <PluginsPage
        plugins={[]}
        addError={null}
        onAdd={onAdd}
        onOpen={vi.fn()}
        hostChoice={choice('h1')}
        remoteHost="build-box"
      />
    )
    await userEvent.click(screen.getByRole('button', { name: /Add folder/ }))
    expect(onAdd).not.toHaveBeenCalled()
    await userEvent.type(screen.getByRole('textbox', { name: 'Plugin folder on build-box' }), '/srv/plugins/trackr{Enter}')
    expect(onAdd).toHaveBeenCalledWith('/srv/plugins/trackr')
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('picks the folder on this PC with only this PC', async () => {
    const onAdd = vi.fn()
    render(<PluginsPage plugins={[]} addError={null} onAdd={onAdd} onOpen={vi.fn()} />)
    expect(screen.queryByRole('radiogroup')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /Add folder/ }))
    expect(onAdd).toHaveBeenCalledWith()
  })
})
