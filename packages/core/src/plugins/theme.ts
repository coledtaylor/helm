import type { HelmTheme, PaletteHue as SdkPaletteHue, ThemeTokenName } from '@coledtaylor/helm-plugin-sdk'
import type { AppSettings } from '../types'
import { THEME_TOKENS, type AppliedTheme, type PaletteHue, type ThemeToken } from '../theme/themes'

/**
 * The SDK's names for the theme's colours and palette are the ones core
 * paints, no more and no fewer: a plugin author reads `ThemeTokenName`, and a
 * name there Helm never writes would be a variable that is always unset.
 */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const sdkNamesTheTokens: Same<ThemeToken, ThemeTokenName> = true
const sdkNamesTheHues: Same<PaletteHue, SdkPaletteHue> = true
void sdkNamesTheTokens
void sdkNamesTheHues

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
