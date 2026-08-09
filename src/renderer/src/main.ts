import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

declare global {
  interface Window {
    helm: {
      ready: () => void
      input: (data: string) => void
      resize: (cols: number, rows: number) => void
      termCreated: () => void
      termResized: () => void
      onTermCreate: (cb: (opts: { cols: number; rows: number; fit: boolean }) => void) => void
      onTermWrite: (cb: (data: string) => void) => void
      onTermResize: (cb: (size: { cols: number; rows: number }) => void) => void
    }
  }
}

let term: Terminal | null = null

window.helm.onTermCreate(({ cols, rows, fit }) => {
  term = new Terminal({
    cols,
    rows,
    fontFamily: 'Cascadia Mono, Consolas, monospace',
    fontSize: 14,
    theme: { background: '#1e1e2e' }
  })
  term.open(document.getElementById('terminal')!)
  term.onData((data) => window.helm.input(data))

  if (fit) {
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    fitAddon.fit()
    window.helm.resize(term.cols, term.rows)
    new ResizeObserver(() => {
      fitAddon.fit()
      window.helm.resize(term!.cols, term!.rows)
    }).observe(document.getElementById('terminal')!)
  }

  term.focus()
  window.helm.termCreated()
})

window.helm.onTermWrite((data) => term?.write(data))

window.helm.onTermResize(({ cols, rows }) => {
  term?.resize(cols, rows)
  window.helm.termResized()
})

window.helm.ready()
