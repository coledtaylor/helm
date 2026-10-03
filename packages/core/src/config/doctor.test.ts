import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runDoctor } from './doctor'

/**
 * `claude doctor`, run against a stand-in that prints a known report and exits
 * with a known status, so the rows and the raw text can be checked against
 * what was printed.
 */
describe('runDoctor', () => {
  let dir: string
  const OUTPUT = [
    'Diagnostics',
    ' └ Currently running: native (2.1.999)',
    'Auto-update channel: latest',
    'Install path: C:\\Tools\\claude.exe',
    'Something the parse has no row for',
    '  Indented detail: belongs to the line above'
  ].join('\n')

  const script = (exitCode: number): string => {
    const file = join(dir, `doctor-${String(exitCode)}.mjs`)
    writeFileSync(
      file,
      [
        `if (process.argv[2] !== 'doctor') { process.stderr.write('not asked for doctor'); process.exit(9) }`,
        `process.stdout.write(${JSON.stringify(`${OUTPUT}\n`)})`,
        `process.exit(${String(exitCode)})`
      ].join('\n')
    )
    return file
  }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'helm-doctor-'))
  })

  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('lays out Label: value lines as rows and keeps every line in the raw output', async () => {
    const report = await runDoctor({ file: process.execPath, prefixArgs: [script(0)] })

    expect(report.rows).toEqual([
      { label: 'Auto-update channel', value: 'latest' },
      { label: 'Install path', value: 'C:\\Tools\\claude.exe' }
    ])
    expect(report.output).toBe(OUTPUT)
    expect(report.exitCode).toBe(0)
    expect(report.error).toBeNull()
  })

  it('reports a non-zero exit as a finding, with the rows and output intact', async () => {
    const report = await runDoctor({ file: process.execPath, prefixArgs: [script(2)] })

    expect(report.exitCode).toBe(2)
    expect(report.error).toBeNull()
    expect(report.output).toBe(OUTPUT)
    expect(report.rows.map((row) => row.label)).toEqual(['Auto-update channel', 'Install path'])
  })
})
