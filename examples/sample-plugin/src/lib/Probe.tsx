import { useState, type JSX } from 'react'
import { busy, instance, loads } from './measure'

/** What the spike reads off a surface: which load this is, and whether memory survived. */
export function Probe(): JSX.Element {
  const [count, setCount] = useState(0)
  return (
    <section className="probe" aria-label="Spike probe">
      <h2>Spike probe</h2>
      <dl>
        <dt>Instance</dt>
        <dd data-probe-instance>{instance}</dd>
        <dt>Page loads</dt>
        <dd data-probe-loads>{loads}</dd>
        <dt>Counter</dt>
        <dd data-probe-count>{count}</dd>
      </dl>
      <div className="row">
        <button type="button" onClick={() => setCount((value) => value + 1)}>
          Count
        </button>
        <button type="button" onClick={() => busy(3000)}>
          Block this page for 3s
        </button>
      </div>
      <p className="hint">
        The counter lives in memory. If it survives a tab switch, a split or a move, the page was not reloaded.
      </p>
    </section>
  )
}
