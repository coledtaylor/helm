export { openStore, type HelmDatabase, type OpenStoreOptions, type Store } from './db'
export {
  historyCursor,
  historySummary,
  indexHistory,
  readHistoryProjects,
  readHistoryPrompts,
  readHistorySession,
  readHistorySessions,
  type HistoryIndexInput
} from './history'
export { knownMigrations, migrate, type MigrationOutcome } from './migrate'
export { cacheProjects, readCachedProjects, type CachedProject } from './projects'
export {
  createProfile,
  deleteProfile,
  findProfileByName,
  listProfiles,
  readProfile,
  setPinnedProfiles,
  updateProfile,
  uniqueProfileName
} from './profiles'
export {
  finishSession,
  readSessions,
  reconcileRunningSessions,
  runningSessionNames,
  startSession,
  type NewSession,
  type SessionQuery
} from './sessions'
export { readSettings, writeSetting, writeSettings } from './settings'
export * as schema from './schema'
