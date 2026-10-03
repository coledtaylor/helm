import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { useState, type JSX } from 'react'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { computeEffectiveView, previewMcpAdd, type DoctorReport, type McpPreview, type McpScope, type Profile } from '@helm/core'
import { EffectiveViewPane } from './EffectiveViewPane'
import { HealthPanel } from './HealthPanel'
import { McpPanel } from './McpPanel'

/**
 * The config console's three whole-pane views: MCP servers, the effective
 * view, and `claude doctor`.
 */

let root: string

function write(rel: string, body: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true })
  writeFileSync(join(root, rel), body)
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'helm config panes-'))
  // A working directory and two overlays that both define `think`.
  write('work/.claude/skills/plan/SKILL.md', '---\nname: plan\ndescription: Plan first\n---\n')
  write('alpha/.claude/skills/think/SKILL.md', '---\nname: think\ndescription: Alpha thinking\n---\n')
  write('beta/.claude/skills/think/SKILL.md', '---\nname: think\ndescription: Beta thinking\n---\n')
  mkdirSync(join(root, 'home', '.claude'), { recursive: true })
  mkdirSync(join(root, 'mcp'), { recursive: true })
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

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
        onPreview={() => setPreview(previewMcpAdd({ ...draft, cwd }))}
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
    const cwd = join(root, 'mcp')
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

    expect(screen.getByText(join(cwd, '.mcp.json'))).toBeTruthy()
    expect(screen.getByText('"echo": {')).toBeTruthy()
    expect(existsSync(join(cwd, '.mcp.json'))).toBe(false)
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
      file: join(root, 'mcp', '.mcp.json'),
      approved: false,
      approvedBy: null,
      shadowedBy: null
    }
    render(
      <McpPanel
        cwd={join(root, 'mcp')}
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
      root: join(root, 'work'),
      overlays: [join(root, 'alpha'), join(root, 'beta')]
    } as Profile
    const view = computeEffectiveView({
      cwd: profile.root,
      overlays: profile.overlays,
      profileId: profile.id,
      profileName: profile.name,
      userHome: join(root, 'home', '.claude')
    })
    render(
      <EffectiveViewPane
        profiles={[profile]}
        profileId={7}
        onProfileChange={vi.fn()}
        cwd=""
        onCwdChange={vi.fn()}
        view={view}
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
