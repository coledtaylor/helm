// A tab. Its parameters arrive with it, in `floti.context`. `floti` is the
// global bridge, as in panel.js.
/* global floti, document */

const { params } = floti.context
const title = typeof params.n === 'number' ? `Page ${params.n}` : 'Page'

document.getElementById('title').textContent = title
document.getElementById('params').textContent = JSON.stringify(params)
// The title in the tab strip. Null would put back the manifest's.
floti.surface.setTitle(title)

const visible = document.getElementById('visible')
visible.textContent = floti.visible ? 'yes' : 'no'
floti.on('visibility', (shown) => {
  visible.textContent = shown ? 'yes' : 'no'
})
