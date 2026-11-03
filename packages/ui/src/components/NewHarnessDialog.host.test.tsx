import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { TemplateChoice } from '@helm/core'
import { NewHarnessDialog, type NewHarnessDialogProps } from './NewHarnessDialog'

/** build-box's own templates, as its `template:list` answers. */
const BUILD_BOX_TEMPLATES: TemplateChoice[] = [
  { id: 'minimal', label: 'Minimal', description: 'A manifest and nothing else.', order: null, builtIn: true },
  { id: 'infra', label: 'Infra', description: 'Runbooks and deploy scripts.', order: 1, builtIn: false }
]

function Typed(props: Omit<NewHarnessDialogProps, 'dir' | 'onDirChange'> & { initial: string }) {
  const [dir, setDir] = useState(props.initial)
  return <NewHarnessDialog {...props} dir={dir} onDirChange={setDir} />
}

describe('NewHarnessDialog on another host', () => {
  it('says it creates on build-box, takes a typed path in build-box’s form with no Choose…, and lists build-box’s templates', async () => {
    const onCreate = vi.fn()
    const onChooseDir = vi.fn()
    render(
      <Typed
        mode="new"
        initial="/home/you/work"
        host="build-box"
        onChooseDir={onChooseDir}
        templates={BUILD_BOX_TEMPLATES}
        template="minimal"
        onTemplateChange={vi.fn()}
        onCreate={onCreate}
        onCancel={vi.fn()}
      />
    )

    expect(screen.getByRole('dialog', { name: 'Create a harness on build-box' })).toBeTruthy()
    expect(screen.getByRole('heading').textContent).toBe('New harness on build-box')
    expect(screen.queryByRole('button', { name: 'Choose…' })).toBeNull()
    expect(screen.getByText(/nothing is written on this PC/)).toBeTruthy()
    expect(screen.getByText('Infra')).toBeTruthy()

    const parent = screen.getByRole('textbox', { name: 'Parent folder on build-box' })
    expect((parent as HTMLInputElement).value).toBe('/home/you/work')
    await userEvent.clear(parent)
    await userEvent.type(parent, '/srv/work')
    await userEvent.type(screen.getByRole('textbox', { name: 'Harness name' }), 'ops')
    // The target is joined in build-box's own form.
    expect(screen.getByTitle('/srv/work/ops')).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: /Create/ }))
    expect(onCreate).toHaveBeenCalledWith({ mode: 'new', dir: '/srv/work', name: 'ops', template: 'minimal' })
    expect(onChooseDir).not.toHaveBeenCalled()
  })
})
