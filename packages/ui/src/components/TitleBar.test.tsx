import { render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TitleBar } from './TitleBar'

function runningOn(platform: 'MacIntel' | 'Win32' | 'Linux x86_64'): void {
  vi.spyOn(Navigator.prototype, 'platform', 'get').mockReturnValue(platform)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('TitleBar', () => {
  it('on macOS leaves the left of the strip to the traffic lights, puts the mark after them, and keeps no right reserve', () => {
    runningOn('MacIntel')
    const { container } = render(<TitleBar />)
    const strip = container.firstElementChild!
    expect(strip.classList.contains('app-drag')).toBe(true)
    expect(strip.classList.contains('pr-36')).toBe(false)

    const lights = strip.firstElementChild!
    expect(lights.hasAttribute('data-traffic-lights')).toBe(true)
    // 80px: 14px in, three 14px lights 20px apart, and a gap.
    expect(lights.classList.contains('w-20')).toBe(true)
    expect(lights.childElementCount).toBe(0)
    expect(lights.querySelector('button, a, input, [tabindex]')).toBeNull()

    const mark = strip.querySelector('[aria-label="Helm"]')
    expect(mark).not.toBeNull()
    expect(lights.contains(mark)).toBe(false)
    expect(lights.compareDocumentPosition(mark!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('on Windows keeps the mark first over the rail and the right clear for the window controls', () => {
    runningOn('Win32')
    const { container } = render(<TitleBar />)
    const strip = container.firstElementChild!
    expect(strip.classList.contains('pr-36')).toBe(true)
    expect(strip.querySelector('[data-traffic-lights]')).toBeNull()
    expect(strip.firstElementChild!.querySelector('[aria-label="Helm"]')).not.toBeNull()
  })

  it('on Linux is drawn as on Windows, under the native frame', () => {
    runningOn('Linux x86_64')
    const { container } = render(<TitleBar />)
    expect(container.querySelector('[data-traffic-lights]')).toBeNull()
    expect(container.firstElementChild!.classList.contains('pr-36')).toBe(true)
  })
})
