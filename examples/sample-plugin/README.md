# Sample plugin

The shape every Helm plugin takes: a rail icon that opens a sidebar panel, and a
tab the panel opens. Generic on purpose - it is the template and the test
fixture, not a feature.

```
sample-plugin/
├── helm-plugin.json      the manifest: id, rail icon, panels, tabs
├── icon.svg              drawn as a mask, so it takes the rail's colours
├── src/
│   ├── panels/main.*     the sidebar panel
│   ├── tabs/detail.*     a tab
│   ├── lib/helm.ts       the plugin's side of the bridge (the SDK's job, later)
│   └── lib/Probe.tsx     spike measurements: page loads, an in-memory counter
├── vite.config.ts        one HTML page per surface, built into dist/
└── dist/                 what Helm loads
```

Build it, then point Helm at the folder:

```powershell
pnpm --filter @helm/sample-plugin build
$env:HELM_PLUGINS = "$PWD\examples\sample-plugin"; pnpm dev
```

`pnpm --filter @helm/sample-plugin watch` rebuilds on every save; reload the
window (Ctrl+R) to pick it up.
