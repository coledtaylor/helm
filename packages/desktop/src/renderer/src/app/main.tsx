import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@helm/ui/styles.css'
import { App } from './App'
import { installTerminalInspector } from './inspect'

const container = document.getElementById('root')
if (!container) throw new Error('#root is missing from index.html')

// See inspect.ts: the terminals live outside React, and this is how a check
// driving the real window can see them.
installTerminalInspector()

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)
