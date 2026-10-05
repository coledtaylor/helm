# My plugin

A Helm plugin: a rail icon that opens a sidebar panel, and a tab the panel
opens. Plain HTML and JavaScript, so there is nothing to build.

```
helm-plugin.json    the manifest
icon.svg            the rail icon, drawn in the rail's own colours
pages/panel.*       the sidebar panel
pages/tab.*         the tab
pages/style.css     layout; colours and controls come from Helm
```

## Run it

In Helm, open Settings > Plugins > Add folder and pick this folder. The icon
appears on the rail.

Helm watches the manifest and the folders its pages are in. Save a file and
the plugin reloads.

## Check it

```
helm-plugin validate
```

says what Helm would say about the manifest and the files it names, without
starting Helm.

The authoring guide is the README of `@helm/plugin-sdk`.
