# Spike C: Claude TUI fidelity inside xterm.js - VERDICT: GO

Ran 2026-08-09 on Windows 11 (build 26100), Electron 43.3.0, xterm.js 6.0.0,
node-pty 1.1.0, Claude Code 2.1.225. ClickUp task: 868knyagp.

**Embedded-first is viable. No external-terminal fallback mode is needed.**

The real `claude` TUI runs in an embedded xterm.js + node-pty pane with no
observable loss of fidelity, and the pane is as fast as having no terminal at
all. Every deviation found was a *host configuration* problem - something Helm
must set, not something xterm.js or Claude Code gets wrong - and all of them are
fixed and re-verified in this repo.

Fidelity is not free, though: an unconfigured xterm.js pane degrades the TUI in
five separate ways at once. The list under "Deviations" is the actual
deliverable of this spike.

## How it was measured

Two automated drivers, both asserting on what xterm.js *parsed* - cell colours,
cell widths, wrap flags, buffer coordinates - rather than on a screenshot a
human has to squint at. Keystrokes and mouse events are synthesised as real
Chromium input events, so they travel the same path a user's typing does.

```
npm run fidelity        # C1-C9, the terminal itself      -> helm-data/fidelity-report.json
npm run claude-check    # D0-D7, the real claude TUI      -> helm-data/claude-report.json
npm run shell           # the interactive pane, for the soak test
```

Both accept `--only=C5,C6` to re-run single checks. Reports and screenshots land
in the app's data directory; the two JSON reports are committed beside this file
as `evidence-fidelity.json` and `evidence-claude.json`.

## Results

### The terminal (`--fidelity`), 9/9

| | Check | Evidence |
|---|---|---|
| C1 | 24-bit colour | Three RGB triples that exist nowhere in the 256-colour palette parsed as RGB cells **and** appeared as ~1,700 exact-match pixels each in the composited frame. Foreground and background both. |
| C2 | Unicode widths | A box padded on the assumption of Unicode 11 widths closed on column 13 in all six rows. `中` and `🚀` measured 2 cells, `─` and `█` measured 1. |
| C3 | Resize reflow | A 300-character line reassembled byte-identical from the wrap flags at 100, 132, 61 and back to 100 columns - including a shrink well below its original wrap point. |
| C4 | Keyboard | Ctrl-C `\x03` interrupted a running loop; `↑` recalled history; Esc cleared the line editor; Tab completed `Get-Chi` → `Get-ChildItem`; Shift+Enter now distinct from Enter. |
| C5 | Paste | Multi-line paste arrived bracketed (`ESC[200~ … ESC[201~`) with newlines normalised to CR; unbracketed when mode 2004 is off; 100 KB delivered to the child process losslessly in 64 ms. |
| C6 | Scrollback | Under streaming output, a wheel scroll parked the viewport at row 1136 and it stayed there while the buffer grew from 1473 to 3273 rows. `scrollToBottom` returned. |
| C7 | Selection | A synthetic mouse drag selected the exact row text; Ctrl-C copied it; the next Ctrl-C interrupted again. |
| C8 | Latency | 150 samples: round trip p50 **1.0 ms**, p95 **7.0 ms**, max 16.4 ms. The host's own share (keydown → byte handed to the pty) is p50 **0 ms**, p95 0.1 ms. |
| C9 | Throughput | 40,000 lines drained in **4,071 ms** at 100x30. |

### The real TUI (`--claude-check`), 8/8

| | Check | Evidence |
|---|---|---|
| D0 | Startup | Reaches the input prompt; startup gates (folder trust, MCP enablement) are arbitrary dialogs a host must expect, not a fixed sequence. |
| D1 | Resize | The composer rules redrew flush to column 99 / 131 / 71 / 99 at 100, 132, 72 and back to 100 - no ghost columns. |
| D2 | Colour | Claude emitted 5 distinct 24-bit colours and **zero** 256-palette colours on the first screen. |
| D3 | Composer | Typing renders; the first Ctrl-C interrupted the running turn and left the composer untouched; the second cleared it; the session survived both. |
| D4 | Overlays | Slash-command menu rendered and its highlight moved with arrow keys (verified by cell foreground colour, since the highlight is a colour change and not a text change); Esc dismissed it; `/help` rendered; the **`/resume` picker rendered in the alternate buffer** and responded to arrow keys. |
| D5 | Permission dialog | A Bash tool prompt rendered with its numbered options, moved with arrow keys, and cancelled on Esc - confirmed by the target directory not existing afterwards. |
| D6 | Shift+Enter | Inserts a newline instead of submitting (after the fix below). |
| D7 | Newline encodings | The composer accepts **all four** of `ESC CR`, `LF`, `CSI 13;2u` and `\`+CR as an inline newline. |

## Deviations

Severity is what would happen if Helm shipped without the fix.

| # | Deviation | Severity | Status |
|---|---|---|---|
| 1 | **Shift+Enter is byte-identical to Enter.** xterm.js has no default encoding for the modifier, so both send `\r` and the composer *submits the prompt* instead of adding a line. | **High** - silently sends half-written prompts | **Fixed.** The pane binds Shift+Enter to `ESC CR`. D7 established the composer accepts it; D6 verifies the binding. |
| 2 | **Electron's default menu eats Ctrl-C.** The stock application menu binds Ctrl-C to the Edit→Copy role, which consumes the keydown before xterm sees it - the interrupt never reaches Claude. | **High** - no way to interrupt a turn | **Fixed.** `Menu.setApplicationMenu(null)`. |
| 3 | **Colour depth is not advertised by default.** Without `COLORTERM=truecolor` in the child environment, Ink resolves 256 colours and the whole theme shifts. | Medium - wrong colours everywhere | **Fixed** in `ptyEnv`. D2 confirms zero palette colours in use. |
| 4 | **Unicode 6 widths by default.** Without `allowProposedApi` + the Unicode 11 addon, emoji are measured one cell wide and every box-drawn surface - status line, dialogs, the composer - misaligns. | Medium - visibly broken UI | **Fixed.** C2 is the regression test. |
| 5 | **Inherited `CLAUDE_CODE_*` environment.** Launching Helm from inside a Claude Code session leaks `CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION` and friends into the hosted session, which then announces *"Transcript saving is off - inherited CLAUDE_CODE_CHILD_SESSION marker"* and stops writing a transcript. | Medium - silent data loss, and it defeats the v1.1 transcript-archive plan | **Fixed.** `ptyEnv` scrubs them. |
| 6 | **Ctrl-C is overloaded.** A terminal host has to choose between copy and interrupt. | Medium | **Implemented** to Windows Terminal's contract: Ctrl-C copies only while a selection is live, any other keystroke drops the selection, Ctrl-Shift-C/V always copy and paste. C7 covers all three transitions. |
| 7 | **`minimumContrastRatio` and `drawBoldTextInBrightColors`** would rewrite Claude's colours if left at anything but the passive setting. | Low | **Fixed** - both pinned explicitly, with comments saying why. |
| 8 | **node-pty prints `AttachConsole failed`** from `conpty_console_list_agent` when enumerating the console process list. | Low | **Not fixed.** node-pty has a built-in timeout fallback (it falls back to killing the shell pid alone), so the effect is stderr noise plus a marginally less thorough process-tree kill. Revisit if orphaned processes ever show up. |
| 9 | **Electron's own binary cannot host a process in a pty.** `electron.exe` run as node inside a ConPTY exits cleanly but its stdio never reaches the pseudoconsole - it is a `/SUBSYSTEM:WINDOWS` binary. | Low | **Informational.** Nothing Helm ships needs it; the spike's own sink/echo processes use `node.exe`. Worth remembering before planning any in-pane helper. |

## On latency

The acceptance criterion is "indistinguishable from Windows Terminal in normal
use". Two measurements bound it:

- **Input.** Keydown to the painted frame carrying the echo is p50 1.0 ms, and
  the host's share of that is p50 0 ms / p95 0.1 ms. There is no room in those
  numbers for a perceivable difference - a 60 Hz frame is 16.7 ms.
- **Output.** 40,000 lines drain in 4,071 ms. The same workload through a
  consumer that does *nothing but read bytes and discard them* takes
  4,065-4,089 ms. The pane is within noise of having no terminal at all, so
  ConPTY and PowerShell are the bottleneck and no terminal can be meaningfully
  faster.

Windows Terminal could not be launched from the automation environment (MSIX
activation is blocked there), so the side-by-side number is the one measurement
this spike did not take. Given the floor above it cannot change the verdict, but
to fill it in, run this in Windows Terminal and compare against 4,071 ms:

```powershell
pwsh -NoLogo -NoProfile -Command '[Console]::SetWindowSize(100,30); $sw=[Diagnostics.Stopwatch]::StartNew(); 1..40000 | ForEach-Object { "line $_ the quick brown fox jumps over the lazy dog" } | Out-Host; "THROUGHPUT $($sw.ElapsedMilliseconds)"'
```

## What automation cannot sign off

`npm run shell` opens the interactive pane against this repo. The 30-minute
real-session soak is still owed a human verdict on:

- [ ] Latency *feels* right over a long session, not just in percentiles
- [ ] Diff rendering and syntax highlighting during real edits (this spike
      proved the colour path, not Claude's diff view specifically)
- [ ] Memory and responsiveness after a long session with heavy scrollback
- [ ] Anything that only shows up when a person is actually working

## Implications for Helm

- **M2 (embedded terminal) is de-risked.** `src/renderer/src/terminal.ts` is the
  seed: it carries all five configuration fixes, and every one has a named
  regression check behind it.
- **Do not build an external-terminal fallback mode.** Nothing found here
  justifies the second code path.
- **`ptyEnv` is load-bearing.** Colour depth and environment scrubbing both live
  there, and both fail silently and confusingly when wrong.
- **The probe bridge is worth keeping.** Asserting on parsed cells rather than
  pixels is what made these checks trustworthy - three of the first-round
  "failures" were bugs in the tests, and the cell-level detail is what exposed
  them.
