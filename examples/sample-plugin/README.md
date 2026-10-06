# Sample plugin

Items from a small API, in a panel, a tab and the status bar. It uses every
part a Helm plugin can have, and it is the plugin Helm's end-to-end tests drive
(`packages/desktop/e2e/plugins.spec.ts`). To write a plugin of your own, start
from `helm-plugin create` and the authoring guide in
[packages/plugin-sdk](../../packages/plugin-sdk/README.md); this folder is the
worked example.

```
sample-plugin/
├── helm-plugin.json      the manifest: every surface, setting, host, program, the service and the tools
├── icon.svg              drawn as a mask, so it takes the rail's colours
├── src/
│   ├── panels/main.*     the rail panel: the items, a token prompt, the service's hello
│   ├── tabs/item.*       one item, or a form for a new one; runs the `echo` program
│   ├── background/*      polls the server, sets the badge and the status bar item, and
│   │                     answers the sessions' list_items and create_item
│   └── lib/api.ts        the server's API, through helm.fetch with {{sample-token}}
├── programs/echo.mjs     the program `helm.exec('echo')` runs
├── service/main.mjs      the service, reached as helm.fetch('service:/hello')
├── server.mjs            the API the plugin reads, on 127.0.0.1:4790
├── vite.config.ts        one HTML page per surface, built into dist/
└── dist/                 what Helm loads
```

## Run it

```powershell
pnpm --filter @helm/sample-plugin build
pnpm --filter @helm/sample-plugin serve      # the API, in a terminal of its own
$env:HELM_PLUGINS = "$PWD\examples\sample-plugin"; pnpm dev
```

`HELM_PLUGINS` registers folders in a dev build only (separate several with
`;`). In an installed Helm, add the folder in Settings > Plugins.

The server wants a bearer token: `sample`, or whatever `node server.mjs <token>`
was given. The panel asks for it the first time (`helm.secrets.request`); the
tests start the server with a token of their own.

A session started while the plugin is on has its tools as `helm-plugin-sample`:
ask it to list the Sample items, or to add one, and the panel shows the new
item at once.

`pnpm --filter @helm/sample-plugin watch` rebuilds on every save. Helm watches
the folder and reloads the plugin when what it loads changes, so there is no
need to reload the window.
