import { CHANNEL, listItems, messageOf, optionsOf } from '../lib/api'

/**
 * The background page: always running while the plugin is on, whether or not
 * any of its surfaces are on screen. It keeps the rail badge and the status
 * bar item current, and tells the open pages when there is something new.
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
