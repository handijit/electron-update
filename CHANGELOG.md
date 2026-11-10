# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the package follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.1] - 2026-11-10

### Fixed

- The quick start no longer awaits `startApp` at the top level of an ES module main: Electron
  emits `ready` only after the main module has finished evaluating, so the program hung at
  start-up. It now calls `startApp(...).catch(...)`.

## [1.0.0] - 2026-11-10

First release: the update experience shared by Han Dijit's Electron desktop
programs, in six entry points (`.`, `./main`, `./preload`, `./renderer`,
`./react`, `./ui`) and a stylesheet (`./styles.css`), as ES modules and
CommonJS.

### Added

- `createUpdater`: one updater per main process, an explicit and serializable
  state machine over `electron-updater` (`idle`, `unsupported`, `checking`,
  `not-available`, `available`, `downloading`, `downloaded`, `error`) joined
  with the backend's version policy (`ok`, `recommended`, `required`). The
  engine is passed in; no check or download overlaps another; no method
  rejects because of the network, the feed or the engine.
- The schedule: a check 10 seconds after the start, every 6 hours with ±10 %
  jitter, and on demand. Failures of scheduled checks are not shown.
- The version policy through `getUpdatePolicy` of `@handijit/core`, stored in
  `update-policy.json` (`createPolicyStore`) and applied before the window
  opens.
- `updateContract`, `createUpdateHandlers` and `registerUpdateIpc`: the
  updater's IPC as a contract fragment of `@handijit/electron`, composable
  into a program's contract or registered on its own. No channel takes an
  argument.
- `withUpdateChannels` and `UPDATE_CHANNELS` for the preload, without Zod.
- `updateClient` and `createUpdateClient`: the page's client, ordered by the
  state's revision, inert outside Electron.
- `useUpdate`: the React hook, one shared subscription, StrictMode-safe.
- `UpdateButton` and `UpdateGate`: the update button for the title bar and the
  settings page, and the full-window "Güncelleme gerekli" gate, on
  `@handijit/ui` 2 and the design tokens, in Turkish, for the light and the
  dark theme, with replaceable texts (`DEFAULT_UPDATE_LABELS`).
- Stable error codes with Turkish messages: `OFFLINE`, `SERVER`,
  `INVALID_FEED`, `CHECKSUM`, `SIGNATURE`, `DISK`, `INSTALL`,
  `NOT_IN_APPLICATIONS`, `UNKNOWN`.
- A smoke test that runs the built package with the real `electron-updater`
  in a real Electron against a generated feed, and a tarball test that
  installs the packed package into an empty project.

### Decisions

Where the house documents were silent, these were chosen and are part of the
contract of 1.x:

- **The feed says what can be installed, the policy says whether the program
  may go on being used.** The button follows the feed; the gate follows the
  policy. `recommended` is in the state and shown by nothing.
- **A required update ignores the staged rollout** and is looked for at once.
  When the feed has nothing newer yet, the gate offers the manual download and
  the feed is read again after 1, 2 and 5 minutes, then every 15 minutes.
- **Offline never locks anyone out.** Without a stored policy the verdict is
  `ok`. A stored `required` holds for 7 days around the moment it was fetched
  (`requiredCacheTtlMs`) and then weakens to `recommended` until the backend
  confirms it. The window is symmetric, so a moved clock can only end the lock
  early. The gate is a courtesy, not a licence check.
- **`autoDownload` is `false` by default**: the customers are small businesses
  on metered or slow lines. The gate shows the size before it downloads.
- **Install on quit by default; never a restart nobody asked for.** The one
  restart the updater starts by itself follows the click on "Şimdi güncelle"
  in the gate, and is dropped when the update stops being required.
- **Downgrades are refused twice**: `allowDowngrade` is turned off before every
  check and the offered version is compared with the running one.
- **A missing channel file is "no update"**, not an error.
- **A build that cannot update itself says so**: a development run, a macOS
  build without a Developer ID signature and an unsupported platform are
  `unsupported` with a reason. A development run asks no policy.
- **Windows updates are verified by checksum only**, because the builds are not
  code-signed. The download server is the trust root.
- **The policy is asked at most once a minute on demand and once in ten
  minutes in the background**, and a 429 is obeyed.
- **No cancel for a running download** in this version.
- **Logs carry no account folder, no query string and no identifier**, also in
  lines that come from `electron-updater`, Squirrel.Mac or the installer.

[Unreleased]: https://github.com/handijit/electron-update/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/handijit/electron-update/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/handijit/electron-update/releases/tag/v1.0.0
