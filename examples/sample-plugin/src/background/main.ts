import { CHANNEL, createItem, listItems, messageOf, optionsOf } from '../lib/api'

/**
 * The background page: always running while the plugin is on, whether or not
 * any of its surfaces are on screen. It keeps the rail badge and the status
 * bar item current, tells the open pages when there is something new, and
 * answers the tools the manifest offers Claude Code sessions (`agent`).
 */

const POLL_MS = 60_000
const channel = new BroadcastChannel(CHANNEL)

async function refresh(): Promise<void> {
  if ((await helm.secrets.state('sample-token')) !== 'ready') {
    await helm.badge.set(null)
    await helm.status.set({ text: 'Sample: no token', tone: 'warn', tooltip: 'Add the token in Settings > Plugins > Sample' })
    return
  }
  try {
    const options = optionsOf(await helm.settings.get())
    const list = await listItems({ ...options, unreadOnly: false })
    await helm.badge.set(list.unread)
    await helm.status.set({
      text: `${String(list.unread)} unread`,
      tone: list.unread > 0 ? 'accent' : 'neutral',
      tooltip: 'Sample items'
    })
    channel.postMessage('refreshed')
  } catch (failure) {
    await helm.status.set({ text: 'Sample: offline', tone: 'danger', tooltip: messageOf(failure) })
  }
}

// Registered as the page starts, before anything it awaits: a session can
// call as soon as the page is up. What a handler returns is what the session
// reads, and what it throws is a failed call with its message.
helm.tools.handle('list_items', async (args) => {
  const options = optionsOf(await helm.settings.get())
  const list = await listItems({ ...options, unreadOnly: args['unreadOnly'] === true })
  return list.items.map(({ id, title, read }) => ({ id, title, read }))
})

helm.tools.handle('create_item', async (args) => {
  const title = typeof args['title'] === 'string' ? args['title'].trim() : ''
  if (title === '') throw new Error('create_item needs a title.')
  const item = await createItem(optionsOf(await helm.settings.get()), title)
  // The panel and any tab show it now, and the badge counts it.
  channel.postMessage('changed')
  void refresh()
  return item
})

helm.on('command', ({ id }) => {
  if (id === 'refresh') void refresh()
})
helm.on('settings', () => void refresh())
helm.on('secrets', () => void refresh())
channel.onmessage = (event: MessageEvent) => {
  if (event.data === 'changed') void refresh()
}

void refresh()
setInterval(() => void refresh(), POLL_MS)
