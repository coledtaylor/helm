import { useLayoutEffect, useRef, type JSX } from 'react'
import { canonicalParams } from '@helm/core/types'
import { EmptyState, WarnIcon, cn } from '@helm/ui'
import type { SurfaceSpec } from '../plugins/relay'
import { attachPluginFrame, detachPluginFrame, reloadPluginFrame, usePluginFrameState } from './pluginFrames'

export interface PluginFrameProps {
  spec: SurfaceSpec
  /** The plugin's name, for the error drawn when its page fails. */
  pluginName: string
  /** Opens the plugin's page in Settings, where its log is. */
  onOpenSettings?: (() => void) | undefined
  className?: string | undefined
}

/**
 * Where a plugin surface appears. The frame itself lives in `pluginFrames.ts`;
 * this is its slot, and the error drawn over it when the page fails to load or
 * stops - in the surface's own place, so one plugin's failure is never Helm's.
 *
 * A layout effect, not a plain one: its cleanup runs while the slot is still
 * in the document, which is the last moment the frame can be moved out
 * without reloading.
 */
export function PluginFrame({ spec, pluginName, onOpenSettings, className }: PluginFrameProps): JSX.Element {
  const slot = useRef<HTMLDivElement>(null)
  const state = usePluginFrameState(spec.key)
  // Read by the effect below, which re-runs only when something that names
  // the page changed - not for every new object with the same fields in it.
  const latest = useRef(spec)
  useLayoutEffect(() => {
    latest.current = spec
  })
  const params = canonicalParams(spec.params)

  useLayoutEffect(() => {
    const element = slot.current
    if (element === null) return
    attachPluginFrame(latest.current, element)
    return () => detachPluginFrame(latest.current.key, element)
  }, [spec.key, spec.plugin, spec.revision, spec.url, spec.title, spec.surface, spec.name, params])

  const failed = state?.kind === 'failed' ? state : null
  return (
    <div className={cn('relative', className)}>
      <div ref={slot} data-plugin-slot={spec.key} className="absolute inset-0" />
      {failed !== null && (
        <div data-plugin-error={spec.key} className="absolute inset-0 bg-surface">
          <EmptyState
            name="plugin-failed"
            icon={<WarnIcon width={18} height={18} />}
            title={failed.reason === 'crash' ? `${pluginName} stopped` : `${pluginName} did not load`}
            actions={
              <>
                <button
                  type="button"
                  onClick={() => reloadPluginFrame(spec.key)}
                  className="rounded-well border border-border-strong px-2.5 py-1 text-[11px] text-fg transition-colors hover:bg-hover"
                >
                  Reload
                </button>
                {onOpenSettings !== undefined && (
                  <button
                    type="button"
                    onClick={onOpenSettings}
                    className="rounded-well px-2.5 py-1 text-[11px] text-fg-muted transition-colors hover:bg-hover hover:text-fg"
                  >
                    Plugin settings
                  </button>
                )}
              </>
            }
          >
            {failed.message}
          </EmptyState>
        </div>
      )}
    </div>
  )
}
