import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState, type JSX } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { DoctorReport, EffectiveView, McpPreview, McpScope, Profile } from '@helm/core'
import { EffectiveViewPane } from './EffectiveViewPane'
import recording from './fixtures/config-panels.fixture.json'
import { HealthPanel } from './HealthPanel'
import { McpPanel } from './McpPanel'
import { fixturePath, recorded } from './recorded.testkit'

/**
 * The config console's three whole-pane views: MCP servers, the effective
 * view, and `claude doctor`.
 *
 * What the host answers is recorded: `config:mcpPreview` for the `echo` server
 * below in an empty `mcp` folder, and `config:effective` for a profile whose
 * `work` root has a `plan` skill and whose overlays `alpha` and `beta` both
 * define `think`.
 */

const answers = recorded<{ mcpPreview: McpPreview; view: EffectiveView }>(recording)
const ECHO = { name: 'echo', scope: 'project' as const, json: '{"command": "node", "args": ["server.mjs"]}' }

describe('McpPanel', () => {
  /** The panel with the draft and the preview held where `useConfig` holds them. */
  function Panel({ cwd, onApply }: { cwd: string; onApply: () => void }): JSX.Element {
    const [draft, setDraft] = useState<{ name: string; scope: McpScope; json: string }>({
      name: '',
      scope: 'project',
      json: ''
    })
    const [preview, setPreview] = useState<McpPreview | null>(null)
    return (
      <McpPanel
        cwd={cwd}
        servers={[]}
        listing={null}
        listing_busy={false}
        onList={vi.fn()}
        draft={draft}
        onDraftChange={setDraft}
        preview={preview}
        onPreview={() => {
          expect({ ...draft, cwd }).toEqual({ ...ECHO, cwd: fixturePath('mcp') })
          setPreview(answers.mcpPreview)
        }}
        onApply={onApply}
        onCancelPreview={() => setPreview(null)}
        applying={false}
        result={null}
        onDismissResult={vi.fn()}
        onRemove={vi.fn()}
        onApprove={vi.fn()}
        onOpenFile={vi.fn()}
      />
    )
  }

  it('shows the change to .mcp.json before anything runs, and runs nothing until Apply', async () => {
    const cwd = fixturePath('mcp')
    const onApply = vi.fn()
    render(<Panel cwd={cwd} onApply={onApply} />)

    await userEvent.click(screen.getByRole('button', { name: 'New' }))
    const preview = screen.getByRole('button', { name: 'Show what would change' }) as HTMLButtonElement
    expect(preview.disabled).toBe(true)

    await userEvent.type(screen.getByRole('textbox', { name: 'MCP server name' }), 'echo')
    await userEvent.click(screen.getByRole('textbox', { name: 'MCP server configuration' }))
    await userEvent.paste('{"command": "node", "args": ["server.mjs"]}')
    expect(preview.disabled).toBe(false)
    await userEvent.click(preview)

    expect(screen.getByText(fixturePath('mcp/.mcp.json'))).toBeTruthy()
    expect(screen.getByText('"echo": {')).toBeTruthy()
    expect(onApply).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: 'Run claude mcp add-json' }))
    expect(onApply).toHaveBeenCalledTimes(1)
  })

  it('offers to approve a project server that is not approved yet', async () => {
    const onApprove = vi.fn()
    const server = {
      name: 'echo',
      scope: 'project' as const,
      transport: 'stdio',
      config: '{ "command": "node" }',
      file: fixturePath('mcp/.mcp.json'),
      approved: false,
      approvedBy: null,
      shadowedBy: null
    }
    render(
      <McpPanel
        cwd={fixturePath('mcp')}
        servers={[server] as Parameters<typeof McpPanel>[0]['servers']}
        listing={null}
        listing_busy={false}
        onList={vi.fn()}
        draft={{ name: '', scope: 'project', json: '' }}
        onDraftChange={vi.fn()}
        preview={null}
        onPreview={vi.fn()}
        onApply={vi.fn()}
        onCancelPreview={vi.fn()}
        applying={false}
        result={null}
        onDismissResult={vi.fn()}
        onRemove={vi.fn()}
        onApprove={onApprove}
        onOpenFile={vi.fn()}
      />
    )
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }))
    expect(onApprove).toHaveBeenCalledWith(server, true)
  })
})

describe('EffectiveViewPane', () => {
  it('paints one invocation per skill a profile resolves, and flags a name two overlays share', () => {
    const profile = {
      id: 7,
      name: 'Combo',
      root: fixturePath('work'),
      overlays: [fixturePath('alpha'), fixturePath('beta')]
    } as Profile
    render(
      <EffectiveViewPane
        profiles={[profile]}
        profileId={7}
        onProfileChange={vi.fn()}
        cwd=""
        onCwdChange={vi.fn()}
        view={answers.view}
        loading={false}
        error={null}
        onReveal={vi.fn()}
        onOpenFile={vi.fn()}
      />
    )

    expect((screen.getByRole('combobox', { name: 'Profile' }) as HTMLSelectElement).value).toBe('7')
    const resolved = screen.getByText('Resolved names').closest('section') as HTMLElement
    const invocations = within(resolved)
      .getAllByRole('listitem')
      .map((row) => within(row).getAllByRole('button')[0]?.textContent)
    expect(invocations.sort()).toEqual(['alpha:think', 'beta:think', 'plan'])

    const shared = screen.getByText('Defined more than once').closest('section') as HTMLElement
    const think = within(shared).getByRole('listitem')
    expect(within(think).getByText('think')).toBeTruthy()
    expect(within(think).getByText('alpha:think')).toBeTruthy()
    expect(within(think).getByText('beta:think')).toBeTruthy()
  })
})

describe('HealthPanel', () => {
  it('runs claude doctor on request and shows its rows, its output and its exit status', async () => {
    const onRun = vi.fn()
    const { rerender } = render(<HealthPanel report={null} running={false} onRun={onRun} claudeVersion="2.1.999" />)
    await userEvent.click(screen.getByRole('button', { name: 'Run it' }))
    expect(onRun).toHaveBeenCalledTimes(1)

    const report: DoctorReport = {
      output: 'Diagnostics\nAuto-update channel: latest\nSomething unparsed',
      rows: [{ label: 'Auto-update channel', value: 'latest' }],
      exitCode: 1,
      ranAt: new Date().toISOString(),
      durationMs: 1500,
      error: null
    }
    rerender(<HealthPanel report={report} running={false} onRun={onRun} claudeVersion="2.1.999" />)

    expect(screen.getByRole('term').textContent).toBe('Auto-update channel')
    expect(screen.getByRole('definition').textContent).toBe('latest')
    expect(screen.getByText(/Something unparsed/).textContent).toBe(report.output)
    expect(screen.getByText('exit 1')).toBeTruthy()
    // Shown, not judged: a non-zero exit is not painted as an error banner.
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button', { name: 'Run again' })).toBeTruthy()
  })
})
