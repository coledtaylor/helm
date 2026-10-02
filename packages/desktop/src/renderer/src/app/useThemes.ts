import { useCallback, useEffect, useState } from 'react'
import type { ThemeListing, ThemeState } from '@helm/core/types'
import { helm } from './bridge'
import { applyTheme } from './theme'

export interface ThemesState {
  /** Built-in and user themes. Null until the first read lands. */
  listing: ThemeListing | null
  /** The theme on screen. Null until the first read lands. */
  state: ThemeState | null
  openFolder: () => void
  duplicate: (id: string) => void
}

/**
 * The themes there are and the one on screen, kept current.
 *
 * This is the only listener for `theme:changed` in the window, and it paints
 * as well as storing: the document's colours and the Appearance pane's ring
 * are the same fact, so they arrive in one place. `main.tsx` paints once
 * before mounting so the first frame is right; from then on it is this.
 */
export function useThemes(): ThemesState {
  const [listing, setListing] = useState<ThemeListing | null>(null)
  const [state, setState] = useState<ThemeState | null>(null)

  useEffect(() => {
    const adopt = (next: ThemeState): void => {
      applyTheme(next)
      setState(next)
    }
    const offs = [helm.on('theme:changed', adopt), helm.on('themes:changed', setListing)]
    void helm.invoke('theme:current').then(adopt)
    void helm.invoke('themes:list').then(setListing)
    return () => {
      for (const off of offs) off()
    }
  }, [])

  const openFolder = useCallback(() => {
    helm.invoke('themes:openFolder').catch((err: unknown) => {
      console.error('could not open the themes folder:', err)
    })
  }, [])

  const duplicate = useCallback((id: string) => {
    helm
      .invoke('themes:duplicate', { id })
      .then(({ file }) => helm.invoke('shell:showItem', { path: file }))
      .catch((err: unknown) => {
        console.error(`could not duplicate ${id}:`, err)
      })
  }, [])

  return { listing, state, openFolder, duplicate }
}
