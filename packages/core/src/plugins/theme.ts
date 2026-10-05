import type { HelmTheme } from '@helm/plugin-sdk'
import type { AppSettings } from '../types'
import { THEME_TOKENS, type AppliedTheme } from '../theme/themes'

/**
 * The theme as a plugin page sees it: the colours on screen and the two shape
 * settings its controls follow.
 *
 * One function for both places a plugin gets it - main, which bakes it into
 * the bridge a page loads with so its first paint is already right, and the
 * window, which sends it again on every change. Pure and browser-safe.
 */
export function pluginThemeOf(
  applied: AppliedTheme,
  settings: Pick<AppSettings, 'cornerRadius' | 'density'>
): HelmTheme {
  const tokens = {} as HelmTheme['tokens']
  for (const token of THEME_TOKENS) tokens[token] = applied.tokens[token]
  return { kind: applied.kind, tokens, radius: settings.cornerRadius, density: settings.density }
}
