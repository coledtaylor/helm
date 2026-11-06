import { describe, expect, it } from 'vitest'
import { LOCAL_HOST_KEY } from '@helm/core/types'
import type * as P from '../host/protocol'
import { pluginFromHost } from '../host/records'
import {
  apiVersionOfScheme,
  formatPluginOrigin,
  hostFrameKey,
  hostLabel,
  hostOfLabel,
  onHostOrigin,
  parsePluginOrigin,
  pluginOrigin,
  pluginSchemeOf
} from './origin'

const BUILD_BOX = '6f1d2c3a-1b2c-4d5e-8f90-a1b2c3d4e5f6'

describe('a plugin’s origin on each host', () => {
  it('s19: keeps This PC’s plugin on helm-plugin://<id> and gives the same plugin on build-box an origin of its own', () => {
    expect(pluginOrigin({ host: LOCAL_HOST_KEY, plugin: 'trackr' })).toBe('helm-plugin://trackr')
    const theirs = pluginOrigin({ host: BUILD_BOX, plugin: 'trackr' })
    expect(theirs).toBe(`helm-plugin://trackr.${BUILD_BOX}`)
    expect(theirs).not.toBe(pluginOrigin({ host: LOCAL_HOST_KEY, plugin: 'trackr' }))
    expect(theirs).not.toBe(pluginOrigin({ host: 'another-host', plugin: 'trackr' }))
  })

  it('derives a DNS-safe label from any host id, the same every time, and never one for This PC', () => {
    expect(hostLabel(BUILD_BOX)).toBe(BUILD_BOX)
    const odd = hostLabel('Build Box/2')
    expect(odd).toMatch(/^h[0-9a-f]{16}$/)
    expect(hostLabel('Build Box/2')).toBe(odd)
    expect(hostLabel('Build Box/3')).not.toBe(odd)
    expect(() => hostLabel(LOCAL_HOST_KEY)).toThrow()
  })

  it('reads an origin or a URL back to its plugin and host', () => {
    expect(parsePluginOrigin('helm-plugin://trackr')).toEqual({ scheme: 'helm-plugin', plugin: 'trackr', label: null })
    expect(parsePluginOrigin('helm-plugin://trackr/dist/a.html?x=1')).toEqual({ scheme: 'helm-plugin', plugin: 'trackr', label: null })
    expect(parsePluginOrigin(`helm-plugin://trackr.${BUILD_BOX}/dist/a.html`)).toEqual({ scheme: 'helm-plugin', plugin: 'trackr', label: BUILD_BOX })
    expect(parsePluginOrigin('https://trackr')).toBeNull()
    expect(parsePluginOrigin('helm-plugin://')).toBeNull()
    expect(parsePluginOrigin('helm-plugin://user@trackr')).toBeNull()
    expect(parsePluginOrigin('helm-plugin://trackr.bad_label')).toBeNull()
    expect(parsePluginOrigin(null)).toBeNull()

    const hosts = [BUILD_BOX, 'Build Box/2']
    expect(hostOfLabel(null, hosts)).toBe(LOCAL_HOST_KEY)
    expect(hostOfLabel(BUILD_BOX, hosts)).toBe(BUILD_BOX)
    expect(hostOfLabel(hostLabel('Build Box/2'), hosts)).toBe('Build Box/2')
    expect(hostOfLabel('not-added', hosts)).toBeNull()
  })

  it('moves a page URL a remote host listed onto that host’s origin, keeping its path, and leaves This PC’s alone', () => {
    const url = 'helm-plugin://trackr/dist/main%20page.html?tab=1#top'
    expect(onHostOrigin(url, { host: LOCAL_HOST_KEY, plugin: 'trackr' })).toBe(url)
    expect(onHostOrigin(url, { host: BUILD_BOX, plugin: 'trackr' })).toBe(
      `helm-plugin://trackr.${BUILD_BOX}/dist/main%20page.html?tab=1#top`
    )
    expect(onHostOrigin('helm-plugin://trackr', { host: BUILD_BOX, plugin: 'trackr' })).toBe(`helm-plugin://trackr.${BUILD_BOX}/`)
  })

  it('s1: puts a version 2 plugin on floti-plugin://<id>, beside version 1 on helm-plugin://<id>, and reads either back with its scheme', () => {
    expect(pluginOrigin({ host: LOCAL_HOST_KEY, plugin: 'sample', scheme: 'floti-plugin' })).toBe('floti-plugin://sample')
    expect(pluginOrigin({ host: BUILD_BOX, plugin: 'sample', scheme: 'floti-plugin' })).toBe(`floti-plugin://sample.${BUILD_BOX}`)
    expect(parsePluginOrigin('floti-plugin://sample/dist/panel.html')).toEqual({ scheme: 'floti-plugin', plugin: 'sample', label: null })
    expect(parsePluginOrigin(`FLOTI-PLUGIN://sample.${BUILD_BOX}`)).toEqual({ scheme: 'floti-plugin', plugin: 'sample', label: BUILD_BOX })
    expect(parsePluginOrigin('floti-plugin://')).toBeNull()
    expect(parsePluginOrigin('floti-pluginx://sample')).toBeNull()
    expect(pluginSchemeOf('helm-plugin://sample/')).toBe('helm-plugin')
    expect(pluginSchemeOf('floti-plugin://sample/')).toBe('floti-plugin')
    expect(pluginSchemeOf('https://sample/')).toBeNull()
    expect(apiVersionOfScheme('helm-plugin')).toBe(1)
    expect(apiVersionOfScheme('floti-plugin')).toBe(2)
    expect(formatPluginOrigin({ scheme: 'floti-plugin', plugin: 'sample', label: 'build-box' })).toBe('floti-plugin://sample.build-box')
    // The scheme is part of the origin: the two versions never share one.
    expect(pluginOrigin({ host: LOCAL_HOST_KEY, plugin: 'sample', scheme: 'floti-plugin' })).not.toBe(
      pluginOrigin({ host: LOCAL_HOST_KEY, plugin: 'sample' })
    )
  })

  it('s1: moves a remote host’s version 2 page onto that host’s origin on floti-plugin, keeping its path', () => {
    const url = 'floti-plugin://sample/dist/panel.html?x=1'
    expect(onHostOrigin(url, { host: LOCAL_HOST_KEY, plugin: 'sample' })).toBe(url)
    expect(onHostOrigin(url, { host: BUILD_BOX, plugin: 'sample' })).toBe(`floti-plugin://sample.${BUILD_BOX}/dist/panel.html?x=1`)
    expect(onHostOrigin('floti-plugin://sample', { host: BUILD_BOX, plugin: 'sample' })).toBe(`floti-plugin://sample.${BUILD_BOX}/`)
  })

  it('keys a remote host’s frame under its host, and This PC’s as today', () => {
    expect(hostFrameKey(undefined, 'background:trackr')).toBe('background:trackr')
    expect(hostFrameKey(LOCAL_HOST_KEY, 'background:trackr')).toBe('background:trackr')
    expect(hostFrameKey(BUILD_BOX, 'background:trackr')).toBe(`host:${BUILD_BOX}/background:trackr`)
  })
})

describe('a plugin as a host lists it', () => {
  const listed: P.PluginInfo = {
    path: '/home/me/plugins/trackr',
    id: 'trackr',
    name: 'Trackr',
    version: '1.0.0',
    description: null,
    enabled: true,
    error: null,
    warnings: [],
    revision: 3,
    icon: null,
    rail: { title: 'Trackr', panel: 'main' },
    panels: { main: { title: 'Trackr', url: 'helm-plugin://trackr/dist/panel.html', actions: [] } },
    tabs: { item: { title: 'Item', url: 'helm-plugin://trackr/dist/item.html' } },
    pageStrip: false,
    background: { url: 'helm-plugin://trackr/dist/background.html', state: 'stopped', error: null },
    commands: [],
    settings: [],
    settingValues: {},
    network: [],
    secrets: [],
    exec: [],
    service: null,
    runsPrograms: false,
    agent: null,
    startsSessions: false,
    seesSessions: false,
    status: null,
    badge: null
  }

  it('s19 s22: has build-box’s pages and background page on build-box’s origin, and This PC’s where they were', () => {
    const ours = pluginFromHost(listed)
    expect(ours.panels['main']?.url).toBe('helm-plugin://trackr/dist/panel.html')
    expect(ours.background?.url).toBe('helm-plugin://trackr/dist/background.html')

    const theirs = pluginFromHost(listed, BUILD_BOX)
    expect(theirs.panels['main']?.url).toBe(`helm-plugin://trackr.${BUILD_BOX}/dist/panel.html`)
    expect(theirs.tabs['item']?.url).toBe(`helm-plugin://trackr.${BUILD_BOX}/dist/item.html`)
    expect(theirs.background?.url).toBe(`helm-plugin://trackr.${BUILD_BOX}/dist/background.html`)
  })

  it('s1: keeps a version 2 plugin’s pages on floti-plugin, here and on build-box', () => {
    const v2: P.PluginInfo = {
      ...listed,
      id: 'sample',
      panels: { main: { title: 'Sample', url: 'floti-plugin://sample/dist/panel.html', actions: [] } },
      tabs: { item: { title: 'Item', url: 'floti-plugin://sample/dist/item.html' } },
      background: { url: 'floti-plugin://sample/dist/background.js', state: 'running', error: null }
    }
    expect(pluginFromHost(v2).panels['main']?.url).toBe('floti-plugin://sample/dist/panel.html')
    const theirs = pluginFromHost(v2, BUILD_BOX)
    expect(theirs.panels['main']?.url).toBe(`floti-plugin://sample.${BUILD_BOX}/dist/panel.html`)
    expect(theirs.tabs['item']?.url).toBe(`floti-plugin://sample.${BUILD_BOX}/dist/item.html`)
    expect(theirs.background?.url).toBe(`floti-plugin://sample.${BUILD_BOX}/dist/background.js`)
  })
})
