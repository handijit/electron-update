# @handijit/electron-update

The update experience every Han Dijit desktop program shares: a thin, tested layer over
[`electron-updater`](https://www.electron.build/auto-update) that turns its events into one
explicit state machine, joins it with the backend's minimum-version policy, and gives the
renderer the "Güncelle" button and the full-window "Güncelleme gerekli" gate.

The programs are distributed outside the stores: Windows (NSIS, **not code-signed**) and macOS
(Developer ID signed and notarized), x64 and arm64. Installers and update metadata are static
files on `https://indir.handijit.com/<product>/`.

- **Two sources, two questions.** The feed (`latest.yml`, `latest-mac.yml`) says _what can be
  installed_. The backend's policy says _whether the program may go on being used_. The state
  carries both, and the rules for when they disagree are written down
  ([Feed and policy](#feed-and-policy)).
- **Nothing overlaps, nothing throws.** One check and one download at a time; every method is
  safe to call in any state; a failed check or download is a state, never a rejection.
- **Never locks a customer out by accident.** No answer from the backend means "go on". A
  stored "required" verdict holds for seven days without confirmation, then weakens.
- **Never restarts unasked.** Updates install when the program quits, or when the customer
  presses "restart". The one exception is the required gate, whose only offer is "update now".
- **Degrades instead of failing.** A development run and an unsigned macOS build report
  `unsupported` with a reason; they do not throw and do not show errors.
- **Six entry points, one per place the code runs.** A build check keeps the page entries free
  of `electron` and `node:*`, and the preload entry free of everything.
- **Small where it ships to the page.** Preload 0.7 kB, client 2.1 kB, hook 0.5 kB,
  components 4.7 kB plus 1.6 kB of CSS, gzipped. No runtime dependency.
- **ES modules and CommonJS**, with types for both.

## Install

```sh
npm install @handijit/electron-update electron-updater @handijit/electron @handijit/core zod
npm install @handijit/ui react react-dom   # only for the /react and /ui entries
npm install --save-dev electron
```

| Peer                 | Range              | Why                                                                                             |
| -------------------- | ------------------ | ----------------------------------------------------------------------------------------------- |
| `electron`           | `>=43.0.0 <46.0.0` | The range of `@handijit/electron`. The smoke test of this package runs on 45.                   |
| `electron-updater`   | `^6.8.0`           | The engine. You pass its `autoUpdater` in; this package never imports it.                       |
| `@handijit/electron` | `^1.0.0`           | The IPC contract, the bridge, the settings store (for the stored policy) and the logger.        |
| `@handijit/core`     | `^1.0.0`           | `getUpdatePolicy` of the API client, the version comparison and the error guards.               |
| `zod`                | `^4.0.0`           | The schemas of the IPC contract (main only).                                                    |
| `react` (optional)   | `>=18`             | Only for `/react` and `/ui`.                                                                    |
| `@handijit/ui` (opt) | `^2.0.0`           | Only for `/ui`. Its stylesheet and the tokens of `@handijit/design` must be loaded by the page. |

Node 24 or newer for the tooling. The main-process code runs on the Node that Electron embeds.

The declarations of `electron-updater` import `semver`: a program that compiles with
`skipLibCheck: false` also needs `@types/semver`.

## Quick start

Three process files and one line of CSS. The example adds the updater to a program that
already starts with `startApp` of `@handijit/electron`.

### 1. main

```ts
// src/main/index.ts
import { createApiClient } from "@handijit/core";
import { startApp } from "@handijit/electron/main";
import {
  createUpdater,
  registerUpdateIpc,
} from "@handijit/electron-update/main";
import type { Updater } from "@handijit/electron-update/main";
import { net } from "electron";
import electronUpdater from "electron-updater";

import { contract } from "../shared/contract";

let updater: Updater | undefined;

await startApp({
  contract,
  handlers: (context) => {
    // Created here: this is the first place the program's logger and URL policy exist.
    updater = createUpdater({
      engine: electronUpdater.autoUpdater,
      product: "on-muhasebe",
      // Electron's network stack: the system proxy and certificates, like the engine's own
      // requests. Node's fetch ignores the system proxy.
      api: createApiClient({ fetch: (input, init) => net.fetch(input, init) }),
      logger: context.logger,
    });
    registerUpdateIpc({ updater, policy: context.policy });

    return {/* the program's own handlers */};
  },
  // Before the window: the stored policy is in the state when the page first asks, so a
  // required update shows the gate at once instead of flashing the program.
  beforeWindow: async () => {
    await updater?.start();
  },
  // ...rendererRoot, window, contentSecurityPolicy as before
});
```

That is all of main. With the defaults the updater reads the feed 10 seconds after the start
and every 6 hours, asks the backend's policy alongside, downloads nothing until the customer
presses the button, and installs a downloaded update when the program quits.

`electron-updater` is a CommonJS package: in an ES module import the default export and read
`autoUpdater` from it, as above.

### 2. preload

```ts
// src/preload/index.ts
import { exposeBridge } from "@handijit/electron/preload";
import { withUpdateChannels } from "@handijit/electron-update/preload";

import { channels } from "../shared/channels"; // the program's ChannelMap, without schemas

exposeBridge(withUpdateChannels(channels));
```

`withUpdateChannels` adds the six channels of the updater to the program's channel list and
throws at start-up when the program already uses one of the names. The preload entry imports
nothing, so the bundled preload still requires only `electron`.

### 3. renderer

```tsx
// src/renderer/main.tsx
import "@handijit/design/tokens.css";
import "@handijit/ui/styles.css";
import "@handijit/electron-update/styles.css";

import { UpdateButton, UpdateGate } from "@handijit/electron-update/ui";

export const App = () => (
  <UpdateGate productName="Ön Muhasebe">
    <header className="title-bar">
      <span>Ön Muhasebe</span>
      <UpdateButton />
    </header>
    <Routes />
  </UpdateGate>
);
```

```tsx
// in the settings page
<UpdateButton isAlwaysVisible />
```

`UpdateGate` goes once around the whole program. While the policy says `required` it covers
the window and makes the program behind it inert (still mounted, so nothing typed is lost);
otherwise it renders its children and nothing else. `UpdateButton` renders nothing while there
is nothing to do; with `isAlwaysVisible` it also offers "Güncellemeleri denetle" and shows
"Program güncel".

A program with its own design reads the same state through the hook and draws it itself:

```tsx
import { useUpdate } from "@handijit/electron-update/react";

const { state, check, download, install, openDownloadPage } = useUpdate();
```

### The other way to wire IPC

`registerUpdateIpc` registers the updater's channels beside the program's contract. A program
that wants one contract for everything spreads the fragment into its own instead. Use one way
or the other, never both: a channel can have one handler.

```ts
// src/shared/contract.ts
import { defineContract } from "@handijit/electron";
import { updateContract } from "@handijit/electron-update/main";

export const contract = defineContract({
  invoke: { ...updateContract.invoke, "notes:list": { output: notes } },
  events: { ...updateContract.events },
});
```

```ts
// src/main/index.ts
handlers: (context) => {
  updater = createUpdater({ /* as above */ });
  updater.onChange((state) => {
    context.emitter.broadcast("update:state-changed", state);
  });
  return { ...createUpdateHandlers(updater), "notes:list": listNotes };
},
```

`updateContract` lives in the `/main` entry because it holds Zod schemas. A preload that
imports the contract file would pull Zod in; keep passing a plain channel list through
`withUpdateChannels`.

## The state

One frozen, serializable object. Every change produces a new one with a higher `revision`;
the same object crosses IPC unchanged.

```ts
type UpdateState = {
  revision: number;
  currentVersion: string; // "1.4.0"
  policy: {
    verdict: "ok" | "recommended" | "required";
    latestVersion: string | null;
    minSupportedVersion: string | null;
    checkedAt: number | null; // when the backend last answered
  };
  checkedAt: number | null; // when the feed was last read successfully
  isInstallPending: boolean; // restarting, or will restart as soon as the download is done
} & (
  | { status: "idle" }
  | { status: "unsupported"; reason: "development" | "unsigned" | "platform" }
  | { status: "checking" }
  | { status: "not-available" }
  | { status: "available"; update: UpdateInfo }
  | { status: "downloading"; update: UpdateInfo; progress: UpdateProgress }
  | { status: "downloaded"; update: UpdateInfo }
  | { status: "error"; error: UpdateError; update: UpdateInfo | null }
);

type UpdateInfo = {
  version: string;
  releaseDate: string | null; // ISO 8601
  releaseNotes: string | null; // plain text, never HTML
  sizeBytes: number | null; // the full download for this platform and architecture
};
type UpdateProgress = {
  percent: number; // 0 to 100
  transferredBytes: number;
  totalBytes: number;
  bytesPerSecond: number;
};
type UpdateError = { code: UpdateErrorCode; message: string }; // message: Turkish, for display
```

### State diagram

```text
 start()
    │
    ├── the build cannot update itself ──────────────► unsupported   (final until restart)
    │                                                  reason: development | unsigned | platform
    ▼
  idle
    │  check: start delay · interval · check() · the policy turned "required"
    ▼
 checking ───── the feed failed ────────────────────► error          (update: null)
    │  │          (a background check that fails shows nothing:
    │  │           the status returns to what it was)
    │  └─ nothing newer · no channel file · staged out · older ──► not-available
    │
    └─ a newer version ──► available
                               │  download() · autoDownload · install() while required
                               ▼
                          downloading ── failed ─────► error          (update: the version)
                               │                         │ download(): reads the feed again,
                               ▼                         ▼ then downloads what it offers now
                          downloaded ── install() ──► the program quits and the installer runs
                               │                      (isInstallPending: true)
                               └─ the program quits ─► installed on quit (installOnQuit)

 not-available · available · error ── check ──► checking
 downloading · downloaded: a check changes nothing (a download is never thrown away)
 downloaded, macOS, Squirrel.Mac refuses the signature ──► unsupported (unsigned)
 downloaded, the installer could not be started ─────────► error (INSTALL)
```

The transitions are a pure reducer driven by events. An event that makes no sense in the
current status returns the same state, so a late or doubled event of the engine cannot corrupt
it.

### What each action does, by status

| Status          | `check()`                     | `download()`                             | `install()`                                                             |
| --------------- | ----------------------------- | ---------------------------------------- | ----------------------------------------------------------------------- |
| `idle`          | reads the feed and the policy | nothing                                  | while `required`: checks, downloads, restarts; otherwise nothing        |
| `unsupported`   | reads the policy only         | nothing                                  | nothing                                                                 |
| `checking`      | joins the running check       | nothing                                  | while `required`: arms the restart; otherwise nothing                   |
| `not-available` | reads the feed and the policy | nothing                                  | while `required`: checks again; otherwise nothing                       |
| `available`     | reads the feed and the policy | starts the download                      | while `required`: downloads, then restarts; otherwise nothing           |
| `downloading`   | reads the policy only         | nothing (it is running)                  | while `required`: restarts when the download is done; otherwise nothing |
| `downloaded`    | reads the policy only         | nothing                                  | quits and installs                                                      |
| `error`         | reads the feed and the policy | with an `update`: checks, then downloads | while `required`: checks, downloads, restarts; otherwise nothing        |

Every action resolves with the state as it is when the action has been accepted; progress
arrives through `onChange`. `check()` resolves when the feed has answered or failed.

## Feed and policy

**The feed decides what can be installed.** It is `electron-updater`'s generic provider on
`https://indir.handijit.com/<product>/`: `latest.yml` for Windows, `latest-mac.yml` for macOS
(`beta.yml`, `beta-mac.yml` on the beta channel). Its checksums are the integrity of the
download; its `stagingPercentage` is the staged rollout.

**The policy decides whether the program may go on being used.** It is
`GET /api/public/products/{product}/update-policy?os=&arch=&channel=` of the backend, through
`client.getUpdatePolicy` of `@handijit/core`: the latest published version and the minimum
supported version for this operating system and architecture.

| The policy says                             | Verdict       | What the customer sees                                                 |
| ------------------------------------------- | ------------- | ---------------------------------------------------------------------- |
| the running version is the latest, or newer | `ok`          | nothing                                                                |
| a newer version is published                | `recommended` | nothing by itself: the button appears when the _feed_ offers a version |
| the running version is below the minimum    | `required`    | the gate                                                               |
| nothing (never answered, 404, unreadable)   | `ok`          | nothing                                                                |

The rules where the two meet:

1. **A required update ignores the staged rollout.** While the verdict is `required` the
   updater answers "yes" to `electron-updater`'s rollout question, so everybody below the
   minimum is offered the version in the feed, whatever `stagingPercentage` says. The moment
   the verdict turns `required` the feed is read at once, not at the next interval.
2. **Required, but the feed has nothing newer yet** (the files are still uploading, the CDN
   lags, the channel file is missing): the status is `not-available` with the verdict
   `required`. The gate says that the new version has not reached this computer yet and offers
   "Yeniden dene" and "Yeni sürümü indir", which opens the download link in the browser. The updater reads the
   feed again after 1, 2 and 5 minutes and then every 15 minutes, and the gate moves on by
   itself when a version appears.
3. **Required in a build that cannot update itself** (unsigned macOS build, unsupported
   platform): the gate offers only the manual download.
4. **A required update is still the customer's click.** The gate downloads when "Şimdi
   güncelle" is pressed, not before (unless `autoDownload` is on), shows the size first, and
   restarts by itself when the download is done: that restart was asked for with the click.
   If the verdict stops being `required` during the download (the minimum was lowered), the
   armed restart is dropped.
5. **`recommended` never interrupts.** It is in the state for a program that wants to show it;
   the components do not. The button follows the feed, so a customer outside the staged
   rollout is not told about a version they cannot install yet.
6. **The feed is never trusted with an older version.** `allowDowngrade` is set to `false`
   before every check (assigning a channel to `electron-updater` silently turns it on), and
   the updater compares the offered version itself: a version that is not newer than the
   running one is `not-available`, also while an update is required.
7. **A failed background check shows nothing.** The status returns to what it was and the
   schedule tries again. A failure is shown only when the customer asked (a click), or while
   an update is required.

### Offline, and the clock

- **The backend cannot be reached and nothing is stored: `ok`.** A customer is never locked
  out because a request failed. The same holds for an unreadable or hand-edited policy file.
- **The last answer is stored** in `update-policy.json` in the user data folder (written
  atomically through the settings store of `@handijit/electron`) and applied at the next
  start before the window opens. An offline start below the minimum shows the gate at once.
- **A stored `required` holds for 7 days** (`requiredCacheTtlMs`) from the moment it was
  fetched, then weakens to `recommended` until the backend confirms it. A customer who is
  offline for longer gets the program back; a customer who is online is asked again within
  seconds of the start and locked again if the backend still says so.
- **Any answer of the backend replaces the stored one**, including a relaxed minimum. A 404
  (no release for this product and platform) removes it.
- **The window is symmetric**: the verdict holds while `|now - fetchedAt| <= 7 days`. Moving
  the clock in either direction can only end the lock early, never extend it. This is
  deliberate: the gate is a courtesy that keeps customers off versions the backend no longer
  serves well, not a licence check. A customer who edits the file or the clock gets past it,
  and the backend must still refuse what it does not support.
- **The policy is asked sparingly**: at the start, with every scheduled check, and on a manual
  check, but at most once a minute for clicks and once in ten minutes in the background. The
  backend throttles the endpoint per address and an office shares one address. On a 429 the
  updater waits for `Retry-After` (10 minutes when the header is missing).
- **A development run asks no policy at all** (`unsupported` / `development`): its version
  numbers are its own and a developer must not be locked out of the program being built.

### Downloads

- **`autoDownload` is `false` by default.** The customers are small businesses, often on a
  metered mobile line or a slow shared one, and an installer is 80 to 120 MB. The button shows
  the version; the gate shows the size before anything is downloaded. Set `autoDownload: true`
  for a program whose customers are known to be on good lines.
- **Install on quit is on by default** (`installOnQuit`): a downloaded update is installed
  when the customer closes the program, with no restart forced on them.
- **A download is never thrown away**: checks do nothing while one is running or finished.
  There is no cancel in 1.0.0.
- **Differential downloads** are `electron-updater`'s: it reads the `.blockmap` files and
  falls back to the full file when that fails. If the server or the CDN mishandles multi-range
  requests, set `useMultipleRangeRequest: false`.

## Windows without a certificate, macOS with one

**Windows builds are not code-signed** and no certificate will be bought. What that means:

- `electron-updater` verifies the publisher of a downloaded installer only when the installed
  program's `app-update.yml` holds a `publisherName`, and `electron-builder` writes that only
  for a signed build. Set `win.verifyUpdateCodeSignature: false` anyway (below), so that the
  configuration says what is meant and a certificate added by accident does not start
  rejecting updates.
- The integrity of an update is the SHA-512 in `latest.yml`, fetched over HTTPS. **Whoever can
  write to the download server can ship code to every customer.** The server, its deploy key
  and the Cloudflare account are the trust root; treat them like a signing key.
- SmartScreen warns on the first manual install ("Windows kişisel bilgisayarınızı korudu" →
  "Ek bilgi" → "Yine de çalıştır"), because the browser marks the downloaded installer as
  coming from the internet. Updates downloaded by the updater carry no such mark and install
  without the warning. The download page must explain the first one.
- If a certificate is ever bought, the switch is one-way: from the first signed release on,
  installed programs hold a `publisherName` and refuse unsigned updates.

**macOS auto-update needs the Developer ID signed build.** Squirrel.Mac refuses to replace an
app whose signature it cannot validate. The updater asks `codesign` once at the start; a
build without a `Developer ID Application` authority (a local build, an ad-hoc signed one) is
`unsupported` / `unsigned` from the first moment, and no check or download is attempted. If
Squirrel.Mac still refuses a signature after a download, the state becomes `unsupported` /
`unsigned` as well, not an error.

**In development** (`app.isPackaged === false`) the state is `unsupported` / `development`.
To exercise the updater in an unpackaged run, point `electron-updater` at a feed yourself
before creating the updater; this is what the smoke test does:

```ts
autoUpdater.updateConfigPath = "/path/to/dev-app-update.yml"; // provider: generic, url: …
autoUpdater.forceDevUpdateConfig = true;
```

## `electron-builder` configuration

The part of `electron-builder.yml` that has to match the server layout and this package:

```yaml
appId: com.handijit.on-muhasebe
productName: Ön Muhasebe
# ASCII, no spaces, and the architecture in the name: the updater picks the file whose name
# contains its own architecture.
artifactName: ${name}-${version}-${os}-${arch}.${ext}

mac:
  target:
    - target: dmg # what the customer downloads
      arch: [arm64, x64]
    - target: zip # what the updater downloads; required
      arch: [arm64, x64]
  hardenedRuntime: true
  notarize: true

win:
  target:
    - target: nsis
      arch: [x64]
  # Not code-signed: updates are verified by their checksum only.
  verifyUpdateCodeSignature: false

publish:
  provider: generic
  url: https://indir.handijit.com/on-muhasebe/
```

- `publish.url` is the same folder the updater defaults to
  (`https://indir.handijit.com/<product>/`). `electron-builder` writes it into the packaged
  program's `app-update.yml`, which `electron-updater` needs to exist; the updater then sets
  the feed itself from `product` (or `feedUrl`), so the two cannot drift apart silently in a
  way that matters, but keep them equal.
- Build both macOS architectures in **one** `electron-builder` run. Each run writes its own
  `latest-mac.yml`; only a run that builds both lists both zips. On an Apple Silicon Mac the
  updater takes the `arm64` zip (also when the x64 build runs under Rosetta, which moves that
  customer to the native build), on Intel the other one.
- Windows is x64 only for now: the backend's product rules accept only x64 for Windows, so an
  arm64 build would get no policy. The x64 build runs on Windows on ARM.
- Build with `--publish never` and upload the files yourself, in the order below.
- The version in `package.json` must be `MAJOR.MINOR.PATCH` (pre-releases like `1.5.0-beta.1`
  on the beta channel). `@handijit/core` compares versions strictly; anything else is rejected
  at start-up with a `TypeError`.

## Release checklist

What goes to the server, and in what order. The server is `/opt/downloads/<product>/`, served
as `https://indir.handijit.com/<product>/` behind Cloudflare.

A release of 1.5.0 produces:

| File                                             | For                               |
| ------------------------------------------------ | --------------------------------- |
| `on-muhasebe-1.5.0-win-x64.exe`                  | Windows: first install and update |
| `on-muhasebe-1.5.0-win-x64.exe.blockmap`         | Windows: differential update      |
| `latest.yml`                                     | Windows: the feed                 |
| `on-muhasebe-1.5.0-mac-arm64.dmg`, `…-x64.dmg`   | macOS: first install              |
| `on-muhasebe-1.5.0-mac-arm64.zip`, `…-x64.zip`   | macOS: update                     |
| `…-mac-arm64.zip.blockmap`, `…-x64.zip.blockmap` | macOS: differential update        |
| `latest-mac.yml`                                 | macOS: the feed                   |

1. **Build and sign.** Windows: NSIS. macOS: signed, notarized, stapled. Check the macOS
   result with `spctl --assess --type execute` before uploading anything.
2. **Upload the installers, the zips and the blockmaps.** They have new names, so nothing a
   customer is using changes. Never overwrite a published file: the checksums in the channel
   files of earlier releases and the CDN's copies refer to it. Keep the previous release's
   files on the server: differential downloads and customers in the middle of a download
   still need them.
3. **Check them from outside**, through Cloudflare: `curl -I` every new URL and compare
   `content-length` with the local size.
4. **Staged rollout (optional).** Add a line `stagingPercentage: 10` to `latest.yml` and
   `latest-mac.yml` before uploading them.
5. **Upload the channel files last**, each under a temporary name followed by a rename, so a
   half-written file is never served. From this moment programs find the release. The updater
   asks for them with a `?noCache=` query; Cloudflare must not be set to ignore query strings
   for `*.yml`, or the old file is served until its cache entry expires.
6. **Record the release in the backend** (admin → the product's releases): the version and the
   installer URLs per operating system and architecture, **without** a minimum version. The
   website's download button and the policy's `latestVersion` now point at 1.5.0.
7. **Raise the rollout.** Watch the error rate, then edit `stagingPercentage` to 50, then
   remove the line. Each program draws its own number once and keeps it, so raising the
   percentage only adds customers.
8. **Only then, if needed, set the minimum version** on the release record
   (`minSupportedVersion`). From the next policy request on, every program below it shows the
   gate and is offered the feed's version regardless of the staging percentage.

How staged rollout and the minimum version work together:

- `stagingPercentage` slows a release down. `minSupportedVersion` forces one. A required
  update overrides the staging percentage (rule 1 above), so setting a minimum on a release
  that is still staged rolls it out to everybody below the minimum at once. Set a minimum
  only on a release you would be willing to give to everyone.
- Set the minimum **after** the files and the channel files are on the server. The other
  order locks customers into the gate with nothing to install; the gate then offers the
  manual download and retries by itself, which is the safety net, not the plan.
- The backend takes the **highest** minimum any published release sets. A later release that
  leaves the field empty does not lower it; to lower it, edit the release that set it.
- A published version cannot be withdrawn: the updater refuses anything that is not newer
  than what is installed. A bad release is fixed by a higher version number.
- The minimum is per operating system and architecture, like the releases themselves.

## Failures

`state.error.code` is stable; `state.error.message` is Turkish and ready for display. After a
failure the button offers "Yeniden dene" (it downloads again when the failure was a download
and checks again otherwise); the gate offers the same and "Yeni sürümü indir" beside it.

| Code                  | When                                                                                                  | Message                                                                                                            |
| --------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `OFFLINE`             | No network, DNS failure, connection refused or reset, timeout.                                        | İnternet bağlantısı kurulamadı. Bağlantınızı kontrol edip yeniden deneyin.                                         |
| `SERVER`              | The server answered with an error status, or a file the feed names is missing.                        | Güncelleme sunucusuna şu anda ulaşılamıyor. Biraz sonra yeniden deneyin.                                           |
| `INVALID_FEED`        | The channel file cannot be parsed, names no file, has no checksum or holds a version that is not one. | Güncelleme bilgisi okunamadı. Biraz sonra yeniden deneyin.                                                         |
| `CHECKSUM`            | The downloaded file does not match the SHA-512 in the feed.                                           | İndirilen dosya doğrulanamadı. Yeniden deneyin.                                                                    |
| `SIGNATURE`           | Windows: the installed program expects a publisher and the update is not signed by it.                | Güncelleme dosyasının imzası doğrulanamadı. Yeni sürümü indirip elle kurabilirsiniz.                               |
| `DISK`                | No space, no permission, read-only or busy file while writing the download.                           | Güncelleme diske yazılamadı. Boş disk alanını kontrol edip yeniden deneyin.                                        |
| `INSTALL`             | The download is complete but the installer could not be started or handed over.                       | Güncelleme kurulamadı. Yeni sürümü indirip elle kurabilirsiniz.                                                    |
| `NOT_IN_APPLICATIONS` | macOS: the program runs from a read-only volume (the mounted DMG, or translocated).                   | Program Uygulamalar klasöründe olmadığı için güncellenemiyor. Programı Uygulamalar klasörüne taşıyıp yeniden açın. |
| `UNKNOWN`             | Anything else. The cause is in the log.                                                               | Güncelleme sırasında beklenmeyen bir sorun oluştu. Yeniden deneyin.                                                |

What is deliberately **not** an error:

| Situation                                            | State                                                  |
| ---------------------------------------------------- | ------------------------------------------------------ |
| The feed has no channel file (nothing published yet) | `not-available`                                        |
| The feed offers the running version or an older one  | `not-available`, and a warning in the log              |
| The customer is outside the staged rollout           | `not-available`                                        |
| A scheduled check fails (offline at night)           | the status it had; the next interval tries again       |
| The policy cannot be fetched                         | the stored verdict, or `ok`                            |
| A development run                                    | `unsupported` / `development`                          |
| A macOS build without a Developer ID signature       | `unsupported` / `unsigned`                             |
| Linux, or an architecture other than x64 and arm64   | `unsupported` / `platform`                             |
| "Restart" was pressed but a window refused to close  | `isInstallPending` returns to `false` after 30 seconds |

Programming errors throw a `TypeError` from `createUpdater`: a `product` that is not a slug, a
current version that is not a version, a `feedUrl` or `downloadPageUrl` that is not `https`
(plain `http` is accepted for `127.0.0.1` and `localhost` only).

## API

### `@handijit/electron-update/main`

#### `createUpdater(options): Updater`

| Option                    | Default                                                                    | Meaning                                                                                   |
| ------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `engine`                  | required                                                                   | `autoUpdater` of `electron-updater`, or anything with the same surface (`UpdaterEngine`). |
| `product`                 | required                                                                   | The product's slug: its folder on the download server and its name in the backend.        |
| `api`                     | required                                                                   | The API client of `@handijit/core`. Only `getUpdatePolicy` is called.                     |
| `logger`                  | required                                                                   | The logger of `@handijit/electron`. The updater writes under the `updater` scope.         |
| `currentVersion`          | `app.getVersion()`                                                         | The running version.                                                                      |
| `channel`                 | `"stable"`                                                                 | `"beta"` reads `beta.yml` / `beta-mac.yml` and asks the policy of the beta channel.       |
| `feedUrl`                 | `https://indir.handijit.com/<product>/`                                    | The folder that holds the channel files.                                                  |
| `downloadPageUrl`         | `https://api.handijit.com/api/public/downloads/<product>/<os>?arch=<arch>` | What "Yeni sürümü indir" opens: the backend's counted download link for this platform.    |
| `autoDownload`            | `false`                                                                    | Download as soon as a version is found, without asking.                                   |
| `installOnQuit`           | `true`                                                                     | Install a downloaded update when the program quits.                                       |
| `isSilentInstall`         | `false`                                                                    | Windows: run the installer without its window on "restart and update".                    |
| `useMultipleRangeRequest` | the engine decides                                                         | `false` when the server mishandles multi-range requests.                                  |
| `startDelayMs`            | `10_000`                                                                   | How long after `start()` the feed is first read.                                          |
| `checkIntervalMs`         | 6 hours                                                                    | How often the feed and the policy are read again; at least 15 minutes, ±10 % jitter.      |
| `requiredCacheTtlMs`      | 7 days                                                                     | How long a stored `required` holds without the backend confirming it.                     |
| `policyStore`             | `createPolicyStore()`                                                      | Where the last policy is kept.                                                            |
| `buildSupport`            | detected                                                                   | `"supported"` or an `UnsupportedReason`; overrides the detection.                         |
| `openExternal`            | `shell.openExternal`                                                       | Opens the download page.                                                                  |
| `platform`, `arch`        | `process.platform`, `process.arch`                                         | For tests.                                                                                |
| `now`, `random`           | `Date.now`, `Math.random`                                                  | For tests.                                                                                |

A duration that is out of range falls back to its default instead of throwing.

```ts
type Updater = {
  getState: () => UpdateState;
  onChange: (listener: (state: UpdateState) => void) => Unsubscribe;
  start: () => Promise<UpdateState>;
  check: () => Promise<UpdateState>;
  download: () => Promise<UpdateState>;
  install: () => Promise<UpdateState>;
  openDownloadPage: () => Promise<void>;
  dispose: () => void;
};
```

- `start()` finds out whether the build can update itself, loads the stored policy, asks the
  backend and starts the schedule. It resolves once the state reflects the first two; calling
  it again starts nothing. Every other method starts the updater first if needed.
- `check()` reads the feed and the policy now and resolves when the feed has answered. A
  failure of a check asked for this way is shown.
- `download()` starts the download of the available version. After a failed download it reads
  the feed again first (the files may have been replaced by a newer release).
- `install()` quits and installs a downloaded update. While an update is required it also
  checks and downloads first and restarts by itself; otherwise it never restarts unasked.
- `openDownloadPage()` opens `downloadPageUrl` in the browser. Never rejects.
- `dispose()` stops the timers, aborts the policy request, detaches from the engine and
  restores its rollout check. The updater stays readable and inert.

What the updater sets on the engine, once, at `start()`: `logger`, `autoDownload = false`,
`autoInstallOnAppQuit`, `setFeedURL({ provider: "generic", url, channel? })`,
`allowDowngrade = false` (again before every check) and a wrapped `isUserWithinRollout`. Do
not call the engine's `checkForUpdates`, `downloadUpdate` or `quitAndInstall` yourself.

#### `registerUpdateIpc({ updater, policy, onError? }): Unsubscribe`

Registers the handlers of `updateContract` and broadcasts every state change to the program's
windows. `policy` is the program's URL policy (`context.policy` of `startApp`): only the
program's own pages may call the handlers. Returns the function that undoes both.

#### `updateContract`, `createUpdateHandlers(updater)`

The contract fragment and its handlers, for a program that composes them into its own
contract ([The other way to wire IPC](#the-other-way-to-wire-ipc)).

| Channel                     | Kind   | Payload         |
| --------------------------- | ------ | --------------- |
| `update:get-state`          | invoke | → `UpdateState` |
| `update:check`              | invoke | → `UpdateState` |
| `update:download`           | invoke | → `UpdateState` |
| `update:install`            | invoke | → `UpdateState` |
| `update:open-download-page` | invoke | nothing         |
| `update:state-changed`      | event  | `UpdateState`   |

No channel takes an argument: the page can ask for a check, a download or an install, and
nothing else. It cannot choose a URL, a version or a file. The state is validated with Zod in
main before it leaves and with `isUpdateState` in the page when it arrives.

#### `createPolicyStore({ directory? }?): PolicyStore`

The default store: `update-policy.json` in `app.getPath("userData")`. Pass your own
`PolicyStore` (`read`, `write`) to keep the policy somewhere else.

Types: `Updater`, `UpdaterOptions`, `UpdaterEngine`, `UpdaterEngineLogger`, `PolicyStore`,
`PolicyStoreOptions`, `StoredPolicy`, `RegisterUpdateIpcOptions`.

### `@handijit/electron-update/preload`

- `withUpdateChannels(channels)`: the program's channel list plus the updater's. Throws on a
  name collision.
- `UPDATE_CHANNELS`: the updater's channels as a plain list (`{ invoke, events }` of `true`s).

Types: `WithUpdateChannels`, `ChannelList`.

### `@handijit/electron-update/renderer`

```ts
type UpdateClient = {
  getState: () => UpdateState | null;
  subscribe: (listener: (state: UpdateState) => void) => Unsubscribe;
  refresh: () => Promise<UpdateState | null>;
  check: () => Promise<UpdateState | null>;
  download: () => Promise<UpdateState | null>;
  install: () => Promise<UpdateState | null>;
  openDownloadPage: () => Promise<void>;
};
```

- `updateClient`: the page's client, over `window.desktop` of `@handijit/electron`. The first
  subscriber connects to main and asks for the current state; the last one to leave
  disconnects. Snapshots are ordered by `revision`, so an answer that arrives after a newer
  event cannot move the state backwards.
- `createUpdateClient()`: another client, for a test.
- `isUpdateState(value)`: the structural guard the client uses on everything it receives.

Outside Electron (a browser preview, a unit test without a bridge) nothing throws at import,
subscribers hear nothing and the state stays `null`, so the components draw nothing. The
actions reject there, saying that `window.desktop` is missing.

No React, no Zod, no `electron`.

### `@handijit/electron-update/react`

`useUpdate(client?)` returns `{ state, check, download, install, openDownloadPage }`. `state`
is `null` until main has answered. Built on `useSyncExternalStore`: every component shares
one subscription, and StrictMode's double mount subscribes and unsubscribes cleanly. The
actions reject only when main refuses the call; attach a `catch` in event handlers.

### `@handijit/electron-update/ui`

Needs `@handijit/ui/styles.css`, the tokens of `@handijit/design` and
`@handijit/electron-update/styles.css`.

#### `<UpdateButton />`

| Prop              | Default        | Meaning                                                                                             |
| ----------------- | -------------- | --------------------------------------------------------------------------------------------------- |
| `client`          | `updateClient` | The client to read from.                                                                            |
| `isAlwaysVisible` | `false`        | Show something in every state (settings page). Off: only when there is something to do (title bar). |
| `size`            | `UISize.SMALL` | The size of the button.                                                                             |
| `labels`          | Turkish        | Replaces any of the texts.                                                                          |
| `className`       |                | Added to the root element.                                                                          |

| State                         | Title bar (default)                            | With `isAlwaysVisible`                      |
| ----------------------------- | ---------------------------------------------- | ------------------------------------------- |
| `idle`                        | nothing                                        | "Güncellemeleri denetle"                    |
| `not-available`               | nothing                                        | "Program güncel" · "Güncellemeleri denetle" |
| `checking`                    | nothing                                        | "Denetleniyor…"                             |
| `unsupported`                 | nothing                                        | "Bu kurulum kendini güncelleyemiyor"        |
| `available`                   | "Güncelle 1.5.0"                               | the same                                    |
| `downloading`                 | progress bar and percent                       | the same, with "Güncelleme indiriliyor"     |
| `downloaded`                  | "Yeniden başlat"                               | the same                                    |
| `downloaded`, install pending | "Yeniden başlatılıyor…"                        | the same                                    |
| `error`                       | "Yeniden dene", the message as its description | the same, with the message shown            |

#### `<UpdateGate productName="…">`

| Prop          | Default        | Meaning                                                                     |
| ------------- | -------------- | --------------------------------------------------------------------------- |
| `productName` | required       | The program's name as the customer knows it.                                |
| `children`    |                | The program. Stays mounted behind the gate, `inert`.                        |
| `titleBar`    |                | Shown along the top of the gate: the window controls of a frameless window. |
| `client`      | `updateClient` | The client to read from.                                                    |
| `labels`      | Turkish        | Replaces any of the texts.                                                  |

While `policy.verdict === "required"` it renders an `alertdialog` over the whole window with
the installed and the new version and exactly one way on:

| State behind the gate   | The gate shows                                                                      |
| ----------------------- | ----------------------------------------------------------------------------------- |
| `checking`              | "Yeni sürüm aranıyor…"                                                              |
| `available`             | the size, "Şimdi güncelle"                                                          |
| `downloading`           | the progress, "İndirme bitince program kendiliğinden yeniden başlayacak."           |
| `downloaded`            | "Yeniden başlat ve güncelle"                                                        |
| install pending         | "Yeniden başlatılıyor…"                                                             |
| `not-available`, `idle` | "Yeni sürüm bu bilgisayara henüz ulaşmadı…", "Yeniden dene" and "Yeni sürümü indir" |
| `unsupported`           | "Bu kurulum kendini güncelleyemiyor…", "Yeni sürümü indir"                          |
| `error`                 | "Güncellenemedi", the message, "Yeniden dene" and "Yeni sürümü indir"               |

There is no "later" and no close button. A frameless window passes its window controls as
`titleBar`, so the customer can still minimize and close the program.

Accessibility: on every change the gate moves the focus to the one thing that can be done,
or to itself when nothing can; the program behind it is `inert` (not clickable, not reachable
by keyboard, not read by a screen reader), so Tab stays inside the gate; its note is a live
region. The button announces a published version, a finished download and a failure through
a live region of its own, also while it draws nothing. With `prefers-reduced-motion` nothing
animates. Both components follow the `light` and `dark` themes through the design tokens.

`DEFAULT_UPDATE_LABELS` holds every text; `labels` takes a `Partial<UpdateLabels>`.

Types: `UpdateButtonProps`, `UpdateGateProps`, `UpdateLabels`.

### `@handijit/electron-update`: shared

- Constants: `UPDATE_STATUSES`, `UPDATE_VERDICTS`, `UPDATE_ERROR_CODES`,
  `UNSUPPORTED_REASONS`, `UPDATE_CHANNELS`.
- `isUpdateState(value)`, `withUpdateChannels(channels)`.
- Types: `UpdateState`, `UpdateStatus`, `UpdateActivity`, `UpdateContext`, `UpdateInfo`,
  `UpdateProgress`, `UpdateError`, `UpdateErrorCode`, `UpdatePolicyState`, `UpdateVerdict`,
  `UnsupportedReason`, `UpdateContract`, `ChannelList`, `WithUpdateChannels`, `Unsubscribe`.

Imports nothing at run time; safe in any process.

## Logging and privacy

The updater writes to the `updater` scope of the program's logger: status changes, verdict
changes, failures with their stable code and the cause's own code. `electron-updater`'s lines
go to the same scope, one line each, with stacks removed.

No personal data is written. Every line from the engine and every cause is cleaned first:
account folders (`/Users/<name>`, `/home/<name>`, `C:\Users\<name>`, also when the account is
not the one Node calls home) become `~`, query strings are cut from URLs, and identifiers
that look like UUIDs are masked. The stored policy file holds two version numbers and a time.

## What the smoke test covers

`npm run test:electron` starts a real Electron four times with a fixture program (main,
preload and a React page wired through `@handijit/electron`), the built package and the real
`autoUpdater` of `electron-updater`, against a loopback server that serves a generated feed
(real SHA-512 checksums) and the policy endpoint. On macOS arm64 it makes 68 checks.

Runs for real, with the real `electron-updater`:

- reading the feed: a missing channel file, an older version (refused), a release staged at
  0 % (not offered), a release with notes and size;
- a required update read at once and offered whatever the staged rollout says;
- a download with a corrupted file (`CHECKSUM`), then a throttled download with progress
  events, without a second download under a burst of clicks, and the cached file's SHA-512
  equal to the published one;
- the choice of the file for the running architecture;
- macOS: the hand-over to Squirrel.Mac on quit and on "restart", which refuses the unsigned
  app, and the resulting `unsupported` / `unsigned` state; the `codesign` detection of an
  unsigned build; the inactive engine in a plain development run;
- the policy through `@handijit/core` (with Node's `fetch` and with `net.fetch`), the stored
  policy, the offline start with a stored `required`, the expiry in both clock directions;
- both IPC wirings, both module formats (ESM and CommonJS main), the sandboxed preload, the
  gate and both buttons in a real page under StrictMode, with no console error and no account
  folder in the log.

Does **not** run, and cannot without a packaged program:

- an actual install and restart into the new version. On macOS that needs a packaged,
  Developer ID signed and notarized app; on Windows a real NSIS installer. On Windows the
  smoke test replaces `quitAndInstall` with a recorder and checks its arguments.
- differential (blockmap) downloads, and the real `indir.handijit.com` behind Cloudflare.
- Windows and macOS x64 run only in CI (`.github/workflows/electron-smoke.yml`).

These are verified with the reference program, once, per platform.

## Not in this package

- **Packaging, signing, notarization, uploading.** `electron-builder` and the release
  workflow of the program.
- **The release record and the minimum version.** The backend's admin.
- **Cancelling a download, choosing a channel in the UI, release notes as HTML.** Not in
  1.0.0.
- **Linux.** `unsupported` / `platform`.
- **Licensing and sign-in.** Their own packages. The gate is not a licence check.

## Development

```sh
npm ci
npm run verify          # lint, typecheck, tests with 100 % coverage, build, sizes, package lint
npm run test:electron   # the smoke test in a real Electron (after npm run build)
npm run screenshots     # every state of the components, light and dark, in real Chromium
sh scripts/smoke-test.sh  # installs the packed tarball into an empty project and uses it
```

- `lib/main` is the updater, `lib/renderer` the page's client, `lib/react` the hook, `lib/ui`
  the components, `lib/shared` what every process may load.
- `__tests__` mirrors `lib`. The state machine is tested against a scripted fake of
  `electron-updater`'s event surface, the policy with fake timers, the components with
  Testing Library.
- `scripts/verify-build.mjs` runs after every build: both formats export the same names and
  every entry imports only what its process can load.
- Publishing happens from a GitHub release through `.github/workflows/publish.yml`.

## License

MIT
