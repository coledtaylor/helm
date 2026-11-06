import { describe, expect, it } from 'vitest'
import type { ChildReport } from '../types'
import { reportNote, sameReport, withReportOf, withReports } from './familyReport'

const at = '2026-11-06T10:00:00.000Z'
const report = (state: string, text = 'Two bugs in ledger.rs.'): ChildReport => ({ state, text, at })
/** A row as a window holds it: some fields of its own, and a report the host may have moved on from. */
interface Row {
  id: number
  label?: string
  lastReport?: ChildReport
}
const running = (lastReport?: ChildReport): { status: string; lastReport?: ChildReport } => ({
  status: 'running',
  ...(lastReport === undefined ? {} : { lastReport })
})

describe('reportNote', () => {
  it('says "Reported done" with all of a done report', () => {
    expect(reportNote(running(report('done')))).toEqual({
      label: 'Reported done',
      text: 'Two bugs in ledger.rs.',
      at
    })
  })

  it('says "Reported stuck" for a stuck report and "Note" for a note', () => {
    expect(reportNote(running(report('stuck', 'Which table, A or B?')))?.label).toBe('Reported stuck')
    expect(reportNote(running(report('note', 'Half way through.')))?.label).toBe('Note')
  })

  it('calls a report of a state it has no word for a note, and still shows its text', () => {
    expect(reportNote(running(report('paused')))).toMatchObject({ label: 'Note', text: 'Two bugs in ledger.rs.' })
  })

  it('has no note for a child that has reported nothing, or nothing but spaces', () => {
    expect(reportNote(running())).toBeNull()
    expect(reportNote(running(report('done', '  \n ')))).toBeNull()
  })

  it('has no note once the host has cleared the report, as it does when the child’s next turn starts', () => {
    const before = running(report('done'))
    expect(reportNote(before)).not.toBeNull()
    expect(reportNote(withReportOf(before, {}))).toBeNull()
  })

  it('has no note for a child that has ended, whatever its row still says', () => {
    for (const status of ['exited', 'lost']) {
      expect(reportNote({ status, lastReport: report('done') })).toBeNull()
    }
  })

  it('never has a note for a command child, which runs a program and not an agent', () => {
    expect(reportNote(running(report('done')), { command: true })).toBeNull()
    expect(reportNote(running(report('done')), { command: false })).not.toBeNull()
  })
})

describe('sameReport', () => {
  it('compares what was said and when', () => {
    expect(sameReport(undefined, undefined)).toBe(true)
    expect(sameReport(report('done'), report('done'))).toBe(true)
    expect(sameReport(report('done'), undefined)).toBe(false)
    expect(sameReport(undefined, report('done'))).toBe(false)
    expect(sameReport(report('done'), report('stuck'))).toBe(false)
    expect(sameReport(report('done'), report('done', 'Another.'))).toBe(false)
    expect(sameReport(report('done'), { ...report('done'), at: '2026-11-06T10:05:00.000Z' })).toBe(false)
  })
})

describe('withReportOf', () => {
  it('keeps the very same row when the report agrees', () => {
    const known: Row = { id: 4, label: 'mine', lastReport: report('done') }
    expect(withReportOf(known, { lastReport: report('done') })).toBe(known)
    const bare: Row = { id: 4, label: 'mine' }
    expect(withReportOf(bare, {})).toBe(bare)
  })

  it('takes the report the host lists and leaves the rest of the row as the window has it', () => {
    const known: Row = { id: 4, label: 'renamed here' }
    const taken = withReportOf(known, { lastReport: report('stuck') })
    expect(taken).toEqual({ id: 4, label: 'renamed here', lastReport: report('stuck') })
    expect(known).not.toHaveProperty('lastReport')
  })

  it('goes without a report the host no longer lists', () => {
    const taken = withReportOf({ id: 4, lastReport: report('done') }, {})
    expect(taken).toEqual({ id: 4 })
    expect(taken).not.toHaveProperty('lastReport')
  })
})

describe('withReports', () => {
  it('returns null when no report changed, so the sessions the window holds stay as they are', () => {
    const current = [{ id: 1 }, { id: 2, lastReport: report('done') }]
    expect(withReports(current, [{ id: 1 }, { id: 2, lastReport: report('done') }, { id: 3 }])).toBeNull()
  })

  it('replaces only the rows whose report changed, and ignores a listed row it does not hold', () => {
    const one = { id: 1 }
    const two = { id: 2, lastReport: report('done') }
    const three = { id: 3, lastReport: report('note') }
    const next = withReports(
      [one, two, three],
      [{ id: 2 }, { id: 3, lastReport: report('note') }, { id: 9, lastReport: report('done') }]
    )!
    expect(next).toEqual([one, { id: 2 }, three])
    expect(next[0]).toBe(one)
    expect(next[2]).toBe(three)
  })
})
