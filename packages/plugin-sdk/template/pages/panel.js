// The sidebar panel. `window.helm` is Helm's bridge, there before this runs.
/* global window, document */

const helm = window.helm
const opened = document.getElementById('opened')
let count = 0

/** Opens a tab of its own for each press: the parameters are part of a tab's identity. */
function openTab() {
  count += 1
  const title = `Page ${count}`
  void helm.tabs.open('page', { n: count }, { title })
  const row = document.createElement('li')
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'helm-row'
  button.textContent = title
  const n = count
  button.addEventListener('click', () => void helm.tabs.open('page', { n }, { title: `Page ${n}` }))
  row.append(button)
  opened.append(row)
}

document.getElementById('open').addEventListener('click', openTab)

// The + in the sidebar header, and the command in Ctrl+Shift+P without a tab.
helm.on('action', ({ id }) => {
  if (id === 'open') openTab()
})

document.getElementById('where').textContent = `${helm.context.plugin}, ${helm.context.surface}, ${helm.theme.kind} theme`
helm.on('theme', (theme) => {
  document.getElementById('where').textContent = `${helm.context.plugin}, ${helm.context.surface}, ${theme.kind} theme`
})
