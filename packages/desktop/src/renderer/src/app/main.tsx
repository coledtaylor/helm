import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@helm/ui/styles.css'
import { App } from './App'
import { installOverlayInspector, installTerminalInspector } from './inspect'

const container = document.getElementById('root')
if (!container) throw new Error('#root is missing from index.html')

// See inspect.ts: the terminals live outside React, and so does the flag that
// says a modal is up. This is how a check driving the real window sees either.
installTerminalInspector()
installOverlayInspector()

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)
