import { StrictMode, type JSX } from 'react'
import { createRoot } from 'react-dom/client'
import { helm } from '../lib/helm'
import { Probe } from '../lib/Probe'
import '../styles.css'

/** The sidebar panel the rail icon opens. Helm draws the header above it. */
function Panel(): JSX.Element {
  return (
    <main className="page">
      <p className="lede">
        A plugin&apos;s sidebar panel. Helm draws the header above; everything below it is the plugin&apos;s own page.
      </p>
      <div className="row">
        <button type="button" onClick={() => helm.tabs.open('detail')}>
          Open the detail tab
        </button>
      </div>
      <Probe />
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
