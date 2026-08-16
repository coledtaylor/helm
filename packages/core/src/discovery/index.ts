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
  type CreateHarnessRequest,
  type CreateHarnessResult
} from './harness'
export {
  applyTemplate,
  listTemplates,
  previewTemplate,
  seedTemplates,
  substituteTemplate,
  templateIdProblems,
  MINIMAL_CHOICE,
  MINIMAL_TEMPLATE,
  SHIPPED_TEMPLATES,
  type ApplyTemplateRequest,
  type ApplyTemplateResult,
  type PreviewTemplateRequest,
  type SeedResult,
  type TemplateChoice,
  type TemplateListing,
  type TemplatePreview,
  type TemplateValues
} from './templates'
export { findEnclosingHarness, suggestRoots } from './roots'
export {
  TITLE_MAX,
  cleanPrompt,
  deriveSessionTitle,
  sessionTitleFrom,
  titleRank,
  type SessionTitle
} from './title'
export {
  disprovedProjectPaths,
  isWithin,
  orphanedProjectPaths,
  scan,
  type ScanOptions
} from './scan'
