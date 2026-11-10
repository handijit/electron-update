import { createApiClient } from "@handijit/core";
import { describe, expect, test, vi } from "vitest";

import type { Harness, HarnessOptions } from "./updater.fixture";
import {
  apiError,
  createHarness,
  DAY_MS,
  engineError,
  feed,
  flush,
  HOUR_MS,
  MINUTE_MS,
  policyAnswer,
  START,
} from "./updater.fixture";

vi.mock("electron", () => ({ app: {}, shell: {} }));
vi.mock("../../lib/main/build-support", () => ({ default: vi.fn() }));
vi.mock("../../lib/main/policy-store", () => ({ default: vi.fn() }));

const REQUIRED = policyAnswer("1.5.0", "1.4.5");
const STORED_REQUIRED = {
  latestVersion: "1.5.0",
  minSupportedVersion: "1.4.5",
  fetchedAt: START - DAY_MS,
};

const started = async (options: HarnessOptions = {}): Promise<Harness> => {
  const harness = createHarness(options);
  await harness.start();
  return harness;
};

/** A click on "check" whose feed answer is "nothing newer". */
const checkNow = async ({ updater, fake }: Harness): Promise<void> => {
  const pending = updater.check();
  await flush();
  fake.offerNothing();
  await pending;
};

const deferred = <T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (cause: unknown) => void;
} => {
  let resolve: (value: T) => void = () => undefined;
  let reject: (cause: unknown) => void = () => undefined;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};

describe("createUpdater: the policy's verdict", () => {
  test("should lock nobody out because the backend could not be reached", async () => {
    const { updater, log, memory } = await started();

    expect(updater.getState().policy).toEqual({
      verdict: "ok",
      latestVersion: null,
      minSupportedVersion: null,
      checkedAt: null,
    });
    expect(
      log.contextOf("warn", "the update policy could not be fetched")
    ).toEqual({ causeCode: "", cause: "[object Object]" });
    expect(memory.store.write).not.toHaveBeenCalled();
  });

  test("should recommend when a newer version is published, and remember the answer", async () => {
    const { updater, fake, memory, getUpdatePolicy } = await started({
      policy: policyAnswer("1.5.0", "1.2.0"),
    });

    expect(updater.getState().policy).toEqual({
      verdict: "recommended",
      latestVersion: "1.5.0",
      minSupportedVersion: "1.2.0",
      checkedAt: START,
    });
    expect(memory.peek()).toEqual({
      latestVersion: "1.5.0",
      minSupportedVersion: "1.2.0",
      fetchedAt: START,
    });
    expect(getUpdatePolicy).toHaveBeenCalledExactlyOnceWith(
      { product: "on-muhasebe", os: "windows", arch: "x64", channel: "stable" },
      { signal: expect.any(AbortSignal) as AbortSignal }
    );
    // A recommendation waits for the schedule.
    expect(fake.engine.checkForUpdates).not.toHaveBeenCalled();
  });

  test("should say ok when the running version is the newest", async () => {
    const { updater } = await started({ policy: policyAnswer("1.4.0") });

    expect(updater.getState().policy).toMatchObject({
      verdict: "ok",
      latestVersion: "1.4.0",
      minSupportedVersion: null,
    });
  });

  test("should require the update below the minimum, and ask the feed at once what can be installed", async () => {
    const { updater, fake, log } = await started({ policy: REQUIRED });

    expect(updater.getState()).toMatchObject({
      status: "checking",
      policy: { verdict: "required", minSupportedVersion: "1.4.5" },
    });
    expect(fake.engine.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(log.contextOf("info", "the policy verdict changed")).toEqual({
      from: "ok",
      to: "required",
      latestVersion: "1.5.0",
      minSupportedVersion: "1.4.5",
    });
  });

  test("should offer a required update to everyone, whatever the staged rollout says", async () => {
    const harness = createHarness({ policy: REQUIRED });
    const original = harness.fake.engine.isUserWithinRollout;
    await harness.start();

    expect(await harness.fake.engine.isUserWithinRollout(feed("1.5.0"))).toBe(
      true
    );
    expect(original).not.toHaveBeenCalled();
  });

  test("should leave the staged rollout to the engine while the update is not required", async () => {
    const harness = createHarness({ policy: policyAnswer("1.5.0") });
    const original = harness.fake.engine.isUserWithinRollout;
    await harness.start();
    const info = feed("1.5.0", { stagingPercentage: 10 });

    expect(await harness.fake.engine.isUserWithinRollout(info)).toBe(false);
    expect(original).toHaveBeenCalledExactlyOnceWith(info);
    expect(original.mock.contexts[0]).toBe(harness.fake.engine);
  });

  test("should show the failure of the feed while an update is required, even if nobody clicked", async () => {
    const { updater, fake } = await started({ policy: REQUIRED });

    fake.failCheck(engineError("ENOTFOUND"));
    await flush();

    expect(updater.getState()).toMatchObject({
      status: "error",
      error: { code: "OFFLINE" },
    });

    // And it keeps trying on its own.
    await vi.advanceTimersByTimeAsync(MINUTE_MS);
    expect(fake.engine.checkForUpdates).toHaveBeenCalledTimes(2);
  });
});

describe("createUpdater: required, but the feed has nothing yet", () => {
  // Far away, so that only the retries read the feed.
  const QUIET = { policy: REQUIRED, startDelayMs: DAY_MS };

  test("should read the feed again after 1, 2, 5 and then every 15 minutes, until it has the update", async () => {
    const harness = await started(QUIET);
    const { updater, fake, getUpdatePolicy } = harness;
    const checks = (): number => fake.engine.checkForUpdates.mock.calls.length;
    fake.offerNothing();
    await flush();
    expect(updater.getState().status).toBe("not-available");

    for (const [minutes, expected] of [
      [1, 2],
      [2, 3],
      [5, 4],
      [15, 5],
      [15, 6],
    ] as const) {
      await vi.advanceTimersByTimeAsync(minutes * MINUTE_MS - 1);
      expect(checks()).toBe(expected - 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(checks()).toBe(expected);
      if (expected < 6) {
        fake.offerNothing();
        await flush();
      }
    }
    // The policy was asked with every retry, but sent only when ten minutes had passed.
    expect(getUpdatePolicy).toHaveBeenCalledTimes(3);

    fake.offer(feed("1.5.0"));
    await flush();
    expect(updater.getState().status).toBe("available");

    await vi.advanceTimersByTimeAsync(2 * HOUR_MS);
    expect(checks()).toBe(6);
  });

  test("should start the wait from one minute again after the update was seen once", async () => {
    const { updater, fake } = await started(QUIET);
    fake.offerNothing();
    await flush();
    await vi.advanceTimersByTimeAsync(MINUTE_MS);
    fake.offer(feed("1.5.0"));
    await flush();

    // The file disappears again (a release that was pulled back).
    const pending = updater.check();
    await flush();
    fake.offerNothing();
    await pending;
    await vi.advanceTimersByTimeAsync(MINUTE_MS);

    expect(fake.engine.checkForUpdates).toHaveBeenCalledTimes(4);
  });

  test("should not add a check to one that is already running when the wait is over", async () => {
    const { updater, fake } = await started(QUIET);
    fake.offerNothing();
    await flush();

    await vi.advanceTimersByTimeAsync(MINUTE_MS - 1000);
    const pending = updater.check();
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fake.engine.checkForUpdates).toHaveBeenCalledTimes(2);

    fake.offerNothing();
    await pending;
    // The next wait starts from that answer.
    await vi.advanceTimersByTimeAsync(2 * MINUTE_MS);
    expect(fake.engine.checkForUpdates).toHaveBeenCalledTimes(3);
  });

  test("should keep one wait when a click is answered while it runs", async () => {
    const harness = await started(QUIET);
    const { fake } = harness;
    fake.offerNothing();
    await flush();

    await vi.advanceTimersByTimeAsync(30_000);
    await checkNow(harness);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(fake.engine.checkForUpdates).toHaveBeenCalledTimes(3);
  });

  test("should stop waiting as soon as the backend no longer requires the update", async () => {
    const harness = await started(QUIET);
    const { updater, fake, getUpdatePolicy, log } = harness;
    fake.offerNothing();
    await flush();
    await vi.advanceTimersByTimeAsync(MINUTE_MS);
    fake.offerNothing();
    await flush();

    getUpdatePolicy.mockResolvedValue(policyAnswer("1.5.0"));
    await vi.advanceTimersByTimeAsync(30_000);
    await checkNow(harness);
    expect(updater.getState().policy.verdict).toBe("recommended");
    expect(log.scoped.info).toHaveBeenCalledWith(
      "the policy verdict changed",
      expect.objectContaining({ from: "required", to: "recommended" })
    );

    await vi.advanceTimersByTimeAsync(2 * HOUR_MS);
    expect(fake.engine.checkForUpdates).toHaveBeenCalledTimes(3);
  });
});

describe("createUpdater: the stored policy", () => {
  test("should hold a stored requirement while the backend cannot be reached", async () => {
    const { updater, fake, memory } = await started({
      stored: STORED_REQUIRED,
    });

    expect(updater.getState()).toMatchObject({
      status: "checking",
      policy: {
        verdict: "required",
        latestVersion: "1.5.0",
        minSupportedVersion: "1.4.5",
        checkedAt: START - DAY_MS,
      },
    });
    expect(fake.engine.checkForUpdates).toHaveBeenCalledTimes(1);
    // Nothing answered, so nothing is written: the old answer keeps its age.
    expect(memory.store.write).not.toHaveBeenCalled();
  });

  test("should weaken a requirement the backend did not confirm for seven days, while the program runs", async () => {
    const { updater, log } = await started({
      stored: { ...STORED_REQUIRED, fetchedAt: START - 6 * DAY_MS },
    });
    expect(updater.getState().policy.verdict).toBe("required");

    // The schedule fires at 10 s and then every six hours.
    await vi.advanceTimersByTimeAsync(18 * HOUR_MS + 10_000);
    expect(updater.getState().policy.verdict).toBe("required");
    await vi.advanceTimersByTimeAsync(6 * HOUR_MS);

    expect(updater.getState().policy).toMatchObject({
      verdict: "recommended",
      checkedAt: START - 6 * DAY_MS,
    });
    expect(log.scoped.info).toHaveBeenCalledWith(
      "the policy verdict changed",
      expect.objectContaining({ from: "required", to: "recommended" })
    );
  });

  test("should hold a requirement only as long as the program was told to", async () => {
    const { updater } = await started({
      stored: { ...STORED_REQUIRED, fetchedAt: START - 30 * MINUTE_MS },
      requiredCacheTtlMs: HOUR_MS,
      checkIntervalMs: 15 * MINUTE_MS,
    });
    expect(updater.getState().policy.verdict).toBe("required");

    await vi.advanceTimersByTimeAsync(15 * MINUTE_MS + 10_000);
    expect(updater.getState().policy.verdict).toBe("required");
    await vi.advanceTimersByTimeAsync(15 * MINUTE_MS);

    expect(updater.getState().policy.verdict).toBe("recommended");
  });

  test("should not hold a stored requirement at all when the program wants none held", async () => {
    const { updater } = await started({
      stored: STORED_REQUIRED,
      requiredCacheTtlMs: 0,
    });

    expect(updater.getState().policy.verdict).toBe("recommended");
  });

  test("should not let a clock that was set back keep the program locked", async () => {
    // Stored "in the future": the clock was moved back by more than the requirement lives.
    const { updater, fake } = await started({
      stored: { ...STORED_REQUIRED, fetchedAt: START + 8 * DAY_MS },
    });

    expect(updater.getState().policy.verdict).toBe("recommended");
    expect(fake.engine.checkForUpdates).not.toHaveBeenCalled();
  });

  test("should let any answer of the backend replace what was stored", async () => {
    const { updater, memory } = await started({
      stored: STORED_REQUIRED,
      policy: policyAnswer("1.5.0"),
    });

    expect(updater.getState().policy).toEqual({
      verdict: "recommended",
      latestVersion: "1.5.0",
      minSupportedVersion: null,
      checkedAt: START,
    });
    expect(memory.peek()).toEqual({
      latestVersion: "1.5.0",
      minSupportedVersion: null,
      fetchedAt: START,
    });
  });

  test("should forget the stored policy when the backend has no release for this platform", async () => {
    const harness = createHarness({ stored: STORED_REQUIRED });
    harness.getUpdatePolicy.mockRejectedValue(
      apiError({ status: 404, code: "RELEASE_NOT_FOUND" })
    );
    await harness.start();

    expect(harness.updater.getState().policy).toEqual({
      verdict: "ok",
      latestVersion: null,
      minSupportedVersion: null,
      checkedAt: START,
    });
    expect(harness.memory.store.write).toHaveBeenCalledExactlyOnceWith(null);
  });

  test("should ignore a policy file that holds something else", async () => {
    const harness = createHarness();
    harness.memory.corrupt({ latestVersion: "newest", fetchedAt: "today" });
    await harness.start();

    expect(harness.updater.getState().policy.verdict).toBe("ok");
  });

  test("should start without the policy file when it cannot be read", async () => {
    const harness = createHarness({ policy: policyAnswer("1.5.0") });
    harness.memory.store.read.mockRejectedValueOnce(
      Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })
    );
    await harness.start();

    expect(
      harness.log.contextOf(
        "warn",
        "the stored update policy could not be read"
      )
    ).toEqual({ causeCode: "EACCES", cause: "EACCES: permission denied" });
    expect(harness.updater.getState().policy.verdict).toBe("recommended");
  });

  test("should apply an answer even when it cannot be written down", async () => {
    const harness = createHarness({ policy: REQUIRED });
    harness.memory.store.write.mockRejectedValueOnce(new Error("disk full"));
    await harness.start();

    expect(harness.updater.getState().policy.verdict).toBe("required");
    expect(
      harness.log.contextOf("warn", "the update policy could not be stored")
    ).toEqual({ causeCode: "", cause: "disk full" });
  });

  test("should ignore an answer whose versions are not versions", async () => {
    const { updater, memory, log } = await started({
      stored: STORED_REQUIRED,
      policy: policyAnswer("newest", "1.4.5"),
    });

    expect(updater.getState().policy).toMatchObject({
      verdict: "required",
      checkedAt: START - DAY_MS,
    });
    expect(memory.store.write).not.toHaveBeenCalled();
    expect(log.messages("warn")).toContain(
      "the policy holds a version that is not a version; ignored"
    );
  });
});

describe("createUpdater: how often the backend is asked", () => {
  test("should ask at most once a minute however often 'check' is clicked", async () => {
    const harness = await started({ policy: policyAnswer("1.4.0") });
    const { getUpdatePolicy } = harness;
    expect(getUpdatePolicy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5000);
    await checkNow(harness);
    await vi.advanceTimersByTimeAsync(54_999);
    await checkNow(harness);
    expect(getUpdatePolicy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await checkNow(harness);
    expect(getUpdatePolicy).toHaveBeenCalledTimes(2);
  });

  test("should ask on the schedule at most once in ten minutes", async () => {
    const { getUpdatePolicy } = await started({
      policy: policyAnswer("1.4.0"),
      checkIntervalMs: 15 * MINUTE_MS,
    });

    // The first tick comes ten seconds after the start's own request.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(getUpdatePolicy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(15 * MINUTE_MS);
    expect(getUpdatePolicy).toHaveBeenCalledTimes(2);
  });

  test("should share one request between the start and a click", async () => {
    const harness = createHarness();
    const answer = deferred<ReturnType<typeof policyAnswer>>();
    harness.getUpdatePolicy.mockReturnValue(answer.promise);
    await harness.start();

    const pending = harness.updater.check();
    await flush();
    harness.fake.offerNothing();
    await pending;
    expect(harness.getUpdatePolicy).toHaveBeenCalledTimes(1);

    answer.resolve(policyAnswer("1.5.0"));
    await flush();
    expect(harness.updater.getState().policy.verdict).toBe("recommended");
  });

  test("should wait as long as the backend says after a 429", async () => {
    const harness = createHarness();
    harness.getUpdatePolicy.mockRejectedValueOnce(
      apiError({
        status: 429,
        code: "TOO_MANY_REQUESTS",
        retryAfterSeconds: 1800,
      })
    );
    harness.getUpdatePolicy.mockResolvedValue(policyAnswer("1.5.0"));
    await harness.start();

    await vi.advanceTimersByTimeAsync(30 * MINUTE_MS - 1);
    await checkNow(harness);
    expect(harness.getUpdatePolicy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await checkNow(harness);
    expect(harness.getUpdatePolicy).toHaveBeenCalledTimes(2);

    // The answer lifted the pause: a minute later a click asks again.
    await vi.advanceTimersByTimeAsync(MINUTE_MS);
    await checkNow(harness);
    expect(harness.getUpdatePolicy).toHaveBeenCalledTimes(3);
  });

  test("should wait ten minutes after a 429 that names no time", async () => {
    const harness = createHarness();
    harness.getUpdatePolicy.mockRejectedValueOnce(apiError({ status: 429 }));
    await harness.start();

    await vi.advanceTimersByTimeAsync(10 * MINUTE_MS - 1);
    await checkNow(harness);
    expect(harness.getUpdatePolicy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await checkNow(harness);
    expect(harness.getUpdatePolicy).toHaveBeenCalledTimes(2);
  });

  test("should not go silent because the clock was set back", async () => {
    const harness = await started({ policy: policyAnswer("1.4.0") });

    vi.setSystemTime(START - 3 * HOUR_MS);
    await checkNow(harness);

    expect(harness.getUpdatePolicy).toHaveBeenCalledTimes(2);
  });

  test("should cancel the request and drop its answer when the program quits", async () => {
    const harness = createHarness();
    const answer = deferred<ReturnType<typeof policyAnswer>>();
    harness.getUpdatePolicy.mockReturnValue(answer.promise);
    await harness.start();

    harness.updater.dispose();
    expect(harness.getUpdatePolicy.mock.calls[0]?.[1]?.signal?.aborted).toBe(
      true
    );
    answer.resolve(REQUIRED);
    await flush();

    expect(harness.updater.getState().policy.verdict).toBe("ok");
    expect(harness.memory.store.write).not.toHaveBeenCalled();
  });

  test("should say nothing about a request that fails because the program quit", async () => {
    const harness = createHarness();
    const answer = deferred<ReturnType<typeof policyAnswer>>();
    harness.getUpdatePolicy.mockReturnValue(answer.promise);
    await harness.start();

    harness.updater.dispose();
    answer.reject(apiError({ kind: "aborted" }));
    await flush();

    expect(harness.log.messages("warn")).toEqual([]);
  });
});

describe("createUpdater: with the client of @handijit/core", () => {
  const json = (
    status: number,
    body: unknown,
    headers: Readonly<Record<string, string>> = {}
  ): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: {
        "content-type":
          status < 400 ? "application/json" : "application/problem+json",
        ...headers,
      },
    });

  const withBackend = (
    answer: () => Response,
    options: HarnessOptions = {}
  ): Harness & { fetch: ReturnType<typeof vi.fn> } => {
    const fetch = vi.fn((url: string, init: RequestInit) => {
      void url;
      void init;
      return Promise.resolve(answer());
    });
    const api = createApiClient({ fetch, retries: 0 });
    return { ...createHarness({ api, ...options }), fetch };
  };

  test("should ask the public policy endpoint for this product and platform, and obey its answer", async () => {
    const harness = withBackend(() => json(200, REQUIRED));
    await harness.start();

    await vi.waitFor(() => {
      expect(harness.updater.getState().policy.verdict).toBe("required");
    });
    expect(harness.fetch.mock.calls[0]?.[0]).toBe(
      "https://api.handijit.com/api/public/products/on-muhasebe/update-policy?os=windows&arch=x64&channel=stable"
    );
  });

  test("should read the backend's 404 for a product without a release as 'nothing is required'", async () => {
    const harness = withBackend(
      () =>
        json(404, {
          type: "about:blank",
          title: "Not Found",
          status: 404,
          code: "RELEASE_NOT_FOUND",
          detail: "No release.",
        }),
      { stored: STORED_REQUIRED }
    );
    await harness.start();

    await vi.waitFor(() => {
      expect(harness.updater.getState().policy.verdict).toBe("ok");
    });
    expect(harness.memory.peek()).toBeNull();
  });

  test("should honour the Retry-After of the backend's 429", async () => {
    const harness = withBackend(() =>
      json(
        429,
        {
          type: "about:blank",
          title: "Too Many Requests",
          status: 429,
          code: "TOO_MANY_REQUESTS",
        },
        { "retry-after": "120" }
      )
    );
    await harness.start();
    await vi.waitFor(() => {
      expect(harness.log.messages("warn")).toContain(
        "the update policy could not be fetched"
      );
    });

    await vi.advanceTimersByTimeAsync(119_000);
    await checkNow(harness);
    expect(harness.fetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2000);
    await checkNow(harness);
    expect(harness.fetch).toHaveBeenCalledTimes(2);
  });
});
