import { StrictMode, useEffect, useMemo, useState, type JSX } from 'react'
import { createRoot } from 'react-dom/client'
import { useHelmEvent, useHelmSettings, useSecret } from '@coledtaylor/helm-plugin-sdk/react'
import { CHANNEL, listItems, messageOf, optionsOf, type ItemList } from '../lib/api'
import '../styles.css'

/**
 * The sidebar panel the rail icon opens. Helm draws the header above it, with
 * the manifest's actions in it; everything below is this page.
 */
function Panel(): JSX.Element {
  const settings = useHelmSettings()
  const [token, requestToken] = useSecret('sample-token')
  const [list, setList] = useState<ItemList | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [service, setService] = useState<string | null>(null)
  const options = useMemo(() => (settings === null ? null : optionsOf(settings)), [settings])
  /** Bumped to read the list again. */
  const [reads, setReads] = useState(0)
  const reload = (): void => setReads((count) => count + 1)

  useEffect(() => {
    if (options === null || token !== 'ready') return undefined
    let live = true
    listItems(options).then(
      (next) => {
        if (!live) return
        setList(next)
        setError(null)
      },
      (failure: unknown) => {
        if (live) setError(messageOf(failure))
      }
    )
    return () => {
      live = false
    }
  }, [options, token, reads])

  // The background page refreshed: read the list again.
  useEffect(() => {
    const channel = new BroadcastChannel(CHANNEL)
    channel.onmessage = (event: MessageEvent) => {
      if (event.data === 'refreshed') setReads((count) => count + 1)
    }
    return () => channel.close()
  }, [])

  useHelmEvent('action', ({ id }) => {
    if (id === 'refresh') reload()
    if (id === 'add') void helm.tabs.open('item', {}, { title: 'New item' })
  })

  useEffect(() => {
    void helm
      .fetch('service:/hello')
      .then((response) => response.json() as Promise<{ message: string; pid: number }>)
      .then(
        (hello) => setService(`${hello.message} (pid ${String(hello.pid)})`),
        (failure: unknown) => setService(`The service did not answer: ${messageOf(failure)}`)
      )
  }, [])

  if (token === 'missing') {
    return (
      <main className="panel">
        <div className="helm-empty" data-sample-empty="token">
          <p className="helm-empty-title">Add the token</p>
          <p className="helm-empty-text">The server wants a bearer token. Helm keeps it; this page never sees it.</p>
          <div className="helm-empty-actions">
            <button type="button" className="helm-button" data-variant="primary" onClick={() => void requestToken()}>
              Add token
            </button>
          </div>
        </div>
      </main>
    )
  }

  return (
    <main className="panel">
      {error !== null ? (
        <div className="helm-empty" data-sample-empty="error">
          <p className="helm-empty-title">No items</p>
          <p className="helm-empty-text">{error}</p>
          <div className="helm-empty-actions">
            <button type="button" className="helm-button" onClick={reload}>
              Try again
            </button>
          </div>
        </div>
      ) : list === null ? (
        <p className="helm-meta pad">Loading…</p>
      ) : (
        <ul className="helm-list" data-sample-items>
          {list.items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className="helm-row item"
                data-sample-item={item.id}
                onClick={() => void helm.tabs.open('item', { id: item.id }, { title: item.title })}
              >
                <span className="helm-dot" data-tone={item.read ? undefined : 'accent'} />
                <span className="grow">
                  <span className="title">{item.title}</span>
                  <span className="helm-meta">{item.read ? 'Read' : 'Unread'}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <hr className="helm-rule" />
      <p className="helm-meta pad" data-sample-service>
        {service ?? 'Asking the service…'}
      </p>
    </main>
  )
}

const root = document.getElementById('root')
if (root !== null) {
  createRoot(root).render(
    <StrictMode>
      <Panel />
    </StrictMode>
  )
}
