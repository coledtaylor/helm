import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { ContentFile } from '@helm/core'
import { ContentDocumentPane, type ArtifactConsoleEntry } from './ContentDocumentPane'

const REPORT: ContentFile = {
  path: 'C:\\vault\\notes\\report.html',
  relPath: 'notes/report.html',
  root: 'notes',
  rootKind: 'notes',
  kind: 'html',
  slug: 'report',
  ext: 'html',
  title: 'Report',
  size: 2048,
  mtimeMs: 0,
  noteType: null,
  date: null,
  tags: []
}

const LOGGED: ArtifactConsoleEntry[] = [
  { level: 'info', message: 'chart drawn', source: 'helm-content://artifact/abc/report.html', line: 12 },
  { level: 'error', message: 'axis data missing', source: 'helm-content://artifact/abc/report.html', line: 30 }
]

/**
 * An HTML artifact's console: the count in the frame's header is the toggle,
 * and the panel it opens is the browser pane's, read-only.
 */
describe('ContentDocumentPane - the artifact console', () => {
  it('opens from the count in the header, shows what the frame logged, and offers no input line', async () => {
    const user = userEvent.setup()
    render(
      <ContentDocumentPane
        file={REPORT}
        document={null}
        preview={null}
        previewPending={false}
        mode="read"
        onModeChange={vi.fn()}
        artifactUrl="helm-content://artifact/abc/report.html"
        artifactConsole={LOGGED}
        snapshots={[]}
        saving={false}
        error={null}
        external={null}
        highlight={null}
        wrapDefault={false}
        wrapIndent={2}
        onSave={vi.fn()}
        onReload={vi.fn()}
        onRestore={vi.fn()}
        onReveal={vi.fn()}
        onDirtyChange={vi.fn()}
        onDraftChange={vi.fn()}
        onOpenPath={vi.fn()}
        onOpenWikilink={vi.fn()}
        onOpenExternal={vi.fn()}
      />
    )
    const count = screen.getByRole('button', { name: '1 console error' })
    expect(count.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('axis data missing')).toBeNull()

    await user.click(count)
    expect(count.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('chart drawn')).toBeTruthy()
    expect(screen.getByText('axis data missing')).toBeTruthy()
    expect(screen.getByText(/^Read-only\./)).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: 'Evaluate JavaScript in the page' })).toBeNull()

    await user.click(count)
    expect(screen.queryByText('axis data missing')).toBeNull()
  })
})
