export { hasClaudeDir, readClaudeInventory } from './claude-inventory'
export { isGitRepo, parseGitStatus, readGitState, readGitStates } from './git'
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
} from './history'
export { findEnclosingHarness, suggestRoots } from './roots'
export { scan, type ScanOptions } from './scan'
