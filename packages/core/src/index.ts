/**
 * `@helm/core` - what Helm's clients share, and `helm.db`.
 *
 * The local host runs sessions and reads and writes the workspace; this
 * package keeps what the window and main need beside it: the shapes the host
 * answers in (`types.ts`, the one entry point a browser bundle imports values
 * from), `helm.db` for what stays per device and the copy of an older
 * install's data into the host (`store/`), and the start-up sweep of what
 * sessions Helm ran in its own process left behind (`launch/`).
 *
 * The one discipline (SPEC 5): nothing in this package may import Electron.
 * It is enforced by ESLint, not by convention - see `eslint.config.js`.
 */

export * from './types'
export {
  messageText,
  parseArchiveLine,
  readArchiveTail,
  type ArchiveRole,
  type ArchiveRow,
  type ArchiveTail
} from './archive/transcript'
export {
  claudeHome,
  directoryExists,
  historyFileIn,
  projectsDirIn,
  readHistoryTail,
  scanTranscripts,
  type HistoryLine,
  type HistoryTail,
  type TranscriptFile
} from './discovery/history'
export { isInsideRoot } from './files/inside'
export { cleanStaleMcpConfigs } from './launch/mcp'
export {
  cleanStaleShims,
  linkKind,
  planOverlays,
  probeProcess,
  syncOverlay,
  type OverlayPlan,
  type OwnerLiveness,
  type ShimOwner,
  type SyncedOverlay
} from './launch/overlay'
export * from './store'
export {
  parseUsageLine,
  readUsageTail,
  scanUsageTranscripts,
  type TranscriptStat,
  type UsageRow,
  type UsageTail
} from './usage/transcripts'
export * from './theme/load'
