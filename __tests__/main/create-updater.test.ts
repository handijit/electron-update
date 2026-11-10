import { homedir } from "node:os";

import { describe, expect, test, vi } from "vitest";

import createUpdater from "../../lib/main/create-updater";
import type { UpdaterOptions } from "../../lib/main/types";
import {
  createFakeEngine,
  createFakeLogger,
  createHarness,
  createMemoryStore,
  engineError,
  feed,
  flush,
  HOUR_MS,
  MINUTE_MS,
  OFFLINE,
  policyAnswer,
  START,
} from "./updater.fixture";

const mocks = vi.hoisted(() => ({
  app: {
    getVersion: vi.fn(() => "2.3.4"),
    isPackaged: true,
    getPath: vi.fn(() => "/Applications/Demo.app/Contents/MacOS/Demo"),
  },
  shell: { openExternal: vi.fn(() => Promise.resolve()) },
  detectBuildSupport: vi.fn<() => Promise<string | null>>(() =>
    Promise.resolve(null)
  ),
  createPolicyStore: vi.fn(),
}));

vi.mock("electron", () => ({ app: mocks.app, shell: mocks.shell }));
vi.mock("../../lib/main/build-support", () => ({
  default: mocks.detectBuildSupport,
}));
vi.mock("../../lib/main/policy-store", () => ({
  default: mocks.createPolicyStore,
}));

const minimal = (overrides: Partial<UpdaterOptions> = {}): UpdaterOptions => ({
  engine: createFakeEngine().engine,
  product: "on-muhasebe",
  api: { getUpdatePolicy: vi.fn(() => Promise.reject(OFFLINE)) },
  logger: createFakeLogger().logger as unknown as UpdaterOptions["logger"],
  currentVersion: "1.4.0",
  policyStore: createMemoryStore().store,
  ...overrides,
});

/** A copy without some keys: what a program that leaves an option out passes. */
const omit = <T extends object, K extends keyof T>(
  value: T,
  ...keys: K[]
): Omit<T, K> =>
  Object.fromEntries(
    Object.entries(value).filter(([key]) => !keys.includes(key as K))
  ) as Omit<T, K>;

describe("createUpdater: the settings", () => {
  test.each([[""], ["On Muhasebe"], ["on_muhasebe"], ["-on"], ["on/../x"]])(
    "should refuse the product %j, which is not a slug",
    (product) => {
      expect(() => createUpdater(minimal({ product }))).toThrow(
        new TypeError(
          'createUpdater: "product" must be the product\'s slug, like "on-muhasebe"'
        )
      );
    }
  );

  test("should refuse a product that is not text at all", () => {
    expect(() =>
      createUpdater(minimal({ product: undefined as unknown as string }))
    ).toThrow(TypeError);
  });

  test("should refuse a current version that is not a version", () => {
    expect(() => createUpdater(minimal({ currentVersion: "1.4" }))).toThrow(
      new TypeError(
        'createUpdater: the current version "1.4" is not a version like "1.4.0"'
      )
    );
  });

  test("should read the current version from the app by default, and refuse that too when it is none", () => {
    const options = omit(minimal(), "currentVersion");

    expect(createUpdater(options).getState().currentVersion).toBe("2.3.4");

    mocks.app.getVersion.mockReturnValueOnce("dev");
    expect(() => createUpdater(options)).toThrow(/"dev" is not a version/);
  });

  test.each([
    ["feedUrl", "http://indir.handijit.com/on-muhasebe/"],
    ["feedUrl", "not a url"],
    ["feedUrl", "file:///opt/downloads/"],
    ["downloadPageUrl", "javascript:alert(1)"],
    ["downloadPageUrl", "http://handijit.com/indir"],
  ] as const)("should refuse the %s %j", (option, value) => {
    expect(() => createUpdater(minimal({ [option]: value }))).toThrow(
      new TypeError(`createUpdater: "${option}" must be an https URL`)
    );
  });

  test("should accept plain http towards this computer only, for a test server", () => {
    expect(() =>
      createUpdater(minimal({ feedUrl: "http://127.0.0.1:8123/demo/" }))
    ).not.toThrow();
    expect(() =>
      createUpdater(minimal({ feedUrl: "http://localhost:8123/demo/" }))
    ).not.toThrow();
  });

  test("should do nothing at all before it is started", async () => {
    const { updater, fake, getUpdatePolicy, memory } = createHarness();
    await flush();

    expect(updater.getState()).toEqual({
      status: "idle",
      revision: 0,
      currentVersion: "1.4.0",
      policy: {
        verdict: "ok",
        latestVersion: null,
        minSupportedVersion: null,
        checkedAt: null,
      },
      checkedAt: null,
      isInstallPending: false,
    });
    expect(Object.isFrozen(updater.getState())).toBe(true);
    expect(fake.engine.setFeedURL).not.toHaveBeenCalled();
    expect(fake.listenerCount("error")).toBe(0);
    expect(getUpdatePolicy).not.toHaveBeenCalled();
    expect(memory.store.read).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("createUpdater: the start", () => {
  test("should take the engine over: no downloads of its own, no downgrades, the product's feed", async () => {
    const { fake, start } = createHarness();
    await start();

    expect(fake.engine.autoDownload).toBe(false);
    expect(fake.engine.autoInstallOnAppQuit).toBe(true);
    expect(fake.engine.allowDowngrade).toBe(false);
    expect(fake.engine.setFeedURL).toHaveBeenCalledExactlyOnceWith({
      provider: "generic",
      url: "https://indir.handijit.com/on-muhasebe/",
    });
    for (const event of [
      "update-available",
      "update-not-available",
      "download-progress",
      "update-downloaded",
      "update-cancelled",
      "error",
    ]) {
      expect(fake.listenerCount(event)).toBe(1);
    }
  });

  test("should pass the options of the feed and of the install on to the engine", async () => {
    const { fake, start, getUpdatePolicy } = createHarness({
      feedUrl: "https://files.example.com/demo/",
      channel: "beta",
      installOnQuit: false,
      useMultipleRangeRequest: false,
    });
    await start();

    expect(fake.engine.autoInstallOnAppQuit).toBe(false);
    expect(fake.engine.setFeedURL).toHaveBeenCalledExactlyOnceWith({
      provider: "generic",
      url: "https://files.example.com/demo/",
      channel: "beta",
      useMultipleRangeRequest: false,
    });
    expect(getUpdatePolicy.mock.calls[0]?.[0]).toMatchObject({
      channel: "beta",
    });
  });

  test("should start once, however often it is asked", async () => {
    const { updater, fake } = createHarness();

    const first = updater.start();
    const second = updater.start();
    await flush();

    expect(await first).toBe(updater.getState());
    expect(await second).toBe(updater.getState());
    expect(fake.engine.setFeedURL).toHaveBeenCalledTimes(1);
  });

  test("should read the feed ten seconds after the start, not while the program is starting", async () => {
    const { fake, start } = createHarness();
    await start();

    await vi.advanceTimersByTimeAsync(9999);
    expect(fake.engine.checkForUpdates).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(fake.engine.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  test("should read the feed again every six hours", async () => {
    const { fake, start } = createHarness();
    await start();
    await vi.advanceTimersByTimeAsync(10_000);
    fake.offerNothing();

    await vi.advanceTimersByTimeAsync(6 * HOUR_MS - 1);
    expect(fake.engine.checkForUpdates).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(fake.engine.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  test.each([
    [0, 27 * MINUTE_MS],
    [1, 33 * MINUTE_MS],
  ])(
    "should spread the interval by ten percent (random %d)",
    async (random, expected) => {
      const { fake, start } = createHarness({
        startDelayMs: 0,
        checkIntervalMs: 30 * MINUTE_MS,
        random: () => random,
      });
      await start();
      fake.offerNothing();

      await vi.advanceTimersByTimeAsync(expected - 1);
      expect(fake.engine.checkForUpdates).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(fake.engine.checkForUpdates).toHaveBeenCalledTimes(2);
    }
  );

  test.each([
    [{ startDelayMs: -1 }],
    [{ startDelayMs: Number.NaN }],
    [{ startDelayMs: 30 * 24 * HOUR_MS }],
  ])(
    "should fall back to the default for a delay that is out of range: %j",
    async (options) => {
      const { fake, start } = createHarness(options);
      await start();

      await vi.advanceTimersByTimeAsync(9999);
      expect(fake.engine.checkForUpdates).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(fake.engine.checkForUpdates).toHaveBeenCalledTimes(1);
    }
  );

  test("should not let a program ask the server more often than every fifteen minutes", async () => {
    const { fake, start } = createHarness({
      startDelayMs: 0,
      checkIntervalMs: MINUTE_MS,
    });
    await start();
    fake.offerNothing();

    await vi.advanceTimersByTimeAsync(6 * HOUR_MS - 1);
    expect(fake.engine.checkForUpdates).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.engine.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  test("should use the app, the real clock, the policy file and the build's own signature by default", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5);
    const fake = createFakeEngine();
    const memory = createMemoryStore();
    mocks.createPolicyStore.mockReturnValue(memory.store);
    const options = omit(
      minimal({
        engine: fake.engine,
        api: {
          getUpdatePolicy: vi.fn(() => Promise.resolve(policyAnswer("2.4.0"))),
        },
        platform: "darwin",
        arch: "arm64",
        startDelayMs: 0,
      }),
      "currentVersion",
      "policyStore"
    );
    fake.engine.forceDevUpdateConfig = true;

    const updater = createUpdater(options);
    void updater.start();
    await flush();

    expect(mocks.detectBuildSupport).toHaveBeenCalledExactlyOnceWith({
      platform: "darwin",
      arch: "arm64",
      isPackaged: true,
      isDevelopmentForced: true,
      executablePath: "/Applications/Demo.app/Contents/MacOS/Demo",
    });
    expect(mocks.app.getPath).toHaveBeenCalledWith("exe");
    expect(mocks.createPolicyStore).toHaveBeenCalledExactlyOnceWith();
    expect(memory.peek()).toEqual({
      latestVersion: "2.4.0",
      minSupportedVersion: null,
      fetchedAt: START,
    });
    expect(updater.getState().policy.verdict).toBe("recommended");
    expect(randomSpy).toHaveBeenCalled();

    await updater.openDownloadPage();
    expect(mocks.shell.openExternal).toHaveBeenCalledExactlyOnceWith(
      "https://api.handijit.com/api/public/downloads/on-muhasebe/macos?arch=arm64"
    );
    updater.dispose();
  });

  test("should take the clock it is given", async () => {
    let time = 5_000_000;
    const { updater, fake, start } = createHarness({ now: () => time });
    await start();

    const pending = updater.check();
    await flush();
    time = 6_000_000;
    fake.offerNothing();

    expect((await pending).checkedAt).toBe(6_000_000);
  });

  test("should write the engine's own lines to the updater's log, without the home folder", async () => {
    const { fake, log, start } = createHarness();
    await start();

    fake.engine.logger?.info(`Cached at ${homedir()}/cache/pending`);
    fake.engine.logger?.error(new Error("Cannot download"));

    expect(log.logger.child).toHaveBeenCalledExactlyOnceWith("updater");
    expect(log.messages("debug")).toEqual([
      "engine: Cached at ~/cache/pending",
    ]);
    expect(log.messages("warn")).toContain("engine: Cannot download");
  });
});

describe("createUpdater: a build that cannot update itself", () => {
  test("should say so in a development run, and leave the engine and the backend alone", async () => {
    const { updater, fake, getUpdatePolicy, memory, log, start } =
      createHarness({ buildSupport: "development" });
    await start();

    expect(updater.getState()).toMatchObject({
      status: "unsupported",
      reason: "development",
    });
    expect(fake.engine.setFeedURL).not.toHaveBeenCalled();
    expect(fake.listenerCount("error")).toBe(0);
    expect(getUpdatePolicy).not.toHaveBeenCalled();
    expect(memory.store.read).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(log.contextOf("info", "this build cannot update itself")).toEqual({
      reason: "development",
    });
  });

  test("should answer every action with the same state instead of throwing", async () => {
    const { updater, fake, start } = createHarness({
      buildSupport: "development",
    });
    await start();
    const state = updater.getState();

    expect(await updater.check()).toBe(state);
    expect(await updater.download()).toBe(state);
    expect(await updater.install()).toBe(state);
    expect(fake.engine.checkForUpdates).not.toHaveBeenCalled();
    expect(fake.engine.downloadUpdate).not.toHaveBeenCalled();
    expect(fake.engine.quitAndInstall).not.toHaveBeenCalled();
  });

  test("should still obey the policy in an unsigned macOS build", async () => {
    const { updater, fake, getUpdatePolicy, start } = createHarness({
      buildSupport: "unsigned",
      platform: "darwin",
      arch: "arm64",
      policy: policyAnswer("1.5.0", "1.4.5"),
    });
    await start();

    expect(updater.getState()).toMatchObject({
      status: "unsupported",
      reason: "unsigned",
      policy: { verdict: "required", latestVersion: "1.5.0" },
    });
    expect(getUpdatePolicy.mock.calls[0]?.[0]).toEqual({
      product: "on-muhasebe",
      os: "macos",
      arch: "arm64",
      channel: "stable",
    });

    // The schedule keeps the policy fresh; the engine is never asked.
    await vi.advanceTimersByTimeAsync(7 * HOUR_MS);
    expect(getUpdatePolicy).toHaveBeenCalledTimes(2);
    expect(fake.engine.checkForUpdates).not.toHaveBeenCalled();
    expect(fake.engine.setFeedURL).not.toHaveBeenCalled();
  });

  test("should wait for the policy when such a build is asked to check", async () => {
    const { updater, getUpdatePolicy, start } = createHarness({
      buildSupport: "unsigned",
      platform: "darwin",
    });
    await start();
    expect(updater.getState().policy.verdict).toBe("ok");

    await vi.advanceTimersByTimeAsync(2 * MINUTE_MS);
    getUpdatePolicy.mockResolvedValueOnce(policyAnswer("1.5.0", "1.4.5"));
    const state = await updater.check();

    expect(state.status).toBe("unsupported");
    expect(state.policy.verdict).toBe("required");
  });

  test("should have neither a feed nor a policy on a platform no release is built for", async () => {
    const { updater, getUpdatePolicy, openExternal, start } = createHarness({
      buildSupport: "platform",
      platform: "linux",
    });
    await start();

    expect(updater.getState()).toMatchObject({
      status: "unsupported",
      reason: "platform",
    });
    expect(getUpdatePolicy).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    await updater.check();
    expect(getUpdatePolicy).not.toHaveBeenCalled();

    await updater.openDownloadPage();
    expect(openExternal).toHaveBeenCalledExactlyOnceWith(
      "https://handijit.com"
    );
  });

  test("should read the feed without a policy on an architecture the backend does not know", async () => {
    const { updater, fake, getUpdatePolicy, start } = createHarness({
      arch: "ia32",
      startDelayMs: 0,
    });
    await start();

    expect(fake.engine.checkForUpdates).toHaveBeenCalledTimes(1);
    fake.offerNothing();
    await flush();

    expect(updater.getState().status).toBe("not-available");
    expect(getUpdatePolicy).not.toHaveBeenCalled();
  });

  test("should learn from the engine itself that the build is a development run", async () => {
    const { updater, fake, log, start } = createHarness();
    await start();

    const pending = updater.check();
    await flush();
    // electron-updater answers null when the app is not packaged.
    fake.checks[0]?.resolve(null);

    expect(await pending).toMatchObject({
      status: "unsupported",
      reason: "development",
    });
    expect(log.messages("info")).toContain(
      "the engine is inactive in this build"
    );
  });
});

describe("createUpdater: listeners and the end", () => {
  test("should hand every listener a new frozen state whose revision counts up", async () => {
    const { updater, fake, states, start } = createHarness();
    await start();

    const pending = updater.check();
    await flush();
    fake.offer(feed("1.5.0"));
    await pending;

    expect(states.map((state) => state.revision)).toEqual([1, 2]);
    expect(states.every((state) => Object.isFrozen(state))).toBe(true);
    expect(updater.getState()).toBe(states.at(-1));
  });

  test("should not publish when nothing a page can see has changed", async () => {
    const { updater, fake, states, start } = createHarness();
    await start();
    const pending = updater.check();
    await flush();
    fake.offer(feed("1.5.0"));
    await pending;
    void updater.download();
    await flush();
    const before = states.length;

    fake.progress(10);
    fake.progress(10);
    fake.progress(10);

    expect(states).toHaveLength(before + 1);
  });

  test("should stop telling a listener that left, and survive one that throws", async () => {
    const { updater, fake, log, states, start } = createHarness();
    const seen: string[] = [];
    const leave = updater.onChange((state) => seen.push(state.status));
    updater.onChange(() => {
      throw new Error("the page is gone");
    });
    await start();

    const pending = updater.check();
    await flush();
    leave();
    leave();
    fake.offerNothing();
    await pending;

    expect(seen).toEqual(["checking"]);
    expect(states.map((state) => state.status)).toEqual([
      "checking",
      "not-available",
    ]);
    expect(log.contextOf("error", "a state listener threw")).toEqual({
      causeCode: "",
      cause: "the page is gone",
    });
  });

  test("should let a listener check again without starting a second check", async () => {
    const { updater, fake, start } = createHarness();
    await start();
    const joined: Promise<unknown>[] = [];
    updater.onChange((state) => {
      if (state.status === "checking") joined.push(updater.check());
    });

    const pending = updater.check();
    await flush();
    fake.offerNothing();
    await pending;
    await Promise.all(joined);

    expect(joined).toHaveLength(1);
    expect(fake.engine.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  test("should detach from the engine and stop every timer when it is disposed", async () => {
    const { updater, fake, getUpdatePolicy, states, start } = createHarness({
      policy: policyAnswer("1.5.0", "1.4.5"),
    });
    const rollout = fake.engine.isUserWithinRollout;
    await start();
    fake.offerNothing();
    await flush();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    expect(fake.engine.isUserWithinRollout).not.toBe(rollout);
    const state = updater.getState();
    const published = states.length;

    updater.dispose();
    updater.dispose();

    expect(vi.getTimerCount()).toBe(0);
    expect(fake.engine.isUserWithinRollout).toBe(rollout);
    for (const event of ["update-available", "download-progress", "error"]) {
      expect(fake.listenerCount(event)).toBe(0);
    }
    expect(getUpdatePolicy.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);

    expect(await updater.start()).toBe(state);
    expect(await updater.check()).toBe(state);
    expect(await updater.download()).toBe(state);
    expect(await updater.install()).toBe(state);
    expect(fake.engine.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(states).toHaveLength(published);
  });

  test("should ignore what a check answers after the end", async () => {
    const { updater, fake, states, start } = createHarness();
    await start();
    void updater.check();
    await flush();
    const published = states.length;

    updater.dispose();
    fake.checks[0]?.resolve({ updateInfo: feed("1.5.0") });
    await flush();

    expect(updater.getState().status).toBe("checking");
    expect(states).toHaveLength(published);
  });

  test("should ignore a check that fails after the end", async () => {
    const { updater, fake, log, start } = createHarness();
    await start();
    void updater.check();
    await flush();

    updater.dispose();
    fake.checks[0]?.reject(engineError("ENOTFOUND"));
    await flush();

    expect(updater.getState().status).toBe("checking");
    expect(log.messages("warn")).not.toContain("the update check failed");
  });

  test("should attach nothing when it is disposed while it is still finding out what the build can do", async () => {
    const { updater, fake, memory } = createHarness();

    void updater.start();
    updater.dispose();
    await flush();

    expect(fake.engine.setFeedURL).not.toHaveBeenCalled();
    expect(memory.store.read).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("should schedule nothing when it is disposed while the policy file is being read", async () => {
    const { updater, memory, getUpdatePolicy } = createHarness();
    let release: (value: null) => void = () => undefined;
    memory.store.read.mockReturnValueOnce(
      new Promise((done) => {
        release = done;
      })
    );

    void updater.start();
    await flush();
    expect(memory.store.read).toHaveBeenCalledTimes(1);
    updater.dispose();
    release(null);
    await flush();

    expect(getUpdatePolicy).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("should open the backend's download link for this platform, which counts the download", async () => {
    const { updater, openExternal } = createHarness();

    await updater.openDownloadPage();

    expect(openExternal).toHaveBeenCalledExactlyOnceWith(
      "https://api.handijit.com/api/public/downloads/on-muhasebe/windows?arch=x64"
    );
  });

  test("should open the page it was given, and only log when the page cannot be opened", async () => {
    const { updater, openExternal, log } = createHarness({
      downloadPageUrl: "https://handijit.com/programlar/on-muhasebe",
    });
    openExternal.mockRejectedValueOnce(new Error("no browser"));

    await expect(updater.openDownloadPage()).resolves.toBeUndefined();

    expect(openExternal).toHaveBeenCalledExactlyOnceWith(
      "https://handijit.com/programlar/on-muhasebe"
    );
    expect(
      log.contextOf("warn", "the download page could not be opened")
    ).toEqual({ causeCode: "", cause: "no browser" });
  });
});
