import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { SecretInfo, SecretInput, SecretsState } from '@helm/core/types'
import { SecretDialog, SecretsPage, type SecretPluginChoice } from './SecretsSettings'

/**
 * The dialog every secret is typed into, and Settings > Secrets.
 *
 * What matters here is what goes to main: a secret bound to the plugins and
 * hosts the user left ticked, a value only when one was typed, and nothing at
 * all when this computer cannot encrypt. The plugin that asked for a secret is
 * the reason the dialog is open, so it is always among the plugins it goes to.
 */

const SAMPLE: SecretPluginChoice = {
  id: 'sample',
  name: 'Sample',
  network: ['http://127.0.0.1:4790'],
  secrets: ['sample-token']
}
const OTHER: SecretPluginChoice = { id: 'other', name: 'Other', network: ['https://api.other.test'], secrets: [] }

const stored = (overrides: Partial<SecretInfo> = {}): SecretInfo => ({
  key: 'sample-token',
  hosts: ['https://a.example.test'],
  plugins: ['other'],
  updatedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
  ...overrides
})

function dialog(props: Partial<Parameters<typeof SecretDialog>[0]> = {}) {
  const onSave = vi.fn<(input: SecretInput) => Promise<string | null>>(async () => null)
  const onClose = vi.fn()
  const onRemove = vi.fn<(key: string) => Promise<string | null>>(async () => null)
  render(
    <SecretDialog
      existing={null}
      presetKey="sample-token"
      requester={{ id: 'sample', name: 'Sample' }}
      plugins={[SAMPLE, OTHER]}
      available
      onSave={onSave}
      onRemove={onRemove}
      onClose={onClose}
      {...props}
    />
  )
  return { onSave, onClose, onRemove }
}

const save = (): HTMLElement => screen.getByRole('button', { name: 'Save' })
const checkbox = (name: string): HTMLInputElement => screen.getByRole('checkbox', { name }) as HTMLInputElement

describe('SecretDialog', () => {
  it('asks for the key a plugin named, which cannot be changed, and saves it for that plugin and its hosts', async () => {
    const { onSave, onClose } = dialog()
    expect(screen.getByRole('dialog', { name: 'Sample needs sample-token' })).toBeTruthy()
    const key = screen.getByRole('textbox', { name: 'Key' }) as HTMLInputElement
    expect(key.value).toBe('sample-token')
    expect(key.readOnly).toBe(true)
    // A new secret needs its value.
    expect(save()).toHaveProperty('disabled', true)
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 's3cret' } })
    expect(save()).toHaveProperty('disabled', false)
    fireEvent.click(save())
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(onSave).toHaveBeenCalledWith({
      key: 'sample-token',
      value: 's3cret',
      hosts: ['http://127.0.0.1:4790'],
      plugins: ['sample']
    })
  })

  it('keeps the plugin asking ticked and fixed, even on a secret stored for another plugin, and adds its hosts', async () => {
    const { onSave } = dialog({ existing: stored() })
    expect(screen.getByRole('dialog', { name: 'Change sample-token' })).toBeTruthy()
    expect(checkbox('Sample').checked).toBe(true)
    expect(checkbox('Sample').disabled).toBe(true)
    expect(checkbox('Other').checked).toBe(true)
    expect(checkbox('https://a.example.test').checked).toBe(true)
    expect(checkbox('http://127.0.0.1:4790').checked).toBe(true)
    // A stored secret keeps its value when none is typed.
    expect(save()).toHaveProperty('disabled', false)
    fireEvent.click(save())
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(onSave).toHaveBeenCalledWith({
      key: 'sample-token',
      value: null,
      hosts: ['https://a.example.test', 'http://127.0.0.1:4790'],
      plugins: ['other', 'sample']
    })
  })

  it('leaves out a host the user unticked, and a plugin they tick offers its hosts unticked', async () => {
    const { onSave } = dialog({ existing: stored({ plugins: ['sample'] }) })
    // Ticking Other offers its host, unticked.
    fireEvent.click(checkbox('Other'))
    expect(checkbox('https://api.other.test').checked).toBe(false)
    fireEvent.click(checkbox('https://a.example.test'))
    fireEvent.click(save())
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(onSave).toHaveBeenCalledWith({ key: 'sample-token', value: null, hosts: [], plugins: ['sample', 'other'] })
  })

  it('says why it cannot save when this computer cannot encrypt, and does not let it', () => {
    const { onSave } = dialog({ available: false })
    expect(screen.getByRole('alert').textContent).toContain('cannot encrypt')
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 's3cret' } })
    expect(save()).toHaveProperty('disabled', true)
    fireEvent.click(save())
    expect(onSave).not.toHaveBeenCalled()
  })

  it('takes a typed host only when it is an origin, ticked, without its trailing slash', async () => {
    const { onSave } = dialog()
    const host = screen.getByRole('textbox', { name: 'Another host' })
    fireEvent.change(host, { target: { value: 'api.example.com/path' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add host' }))
    expect(screen.getByRole('alert').textContent).toContain('is not an origin')
    fireEvent.change(host, { target: { value: 'https://*.example.com/' } })
    fireEvent.keyDown(host, { key: 'Enter' })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(checkbox('https://*.example.com').checked).toBe(true)
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'v' } })
    fireEvent.click(save())
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(onSave.mock.calls[0]![0]).toMatchObject({ hosts: ['http://127.0.0.1:4790', 'https://*.example.com'] })
  })

  it('shows what main refused and stays open', async () => {
    const { onSave, onClose } = dialog()
    onSave.mockResolvedValueOnce('A key is letters, digits, dots, dashes and underscores.')
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'v' } })
    fireEvent.click(save())
    expect((await screen.findByRole('alert')).textContent).toContain('A key is letters')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('takes a key typed in when nothing named one', () => {
    dialog({ presetKey: null, requester: null })
    expect(screen.getByRole('dialog', { name: 'Add a secret' })).toBeTruthy()
    const key = screen.getByRole('textbox', { name: 'Key' }) as HTMLInputElement
    expect(key.readOnly).toBe(false)
    fireEvent.change(key, { target: { value: 'sample-token' } })
    // A plugin that declares the key is offered first, and says so.
    const plugins = within(screen.getByRole('group', { name: 'Plugins that may use it' })).getAllByRole('checkbox')
    expect(plugins.map((box) => box.getAttribute('aria-label'))).toEqual(['Sample', 'Other'])
    expect(screen.getByText('declares it')).toBeTruthy()
  })

  it('removes a stored secret only after a second press', async () => {
    const { onRemove, onClose } = dialog({ existing: stored() })
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(onRemove).not.toHaveBeenCalled()
    expect(screen.getByText('Plugins that use it stop working.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(onRemove).toHaveBeenCalledWith('sample-token')
  })

  it('offers no remove for a secret not stored yet', () => {
    dialog()
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull()
  })
})

function page(state: SecretsState | null) {
  const onSave = vi.fn<(input: SecretInput) => Promise<string | null>>(async () => null)
  const onRemove = vi.fn<(key: string) => Promise<string | null>>(async () => null)
  render(<SecretsPage state={state} plugins={[SAMPLE, OTHER]} onSave={onSave} onRemove={onRemove} />)
  return { onSave, onRemove }
}

describe('SecretsPage', () => {
  it('lists each secret with where it may go and who may send it, and a row opens it', () => {
    page({
      available: true,
      secrets: [stored({ plugins: ['sample', 'gone'] }), stored({ key: 'program-only', hosts: [], plugins: [] })]
    })
    const row = screen.getByRole('button', { name: /^sample-token/ })
    expect(row.textContent).toContain('https://a.example.test')
    // A plugin no longer loaded is named by its id.
    expect(row.textContent).toContain('Sample, gone')
    expect(row.textContent).toContain('3m')
    const programOnly = screen.getByRole('button', { name: /^program-only/ })
    expect(programOnly.textContent).toContain('No hosts - programs only')
    expect(programOnly.textContent).toContain('No plugin')
    fireEvent.click(row)
    expect(screen.getByRole('dialog', { name: 'Change sample-token' })).toBeTruthy()
  })

  it('says when there are none, and adds one', () => {
    page({ available: true, secrets: [] })
    expect(screen.getByText('No secrets')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Add secret' }))
    expect(screen.getByRole('dialog', { name: 'Add a secret' })).toBeTruthy()
  })

  it('says this computer cannot encrypt, and offers no add', () => {
    page({ available: false, secrets: [] })
    expect(screen.getByText('This computer cannot encrypt, so Helm stores no secrets.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add secret' })).toHaveProperty('disabled', true)
  })

  it('says nothing about secrets before main has answered', () => {
    page(null)
    expect(screen.queryByText('No secrets')).toBeNull()
    expect(screen.queryAllByRole('button', { name: /sample-token/ })).toHaveLength(0)
  })
})
