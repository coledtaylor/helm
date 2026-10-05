import { useLayoutEffect, useRef, type JSX } from 'react'
import { attachPluginFrame, detachPluginFrame } from './pluginFrames'

export interface PluginFrameProps {
  /** The surface: one frame per key for as long as the surface is open. */
  frameKey: string
  plugin: string
  url: string
  title: string
  className: string
}

/**
 * Where a plugin surface appears. The frame itself lives in `pluginFrames.ts`.
 *
 * A layout effect, not a plain one: its cleanup runs while the slot is still
 * in the document, which is the last moment the frame can be moved out
 * without reloading.
 */
export function PluginFrame({ frameKey, plugin, url, title, className }: PluginFrameProps): JSX.Element {
  const slot = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = slot.current
    if (element === null) return
    attachPluginFrame(frameKey, plugin, url, title, element)
    return () => detachPluginFrame(frameKey, element)
  }, [frameKey, plugin, url, title])
  return <div ref={slot} data-plugin-slot={frameKey} className={className} />
}

/**
 * A plugin's icon, drawn as a mask over `currentColor` so it takes the colour
 * of wherever it sits - the rail's idle, hover and current states, a tab's
 * label - like Helm's own icons. Its own colours are ignored on purpose.
 */
export function PluginIcon({ url, size }: { url: string | null; size: number }): JSX.Element {
  const mask = url === null ? undefined : `url("${url}") center / contain no-repeat`
  return (
    <span
      aria-hidden
      className="inline-block shrink-0 bg-current"
      style={{ width: size, height: size, mask, WebkitMask: mask }}
    />
  )
}
