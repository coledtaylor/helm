import { CHANNEL, createItem, listItems, messageOf, optionsOf } from '../lib/api'

/**
 * The background module: the host runs it in an isolate of its own while the
 * plugin is on, whether or not any of its surfaces are on screen, and whether
 * or not a window is attached. It keeps the rail badge and the status bar item
 * current, tells the open pages when there is something new, and answers the
 * tools the manifest offers Claude Code sessions (`agent`).
 *
 * It has `floti`, `BroadcastChannel` and timers, and nothing else: no window,
 * no DOM, no file system or network of its own. `floti.fetch` is its way out,
 * held to the origins the manifest lists as a page's is.
 */

const POLL_MS = 60_000
const channel = new BroadcastChannel(CHANNEL)

async function refresh(): Promise<void> {
  if ((await floti.secrets.state('sample-token')) !== 'ready') {
    await floti.badge.set(null)
    await floti.status.set({ text: 'Sample: no token', tone: 'warn', tooltip: 'Add the token in Settings > Plugins > Sample' })
    return
  }
  try {
    const options = optionsOf(await floti.settings.get())
    const list = await listItems({ ...options, unreadOnly: false })
    await floti.badge.set(list.unread)
    await floti.status.set({
      text: `${String(list.unread)} unread`,
      tone: list.unread > 0 ? 'accent' : 'neutral',
      tooltip: 'Sample items'
    })
    channel.postMessage('refreshed')
  } catch (failure) {
    await floti.status.set({ text: 'Sample: offline', tone: 'danger', tooltip: messageOf(failure) })
  }
}

// Registered as the module starts, before anything it awaits: a session can
// call as soon as it has run. What a handler returns is what the session
// reads, and what it throws is a failed call with its message.
floti.tools.handle('list_items', async (args) => {
  const options = optionsOf(await floti.settings.get())
  const list = await listItems({ ...options, unreadOnly: args['unreadOnly'] === true })
  return list.items.map(({ id, title, read }) => ({ id, title, read }))
})

floti.tools.handle('create_item', async (args) => {
  const title = typeof args['title'] === 'string' ? args['title'].trim() : ''
  if (title === '') throw new Error('create_item needs a title.')
  const item = await createItem(optionsOf(await floti.settings.get()), title)
  // The panel and any tab show it now, and the badge counts it.
  channel.postMessage('changed')
  void refresh()
  return item
})

floti.on('command', ({ id }) => {
  if (id === 'refresh') void refresh()
})
floti.on('settings', () => void refresh())
floti.on('secrets', () => void refresh())
// A page that changed an item says so here; the host relays the plugin's
// channels between its pages, on any client, and this module.
channel.onmessage = (event: MessageEvent) => {
  if (event.data === 'changed') void refresh()
}

void refresh()
setInterval(() => void refresh(), POLL_MS)
