# Sample plugin

Items from a small API, in a panel, a tab and the status bar. It uses every
part a Helm plugin can have, and it is the plugin Helm's end-to-end tests drive
(`packages/desktop/e2e/plugins.spec.ts`). To write a plugin of your own, start
from `helm-plugin create` and the authoring guide in
[packages/plugin-sdk](../../packages/plugin-sdk/README.md); this folder is the
worked example.

It is an `apiVersion` 2 plugin: its pages are served on `floti-plugin://sample/`
and call `window.floti`, and its background is an ES module the host runs in
an isolate of its own, with `floti`, `BroadcastChannel` and timers and nothing
else.

```
sample-plugin/
├── helm-plugin.json          the manifest: every surface, setting, host, program, the service and the tools
├── icon.svg                  drawn as a mask, so it takes the rail's colours
├── src/
│   ├── panels/main.*         the rail panel: the items, a token prompt, the service's hello,
│   │                         and Helm's sessions (`floti.sessions.list`, the `sessions` event)
│   ├── tabs/item.*           one item, or a form for a new one; runs the `echo` program
│   │                         and asks to start a session about the item (`floti.sessions.start`);
│   │                         opens an address in the Browser tab (`floti.open`)
│   ├── background/main.ts    the background module: polls the server, sets the badge and the
│   │                         status bar item, and answers the sessions' list_items and create_item
│   └── lib/api.ts            the server's API, through floti.fetch with {{sample-token}},
│                             shared by the pages and the background module
├── programs/echo.mjs         the program `floti.exec('echo')` runs
├── service/main.mjs          the service, reached as floti.fetch('service:/hello')
├── server.mjs                the API the plugin reads, on 127.0.0.1:4790
├── vite.config.ts            one HTML page per surface, and the background module, built into dist/
├── tsconfig.json             the pages, checked with the DOM and window.floti
├── tsconfig.background.json  the background module, checked with no DOM and the background's floti
└── dist/                     what Helm loads
```

The background is built to `dist/background/main.js`, and what it shares with
the pages to `dist/assets/`, which it imports by a relative path: a background
module may import only its plugin's own files, by `./` or `../`. It has no
window, so `floti.tabs.open`, `floti.open`, `floti.secrets.request` and
`floti.sessions.*` reject there; it tells the pages about a change on the
`sample-items` channel instead, and hears theirs on it.

## Run it

```powershell
pnpm --filter @helm/sample-plugin build
pnpm --filter @helm/sample-plugin serve      # the API, in a terminal of its own
$env:HELM_PLUGINS = "$PWD\examples\sample-plugin"; pnpm dev
```

`HELM_PLUGINS` registers folders in a dev build only (separate several with
`;`). In an installed Helm, add the folder in Settings > Plugins.

The server wants a bearer token: `sample`, or whatever `node server.mjs <token>`
was given. The panel asks for it the first time (`floti.secrets.request`); the
tests start the server with a token of their own.

A session started while the plugin is on has its tools as `helm-plugin-sample`:
ask it to list the Sample items, or to add one, and the panel shows the new
item at once.

`pnpm --filter @helm/sample-plugin watch` rebuilds on every save. Helm watches
the folder and reloads the plugin when what it loads changes, so there is no
need to reload the window.
