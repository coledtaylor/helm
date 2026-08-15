import { describe, expect, it } from 'vitest'
import {
  TITLE_MAX,
  cleanPrompt,
  deriveSessionTitle,
  sessionTitleFrom,
  titleRank
} from './title'

/**
 * The four cases the pane was failing at, one describe each, plus the one that
 * has no good answer - a session where nothing anybody typed says anything -
 * which must still produce something legible rather than an empty row.
 */

describe('titleRank', () => {
  it('ranks prose as a subject', () => {
    expect(titleRank('add geofencing to the map')).toBe(0)
    expect(titleRank('Whycdid my pc shutdown?')).toBe(0)
  })

  it('ranks a bare slash command as legible but subjectless', () => {
    expect(titleRank('/usage')).toBe(1)
    expect(titleRank('/exit')).toBe(1)
    expect(titleRank('/spec:execute-phase 1')).toBe(1)
    // The argument is a switch, which is no more a subject than the number is.
    expect(titleRank('/gsd:plan-phase 1 --research')).toBe(1)
  })

  it('ranks a slash command with prose arguments as a subject', () => {
    expect(titleRank('/spec:quick when a user clicks the admin menu nothing opens')).toBe(0)
  })

  it('ranks a single word as legible but subjectless', () => {
    expect(titleRank('continue')).toBe(1)
    expect(titleRank('1')).toBe(1)
  })

  it('ranks an empty or attachment-only prompt as nothing at all', () => {
    expect(titleRank('')).toBe(2)
    expect(titleRank('   \n ')).toBe(2)
    expect(titleRank('[Image #1]')).toBe(2)
    expect(titleRank('[Image #1] [Image #2]')).toBe(2)
    expect(titleRank('[Pasted text #1 +142 lines]')).toBe(2)
  })
})

describe('cleanPrompt', () => {
  it('takes the attachment placeholders out and puts the prompt on one line', () => {
    expect(cleanPrompt('What is causing this [Image #1]')).toBe('What is causing this')
    expect(cleanPrompt('look at\n\nthis  please')).toBe('look at this please')
  })
})

describe('deriveSessionTitle', () => {
  it('keeps a short prompt verbatim', () => {
    expect(deriveSessionTitle('add geofencing to the map')).toEqual({
      text: 'add geofencing to the map',
      fallback: false
    })
  })

  it('truncates on a word boundary', () => {
    const prompt =
      'I want to rethink the pull request pane to make it easier to see the ones that need attention'
    const { text } = deriveSessionTitle(prompt)

    expect(text.endsWith('…')).toBe(true)
    expect(text.length).toBeLessThanOrEqual(TITLE_MAX + 1)
    // The last word is whole: what is kept is a prefix of the prompt that ends
    // where a word ends.
    const kept = text.slice(0, -1)
    expect(prompt.startsWith(kept)).toBe(true)
    expect(prompt[kept.length]).toBe(' ')
  })

  it('cuts mid-word only when there is no word boundary worth keeping', () => {
    const url = `https://example.test/${'a'.repeat(200)}`
    const { text } = deriveSessionTitle(`${url} fix this`)
    expect(text).toBe(`${url.slice(0, TITLE_MAX)}…`)
  })

  it('never returns an empty title', () => {
    expect(deriveSessionTitle('')).toEqual({ text: 'No prompt recorded', fallback: true })
    expect(deriveSessionTitle(null)).toEqual({ text: 'No prompt recorded', fallback: true })
    expect(deriveSessionTitle('[Image #1]')).toEqual({ text: 'Image only', fallback: true })
    expect(deriveSessionTitle('[Pasted text #1 +9 lines]')).toEqual({
      text: 'Pasted text only',
      fallback: true
    })
  })
})

describe('sessionTitleFrom', () => {
  it('reads past a slash command to the prompt that says something', () => {
    expect(sessionTitleFrom(['/usage', 'why is the status bar blank on a fresh install'])).toEqual({
      text: 'why is the status bar blank on a fresh install',
      fallback: false
    })
  })

  it('reads past an empty opening prompt', () => {
    expect(sessionTitleFrom(['', 'rename the profiles pane']).text).toBe('rename the profiles pane')
  })

  it('reads past an image-only opening prompt', () => {
    expect(sessionTitleFrom(['[Image #1]', 'this button is misaligned']).text).toBe(
      'this button is misaligned'
    )
  })

  it('drops the placeholder from a prompt that also says something', () => {
    expect(sessionTitleFrom(['What is causing this [Image #1]']).text).toBe('What is causing this')
  })

  it('falls back to the most legible prompt when none of them says anything', () => {
    // Legible beats nothing: the session really was `/usage`, twice, and saying
    // so is better than saying nothing.
    expect(sessionTitleFrom(['[Image #1]', '/usage', '/usage'])).toEqual({
      text: '/usage',
      fallback: false
    })
  })

  it('falls back to Helm’s own words when every prompt is empty', () => {
    expect(sessionTitleFrom(['', '   '])).toEqual({ text: 'No prompt recorded', fallback: true })
    expect(sessionTitleFrom([])).toEqual({ text: 'No prompt recorded', fallback: true })
    expect(sessionTitleFrom(['[Image #1]', '[Image #2]'])).toEqual({
      text: 'Image only',
      fallback: true
    })
  })

  it('takes the first of two prompts that both say something', () => {
    expect(sessionTitleFrom(['open the pull request pane', 'now close it']).text).toBe(
      'open the pull request pane'
    )
  })
})
