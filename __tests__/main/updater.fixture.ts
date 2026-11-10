import { EventEmitter } from "node:events";

import type { ApiClient, UpdatePolicy } from "@handijit/core";
import { vi } from "vitest";
import type { Mock } from "vitest";

import createUpdater from "../../lib/main/create-updater";
import type { StoredPolicy } from "../../lib/main/policy-verdict";
import type {
  PolicyStore,
  Updater,
  UpdaterEngine,
  UpdaterOptions,
} from "../../lib/main/types";
import type { UpdateState } from "../../lib/types";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** Monday 10 November 2026, 08:00 UTC: where every test's clock starts. */
const START = Date.UTC(2026, 10, 10, 8);

type Deferred = {
  readonly promise: Promise<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (cause: unknown) => void;
};

const defer = (): Deferred => {
  let resolve: (value: unknown) => void = () => undefined;
  let reject: (cause: unknown) => void = () => undefined;
  const promise = new Promise<unknown>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};

/** What `latest.yml` says, as electron-updater hands it over. */
const feed = (
  version: string,
  extra: Readonly<Record<string, unknown>> = {}
): Readonly<Record<string, unknown>> => ({
  version,
  releaseDate: "2026-11-09T10:00:00.000Z",
  files: [
    { url: `Demo-Setup-${version}-x64.exe`, sha512: "c2hh", size: 84_200_000 },
  ],
  path: `Demo-Setup-${version}-x64.exe`,
  sha512: "c2hh",
  ...extra,
});

/** An error as electron-updater throws it: a message and a stable `code`. */
const engineError = (code: string, message = "the engine failed"): Error =>
  Object.assign(new Error(message), { code });

/**
 * A scripted stand-in for electron-updater's `autoUpdater`: the same event surface and the
 * same promises, but every answer is given by the test, in the order the test chooses.
 */
const createFakeEngine = () => {
  const emitter = new EventEmitter();
  const checks: Deferred[] = [];
  const downloads: Deferred[] = [];
  const lastOf = (list: Deferred[]): Deferred => {
    const last = list.at(-1);
    if (last === undefined) throw new Error("the engine was not asked yet");
    return last;
  };

  const engine = {
    // The opposite of what the updater wants, so that the tests see it set them.
    autoDownload: true,
    autoInstallOnAppQuit: false,
    allowDowngrade: true,
    logger: null as UpdaterEngine["logger"],
    forceDevUpdateConfig: false,
    isUserWithinRollout: vi.fn<UpdaterEngine["isUserWithinRollout"]>(
      () => false
    ),
    setFeedURL: vi.fn<UpdaterEngine["setFeedURL"]>(),
    checkForUpdates: vi.fn<UpdaterEngine["checkForUpdates"]>(() => {
      const check = defer();
      checks.push(check);
      return check.promise;
    }),
    downloadUpdate: vi.fn<UpdaterEngine["downloadUpdate"]>(() => {
      const download = defer();
      downloads.push(download);
      return download.promise;
    }),
    quitAndInstall: vi.fn<UpdaterEngine["quitAndInstall"]>(),
    on: (event: string, listener: (...parameters: never[]) => void) =>
      emitter.on(event, listener as (...parameters: unknown[]) => void),
    removeListener: (
      event: string,
      listener: (...parameters: never[]) => void
    ) =>
      emitter.removeListener(
        event,
        listener as (...parameters: unknown[]) => void
      ),
  };

  return {
    engine,
    checks,
    downloads,
    emit: (event: string, ...parameters: unknown[]): void => {
      emitter.emit(event, ...parameters);
    },
    listenerCount: (event: string): number => emitter.listenerCount(event),
    /** The feed has a version: the event, then the promise, as the real engine does. */
    offer: (info: Readonly<Record<string, unknown>>): void => {
      emitter.emit("update-available", info);
      lastOf(checks).resolve({ updateInfo: info });
    },
    /** The feed has nothing newer. */
    offerNothing: (info: Readonly<Record<string, unknown>> = {}): void => {
      emitter.emit("update-not-available", info);
      lastOf(checks).resolve({ updateInfo: info });
    },
    /** The check fails: the `error` event, then the rejection. */
    failCheck: (cause: unknown): void => {
      emitter.emit("error", cause, String(cause));
      lastOf(checks).reject(cause);
    },
    progress: (percent: number, total = 84_200_000): void => {
      emitter.emit("download-progress", {
        percent,
        total,
        transferred: (total * percent) / 100,
        bytesPerSecond: 1_200_000,
        delta: 1000,
      });
    },
    /** The download is complete: the event, then the promise. */
    finishDownload: (info: Readonly<Record<string, unknown>>): void => {
      emitter.emit("update-downloaded", {
        ...info,
        downloadedFile: "/cache/pending/update.exe",
      });
      lastOf(downloads).resolve(["/cache/pending/update.exe"]);
    },
    /** The download fails: the `error` event, then the rejection. */
    failDownload: (cause: unknown): void => {
      emitter.emit("error", cause, String(cause));
      lastOf(downloads).reject(cause);
    },
  };
};

type FakeEngine = ReturnType<typeof createFakeEngine>;

type LogMock = Mock<(message: string, context?: object) => void>;

type FakeScopedLogger = {
  debug: LogMock;
  info: LogMock;
  warn: LogMock;
  error: LogMock;
  directory: string;
  child: () => FakeScopedLogger;
  flush: () => Promise<void>;
};

const createFakeLogger = () => {
  const scoped: FakeScopedLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    directory: "/logs",
    child: () => scoped,
    flush: () => Promise.resolve(),
  };
  const child = vi.fn((scope: string) => {
    void scope;
    return scoped;
  });
  /** Every message written at a level, without its context. */
  const messages = (level: "debug" | "info" | "warn" | "error"): string[] =>
    scoped[level].mock.calls.map(([message]) => message);
  /** The context of the first line with this message. */
  const contextOf = (
    level: "debug" | "info" | "warn" | "error",
    message: string
  ): unknown =>
    scoped[level].mock.calls.find(([text]) => text === message)?.[1];

  return { logger: { child }, scoped, messages, contextOf };
};

const createMemoryStore = (initial: StoredPolicy | null = null) => {
  let value: unknown = initial;
  const store = {
    read: vi.fn<PolicyStore["read"]>(() =>
      Promise.resolve(value as StoredPolicy | null)
    ),
    write: vi.fn<PolicyStore["write"]>((policy) => {
      value = policy;
      return Promise.resolve();
    }),
  };
  return {
    store,
    peek: (): unknown => value,
    /** Puts anything in the file, as a hand edit or an older version would. */
    corrupt: (anything: unknown): void => {
      value = anything;
    },
  };
};

/** The backend's answer for a product. */
const policyAnswer = (
  latestVersion: string,
  minSupportedVersion?: string
): UpdatePolicy => ({
  product: "on-muhasebe",
  os: "windows",
  arch: "x64",
  channel: "stable",
  latestVersion,
  ...(minSupportedVersion === undefined ? {} : { minSupportedVersion }),
});

/** An error of `@handijit/core`'s client, by shape (its guards read the shape). */
const apiError = (
  fields: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> => ({
  name: "HandijitApiError",
  message: "the request failed",
  method: "GET",
  path: "/api/public/products/on-muhasebe/update-policy",
  kind: "problem",
  fields: [],
  extensions: {},
  ...fields,
});

const OFFLINE = apiError({ kind: "network" });

/** Lets every promise that is ready run, without moving the clock. */
const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

type Harness = {
  readonly updater: Updater;
  readonly fake: FakeEngine;
  readonly log: ReturnType<typeof createFakeLogger>;
  readonly memory: ReturnType<typeof createMemoryStore>;
  readonly getUpdatePolicy: Mock<ApiClient["getUpdatePolicy"]>;
  readonly openExternal: Mock<(url: string) => Promise<void>>;
  /** Every state the listeners saw, in order. */
  readonly states: UpdateState[];
  /** The statuses the listeners saw, in order, without repeats. */
  readonly statuses: () => string[];
  /** Starts the updater and waits until the first policy request has been answered. */
  readonly start: () => Promise<void>;
};

type HarnessOptions = Partial<UpdaterOptions> & {
  /** What the policy file holds before the start. */
  stored?: StoredPolicy | null;
  /** The backend's answer; default: offline. */
  policy?: UpdatePolicy;
};

/**
 * An updater on Windows x64, version 1.4.0, in a build that can update itself, with a scripted
 * engine, an in-memory policy file and a backend that is offline unless the test says more.
 */
const createHarness = ({
  stored = null,
  policy,
  ...overrides
}: HarnessOptions = {}): Harness => {
  vi.useFakeTimers();
  vi.setSystemTime(START);

  const fake = createFakeEngine();
  const log = createFakeLogger();
  const memory = createMemoryStore(stored);
  const getUpdatePolicy = vi.fn<ApiClient["getUpdatePolicy"]>(() =>
    policy === undefined ? Promise.reject(OFFLINE) : Promise.resolve(policy)
  );
  const openExternal = vi.fn<(url: string) => Promise<void>>(() =>
    Promise.resolve()
  );

  const updater = createUpdater({
    engine: fake.engine,
    product: "on-muhasebe",
    api: { getUpdatePolicy },
    logger: log.logger as unknown as UpdaterOptions["logger"],
    currentVersion: "1.4.0",
    platform: "win32",
    arch: "x64",
    buildSupport: "supported",
    policyStore: memory.store,
    openExternal,
    random: () => 0.5,
    ...overrides,
  });
  const states: UpdateState[] = [];
  updater.onChange((state) => states.push(state));

  return {
    updater,
    fake,
    log,
    memory,
    getUpdatePolicy,
    openExternal,
    states,
    statuses: () =>
      states
        .map((state) => state.status)
        .filter((status, index, all) => status !== all[index - 1]),
    start: async () => {
      void updater.start();
      await flush();
    },
  };
};

export type { FakeEngine, Harness, HarnessOptions };
export {
  apiError,
  createFakeEngine,
  createFakeLogger,
  createHarness,
  createMemoryStore,
  DAY_MS,
  engineError,
  feed,
  flush,
  HOUR_MS,
  MINUTE_MS,
  OFFLINE,
  policyAnswer,
  START,
};
