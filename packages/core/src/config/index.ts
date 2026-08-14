export { computeEffectiveView, claudeJsonPath, type EffectiveInput } from './effective'
export { runDoctor } from './doctor'
export {
  addMcpServer,
  diffLines,
  listMcpServers,
  mcpTargetFile,
  previewMcpAdd,
  removeMcpServer,
  type ClaudeCommand,
  type McpRunResult
} from './mcp'
export {
  createConfigFile,
  deleteConfigEntry,
  renameConfigEntry
} from './create-rename-delete'
// `validate.ts`, `settings-schema.ts` and `names.ts` are deliberately absent:
// all three are re-exported from `types.ts`, which is the entry point the
// renderer imports them from, and exporting them from two `export *` sources
// would make the names ambiguous at the package root.
export {
  homeDirectory,
  projectConfigScope,
  readConfigTree,
  userConfigScope
} from './tree'
export {
  assertWritable,
  hashContent,
  readConfigFileContent,
  restoreConfigSnapshot,
  snapshotKey,
  writeConfigFile
} from './write'
