import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import {
  archiveTranscriptFile,
  indexUsageFile,
  insertConfigSnapshot,
  openStore,
  renameHistorySession,
  writeSettings
} from '@helm/core'
import { appendPrompts, claudeTree, sessionUuid, transcriptFile } from '../test/history-fixture'
import type { World } from '../test/world'
import type { OwnDataCopyState } from '../src/shared/ipc'
import { expect, test as base } from './helm'

/**
 * What only Helm's own database holds - a conversation it archived whose
 * transcript Claude Code has since deleted, the name given to it in History,
 * its usage and a saved version of a CLAUDE.md - is copied into the local
 * host, and reads there as it did from helm.db.
 */

const KEPT = sessionUuid(0x11)
/** Holds one message longer than a protocol frame, which is sent cut short. */
const TOO_LARGE = sessionUuid(0x55)
/** Sorts after the others, so a copy the host refuses at it has already sent them whole. */
const REFUSED = sessionUuid(0x99)
const PROMPT = 'draft the migration'
const REPLY = 'The migration adds two columns to the ledger.'
const NAME = 'Migration plan'
const CURRENT = '# Alpha\n\nWhat the file says now.\n'
const SAVED = '# Alpha\n\nWhat it said before the console wrote it.\n'
const sha = (text: string): string => createHash('sha256').update(text).digest('hex')

const helmDb = (world: World): string => join(world.dataDir, 'helm.db')

/** The `n`th message of a conversation: its session id with the fourth group numbering the message. */
const messageUuid = (sessionId: string, n: number): string =>
  `${sessionId.slice(0, 19)}${n.toString(16).padStart(4, '0')}${sessionId.slice(23)}`

function archive(world: World, sessionId: string, texts: readonly string[], at: number): void {
  const store = openStore({ file: helmDb(world) })
  try {
    archiveTranscriptFile(store, {
      file: transcriptFile(claudeTree(world.claudeDir), sessionId, world.projects.alpha),
      sessionId,
      tail: {
        rows: texts.map((text, index) => ({
          uuid: messageUuid(sessionId, index + 1),
          sessionId,
          role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
          at: at + index,
          text
        })),
        bytes: 100,
        reset: false,
        skipped: 0,
        read: 100
      }
    })
  } finally {
    store.close()
  }
}

/**
 * Helm's database as an earlier version left it. The conversation's prompts
 * stay in history.jsonl; its transcript file was never written, as after
 * Claude Code reaped it.
 */
function seedOwnData(world: World): void {
  const at = Date.now() - 60 * 60 * 1000
  appendPrompts(claudeTree(world.claudeDir), [{ sessionId: KEPT, project: world.projects.alpha, display: PROMPT, at }])
  archive(world, KEPT, [PROMPT, REPLY], at)
  writeFileSync(join(world.projects.alpha, 'CLAUDE.md'), CURRENT)
  const store = openStore({ file: helmDb(world) })
  try {
    renameHistorySession(store, KEPT, NAME)
    indexUsageFile(store, {
      file: transcriptFile(claudeTree(world.claudeDir), KEPT, world.projects.alpha),
      tail: {
        rows: [
          {
            uuid: messageUuid(KEPT, 2),
            at: at + 1,
            model: 'claude-opus-4-1',
            input: 1200,
            output: 800,
            cacheWrite5m: 0,
            cacheWrite1h: 0,
            cacheRead: 0
          }
        ],
        bytes: 100,
        reset: false,
        skipped: 0
      }
    })
    insertConfigSnapshot(store, {
      scopePath: world.projects.alpha,
      filePath: 'CLAUDE.md',
      content: SAVED,
      contentHash: sha(SAVED),
      reason: 'edit'
    })
    // Helm's profiles and plugins were copied into this host before its own
    // data was: that copy's markers do not stand in for this one's.
    const now = new Date().toISOString()
    writeSettings(store, { profilesCopiedToHostAt: now, pluginsCopiedToHostAt: now })
  } finally {
    store.close()
  }
}

const test = base.extend({
  world: async ({ world }, use) => {
    seedOwnData(world)
    await use(world)
  }
})

const copyState = (window: Page): Promise<OwnDataCopyState> =>
  window.evaluate(
    () =>
      (
        window as unknown as { helm: { invoke: (channel: string) => Promise<OwnDataCopyState> } }
      ).helm.invoke('ownData:state')
  )

async function openHistory(window: Page): Promise<void> {
  await window.getByRole('navigation', { name: 'Destinations' }).getByRole('button', { name: 'Session history' }).click()
}

/** History names the session as it was named in Helm, and its conversation opens from the archive. */
async function showsTheArchivedConversation(window: Page): Promise<void> {
  await openHistory(window)
  const row = window.getByRole('group', { name: 'Sessions' }).getByRole('button', { name: new RegExp(`^${NAME}`) })
  await expect(row).toBeVisible()
  await row.click()
  await expect(window.getByText('This conversation cannot be reopened, but Helm kept it')).toBeVisible()
  await expect(window.getByText(REPLY)).toHaveCount(1)
}

async function chooseScope(window: Page, name: string): Promise<void> {
  const scope = window.getByRole('combobox', { name: 'Scope' })
  await expect(scope).not.toHaveValue('')
  const value = await scope.locator('option', { hasText: new RegExp(`^${name}\\b`) }).getAttribute('value')
  expect(value).not.toBeNull()
  if ((await scope.inputValue()) !== value) await scope.selectOption(value!)
  await expect(scope).toHaveValue(value!)
}

/** The version helm.db saved is listed, and restoring it puts its bytes back. */
async function restoresTheSavedVersion(window: Page, world: World): Promise<void> {
  const file = join(world.projects.alpha, 'CLAUDE.md')
  await window.getByRole('button', { name: 'Config', exact: true }).click()
  await chooseScope(window, 'alpha')
  await window.getByRole('group', { name: 'Configuration files' }).getByRole('button', { name: /CLAUDE\.md/ }).click()
  await window.getByRole('button', { name: '1 version', exact: true }).click()
  await expect(window.locator('[data-snapshot-list]')).toContainText(sha(SAVED).slice(0, 12))
  await window.getByRole('button', { name: 'Restore', exact: true }).click()
  await expect.poll(() => readFileSync(file, 'utf8')).toBe(SAVED)
  await expect(window.getByRole('button', { name: '2 versions', exact: true })).toBeVisible()
}

test('History, the archived conversation and the config console show what only helm.db held, once copied into the host', async ({
  world,
  helm
}) => {
  const before = readFileSync(helmDb(world))
  await expect.poll(async () => (await copyState(helm.window)).state).toBe('finished')

  await showsTheArchivedConversation(helm.window)
  await restoresTheSavedVersion(helm.window, world)

  await expect(helm.window.locator('[data-own-data-banner]')).toHaveCount(0)
  // The config console's restore wrote the host's database, never Helm's.
  expect(readFileSync(helmDb(world)).equals(before)).toBe(true)
})

/**
 * The same, with two more conversations: one holding a message past the
 * protocol's frame, which goes cut short, and one holding a message whose role
 * the host does not know, which it refuses, so the copy stops after the
 * conversations before it went whole.
 */
const refused = test.extend({
  world: async ({ world }, use) => {
    archive(world, TOO_LARGE, ['x'.repeat(17 * 1024 * 1024)], Date.now() - 40 * 60 * 1000)
    archive(world, REFUSED, ['a row only a later build could have written'], Date.now() - 30 * 60 * 1000)
    const store = openStore({ file: helmDb(world) })
    try {
      store.raw.prepare("UPDATE transcript_messages SET role = 'system' WHERE session_id = ?").run(REFUSED)
    } finally {
      store.close()
    }
    await use(world)
  }
})

refused('a copy that did not finish says so, and the next start finishes it without copying anything twice', async ({
  world,
  helm,
  relaunch
}, testInfo) => {
  await expect.poll(async () => (await copyState(helm.window)).state).toBe('unfinished')
  // The conversation with a message past one frame went, cut short, before the refusal.
  expect(await copyState(helm.window)).toMatchObject({
    copied: { conversations: 2 },
    reason: expect.stringContaining('the local host refused a batch of conversations')
  })
  const banner = helm.window.locator('[data-own-data-banner]')
  await expect(banner).toContainText('did not finish')
  await expect(banner).toContainText('It will be tried again when Helm next starts.')
  await helm.window.screenshot({ path: testInfo.outputPath('own-data-banner.png') })
  await showsTheArchivedConversation(helm.window)

  // The conversation the host refused goes from Helm's database between
  // starts, so the next attempt can finish.
  const store = openStore({ file: helmDb(world) })
  try {
    store.raw.prepare('DELETE FROM transcript_messages WHERE session_id = ?').run(REFUSED)
    store.raw.prepare('DELETE FROM transcript_sessions WHERE session_id = ?').run(REFUSED)
  } finally {
    store.close()
  }

  const next = await relaunch()
  await expect.poll(async () => (await copyState(next.window)).state).toBe('finished')
  await expect(next.window.locator('[data-own-data-banner]')).toHaveCount(0)
  // Sent once, by the first attempt; the second sent only what the host lacked.
  await showsTheArchivedConversation(next.window)
})
