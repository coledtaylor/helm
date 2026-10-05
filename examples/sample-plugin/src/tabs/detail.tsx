import { StrictMode, type JSX } from 'react'
import { createRoot } from 'react-dom/client'
import { Probe } from '../lib/Probe'
import '../styles.css'

/** A tab the plugin opens. It sits in any pane, splits and drags like Helm's own tabs. */
function Detail(): JSX.Element {
  return (
    <main className="page">
      <h1>Sample detail</h1>
      <p className="lede">
        A plugin tab. Helm draws the tab and the pane around it; this page is the plugin&apos;s. Switch away, split
        the pane or drag the tab to another pane, then come back and check the counter.
      </p>
      <Probe />
    </main>
  )
}

const root = document.getElementById('root')
if (root !== null) {
  createRoot(root).render(
    <StrictMode>
      <Detail />
    </StrictMode>
  )
}
