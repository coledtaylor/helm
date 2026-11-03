// What the fake transports share: recording how each was run, and running
// the line it was given on "the other computer", which in a test is this one,
// in the test's own folders.
//
// A transport carries bytes unchanged: the line's program gets this process's
// standard input, output and error as they are, and its exit status is this
// process's. `floti` in the line is the `floti` binary the test built, named
// by FAKE_SSH_FLOTI; every other program is looked up on PATH. Nothing runs
// through a shell.

import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { dirname } from "node:path";

import { watchOwner } from "../fake-agents/common.mjs";

/**
 * Appends `entry` to the JSON-lines file FAKE_SSH_LOG names, one line per
 * run, when it is set. A test reads it to see exactly how it was run.
 */
export function record(entry) {
  const log = process.env.FAKE_SSH_LOG;
  if (!log) return;
  appendFileSync(log, `${JSON.stringify({ pid: process.pid, ...entry })}\n`);
}

/**
 * Splits `line` into words the way a POSIX shell does for a plain command:
 * on blanks, with single and double quotes grouping and a backslash escaping
 * the next character outside single quotes. Nothing is expanded.
 */
export function splitWords(line) {
  const words = [];
  let word = null;
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      else word += c;
    } else if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === "\\" && i + 1 < line.length) word += line[++i];
      else word += c;
    } else if (c === " " || c === "\t") {
      if (word !== null) words.push(word);
      word = null;
    } else if (c === "'" || c === '"') {
      word ??= "";
      quote = c;
    } else if (c === "\\" && i + 1 < line.length) {
      word = (word ?? "") + line[++i];
    } else {
      word = (word ?? "") + c;
    }
  }
  if (word !== null) words.push(word);
  return words;
}

/**
 * Runs `line` as the login on the other side would, and exits with its
 * status. A program that is not found fails as `sh` says it, with 127.
 */
export function runLine(line) {
  const [program, ...args] = splitWords(line);
  if (program === undefined) process.exit(0);
  // FAKE_SSH_MISSING_LINE plays a computer that cannot run one line: a line
  // starting with it fails as `sh` says a program it cannot find, with 127.
  const missing = process.env.FAKE_SSH_MISSING_LINE;
  if (missing && line.startsWith(missing)) {
    process.stderr.write(`sh: 1: ${program}: not found
`);
    process.exit(127);
  }
  // FAKE_SSH_ELSEWHERE_LINE and FAKE_SSH_ELSEWHERE_RUNTIME play a login
  // that finds no host for one line: a line starting with the first runs
  // with FLOTI_RUNTIME_DIR set to the second, a folder no host listens in.
  const elsewhere = process.env.FAKE_SSH_ELSEWHERE_LINE;
  const env =
    elsewhere &&
    process.env.FAKE_SSH_ELSEWHERE_RUNTIME &&
    line.startsWith(elsewhere)
      ? {
          ...process.env,
          FLOTI_RUNTIME_DIR: process.env.FAKE_SSH_ELSEWHERE_RUNTIME,
        }
      : process.env;
  const floti = process.env.FAKE_SSH_FLOTI;
  const resolved = program === "floti" && floti ? floti : program;
  const child = spawn(resolved, args, {
    stdio: "inherit",
    windowsHide: true,
    env,
  });
  child.on("error", () => {
    process.stderr.write(`sh: 1: ${program}: not found\n`);
    process.exit(127);
  });
  child.on("exit", (code) => process.exit(code ?? 1));
  // A run whose test has gone ends with it, taking the line's program along.
  if (process.env.FAKE_SSH_LOG) {
    watchOwner(dirname(process.env.FAKE_SSH_LOG), () => {
      child.kill();
      process.exit(1);
    });
  }
}
