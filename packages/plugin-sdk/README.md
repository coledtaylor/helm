# Writing a Helm plugin

`@coledtaylor/helm-plugin-sdk` holds the types, the manifest validator and schema,
helpers for any framework and the `helm-plugin` command for building Helm plugins. The runtime
itself - `window.helm`, the theme and the primitives stylesheet - comes from
the Helm that runs the plugin, so a plugin never ships a copy of it.

## What a plugin is

A plugin is a folder on your computer with a `helm-plugin.json` at its root.
You register the folder in Helm, and Helm reads the manifest and serves the
folder to its pages.

- Every page the plugin has is an ordinary HTML page, served at
  `helm-plugin://<id>/<path>`. That origin is the plugin's identity: its
  storage, its messages and its permissions are its own, and no other plugin
  or Helm page shares them.
- Its pages run in a process of their own, separate from Helm's window. A
  plugin that loops forever or crashes takes down its own pages and nothing
  else.
- A page has no network access and no access to the computer. It asks Helm,
  through `window.helm`, for what the manifest says it may have: requests to
  the hosts it lists, the programs it names, the secrets it declares.

## Quick start

```
npx @coledtaylor/helm-plugin-sdk create my-plugin
```

writes a working plugin into `my-plugin/`: a rail icon, a sidebar panel and a
tab, in plain HTML and JavaScript with nothing to build. Then, in Helm:

1. Open Settings > Plugins and press **Add folder**.
2. Pick `my-plugin`. Its icon appears on the rail.
3. Edit `pages/panel.html` or `pages/panel.js` and save. Helm reloads the
   plugin.

The new plugin's `package.json` has this SDK as a development dependency.
`npm install` puts it in the plugin's `node_modules`, where the manifest's
`$schema` points, and `npm run validate` then runs `helm-plugin validate`. It
checks a plugin the way Helm does when it loads it - the manifest, then every
file the manifest names - and exits 1 when Helm would refuse it:

```
cd my-plugin
npm install
npm run validate
```

Helm needs none of this to run the plugin; it is for your editor and for
checking. To add the SDK to a plugin you already have:

```
npm install --save-dev @coledtaylor/helm-plugin-sdk
```

Keep it current (`npm update @coledtaylor/helm-plugin-sdk`) so `validate`
agrees with the Helm you run.

### Reloading

Helm watches the manifest and the folders the pages named in it live in, and
reloads the plugin a moment after a burst of writes ends. A build that writes
to `dist/` reloads it once. Keep pages in a folder (`pages/`, `dist/`) rather
than at the plugin root: a page at the root is watched as a single file, so a
script beside it would not trigger a reload. `node_modules` is never watched.

Settings > Plugins > the plugin > **Reload** reads the folder again by hand.

## The manifest

`helm-plugin.json`. Every surface is optional; a plugin with none loads and
does nothing. For editor completion, `$schema` points at the SDK's schema in
the plugin's `node_modules`, as `helm-plugin create` writes it:

```json
{ "$schema": "./node_modules/@coledtaylor/helm-plugin-sdk/helm-plugin.schema.json" }
```

Paths (`icon`, every `entry`, `background`, `service.node`) are relative to the
plugin folder and may not leave it, through `..` or a link. Nothing may live
under `__helm/`, where Helm serves its runtime.

| field | what it is |
| --- | --- |
| `apiVersion` | Required. `1`. The bridge the plugin was written against. A Helm that does not speak it refuses the plugin and says so in Settings. |
| `id` | Required. 1-63 lower-case letters, digits and dashes, starting with a letter or digit. The plugin's origin is `helm-plugin://<id>`. Two loaded plugins cannot share an id. |
| `name` | Required. What Helm calls the plugin, up to 60 characters. |
| `version`, `description` | Shown in Settings. Up to 40 and 300 characters. |
| `icon` | An `.svg` or `.png`, 64 KB at most. Drawn as a mask, so only its shape counts: it takes the rail's own colours. |
| `rail` | `{ "title", "panel" }`: a rail button with that tooltip, opening that panel in the sidebar. |
| `panels` | Sidebar panels by name: `{ "title", "entry", "actions"? }`. |
| `tabs` | Tabs by name: `{ "title", "entry" }`. |
| `pageStrip` | `true` opens the tabs as pages in one tab of the plugin's own. See [Tabs](#tabs). |
| `background` | A page that runs whenever the plugin is on. |
| `commands` | Entries in the command palette: `{ "id", "title", "tab"? }`. |
| `settings` | A settings page Helm draws: see [Settings](#settings). |
| `network` | The origins `helm.fetch` may reach. |
| `secrets` | The secret keys the plugin uses as `{{key}}`. |
| `exec` | Programs `helm.exec` may run, by name. |
| `service` | One long-running process Helm supervises. |
| `agent` | Tools Claude Code sessions can call, answered by the background page. See [Tools for sessions](#tools-for-sessions). |
| `sessions` | `true` lets the plugin's pages ask to start a Claude Code session. See [Starting a session](#starting-a-session). |

Names - panel and tab keys, action, command and program names - are 1-32
lower-case letters, digits and dashes.

Limits: 20 panels, 50 tabs, 5 actions a panel, 100 commands, 100 settings, 50
origins, 50 secrets, 50 programs, 64 arguments and 64 environment variables a
program, 50 tools.

Helm warns about a top-level field it does not know, and loads the plugin
anyway. Everything else it refuses, and lists every problem at once:

```
helm-plugin.json: rail.panel must name one of the panels - "main" is not one
```

## Surfaces

### Rail and panels

A `rail` entry puts a button on Helm's rail. Pressing it opens its panel in the
sidebar; pressing it again puts the sidebar away. The user can hide the button
from the rail's right-click menu like any of Helm's own.

Helm draws the panel's header: its `title`, and an icon button for each of
its `actions`. A press arrives at the panel as the `action` event:

```json
"panels": {
  "main": {
    "title": "Runs",
    "entry": "dist/panels/main.html",
    "actions": [
      { "id": "refresh", "title": "Refresh", "icon": "refresh" },
      { "id": "new", "title": "New run", "icon": "plus" }
    ]
  }
}
```

```js
helm.on('action', ({ id }) => {
  if (id === 'refresh') reload()
})
```

The icons are Helm's: `refresh`, `plus`, `search`, `list`, `settings`,
`external`, `pin`, `edit`, `trash`, `link`, `eye`.

### Tabs

A tab is a page in one of Helm's panes. It splits, drags and maximises like
Helm's own tabs, keeps its state while it does, and is reopened when Helm
starts again.

A plugin opens its tabs itself:

```js
await helm.tabs.open('run', { id: 42 }, { title: 'Run 42' })
```

The parameters are part of the tab's identity: the same tab with the same
parameters is brought forward, and other parameters open another tab. They are
up to 16 keys of strings, numbers and booleans (a string up to 512 characters),
and the page reads them from `helm.context.params`. `title` names the tab until its page names it:

```js
helm.surface.setTitle('Run 42 - passed') // null puts back the manifest's title
```

A plugin that opens many tabs - a list, then an item, then another - can keep
them out of the pane's strip with `"pageStrip": true`. Its tabs then open as
pages in one tab of its own, named for the plugin, with a strip of pages inside
it, the way Helm's Browser tab holds its pages. `helm.tabs.open` opens a page
there, or brings forward the page with the same parameters; `setTitle` names
the page in that strip. Pages switch, close (Ctrl+W) and reorder (drag, or
Ctrl+Shift+Left and Right) as the Browser tab's do, and closing the last one
closes the tab. Without it, each tab is a tab of its own in the pane.

### Background page

`background` is a page with no surface. It starts when the plugin is turned
on and runs until it is turned off, whether or not any of its panels or tabs
are open - the place to poll, to keep a badge current, and to answer
commands. It shares the plugin's origin, so its `localStorage`, IndexedDB and
`BroadcastChannel`s are the same ones the panels and tabs see.

If it crashes it stays stopped, and Settings says so. **Reload** starts it
again.

### Status bar item and badge

```js
await helm.status.set({ text: '3 failing', tone: 'danger', tooltip: 'Runs in the last hour' })
await helm.status.set(null) // takes it away

await helm.badge.set(3) // a count on the rail button; null or 0 takes it away
```

`tone` is `neutral`, `accent`, `success`, `warn` or `danger`. The text is up to
80 characters. Pressing the item opens the plugin's rail panel, or its page in
Settings when it has none. A badge over 99 is drawn as 99+.

Both belong to the plugin, not to the page that set them: any of its pages can
change them. When the background page crashes, Helm takes both away rather
than keep showing what a stopped page said.

### Commands

```json
"commands": [
  { "id": "open-runs", "title": "Open runs", "tab": "runs" },
  { "id": "sync", "title": "Sync now" }
]
```

Each appears in the command palette (Ctrl+Shift+P) under the plugin's name. A
command with a `tab` opens that tab. One without arrives as the `command`
event: at the background page when there is one, and otherwise at the rail
panel, which Helm opens first. A command with neither a tab nor a page to
receive it is refused.

```js
helm.on('command', ({ id }) => {
  if (id === 'sync') sync()
})
```

## Settings

Helm draws a page for the plugin in Settings, from `settings`:

```json
"settings": [
  { "key": "server", "type": "text", "label": "Server", "default": "https://ci.example.com", "placeholder": "https://..." },
  { "key": "limit", "type": "number", "label": "Runs shown", "default": 20, "min": 1, "max": 100 },
  { "key": "failedOnly", "type": "toggle", "label": "Failed runs only", "default": false },
  { "key": "order", "type": "select", "label": "Order", "options": [{ "value": "new", "label": "Newest first" }], "default": "new" },
  { "key": "token", "type": "secret", "label": "Token", "secret": "ci-token", "description": "A personal access token." }
]
```

Every setting has a `key`, a `label` and an optional `description`. A `secret`
setting holds no value: it shows whether the secret it names is stored, with a
button to add it.

```js
const values = await helm.settings.get() // { server: '...', limit: 20, failedOnly: false, order: 'new' }
helm.on('settings', (values) => apply(values))
```

A setting the user has not changed reads as its `default`, or `null` without
one. `secret` settings are not among the values: a page asks
`helm.secrets.state` instead.

## The bridge: `window.helm`

Helm puts `window.helm` on every page it serves, before the page's own scripts
run. Calls made before it has connected to Helm wait for it rather than fail.
It cannot be redefined, so in a classic (non-module) script use the global
`helm` as it is: a top-level `const helm` or `let helm` of your own is a
SyntaxError and stops the whole file.

| member | what it does |
| --- | --- |
| `apiVersion` | `1`. |
| `context` | `{ plugin, surface, name, params }`: where this page is running. `surface` is `panel`, `tab` or `background`; `name` is the panel's or tab's key. It never changes for the life of the page. |
| `theme` | The current theme. See [Theme and styling](#theme-and-styling). |
| `visible` | Whether the surface is on screen. Always false for the background page. |
| `fetch(input, init?)` | `fetch`, sent by Helm. See [Network](#network). |
| `exec(name, args?, options?)` | Runs a program from `exec`. See [Programs](#programs). |
| `open(url)` | Opens an `https` address in Helm's Browser tab, from a click. See [Opening a link](#opening-a-link). |
| `tabs.open(tab, params?, options?)` | Opens one of the plugin's tabs. |
| `surface.setTitle(title)` | Names a tab in the strip; null puts back the manifest's. No effect outside a tab. |
| `status.set(item)` | The status bar item, or null. |
| `badge.set(count)` | The rail badge, or null. |
| `settings.get()` | Every setting's value. |
| `secrets.state(key)` | `ready` or `missing`. |
| `secrets.request(key)` | Opens Helm's dialog for adding the key, scoped to this plugin. Resolves with the state once it closes. |
| `sessions.start({ cwd, prompt, name? })` | Asks to start a Claude Code session, from a click. See [Starting a session](#starting-a-session). |
| `tools.handle(name, handler)` | Answers one of the tools `agent` declares. Background page only. See [Tools for sessions](#tools-for-sessions). |
| `on(event, listener)` | Subscribes; returns the function that unsubscribes. |

Events:

| event | data |
| --- | --- |
| `theme` | The new `HelmTheme`. The page's CSS variables have already changed. |
| `visibility` | Whether the surface is now on screen. |
| `settings` | Every setting's value, after the user changed one. |
| `secrets` | Every declared key's state, after one was stored, permitted or removed. |
| `command` | `{ id }`: a command with no tab was chosen. |
| `action` | `{ id }`: a panel header action was pressed. Panels only. |

### Errors

A call that fails rejects with an `Error` whose `code` says why:

| `code` | meaning |
| --- | --- |
| `not-declared` | The URL, program, tab or secret is not in the manifest. |
| `secret` | A `{{key}}` is not stored, not permitted for this plugin, or not bound to the request's host. |
| `network` | The request could not be made or did not complete. |
| `timeout` | No answer in time. |
| `invalid` | The arguments were not what the method takes. |
| `unavailable` | The plugin is turned off, or Helm is shutting down. |
| `service` | The service is not running and could not be started. |
| `not-found` | A program `exec` names is not on this computer. |
| `not-allowed` | The call needs a click or key press the user just made in the page, and there was none. |
| `busy` | The same request is already waiting on the user, or the plugin opened a link a moment ago. |

A call cancelled through an `AbortSignal` rejects with a `DOMException` named
`AbortError`, as `fetch` does.

```js
try {
  await helm.exec('git', ['status'])
} catch (error) {
  if (error.code === 'not-found') showInstallHint()
  else throw error
}
```

## Network

A plugin page has no network of its own: its Content-Security-Policy says
`connect-src 'none'`, so `fetch`, `XMLHttpRequest`, `WebSocket` and
`EventSource` all fail. `helm.fetch` is the way out, and it reaches only the
origins in `network`:

```json
"network": ["https://api.github.com", "https://*.example.com", "http://127.0.0.1:8080"]
```

An origin is a scheme, a host and an optional port, with no path. `*.` in
front of a domain means every subdomain of it, and not the domain itself.

```js
const response = await helm.fetch('https://api.github.com/user', {
  headers: { authorization: 'Bearer {{github-token}}' }
})
const user = await response.json()
```

It takes what `fetch` takes and returns a `Response`. What differs:

- **Redirects** are followed by Helm one hop at a time, and every hop is
  checked against `network` again. A redirect to an origin the manifest does
  not list fails with `not-declared`. A redirect to another origin drops
  `Authorization`, `Cookie` and `Proxy-Authorization`. `redirect: 'manual'`
  returns the redirect itself, with its status and headers, and
  `redirect: 'error'` fails on one.
- **No cookies** are sent or kept, and nothing is cached.
- **Limits**: a request body of 16 MB, a response of 32 MB, 20 redirects, two
  minutes for the whole request.
- **Certificates**: a self-signed certificate is accepted on loopback
  (`127.0.0.1`, `localhost`, `::1`) only.

### The plugin's own service

`service:/path` is a request to the plugin's [service](#services), on the port
Helm gave it, with its token. It needs no `network` entry:

```js
const health = await (await helm.fetch('service:/health')).json()
```

## Secrets

A secret is a value - a token, an API key - the user stores in Helm, encrypted
on their computer. A plugin declares the keys it uses and writes them as
`{{key}}`; Helm puts the value in on the way out. **The page never sees the
value**, so a page that renders untrusted content cannot leak it.

```json
"secrets": ["github-token"]
```

`{{key}}` is replaced in:

- a request URL's path and query (never its scheme, host or port),
- a request header's value (never its name; a value with a line break is
  refused),
- a request body that is text: written as a JSON string's contents for
  `application/json`, form-encoded for `application/x-www-form-urlencoded`,
  and as it is for any other text,
- the environment of a program or the service, in the manifest's `env`.

Each stored secret is bound to the hosts it may be sent to and the plugins
that may use it, and the user chooses both. A request that would send a secret
anywhere else fails with `secret` before it is sent. A URL a server supplies -
a redirect's `Location` - is never searched for `{{key}}`, so a server cannot
ask for a secret by name. Requests to the plugin's own service may not carry
secrets; the service gets them through its environment.

When a secret is missing, ask for it:

```js
if ((await helm.secrets.state('github-token')) === 'missing') {
  await helm.secrets.request('github-token') // Helm's dialog, scoped to this plugin and its hosts
}
```

`missing` also covers a secret that is stored but not permitted for this
plugin: another plugin's secrets are not the page's business. If the computer
cannot encrypt, Helm stores no secrets at all.

## Programs

```json
"exec": {
  "git": "git",
  "lint": { "command": "tools/lint.cmd", "args": ["--json"], "env": { "API_TOKEN": "{{ci-token}}" } }
}
```

```js
const { exitCode, stdout, stderr, timedOut } = await helm.exec('git', ['log', '-1', '--format=%s'])
```

- A program is a name looked up on `PATH`, a path with a slash relative to the
  plugin folder, or an absolute path. The page names the program by its key in
  `exec`, never by a path.
- There is **no shell**. Arguments go to the program as an array, so text a
  user typed is an argument, never a command. A `.cmd` or `.bat` file runs
  through `cmd.exe` with its arguments quoted for it.
- The program runs in the plugin folder, with the user's environment (less
  Helm's own internals) and the manifest's `env`.
- `options`: `stdin` (a string written and closed), `timeoutMs` (default 60
  seconds, at most 10 minutes). A program that times out is stopped with
  everything it started, and resolves with `timedOut: true`.
- A non-zero exit is an answer, not an error. Output is limited to 16 MB per
  stream, and a plugin may have 8 programs running at once.

A plugin that declares programs or a service is marked in Settings as one that
**runs programs on this computer**: what it runs runs with the user's rights.

## Services

One long-running process, started and stopped by Helm:

```json
"service": { "node": "service/main.mjs", "start": "demand" }
```

- `node` is a script in the plugin folder, run by the Node inside Helm - the
  user needs no Node install. `command` is any program instead. Each takes
  `args` and `env`.
- It is given `HELM_SERVICE_PORT` to listen on, on `127.0.0.1`,
  `HELM_SERVICE_TOKEN`, and `HELM_PLUGIN_ID`. Every request from Helm carries
  the token as the `Helm-Service-Token` header; answer anything without it with
  401.
- `start: "demand"` (the default) starts it on the first `service:` request;
  `"enable"` starts it with the plugin. It has 20 seconds to start listening.
- It is restarted after a crash, after 1 second and then twice as long each
  time up to 30 seconds. Five crashes inside a minute and Helm stops trying
  until the plugin is reloaded.
- It is stopped, with everything it started, when the plugin is turned off,
  reloaded or removed, and when Helm quits.

```js
// service/main.mjs
import { createServer } from 'node:http'

createServer((req, res) => {
  if (req.headers['helm-service-token'] !== process.env.HELM_SERVICE_TOKEN) {
    res.writeHead(401).end()
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }))
}).listen(Number(process.env.HELM_SERVICE_PORT), '127.0.0.1')
```

Its output goes to the plugin's log in Settings.

## Tools for sessions

A plugin can give the Claude Code sessions Helm starts tools to call: read its
state, change it, start its work. Helm serves them to each session as an MCP
server of the plugin's own, `helm-plugin-<id>`, the way it serves its own
browser tools. The background page answers every call.

```json
"background": "dist/background/index.html",
"agent": {
  "instructions": "The user's items. List them before adding one, so you do not add one that is already there.",
  "tools": {
    "list_items": {
      "description": "Lists the items, newest first, each with its id, title and whether it has been read.",
      "inputSchema": {
        "type": "object",
        "properties": { "unreadOnly": { "type": "boolean", "description": "Only the unread ones." } }
      }
    },
    "create_item": {
      "description": "Adds an item, unread, and answers with it.",
      "inputSchema": {
        "type": "object",
        "properties": { "title": { "type": "string" } },
        "required": ["title"]
      }
    }
  }
}
```

```js
// The background page. Register as the page starts, before anything it awaits.
helm.tools.handle('list_items', async (args) => {
  const items = await listItems({ unreadOnly: args.unreadOnly === true })
  return items.map(({ id, title, read }) => ({ id, title, read }))
})

helm.tools.handle('create_item', async (args, { session, signal }) => {
  if (typeof args.title !== 'string' || args.title.trim() === '') throw new Error('create_item needs a title.')
  return createItem(args.title.trim(), { createdBy: session.name, signal })
})
```

- `agent` needs `background`: the background page is the one page running
  whenever a session might call.
- `instructions` go into the session's system prompt, after a line saying the
  tools come from this plugin. Say when to reach for them and how they fit
  together. 2000 characters at most, as is each `description`.
- Tool names are lower-case letters, digits, `_` and `-`, starting with a
  letter. A session calls `list_items` as `mcp__helm-plugin-<id>__list_items`,
  and that whole name may be 64 characters at most.
- `inputSchema` is JSON Schema with `type: "object"`; without one a tool takes
  no arguments. Helm passes it to the session as written and does **not** check
  a call's arguments against it, so a handler treats them as untrusted input.
- What a handler returns is what the session reads: a string as it is,
  `undefined` as `Done.`, anything else as JSON. 1 MB at most. What it throws
  is a failed call, and the error's message is what the session reads.
- The second argument says who is calling: `session.id` (the same for every
  call one session makes, and meaningless outside Helm), `session.name` (as
  its tab shows it) and `session.cwd` (its working directory). The session's
  conversation is never shared with a plugin.
- `signal` aborts when nobody is waiting any more: the user interrupted the
  session, it ended, or the plugin was turned off or reloaded. Hand it to
  `helm.fetch` so the request stops too.
- A call that arrives before its handler is registered waits up to 5 seconds
  for it. A call answers within 10 minutes or fails.
- Claude Code asks the user before a session runs a tool, as it does for any
  MCP tool, unless the user has allowed it.

The tools are on while the plugin is, for sessions started after that. The
user can turn them off on the plugin's page in Settings, which takes them from
sessions already running too. Each call is noted in the plugin's log with the
session that made it.

## Starting a session

A plugin that declares `"sessions": true` can ask Helm to start a Claude Code
session in a folder, with a first message:

```js
button.addEventListener('click', async () => {
  const result = await helm.sessions.start({ cwd: 'C:\\work\\api', prompt: 'work on API-12', name: 'API-12' })
  if (result === 'started') showStarted()
})
```

- Only from a click or key press the user just made in a panel or tab: call it
  from the handler. Anything else rejects with `not-allowed`, and the
  background page cannot ask at all.
- Helm shows the folder, the message and the command it will run, and the user
  starts it or cancels. It resolves `started` once the session's tab is open,
  and `cancelled` when the user said no, or the page went away first. One
  request at a time: a second while the first is on screen rejects with `busy`.
- `cwd` is an absolute path to a folder that exists. `prompt` is one line of
  up to 2000 characters, with no `"` (a Windows command line cannot carry one
  intact) and not starting with `-` (`claude` would read it as a flag). `name` names the tab and the
  session, up to 60 characters; the folder's name when absent.
- The message is the session's first, said once, as if typed when it opened.
  After that the session is the user's: a plugin cannot type into it, read it,
  or end it.

## Opening a link

`helm.open(url)` opens a page in Helm's Browser tab, beside the user's own:

```js
link.addEventListener('click', (event) => {
  event.preventDefault()
  helm.open(link.href).catch(showProblem)
})
```

- Only from a click or key press the user just made in a panel or tab: call it
  from the handler. Anything else rejects with `not-allowed`.
- `https` addresses only, with no user name or password in them, up to 2048
  characters. Anything else rejects with `invalid`.
- One link a second: a second call sooner, a double click's, rejects with
  `busy`.
- It resolves once Helm has the address, not once the page has loaded. The
  page goes where any address typed in the Browser tab may go: when the user
  has kept the Browser tab to this computer, it says so on the new tab instead
  of loading.
- The page is the user's, signed in wherever they are signed in. The plugin
  cannot read it, drive it or close it, and nothing it does there reaches the
  plugin. No manifest field is needed.

## Theme and styling

Helm injects its primitives stylesheet at the top of every page's `<head>`,
before the plugin's own styles, and writes the theme onto `<html>`:

- `--helm-<token>` for each of the theme's colours: `bg`, `surface`,
  `surface-raised`, `surface-sunken`, `hover`, `active`, `border`,
  `border-strong`, `fg`, `fg-muted`, `fg-subtle`, `accent`, `accent-fg`,
  `accent-soft`, `accent-soft-hover`, `accent-text`, `success`, `warn`,
  `danger`;
- `--helm-radius` (the corner setting) and `--helm-radius-well` (one pixel
  rounder, for controls);
- `--helm-row-y` and `--helm-line`, which follow the density setting, and
  `data-density="comfortable|compact"`;
- `--helm-font-sans` and `--helm-font-mono`;
- `data-theme="dark|light"`, a `dark` class for dark themes, and
  `color-scheme`, so native controls match.

All of it changes in place when the user changes the theme, with no reload;
the `theme` event follows. A page sits inside one of Helm's panels, and its
`body` is already the panel's surface.

The primitives, so a plugin looks like the rest of Helm without copying it:

| class | what it is |
| --- | --- |
| `helm-button` | A button. `data-variant="primary"` (outlined in the accent), `"ghost"`, `"danger"`. |
| `helm-icon-button` | A 24px icon button. `aria-pressed="true"` for a toggled one. |
| `helm-input`, `helm-select`, `helm-textarea` | Fields in Helm's sunken well. `aria-invalid="true"` marks one wrong. |
| `helm-list`, `helm-row` | A list and its rows. `aria-selected="true"` or `aria-current` marks the chosen row. |
| `helm-chip` | A borderless count or status, in a tone: `data-tone="accent|success|warn|danger"`. |
| `helm-state` | The one outlined pill: a single word that is a thing's whole status. Takes `data-tone`. |
| `helm-dot` | A 6px dot in a tone. |
| `helm-tag` | A hairline pill; `data-tone="accent"` for a kind. |
| `helm-bar` | A row along the top of a page, with a hairline under it. |
| `helm-rule` | A divider that fades at its ends. |
| `helm-caps` | The small capitals label over a section. |
| `helm-meta` | A row's second line, a hint, a time. |
| `helm-mono` | Machine data: a path, a hash, a size. |
| `helm-empty` | An empty state, with `helm-empty-icon`, `helm-empty-title`, `helm-empty-text` and `helm-empty-actions` inside. |

The primitives are in a CSS layer named `helm`, so **any unlayered CSS in the
plugin wins over them**, whatever its specificity. For Tailwind, the layer
order is declared as `theme, base, helm, components, utilities`: Tailwind's
reset does not undo the primitives, and its utilities override them, so
`class="helm-button px-4"` gets the padding.

## Frameworks

A plugin page is a web page, so any framework that builds one works, or none.
The SDK has helpers that keep Helm's state current in a page: stores that work
anywhere, and React hooks and Vue composables built on them. Each is optional.

### Stores

`@coledtaylor/helm-plugin-sdk/stores` has Helm's state as stores:

| store | value |
| --- | --- |
| `theme` | The current `HelmTheme`. |
| `visible` | Whether the surface is on screen. |
| `settings` | Every setting's value: null until read, then kept current. |
| `secret(key)` | A declared key's state, `ready` or `missing`: null until read. `request()` opens Helm's dialog for adding the key and resolves with the state once it closes. The same key is always the same store. |

A store's `subscribe(run)` calls `run` with the value at once and again on
every change, and returns the function that unsubscribes. `current` is the
value now. However many subscribe, a store reads once and listens once; when
the last subscriber leaves it forgets the value, so the next one starts from
null rather than from something nothing kept current.

```js
import { settings } from '@coledtaylor/helm-plugin-sdk/stores'

const stop = settings.subscribe((values) => {
  if (values !== null) render(values)
})
```

`command` and `action` are events, not state, so they have no store:
`helm.on` already returns the function that unsubscribes, which is what every
framework's cleanup takes.

### Svelte

The stores are Svelte stores, so there is no Svelte entry. Read them with `$`:

```svelte
<script>
  import { onMount } from 'svelte'
  import { secret, settings } from '@coledtaylor/helm-plugin-sdk/stores'

  const token = secret('github-token')
  onMount(() =>
    helm.on('action', ({ id }) => {
      if (id === 'refresh') reload()
    })
  )
</script>

{#if $token === 'missing'}
  <button class="helm-button" onclick={() => token.request()}>Add token</button>
{:else if $settings !== null}
  <!-- ... -->
{/if}
```

`get` and `derived` from `svelte/store` take them too, and in a `.svelte.js`
module `fromStore(settings).current` reads one as state.

### Vue

`@coledtaylor/helm-plugin-sdk/vue` has composables that return refs:

```vue
<script setup>
import { useHelmEvent, useHelmSettings, useHelmTheme, useHelmVisible, useSecret } from '@coledtaylor/helm-plugin-sdk/vue'

const settings = useHelmSettings() // null until read, then kept current
const visible = useHelmVisible()
const theme = useHelmTheme()
const [token, requestToken] = useSecret('github-token') // 'ready' | 'missing' | null
useHelmEvent('action', ({ id }) => {
  if (id === 'refresh') reload()
})
</script>

<template>
  <button v-if="token === 'missing'" class="helm-button" @click="requestToken()">Add token</button>
</template>
```

Each subscription ends with the `setup()` or `effectScope()` it was made in.
`useSecret` also takes a ref or a getter, and follows the key when it changes.

### React

`@coledtaylor/helm-plugin-sdk/react` has hooks:

```tsx
import { useHelmEvent, useHelmSettings, useHelmTheme, useHelmVisible, useSecret } from '@coledtaylor/helm-plugin-sdk/react'

function Panel() {
  const settings = useHelmSettings() // null until read, then kept current
  const visible = useHelmVisible()
  const theme = useHelmTheme()
  const [token, requestToken] = useSecret('github-token') // 'ready' | 'missing' | null
  useHelmEvent('action', ({ id }) => {
    if (id === 'refresh') reload()
  })
  if (token === 'missing') return <button className="helm-button" onClick={() => void requestToken()}>Add token</button>
  // ...
}
```

React 18 or later and Vue 3.3 or later are optional peer dependencies; the
stores need neither, and nothing else in the SDK needs them.

## TypeScript

```ts
import type { HelmBridge, HelmContext, PluginManifest } from '@coledtaylor/helm-plugin-sdk'
```

and, once in the project (a `.d.ts`, or `types` in `tsconfig.json`):

```ts
/// <reference types="@coledtaylor/helm-plugin-sdk/global" />
```

which types `window.helm` and the global `helm`. `@coledtaylor/helm-plugin-sdk/manifest`
is the validator itself, for a build that wants to check the manifest.

## Keyboard

Keys pressed in a plugin page go to that page. So that Helm's shortcuts still
work from inside a plugin - Ctrl+N, Ctrl+P, Ctrl+Tab and the rest - the bridge
passes on a key with Ctrl, Alt or the Windows key held **after the page's own
handlers have run, unless one of them called `preventDefault()`**. A page that
binds a shortcut of its own calls `preventDefault()` and keeps it.

The page's own editing keys are never passed on: Ctrl+A, C, V, X, Y and Z, and
AltGr combinations, which many keyboards type characters with.

## Errors and crashes

- **The plugin will not load**: Settings > Plugins lists it with the reason -
  a manifest problem, an `apiVersion` this Helm does not speak, a page that is
  missing because the plugin is not built. Its surfaces do not appear.
- **A page does not start** (it is missing, or is not a page Helm served):
  its panel or tab shows that, in its own place, with **Reload**.
- **A page crashes**: every surface of the plugin that shared its process
  shows that it stopped, with **Reload** and a link to the plugin's Settings.
  Helm and other plugins are unaffected.
- The plugin's page in Settings has its **log** - the last 500 lines its
  programs and service printed, and what Helm noted about it - and the memory
  and CPU its processes are using.

## What a plugin cannot do

- **Reach the network directly.** Only `helm.fetch`, only to `network`.
- **Run code it did not ship.** Pages may load scripts, styles, images, fonts
  and workers from their own origin only. No inline scripts, no `eval`, no
  remote scripts.
- **Frame anything.** A page cannot contain another frame, and cannot navigate
  off its own origin.
- **Open windows or dialogs.** No popups, no `alert`, `confirm` or `prompt`,
  no downloads. Writing text to the clipboard is the one browser permission a
  page has. A link goes to Helm's Browser tab through `helm.open`, from a
  click.
- **Post notifications**, or reach into a Claude Code session: a session can
  call a plugin's tools, but a plugin cannot send a running session anything
  or read its conversation. It can ask to start one with a first message,
  which the user sees and agrees to first.
- **See a secret's value**, or another plugin's anything.
