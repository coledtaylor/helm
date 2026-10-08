import { StrictMode, useEffect, useMemo, useState, type JSX } from 'react'
import { createRoot } from 'react-dom/client'
import type { ExecResult, HelmError, SessionStartResult } from '@coledtaylor/helm-plugin-sdk'
import { useHelmSettings } from '@coledtaylor/helm-plugin-sdk/react'
import { CHANNEL, createItem, getItem, markRead, messageOf, optionsOf, type Item, type Options } from '../lib/api'
import '../styles.css'

/**
 * One item, in a tab of its own. Its parameters are part of its identity: the
 * same item opened twice is one tab, and another item is another.
 */
function ItemTab(): JSX.Element {
  const settings = useHelmSettings()
  const options = useMemo(() => (settings === null ? null : optionsOf(settings)), [settings])
  const id = helm.context.params['id']
  if (options === null) return <p className="helm-meta page">Loading…</p>
  return typeof id === 'string' ? <ItemView options={options} id={id} /> : <NewItem options={options} />
}

function ItemView({ options, id }: { options: Options; id: string }): JSX.Element {
  const [item, setItem] = useState<Item | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [echo, setEcho] = useState<ExecResult | null>(null)

  useEffect(() => {
    let live = true
    void getItem(options, id).then(
      async (found) => {
        if (!live) return
        setItem(found)
        helm.surface.setTitle(found.title)
        if (!found.read) {
          await markRead(options, id)
          new BroadcastChannel(CHANNEL).postMessage('changed')
        }
      },
      (failure: unknown) => live && setError(messageOf(failure))
    )
    return () => {
      live = false
    }
  }, [options, id])

  if (error !== null) {
    return (
      <div className="helm-empty">
        <p className="helm-empty-title">Item {id} did not load</p>
        <p className="helm-empty-text">{error}</p>
      </div>
    )
  }
  if (item === null) return <p className="helm-meta page">Loading…</p>
  return (
    <main className="page" data-sample-item-page={item.id}>
      <h1>{item.title}</h1>
      <p>{item.body === '' ? <span className="helm-meta">No body.</span> : item.body}</p>
      <div className="row">
        <button
          type="button"
          className="helm-button"
          data-sample-echo
          onClick={() => void helm.exec('echo', [item.id]).then(setEcho, (failure: unknown) => setError(messageOf(failure)))}
        >
          Run echo
        </button>
      </div>
      {echo !== null && (
        <pre className="helm-mono output" data-sample-echo-output>
          {echo.stdout.trim()}
        </pre>
      )}
      <StartSession item={item} />
      <OpenLink />
    </main>
  )
}

/**
 * An address, opened in Helm's Browser tab. Like a session, only the click
 * itself can ask: Helm refuses the call from anywhere else.
 */
function OpenLink(): JSX.Element {
  const [address, setAddress] = useState('')
  const [error, setError] = useState<string | null>(null)
  const open = (): void => {
    setError(null)
    helm.open(address.trim()).catch((failure: unknown) => {
      const code = (failure as Partial<HelmError>).code
      setError(code === undefined ? messageOf(failure) : `${code}: ${messageOf(failure)}`)
    })
  }
  return (
    <section className="session">
      <h2>Open a link</h2>
      <div className="row">
        <input
          className="helm-input"
          aria-label="Address"
          data-sample-link-address
          placeholder="https://example.com"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
        />
        <button type="button" className="helm-button" data-sample-link-open disabled={address.trim() === ''} onClick={open}>
          Open
        </button>
      </div>
      {error !== null && (
        <p className="error" data-sample-link-error>
          {error}
        </p>
      )}
    </section>
  )
}

/**
 * A Claude Code session about this item, in a folder the user names. Helm
 * shows the folder and the message, and starts it only if the user does; the
 * call has to come from the click itself.
 */
function StartSession({ item }: { item: Item }): JSX.Element {
  const [folder, setFolder] = useState('')
  const [outcome, setOutcome] = useState<SessionStartResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const start = (): void => {
    setOutcome(null)
    setError(null)
    helm.sessions.start({ cwd: folder.trim(), prompt: `work on ${item.title}`, name: item.title }).then(setOutcome, (failure: unknown) => {
      const code = (failure as Partial<HelmError>).code
      setError(code === undefined ? messageOf(failure) : `${code}: ${messageOf(failure)}`)
    })
  }
  return (
    <section className="session">
      <h2>Work on it in Claude Code</h2>
      <div className="row">
        <input
          className="helm-input"
          aria-label="Folder"
          data-sample-session-folder
          placeholder="C:\path\to\project"
          value={folder}
          onChange={(event) => setFolder(event.target.value)}
        />
        <button type="button" className="helm-button" data-sample-session-start disabled={folder.trim() === ''} onClick={start}>
          Start a session
        </button>
      </div>
      {outcome !== null && (
        <p className="helm-meta" data-sample-session-result>
          {outcome === 'started' ? 'Started.' : 'Cancelled.'}
        </p>
      )}
      {error !== null && (
        <p className="error" data-sample-session-error>
          {error}
        </p>
      )}
    </section>
  )
}

function NewItem({ options }: { options: Options }): JSX.Element {
  const [title, setTitle] = useState('')
  const [error, setError] = useState<string | null>(null)
  const create = async (): Promise<void> => {
    try {
      const item = await createItem(options, title)
      new BroadcastChannel(CHANNEL).postMessage('changed')
      await helm.tabs.open('item', { id: item.id }, { title: item.title })
    } catch (failure) {
      setError(messageOf(failure))
    }
  }
  return (
    <main className="page">
      <h1>New item</h1>
      <div className="row">
        <input
          className="helm-input"
          aria-label="Title"
          data-sample-new-title
          placeholder="Title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void create()
          }}
        />
        <button type="button" className="helm-button" data-variant="primary" disabled={title.trim() === ''} onClick={() => void create()}>
          Create
        </button>
      </div>
      {error !== null && <p className="error">{error}</p>}
    </main>
  )
}

const root = document.getElementById('root')
if (root !== null) {
  createRoot(root).render(
    <StrictMode>
      <ItemTab />
    </StrictMode>
  )
}
