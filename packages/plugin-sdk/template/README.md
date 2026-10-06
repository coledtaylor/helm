# My plugin

A Helm plugin: a rail icon that opens a sidebar panel, and a tab the panel
opens. Plain HTML and JavaScript, so there is nothing to build.

```
helm-plugin.json    the manifest
icon.svg            the rail icon, drawn in the rail's own colours
pages/panel.*       the sidebar panel
pages/tab.*         the tab
pages/style.css     layout; colours and controls come from Helm
package.json        the SDK, for the manifest schema and helm-plugin validate
```

## Run it

In Helm, open Settings > Plugins > Add folder and pick this folder. The icon
appears on the rail.

Helm watches the manifest and the folders its pages are in. Save a file and
the plugin reloads.

## Check it

```
npm install
npm run validate
```

says what Helm would say about the manifest and the files it names, without
starting Helm. `npm install` also puts the SDK where the manifest's `$schema`
points, so your editor completes and checks `helm-plugin.json`. Helm itself
needs neither: it runs the plugin from this folder as it is.

The authoring guide is the README of `@coledtaylor/helm-plugin-sdk`, in
`node_modules/@coledtaylor/helm-plugin-sdk/README.md` once it is installed.
