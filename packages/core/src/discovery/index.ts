export { hasClaudeDir, readClaudeInventory } from './claude-inventory'
export { isGitRepo, parseGitStatus, readGitBranch, readGitState, readGitStates } from './git'
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
export {
  countTopLevelFolders,
  createHarness,
  harnessNameProblems,
  HARNESS_FORMAT_VERSION,
  MINIMAL_TEMPLATE,
  type CreateHarnessRequest,
  type CreateHarnessResult
} from './harness'
export { findEnclosingHarness, suggestRoots } from './roots'
export {
  disprovedProjectPaths,
  isWithin,
  orphanedProjectPaths,
  scan,
  type ScanOptions
} from './scan'
