// A fake custom transport for tests: `node carry.mjs [<argument>...] <line>`.
//
// It stands for any command of the user's choosing that carries bytes
// unchanged and is given the line to run on the other side as its last
// argument (a WSL bridge, a container exec, a serial link). It records its
// argv, ignores every argument but the last, and runs that line "on the
// other computer", which is this one, in the test's own folders, carrying
// standard input and output unchanged (`runLine` in common.mjs).

import { record, runLine } from './common.mjs'

const argv = process.argv.slice(2)
const line = argv.at(-1) ?? ''
record({ program: 'carry', argv, line })
runLine(line)
