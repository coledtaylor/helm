import type { SettingValue } from '@coledtaylor/helm-plugin-sdk'

/**
 * The sample server's API, through `helm.fetch`.
 *
 * `{{sample-token}}` is written into the header as it is: Helm puts the stored
 * value there on its way out, and only for a host the user allowed it for.
 * The page never holds the token, so nothing here can leak it.
 */

export interface Item {
  id: string
  title: string
  body: string
  read: boolean
  created: number
}

export interface ItemList {
  items: Item[]
  unread: number
}

export interface Options {
  server: string
  limit: number
  unreadOnly: boolean
  order: string
}

/** Pages tell each other the items changed: the background page, the panel and every tab share an origin. */
export const CHANNEL = 'sample-items'

export function optionsOf(settings: Record<string, SettingValue>): Options {
  const server = settings['server']
  const limit = settings['limit']
  const order = settings['order']
  return {
    server: (typeof server === 'string' && server !== '' ? server : 'http://127.0.0.1:4790').replace(/\/+$/, ''),
    limit: typeof limit === 'number' ? limit : 20,
    unreadOnly: settings['unreadOnly'] === true,
    order: typeof order === 'string' ? order : 'new'
  }
}

async function call<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  headers.set('authorization', 'Bearer {{sample-token}}')
  const response = await helm.fetch(url, { ...init, headers })
  if (!response.ok) throw new Error(`The server answered ${String(response.status)}.`)
  return (await response.json()) as T
}

export function listItems(options: Options): Promise<ItemList> {
  const query = new URLSearchParams({
    limit: String(options.limit),
    order: options.order,
    unread: String(options.unreadOnly)
  })
  return call<ItemList>(`${options.server}/items?${query.toString()}`)
}

export function getItem(options: Options, id: string): Promise<Item> {
  return call<Item>(`${options.server}/items/${encodeURIComponent(id)}`)
}

export function markRead(options: Options, id: string): Promise<Item> {
  return call<Item>(`${options.server}/items/${encodeURIComponent(id)}/read`, { method: 'POST' })
}

export function createItem(options: Options, title: string): Promise<Item> {
  return call<Item>(`${options.server}/items`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title })
  })
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
