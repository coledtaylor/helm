/**
 * The Files view's headless half: what git says about a project's files, which
 * lines of one differ from the last commit, every file in a project for Ctrl+P,
 * and one file read for viewing. Read-only throughout.
 */

export { parseZeroContextDiff, readFileChanges } from './changes'
export { FILE_LIST_MAX, listProjectFiles } from './listing'
export { parseStatusZ, prefixIn, readFilesStatus } from './status'
export { FILE_VIEW_MAX_BYTES, isInsideRoot, readFileView } from './view'
