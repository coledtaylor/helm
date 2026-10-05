import type { JSX } from 'react'

/**
 * A plugin's icon, drawn as a mask over `currentColor` so it takes the colour
 * of wherever it sits - the rail's idle, hover and current states, a tab's
 * label, a Settings row - like Helm's own icons. Its own colours are ignored
 * on purpose. A block, as Helm's SVGs are, so it centres in its slot rather
 * than sitting on a text baseline. `url` is the `data:` URL main made of the
 * manifest's icon; a plugin without one gets an outlined square.
 */
export function PluginIcon({ url, size }: { url: string | null; size: number }): JSX.Element {
  const mask = url === null ? undefined : `url("${url}") center / contain no-repeat`
  return (
    <span
      aria-hidden
      className={url === null ? 'block shrink-0 rounded-xs border-[1.5px] border-current' : 'block shrink-0 bg-current'}
      style={{ width: size, height: size, mask, WebkitMask: mask }}
    />
  )
}
