import type { JSX } from 'react'
import { cn } from '../lib/cn'
import { ROW_SELECTED } from '../lib/rows'

/**
 * Settings, one section at a time: the sections listed in the sidebar, the one
 * picked drawn in the pane (the Appearance board's layout).
 *
 * The page it replaces was every group on one scroll, twelve of them, which
 * is a page you search rather than read. A section is a handful of related
 * groups, named for what somebody comes to change.
 */
export type SettingsSectionId =
  | 'general'
  | 'appearance'
  | 'terminal'
  | 'sessions'
  | 'workspace'
  | 'files'
  | 'browser'
  | 'plugins'
  | 'secrets'
  | 'archive'
  | 'updates'
  /** One plugin's page, by its folder: a plugin whose manifest failed has no id. */
  | `plugin:${string}`

export interface SettingsSection {
  id: SettingsSectionId
  label: string
  /**
   * The line under the section's title. Only a section holding more than one
   * group has one here; a section that is a single group says its group's own
   * hint there instead.
   */
  hint?: string
}

/** In the order the sidebar lists them: the daily things first, the rare ones last. */
export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  { id: 'general', label: 'General' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'workspace', label: 'Workspace', hint: 'The folders Helm scans, and what a new harness is written from.' },
  { id: 'files', label: 'Files' },
  { id: 'browser', label: 'Browser' },
  { id: 'plugins', label: 'Plugins' },
  { id: 'secrets', label: 'Secrets' },
  { id: 'archive', label: 'Archive' },
  { id: 'updates', label: 'Updates' }
]

/** A registered plugin, listed under Plugins with a page of its own. */
export interface SettingsPluginLink {
  path: string
  name: string
  /** Turned off, or failed to load: said beside its name. */
  state: 'on' | 'off' | 'error'
}

export interface SettingsSectionsProps {
  current: SettingsSectionId
  onSelect: (id: SettingsSectionId) => void
  plugins?: readonly SettingsPluginLink[] | undefined
}

export const pluginSection = (path: string): SettingsSectionId => `plugin:${path}`

/** The sidebar's list of sections, with the sidebar's own selected-row recipe. */
export function SettingsSections({ current, onSelect, plugins = [] }: SettingsSectionsProps): JSX.Element {
  return (
    <nav aria-label="Settings sections" className="flex flex-col gap-px px-1.5 pb-1.5">
      {SETTINGS_SECTIONS.map((section) => {
        const selected = section.id === current
        const link = (
          <button
            key={section.id}
            type="button"
            data-settings-section-link={section.id}
            aria-current={selected ? 'page' : undefined}
            onClick={() => onSelect(section.id)}
            className={cn(
              'relative flex h-line w-full items-center rounded-raised px-2.5 text-left text-[12.5px] transition-colors',
              selected ? cn(ROW_SELECTED, 'font-medium text-fg') : 'text-fg-muted hover:bg-hover hover:text-fg'
            )}
          >
            {selected && (
              <span aria-hidden className="absolute top-1.5 bottom-1.5 left-0 w-[2px] rounded-full bg-accent" />
            )}
            {section.label}
          </button>
        )
        if (section.id !== 'plugins' || plugins.length === 0) return link
        // Each plugin's own page, under Plugins, a step in.
        return (
          <div key={section.id} className="contents">
            {link}
            {plugins.map((plugin) => {
              const id = pluginSection(plugin.path)
              const chosen = id === current
              return (
                <button
                  key={id}
                  type="button"
                  data-settings-plugin-link={plugin.path}
                  aria-current={chosen ? 'page' : undefined}
                  title={plugin.path}
                  onClick={() => onSelect(id)}
                  className={cn(
                    'relative flex h-line w-full items-center gap-2 rounded-raised pr-2.5 pl-6 text-left text-[12.5px] transition-colors',
                    chosen ? cn(ROW_SELECTED, 'font-medium text-fg') : 'text-fg-muted hover:bg-hover hover:text-fg'
                  )}
                >
                  {chosen && (
                    <span aria-hidden className="absolute top-1.5 bottom-1.5 left-0 w-[2px] rounded-full bg-accent" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{plugin.name}</span>
                  {plugin.state === 'off' && <span className="shrink-0 text-[11px] font-normal text-fg-subtle">Off</span>}
                  {plugin.state === 'error' && (
                    <span className="shrink-0 text-[11px] font-normal text-danger">Not loaded</span>
                  )}
                </button>
              )
            })}
          </div>
        )
      })}
    </nav>
  )
}
