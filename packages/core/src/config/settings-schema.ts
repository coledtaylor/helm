/**
 * What the keys in a `settings.json` mean, as hints beside a JSON editor.
 *
 * Not a validator. Claude Code owns this file's schema and adds keys between
 * releases, so a table that rejected what it did not recognise would turn a new
 * feature into an error message. Every key here is one observed in the wild on
 * 2.1.225 or documented by the CLI; anything else is shown as unrecognised,
 * which is a note rather than a problem.
 *
 * Pure, like `validate.ts`, because the editor that shows the hints is the
 * renderer.
 */

export interface SettingHint {
  key: string
  /** JSON type the key takes, for the hint line. */
  type: 'string' | 'number' | 'boolean' | 'object' | 'array'
  summary: string
  /** Accepted values, when the key is an enumeration. */
  values?: readonly string[]
}

export const SETTING_HINTS: readonly SettingHint[] = [
  { key: 'model', type: 'string', summary: 'Default model for sessions started here.' },
  {
    key: 'effortLevel',
    type: 'string',
    summary: 'Default reasoning effort.',
    values: ['low', 'medium', 'high', 'xhigh', 'max']
  },
  {
    key: 'env',
    type: 'object',
    summary: 'Environment variables injected into every session and every process it spawns.'
  },
  {
    key: 'permissions',
    type: 'object',
    summary: 'allow / deny / ask rule lists, defaultMode, and additionalDirectories.'
  },
  { key: 'hooks', type: 'object', summary: 'Commands run on tool events (PreToolUse, PostToolUse, Stop, …).' },
  { key: 'disableAllHooks', type: 'boolean', summary: 'Turns every hook off without deleting them.' },
  { key: 'statusLine', type: 'object', summary: 'Command whose output is drawn under the composer.' },
  { key: 'outputStyle', type: 'string', summary: 'Named output style applied to responses.' },
  { key: 'enabledPlugins', type: 'object', summary: 'Plugin name -> whether it loads. Keys are `<plugin>@<marketplace>`.' },
  { key: 'extraKnownMarketplaces', type: 'object', summary: 'Additional plugin marketplaces this scope can install from.' },
  {
    key: 'enabledMcpjsonServers',
    type: 'array',
    summary: 'Names from `.mcp.json` approved for this project. Without this each one gates on first launch.'
  },
  { key: 'disabledMcpjsonServers', type: 'array', summary: 'Names from `.mcp.json` that must not load.' },
  { key: 'enableAllProjectMcpServers', type: 'boolean', summary: 'Approve every `.mcp.json` server without listing them.' },
  { key: 'apiKeyHelper', type: 'string', summary: 'Script that prints a credential on stdout.' },
  { key: 'cleanupPeriodDays', type: 'number', summary: 'How long transcripts survive before they are reaped.' },
  { key: 'includeCoAuthoredBy', type: 'boolean', summary: 'Adds the Co-Authored-By trailer to commits.' },
  { key: 'forceLoginMethod', type: 'string', summary: 'Pins the sign-in path.', values: ['claudeai', 'console'] },
  { key: 'theme', type: 'string', summary: 'TUI colour theme.' },
  { key: 'tui', type: 'string', summary: 'Terminal presentation mode.', values: ['fullscreen', 'inline'] },
  { key: 'autoUpdatesChannel', type: 'string', summary: 'Which release stream the CLI updates from.' },
  { key: 'agentTeams', type: 'object', summary: 'Multi-agent team settings.' },
  { key: 'agentPushNotifEnabled', type: 'boolean', summary: 'Push notifications for background agents.' },
  { key: 'remoteControlAtStartup', type: 'boolean', summary: 'Offer remote control when a session starts.' },
  { key: 'skipDangerousModePermissionPrompt', type: 'boolean', summary: 'Suppresses the bypassPermissions confirmation.' },
  { key: 'skipAutoPermissionPrompt', type: 'boolean', summary: 'Suppresses the automatic-permissions confirmation.' },
  { key: 'sandbox', type: 'object', summary: 'Sandboxing rules for tool execution.' },
  { key: 'spinnerTipsEnabled', type: 'boolean', summary: 'Shows tips while the model is working.' },
  { key: 'alwaysThinkingEnabled', type: 'boolean', summary: 'Keeps extended thinking on by default.' }
] as const

const BY_KEY = new Map(SETTING_HINTS.map((hint) => [hint.key, hint]))

export function settingHint(key: string): SettingHint | null {
  return BY_KEY.get(key) ?? null
}

/** `env.FOO` -> `env`. The hint table is keyed on the top-level name. */
export function topLevelKey(path: string): string {
  const dot = path.indexOf('.')
  return dot < 0 ? path : path.slice(0, dot)
}
