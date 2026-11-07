import {
  LOCAL_HOST_KEY,
  commandState,
  isCommandChild,
  sessionLabel,
  type ChildMark,
  type PermissionMode,
  type SessionRecord
} from '@helm/core/types'
import { SESSION_STATE_LABEL, type ChildPeekProps, type PeekTone, type PopupAnchor, type TabIndicator } from '@helm/ui'
import type { PeekAnchor as PeekOpenedFrom, PeekTarget } from './peek'
import { commandWord } from './treeFamilies'

/**
 * What the peek says of a child, from its row and its state. The wording lives
 * here so the view only draws, and so the chip, the peek and the tree agree on
 * what a state is called.
 */

/**
 * What a state chip says and how it is toned: the dot's own tones, in a word.
 * A child that has ended says how: 'stopped' when the host ended it, 'exited 0'
 * for a command's exit code, and 'ended' otherwise.
 */
export function peekState(
  state: TabIndicator,
  how: { stopped?: boolean | undefined; exitCode?: number | undefined } = {}
): { label: string; tone: PeekTone } {
  switch (state) {
    case 'busy':
      return { label: 'working', tone: 'working' }
    case 'waiting':
      return { label: 'needs you', tone: 'needs' }
    case 'idle':
    case 'shell':
      return { label: 'idle', tone: 'idle' }
    case 'running':
      return { label: 'running', tone: 'idle' }
    case 'error':
    case 'failed':
      return { label: state === 'error' ? 'error' : 'failed', tone: 'danger' }
    case 'ended':
      return {
        label: how.exitCode !== undefined ? `exited ${String(how.exitCode)}` : how.stopped === true ? 'stopped' : 'ended',
        tone: 'neutral'
      }
  }
}

/**
 * What a command child's state chip says and how it is toned: the word its row
 * says (`running`, `exited <code>`, `stopped` where the host ended it, `ended`
 * where its code was never seen), toned as its glyph is.
 */
export function commandPeekState(session: {
  status: string
  exitCode?: number | null | undefined
  stopped?: boolean | undefined
}): { label: string; tone: PeekTone } {
  const tone: Record<ReturnType<typeof commandState>, PeekTone> = {
    running: 'idle',
    ended: 'neutral',
    failed: 'danger'
  }
  return { label: commandWord(session), tone: tone[commandState(session)] }
}

/** A permission mode as the peek's Mode row says it, in lower case, as the frame sets it in mono. */
const MODE_WORDS: Readonly<Record<PermissionMode, string>> = {
  manual: 'manual',
  plan: 'plan',
  acceptEdits: 'accept edits',
  auto: 'auto',
  dontAsk: 'don’t ask',
  bypassPermissions: 'bypass permissions'
}

/** The last path segment of a folder, either separator. */
function folderOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return at < 0 ? trimmed : trimmed.slice(at + 1)
}

/** What a child of the peek's facts are, everything the popover shows but its screen and its buttons. */
export type PeekFacts = Pick<
  ChildPeekProps,
  'name' | 'mark' | 'state' | 'role' | 'command' | 'folder' | 'folderPath' | 'branch' | 'mode' | 'runsIn' | 'report'
>

/**
 * The peek's facts for `child`: who it is (its role, or its command), where
 * it runs, the mode it was launched in and its last report. `command` is the
 * command line of a child that runs one and not an agent, which has no role,
 * mode or report; absent for an agent child.
 */
export function peekFacts(
  child: SessionRecord,
  indicator: TabIndicator,
  mark: ChildMark,
  command?: { line: string; runsIn?: string; exitCode?: number }
): PeekFacts {
  const report = child.lastReport
  return {
    name: sessionLabel(child),
    mark,
    state:
      command === undefined
        ? peekState(indicator, { stopped: child.stopped })
        : commandPeekState({
            status: child.status,
            exitCode: command.exitCode ?? child.exitCode,
            ...(child.stopped === undefined ? {} : { stopped: child.stopped })
          }),
    role: command === undefined ? (child.role ?? null) : null,
    command: command?.line,
    folder: folderOf(child.cwd),
    folderPath: child.cwd,
    branch: child.branch,
    mode: command !== undefined || child.permissionMode === undefined ? null : MODE_WORDS[child.permissionMode],
    runsIn: command?.runsIn,
    report:
      command !== undefined || report === undefined || report.text.trim() === ''
        ? null
        : { state: report.state, text: report.text }
  }
}

/**
 * The program a command child's line ran through, as the peek's Runs in row
 * says it: `your shell, ` and the file name of the record's first argument
 * without its extension (`pwsh` for `C:\Program Files\PowerShell\7\pwsh.exe`).
 * Absent where the record holds no argv.
 */
export function shellRunsIn(argv: readonly string[]): string | undefined {
  const program = argv[0]
  if (program === undefined || program === '') return undefined
  const file = program.slice(Math.max(program.lastIndexOf('/'), program.lastIndexOf('\\')) + 1)
  const name = file.replace(/\.[^.]*$/, '')
  return name === '' ? undefined : `your shell, ${name}`
}

/**
 * What the peek of a command child shows of it - its command line, the shell
 * it ran in and its exit code - or undefined for a session that is not one.
 */
export function commandFacts(
  child: Pick<SessionRecord, 'command' | 'argv' | 'exitCode'>
): { line: string; runsIn?: string; exitCode?: number } | undefined {
  if (!isCommandChild(child)) return undefined
  const runsIn = shellRunsIn(child.argv)
  return {
    line: child.command as string,
    ...(runsIn === undefined ? {} : { runsIn }),
    ...(child.exitCode === null || child.exitCode === undefined ? {} : { exitCode: child.exitCode })
  }
}

/** Names a chip in a parent's crumb to the window, which finds it to place the peek under it. */
export const chipKey = (host: string, id: number): string => `${host}:${String(id)}`

/** The peek's width, which a centred fallback needs to know. */
const PEEK_WIDTH = 470

/** The element the peek of `target` opened from, or null when it is not on screen (a closed sidebar). */
function anchorElement(target: Pick<PeekTarget, 'host' | 'id' | 'anchor'>, doc: Document): HTMLElement | null {
  if (target.anchor.kind === 'chip') {
    const key = chipKey(target.host, target.id)
    return [...doc.querySelectorAll<HTMLElement>('[data-crumb-chip]')].find((chip) => chip.dataset.crumbChip === key) ?? null
  }
  const group = [...doc.querySelectorAll<HTMLElement>('[data-host-group]')].find(
    (each) => each.dataset.hostGroup === target.host
  )
  const row = `session:${String(target.id)}`
  // With only this PC's host the tree is not grouped by host: its rows sit under no group at all.
  const rows =
    group !== undefined
      ? [...group.querySelectorAll<HTMLElement>('[data-session-row]')]
      : target.host === LOCAL_HOST_KEY
        ? [...doc.querySelectorAll<HTMLElement>('[data-session-row]')].filter(
            (each) => each.closest('[data-host-group]') === null
          )
        : []
  return rows.find((each) => each.dataset.sessionRow === row) ?? null
}

/**
 * Where the peek of `target` goes: beside the row it was opened from, or under
 * the chip, and in the middle of the window's top when what it opened from is
 * not on screen (a notification clicked with the sidebar closed).
 */
export function peekPlace(
  target: Pick<PeekTarget, 'host' | 'id' | 'anchor'>,
  doc: Document = document
): { at: PopupAnchor; element: HTMLElement | null } {
  const element = anchorElement(target, doc)
  if (element === null) {
    return { at: { x: Math.max(8, (window.innerWidth - PEEK_WIDTH) / 2), y: 80 }, element: null }
  }
  const rect = element.getBoundingClientRect()
  if (target.anchor.kind === 'chip') {
    // Under the chip, 8px left of its left edge, and inside the window by 8px.
    const x = Math.min(Math.max(8, rect.left - 8), window.innerWidth - PEEK_WIDTH - 8)
    return { at: { x, y: rect.bottom + 6 }, element }
  }
  return { at: { x: rect.right + 10, y: rect.top - 16 }, element }
}

/**
 * What the peek of a child opens from when a toast asks for it rather than a
 * press: the child's chip in its parent's crumb when that
 * crumb is on screen with one, and its row otherwise.
 */
export function peekAnchorFor(
  host: string,
  child: Pick<SessionRecord, 'id' | 'parentId'>,
  doc: Document = document
): PeekOpenedFrom {
  if (child.parentId === undefined || child.parentId === null) return { kind: 'row' }
  const key = chipKey(host, child.id)
  const chip = [...doc.querySelectorAll<HTMLElement>('[data-crumb-chip]')].some((each) => each.dataset.crumbChip === key)
  return chip ? { kind: 'chip', parentId: child.parentId } : { kind: 'row' }
}

/**
 * The mark's state in words, for a chip's label. A command child's chip says
 * what its row says (`running`, `exited <code>`): pass the child it belongs to.
 */
export function markLabel(
  mark: ChildMark,
  child?: {
    command?: string | null
    status: string
    exitCode?: number | null | undefined
    stopped?: boolean | undefined
  }
): string {
  if (child !== undefined && isCommandChild(child)) return commandWord(child)
  return mark.state === null ? 'state unknown' : SESSION_STATE_LABEL[mark.state]
}
