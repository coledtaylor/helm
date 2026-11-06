// The sidebar panel. `floti` is the bridge, a global there before this runs.
// Use it as it is: in a classic script like this one, declaring a top-level
// `floti` of your own is a SyntaxError beside it, and the whole file stops.
/* global floti, document */

const opened = document.getElementById('opened')
// Tells the background module, which counts the tabs on the rail icon.
const tabs = new BroadcastChannel('tabs')
let count = 0

/** Opens a tab of its own for each press: the parameters are part of a tab's identity. */
function openTab() {
  count += 1
  const title = `Page ${count}`
  void floti.tabs.open('page', { n: count }, { title })
  tabs.postMessage({ opened: true })
  const row = document.createElement('li')
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'helm-row'
  button.textContent = title
  const n = count
  button.addEventListener('click', () => void floti.tabs.open('page', { n }, { title: `Page ${n}` }))
  row.append(button)
  opened.append(row)
}

document.getElementById('open').addEventListener('click', openTab)

// The + in the sidebar header, and the command in the command palette
// (Ctrl+Shift+P, or Cmd+Shift+P on macOS) without a tab.
floti.on('action', ({ id }) => {
  if (id === 'open') openTab()
})

document.getElementById('where').textContent = `${floti.context.plugin}, ${floti.context.surface}, ${floti.theme.kind} theme`
floti.on('theme', (theme) => {
  document.getElementById('where').textContent = `${floti.context.plugin}, ${floti.context.surface}, ${theme.kind} theme`
})
