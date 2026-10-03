import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@helm/ui/styles.css'
import { App } from './App'
import { helm } from './bridge'
import { installOverlayInspector, installTerminalInspector } from './inspect'
import { applyShape, applyTheme } from './theme'

const container = document.getElementById('root')
if (!container) throw new Error('#root is missing from index.html')

// See inspect.ts: the terminals live outside React, and so does the flag that
// says a modal is up. This is how a check driving the real window sees either.
installTerminalInspector()
installOverlayInspector()

/*
 * The theme and the shape are painted before React's first frame, not after:
 * the palette is data the main process holds, so until it arrives the document
 * has no colours at all, and a first render without it would be a frame of
 * black text on the window's background. One round trip, before anything is on
 * screen to flash. If either read fails the app still mounts - `useLauncher`
 * reads both again and the stylesheet's shape defaults stand in until then.
 */
void Promise.allSettled([helm.invoke('theme:current'), helm.invoke('settings:read')])
  .then(([theme, settings]) => {
    if (theme.status === 'fulfilled') applyTheme(theme.value)
    if (settings.status === 'fulfilled') applyShape(settings.value)
  })
  .finally(() => {
    createRoot(container).render(
      <StrictMode>
        <App />
      </StrictMode>
    )
  })
