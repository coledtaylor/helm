// The background module. The host runs it from the moment the plugin is
// turned on, in an isolate of its own, whether or not a page is on screen.
// `floti` is a global there before this runs. It has no window: no DOM, no
// `localStorage` and no `fetch` of its own (`floti.fetch` is its way out), and
// it may import only this plugin's own files, by a relative path.
/* global floti */

let opened = 0

// The panel says here each time it opens a tab, wherever it is drawn.
const tabs = new BroadcastChannel('tabs')
tabs.addEventListener('message', (event) => {
  if (event.data?.opened !== true) return
  opened += 1
  void floti.badge.set(opened)
})

void floti.status.set({ text: 'My plugin', tooltip: 'Open its panel' })
