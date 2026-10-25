# sing-box client

Desktop client for [sing-box](https://github.com/SagerNet/sing-box), modeled on the screens of
SFA (sing-box for Android). Built with [Neutralinojs](https://neutralino.js.org), Angular 22 and Angular Material.

Windows is implemented; Linux and macOS are stubbed behind the platform factory.

## Screens

| Screen      | What it does                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------- |
| Dashboard   | Start/stop, upload/download speed + totals with graphs, connections/memory, Clash mode, system proxy, profiles |
| Groups      | Selector / URL-test groups, switch outbound, latency test                                          |
| Connections | Active / closed / all, search, sort, close one or all, details screen                              |
| Log         | Live sing-box output, level filter, search, pause, copy, save to file                              |
| Profiles    | Local (new / import file) and remote (URL, auto update) profiles, import links, JSON editor        |
| Tools       | Tailscale: status, login, this device, exit-node dropdown, peers by user, peer details (addresses, live ping, Taildrop send, SSH), Taildrop inbox |
| Settings    | Core binary (path, version, **Update** from GitHub releases), service, app, data folder           |

## How it works

- **Core**: `sing-box.exe` is not bundled. It is downloaded into `%APPDATA%\sing-box-client\core`
  from the latest production GitHub release via **Settings → Core → Update**.
- **Runtime**: the selected profile is written to `work/config.json` with client overrides
  (Clash API endpoint, system proxy switch) and started as a child process. Live data comes from
  sing-box's Clash API (`experimental.clash_api`); logs come from the process output.
- **Stop**: sing-box is asked to exit gracefully (console CTRL_BREAK on Windows) so it can restore
  the system proxy and routes; it is force-killed only if that fails.
- **TUN** profiles need administrator rights; the client offers to relaunch elevated.
- **Tools** use sing-box's API service (`daemon.StartedService`, sing-box 1.14+), the same API SFA
  uses. The client adds an `api` service on 127.0.0.1 with a random secret and calls it with
  gRPC-Web from the webview. Client-streaming calls (Taildrop send, SSH) go through
  `sing-box api …` instead. The message definitions in `src/app/core/daemon/daemon.proto.json`
  are extracted from the sing-box binary: re-run `node scripts/extract-daemon-proto.mjs` after a
  core update that changes the API.

### Data folder (`%APPDATA%\sing-box-client`)

```
core/            sing-box.exe (+ libcronet.dll)
profiles/<id>.json
profiles.json    profile list
settings.json    app settings (see BaseSettings)
work/            sing-box working directory (cache.db, rule-sets, generated config.json)
```

## Code map

```
src/app/core/
  platform/                 CorePlatform abstraction + factory (Windows impl, Linux/macOS stubs)
  settings/base-settings.ts BaseSettings<T>: JSON file ⇄ webview storage replication
  settings.service.ts       AppSettings (extends BaseSettings)
  box.service.ts            service lifecycle (start/stop/restart, overrides, alerts)
  clash-api.service.ts      Clash API REST + WebSocket streams
  core-binary.service.ts    core version, GitHub release download/install, `sing-box check`
  profile.service.ts        profiles CRUD, remote updates, auto update
  log.service.ts            log buffer
  daemon/                   API service client: gRPC-Web, message models, DaemonService
src/app/screens/            dashboard, groups, connections, log, profiles, tools (tailscale), settings
src/app/shared/             JSON editor (CodeMirror 6), dialogs, pipes, sparkline
```

### Settings persistence

`BaseSettings<T>` is the base class for persisted settings groups. On load the JSON file in the data
folder is the source of truth and is copied into webview `localStorage`; every change is written to
`localStorage` immediately and replicated to the JSON file (debounced, serialized). Subclasses
provide `fileName`, `defaults` and optionally `normalize()`.

### Adding a platform

Implement `CorePlatform` (binary name, release asset name, download/extract, `resolveCorePid`,
`stopGracefully`, `forceKill`, elevation) and return it from `createCorePlatform()` in
`core/platform/core-platform.factory.ts`.

## Development

Requires Node.js ≥ 22.22.3 or ≥ 24.15 (see `.nvmrc`).

```sh
npm install
npx neu update        # downloads Neutralino binaries into bin/
npm run dev           # ng serve (port 5180) + Neutralino window with hot reload
npm run build:app     # single self-contained exe → dist/sing-box-client/sing-box-client-win_x64.exe
```

Routes use hash location because Neutralino's static server cannot resolve deep links.

## License

GPL-3.0-or-later. Screen design follows SFA; no SFA source code is included.
