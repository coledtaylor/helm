// A tab. Its parameters arrive with it, in `helm.context`. `helm` is the global
// bridge, as in panel.js.
/* global helm, document */

const { params } = helm.context
const title = typeof params.n === 'number' ? `Page ${params.n}` : 'Page'

document.getElementById('title').textContent = title
document.getElementById('params').textContent = JSON.stringify(params)
// The title in the tab strip. Null would put back the manifest's.
helm.surface.setTitle(title)

const visible = document.getElementById('visible')
visible.textContent = helm.visible ? 'yes' : 'no'
helm.on('visibility', (shown) => {
  visible.textContent = shown ? 'yes' : 'no'
})
