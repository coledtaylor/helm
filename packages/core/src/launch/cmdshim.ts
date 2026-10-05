/**
 * Running a batch file - a `.cmd` or `.bat` shim, which is what npm and scoop
 * install a CLI as on Windows - without handing anything to a shell.
 *
 * `CreateProcess` cannot run a batch file, so it goes through `cmd.exe`, and
 * cmd re-parses the command line under a rule of its own: unless there are
 * exactly two quotes on it, it strips the first and the last, whatever they
 * were quoting. `/s` plus an extra pair of quotes around the whole line is the
 * documented way out (`cmd /?`), and `/d` keeps AutoRun commands out of it.
 * The line is passed verbatim (`windowsVerbatimArguments`), because Node would
 * otherwise quote it a second time.
 */

/** Anything cmd.exe would read as structure rather than as text. */
const CMD_SPECIAL = /[\s"&<>()@^|]/

/**
 * One argument, quoted so `cmd.exe` hands it to the batch file intact.
 *
 * cmd does no special-character processing inside quotes, so an `&` in an
 * argument reaches the program as an ampersand rather than ending the
 * command. The known limit: a literal `"` cannot be expressed through cmd at
 * all - the two quotings disagree by construction - so it is dropped rather
 * than allowed to end the line early.
 */
export function quoteForCmd(arg: string): string {
  const clean = arg.replace(/"/g, '')
  return CMD_SPECIAL.test(clean) || clean === '' ? `"${clean}"` : clean
}

/** The `cmd.exe` arguments that run `resolved` with `args`, as one verbatim line. */
export function cmdShimArgs(resolved: string, args: readonly string[]): string[] {
  return ['/d', '/s', '/c', `"${[resolved, ...args].map(quoteForCmd).join(' ')}"`]
}

/** Whether a resolved program is a batch file that has to go through `cmdShimArgs`. */
export function isBatchFile(path: string): boolean {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(path)
}
