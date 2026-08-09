import type { LatencySample } from '../../shared/protocol'

/**
 * Measures the cost the *host* adds to a keystroke.
 *
 * Two numbers per sample:
 *   hostInputMs - keydown to the moment xterm has translated the key and the
 *                 byte is handed to IPC. Pure renderer overhead.
 *   roundTripMs - keydown to the first animation frame after the echoed glyph
 *                 was parsed. The whole loop: key -> IPC -> pty -> shell ->
 *                 pty -> IPC -> parse -> paint.
 *
 * The driver sends one key at a time and waits for its sample, so keystrokes
 * and echoes stay correlated without guessing.
 */
export class LatencyRecorder {
  private armedChar = ''
  private pending: { t0: number; hostMs: number | null }[] = []
  private samples: LatencySample[] = []

  arm(char: string): void {
    this.armedChar = char
    this.pending = []
    this.samples = []
  }

  disarm(): void {
    this.armedChar = ''
  }

  keyDown(at: number): void {
    if (this.armedChar) this.pending.push({ t0: at, hostMs: null })
  }

  /** Called as the translated byte leaves for the pty. */
  hostInput(): void {
    const last = this.pending[this.pending.length - 1]
    if (last && last.hostMs === null) last.hostMs = performance.now() - last.t0
  }

  /** How many armed echoes this chunk contains. Call once the chunk is parsed. */
  countPending(chunk: string): number {
    if (!this.armedChar) return 0
    let n = 0
    for (const ch of chunk) if (ch === this.armedChar) n++
    return Math.min(n, this.pending.length)
  }

  /** Close `n` samples at the current (post-paint) timestamp. */
  close(n: number): void {
    const now = performance.now()
    for (let i = 0; i < n; i++) {
      const p = this.pending.shift()
      if (!p) return
      this.samples.push({ roundTripMs: now - p.t0, hostInputMs: p.hostMs ?? -1 })
    }
  }

  results(): LatencySample[] {
    return this.samples
  }
}
