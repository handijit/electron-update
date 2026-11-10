import type { ApiClient } from "@handijit/core";
import type { Logger } from "@handijit/electron/main";

import type { UnsupportedReason, Unsubscribe, UpdateState } from "../types";
import type { StoredPolicy } from "./policy-verdict";

/** The four log levels of `@handijit/electron`'s logger; all the updater's internals need. */
type UpdaterLogger = Pick<Logger, "debug" | "info" | "warn" | "error">;

/** The logger `electron-updater` writes to. */
type UpdaterEngineLogger = {
  info(message?: unknown): void;
  warn(message?: unknown): void;
  error(message?: unknown): void;
};

// Method syntax, on purpose: its parameter is checked bivariantly, so `electron-updater`'s
// `(updateInfo: UpdateInfo) => ...` fits without this package importing its types.
type RolloutCheck = {
  check(updateInfo: unknown): boolean | Promise<boolean>;
}["check"];

/**
 * The part of `electron-updater`'s `AppUpdater` this package uses. `autoUpdater` fits as it
 * is; a test passes a scripted fake.
 */
type UpdaterEngine = {
  /** Set to `false`: the updater decides when a download starts. */
  autoDownload: boolean;
  /** Set from the `installOnQuit` option. */
  autoInstallOnAppQuit: boolean;
  /** Set to `false` before every check. */
  allowDowngrade: boolean;
  /** Replaced by an adapter that writes to the updater's logger. */
  logger: UpdaterEngineLogger | null;
  /** Wrapped: a required update is offered to everyone, whatever the staged rollout says. */
  isUserWithinRollout: RolloutCheck;
  /** `true` when the program asked for updates in an unpackaged run (`dev-app-update.yml`). */
  readonly forceDevUpdateConfig?: boolean;
  setFeedURL(options: {
    provider: "generic";
    url: string;
    channel?: string;
    useMultipleRangeRequest?: boolean;
  }): void;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(event: string, listener: (...args: never[]) => void): unknown;
  removeListener(event: string, listener: (...args: never[]) => void): unknown;
};

/** Where the last answer of the backend's version policy is kept between starts. */
type PolicyStore = {
  /** The stored policy, or `null` when there is none. */
  readonly read: () => Promise<StoredPolicy | null>;
  /** Replaces the stored policy; `null` removes it. */
  readonly write: (policy: StoredPolicy | null) => Promise<void>;
};

/** How `createUpdater` is set up. */
type UpdaterOptions = {
  /** The `autoUpdater` of `electron-updater` (or anything with the same surface). */
  engine: UpdaterEngine;
  /** The product's slug: its folder on the download server and its name in the backend. */
  product: string;
  /** The API client of `@handijit/core`; only `getUpdatePolicy` is called. */
  api: Pick<ApiClient, "getUpdatePolicy">;
  /** The logger of `@handijit/electron`; the updater writes under the `updater` scope. */
  logger: Pick<Logger, "child">;
  /** The running version. Default: `app.getVersion()`. */
  currentVersion?: string;
  /** The release channel, in the backend's terms. Default: `"stable"`. */
  channel?: "stable" | "beta";
  /** The folder that holds the feed. Default: `https://indir.handijit.com/<product>/`. */
  feedUrl?: string;
  /** What "download it yourself" opens. Default: the backend's download link for this platform. */
  downloadPageUrl?: string;
  /** Download an update as soon as it is found, without asking. Default: `false`. */
  autoDownload?: boolean;
  /** Install a downloaded update when the program quits. Default: `true`. */
  installOnQuit?: boolean;
  /** Windows: run the installer without its window on "restart and update". Default: `false`. */
  isSilentInstall?: boolean;
  /** Set `false` when the server mishandles multi-range requests (differential downloads). Default: the engine decides. */
  useMultipleRangeRequest?: boolean;
  /** How long after `start()` the feed is first read, in milliseconds. Default: 10 seconds. */
  startDelayMs?: number;
  /** How often the feed and the policy are read again, in milliseconds (at least 15 minutes). Default: 6 hours. */
  checkIntervalMs?: number;
  /** How long a stored "required" verdict holds without the backend confirming it, in milliseconds. Default: 7 days. */
  requiredCacheTtlMs?: number;
  /** Where the last policy is kept. Default: `update-policy.json` in the user data folder. */
  policyStore?: PolicyStore;
  /** Overrides the detection of whether this build can update itself. */
  buildSupport?: "supported" | UnsupportedReason;
  /** Opens the download page. Default: `shell.openExternal`. */
  openExternal?: (url: string) => Promise<void>;
  /** For tests: stands in for `process.platform`. */
  platform?: string;
  /** For tests: stands in for `process.arch`. */
  arch?: string;
  /** For tests: the clock. Default: `Date.now`. */
  now?: () => number;
  /** For tests: the source of the interval's jitter. Default: `Math.random`. */
  random?: () => number;
};

/** The updater of a program: one per main process. */
type Updater = {
  /** The current state. The object is frozen; every change produces a new one. */
  readonly getState: () => UpdateState;
  /** Listens to state changes. Returns the function that stops listening. */
  readonly onChange: (listener: (state: UpdateState) => void) => Unsubscribe;
  /**
   * Finds out whether this build can update itself, loads the stored policy and starts the
   * schedule. Resolves with the state once it reflects both; calling it again starts nothing
   * and resolves with the current state.
   */
  readonly start: () => Promise<UpdateState>;
  /** Reads the feed and the policy now. Resolves when the feed has answered or failed. */
  readonly check: () => Promise<UpdateState>;
  /** Starts downloading the available update; after a failed download, checks again first. */
  readonly download: () => Promise<UpdateState>;
  /**
   * Restarts into the downloaded update. While an update is required it also downloads first
   * and restarts on its own when the download is done; otherwise it never restarts unasked.
   */
  readonly install: () => Promise<UpdateState>;
  /** Opens the page the new version can be downloaded from by hand. */
  readonly openDownloadPage: () => Promise<void>;
  /** Stops the timers and detaches from the engine. The updater stays readable and inert. */
  readonly dispose: () => void;
};

export type {
  PolicyStore,
  Updater,
  UpdaterEngine,
  UpdaterEngineLogger,
  UpdaterLogger,
  UpdaterOptions,
};
