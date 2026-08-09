import { createTerminal, type TerminalHost } from './terminal'
import { LatencyRecorder } from './latency'
import { makeProbeHandler } from './probe'
import type { ProbeOp, TermCreateOptions } from '../../shared/protocol'

declare global {
  interface Window {
    helm: {
      ready: () => void
      input: (data: string) => void
      resize: (cols: number, rows: number) => void
      termCreated: (info: unknown) => void
      termResized: () => void
      onTermCreate: (cb: (opts: TermCreateOptions) => void) => void
      onTermWrite: (cb: (data: string) => void) => void
      onTermResize: (cb: (size: { cols: number; rows: number }) => void) => void
      clipboardRead: () => Promise<string>
      clipboardWrite: (text: string) => Promise<void>
      onProbe: (handler: (req: ProbeOp) => unknown) => void
    }
  }
}

let host: TerminalHost | null = null
const latency = new LatencyRecorder()

window.helm.onProbe(makeProbeHandler(() => host, latency))

window.helm.onTermCreate((opts) => {
  host = createTerminal(document.getElementById('terminal')!, opts, {
    onInput: (data) => {
      latency.hostInput()
      window.helm.input(data)
    },
    onResize: (cols, rows) => window.helm.resize(cols, rows),
    readClipboard: () => window.helm.clipboardRead(),
    writeClipboard: (text) => window.helm.clipboardWrite(text),
    onKeyDown: (at) => latency.keyDown(at)
  })
  window.helm.termCreated({
    rendererKind: host.rendererKind,
    cols: host.term.cols,
    rows: host.term.rows,
    unicodeVersion: host.term.unicode.activeVersion
  })
})

window.helm.onTermWrite((data) => {
  host?.term.write(data, () => {
    const n = latency.countPending(data)
    if (n > 0) requestAnimationFrame(() => latency.close(n))
  })
})

window.helm.onTermResize(({ cols, rows }) => {
  host?.term.resize(cols, rows)
  window.helm.termResized()
})

window.helm.ready()
