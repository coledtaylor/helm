import type { SettingSpec } from '@coledtaylor/helm-plugin-sdk'
import type { PluginBackgroundReport, PluginDelivery, PluginInfo, PluginLogLine, PluginUiRequest } from '../../ipc'
import type * as P from '../protocol'

/**
 * The host's plugins in the window's vocabulary. Nothing here reaches Node,
 * so main and the window's and the hidden plugin window's adapters share it.
 */

/** A background a page runs, as opposed to a script the host's engine runs. */
export const isBackgroundPage = (url: string): boolean => /\.html?$/i.test(new URL(url).pathname)

/**
 * The host's list with what the hidden plugin window saw of each background
 * page it runs. The host lists a background page without running it, so a
 * page of an enabled plugin with no error is starting until a report for the
 * plugin's current read says it runs or crashed.
 */
export function withBackgroundReports(
  list: readonly PluginInfo[],
  report: (plugin: string) => PluginBackgroundReport | undefined
): PluginInfo[] {
  return list.map((plugin) => {
    const { background } = plugin
    if (
      background === null ||
      plugin.id === null ||
      !plugin.enabled ||
      plugin.error !== null ||
      !isBackgroundPage(background.url)
    ) {
      return plugin
    }
    const seen = report(plugin.id)
    const current = seen !== undefined && seen.revision === plugin.revision ? seen : null
    return {
      ...plugin,
      background: { ...background, state: current?.state ?? 'starting', error: current?.error ?? null }
    }
  })
}

/** A plugin as the host lists it, in the shape Helm's window draws. */
export function pluginFromHost(plugin: P.PluginInfo): PluginInfo {
  return {
    path: plugin.path,
    id: plugin.id,
    name: plugin.name,
    version: plugin.version,
    description: plugin.description,
    enabled: plugin.enabled,
    error: plugin.error,
    warnings: plugin.warnings,
    revision: plugin.revision,
    icon: plugin.icon,
    rail: plugin.rail,
    panels: defined(plugin.panels),
    tabs: defined(plugin.tabs),
    pageStrip: plugin.pageStrip,
    background: plugin.background,
    commands: plugin.commands,
    settings: plugin.settings as SettingSpec[],
    settingValues: defined(plugin.settingValues),
    network: plugin.network,
    secrets: plugin.secrets,
    exec: plugin.exec,
    service: plugin.service,
    runsPrograms: plugin.runsPrograms,
    agent:
      plugin.agent === null
        ? null
        : {
            enabled: plugin.agent.enabled,
            server: plugin.agent.server,
            instructions: plugin.agent.instructions,
            tools: plugin.agent.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              readOnly: tool.readOnly
            }))
          },
    startsSessions: plugin.startsSessions,
    seesSessions: plugin.seesSessions,
    status: plugin.status,
    badge: plugin.badge
  }
}

/** What the host asks of a page's window, in the shape the window reads. */
export function uiFromHost(request: P.PluginUiRequest): PluginUiRequest {
  return request.kind === 'openTab' ? { ...request, params: defined(request.params) } : request
}

/** What the host hands a plugin's pages, in the shape the relay reads. */
export function deliveryFromHost(delivery: P.PluginDelivery): PluginDelivery {
  return { plugin: delivery.plugin, event: delivery.event, data: delivery.data, to: delivery.to }
}

/** The host's own log lines are what Helm's log calls its own. */
export function logFromHost(lines: readonly P.PluginLogLine[]): PluginLogLine[] {
  return lines.map((line) => ({ at: line.at, stream: line.stream === 'host' ? 'helm' : line.stream, text: line.text }))
}

/** A record whose values the protocol marks optional, with only the ones that are there. */
function defined<T>(record: { [key in string]?: T }): Record<string, T> {
  const out: Record<string, T> = {}
  for (const [key, value] of Object.entries(record)) if (value !== undefined) out[key] = value
  return out
}
