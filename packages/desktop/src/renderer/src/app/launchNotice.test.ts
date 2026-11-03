import { describe, expect, it } from 'vitest'
import { LOCAL_HOST_KEY } from '@helm/core/types'
import { treeLaunchNotice, type TreeLaunchFailure } from './launchNotice'

const BUILD = 'h-build'
const nameOf = (host: string): string => (host === BUILD ? 'build-box' : host)
const failed: TreeLaunchFailure = { host: BUILD, path: '/srv/app', name: 'app', text: 'claude is not installed there.' }

describe('a launch from the sidebar that failed', () => {
  it('says so over the panes, naming build-box, whatever is in front', () => {
    expect(treeLaunchNotice(failed, null, nameOf)).toBe(
      'Could not start a session in app on build-box: claude is not installed there.'
    )
    expect(treeLaunchNotice(failed, { kind: 'history' }, nameOf)).toBe(
      'Could not start a session in app on build-box: claude is not installed there.'
    )
    // This PC's project of the same path is another folder.
    expect(treeLaunchNotice(failed, { kind: 'project', path: '/srv/app' }, nameOf)).not.toBeNull()
  })

  it('says nothing over the panes while that project’s page is in front, which says it already', () => {
    expect(treeLaunchNotice(failed, { kind: 'project', path: '/srv/app', host: BUILD }, nameOf)).toBeNull()
    expect(treeLaunchNotice(null, null, nameOf)).toBeNull()
  })

  it('names no host for a launch on this PC', () => {
    const here: TreeLaunchFailure = { ...failed, host: LOCAL_HOST_KEY, path: 'C:\\work\\app' }
    expect(treeLaunchNotice(here, null, nameOf)).toBe('Could not start a session in app: claude is not installed there.')
    expect(treeLaunchNotice(here, { kind: 'project', path: 'C:\\work\\app' }, nameOf)).toBeNull()
  })
})
