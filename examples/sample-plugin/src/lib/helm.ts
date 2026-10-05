/**
 * The plugin's side of the bridge to Helm.
 *
 * In the finished design this object is injected by the running Helm and typed
 * by the SDK, so a plugin never carries a copy that can drift from the Helm it
 * runs in. For the spike it is the one call the prototype needs, written out so
 * the shape is visible.
 *
 * Every message goes to the parent window. Helm knows which plugin sent it from
 * `event.origin` - `helm-plugin://<id>` - which the browser sets and the page
 * cannot, so nothing in the message claims an identity.
 */
interface OpenTab {
  type: 'helm:tabs.open'
  tab: string
}

function send(message: OpenTab): void {
  // The target origin is the window that framed us, whatever Helm is serving
  // from; the message carries nothing a different parent could misuse.
  window.parent.postMessage(message, '*')
}

export const helm = {
  tabs: {
    /** Opens one of the tabs this plugin's manifest declares, in the focused pane. */
    open: (tab: string): void => send({ type: 'helm:tabs.open', tab })
  }
}
