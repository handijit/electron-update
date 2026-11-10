import { homedir } from "node:os";

import { describe, expect, test, vi } from "vitest";

import type { Harness, HarnessOptions } from "./updater.fixture";
import {
  createHarness,
  engineError,
  feed,
  flush,
  HOUR_MS,
  policyAnswer,
  START,
} from "./updater.fixture";

vi.mock("electron", () => ({ app: {}, shell: {} }));
vi.mock("../../lib/main/build-support", () => ({ default: vi.fn() }));
vi.mock("../../lib/main/policy-store", () => ({ default: vi.fn() }));

const UPDATE = {
  version: "1.5.0",
  releaseDate: "2026-11-09T10:00:00.000Z",
  releaseNotes: null,
  sizeBytes: 84_200_000,
};

const started = async (options: HarnessOptions = {}): Promise<Harness> => {
  const harness = createHarness(options);
  await harness.start();
  return harness;
};

/** A started updater that already knows about 1.5.0. */
const withUpdate = async (options: HarnessOptions = {}): Promise<Harness> => {
  const harness = await started(options);
  const pending = harness.updater.check();
  await flush();
  harness.fake.offer(feed("1.5.0"));
  await pending;
  return harness;
};

/** A started updater whose download of 1.5.0 is running. */
const whileDownloading = async (
  options: HarnessOptions = {}
): Promise<Harness> => {
  const harness = await withUpdate(options);
  await harness.updater.download();
  await flush();
  return harness;
};

/** A started updater that has 1.5.0 on disk. */
const withDownload = async (options: HarnessOptions = {}): Promise<Harness> => {
  const harness = await whileDownloading(options);
  harness.fake.finishDownload(feed("1.5.0"));
  await flush();
  return harness;
};

describe("createUpdater: checking", () => {
  test("should go through checking to not-available when the feed has nothing newer", async () => {
    const { updater, fake, statuses } = await started();
    fake.engine.allowDowngrade = true;

    const pending = updater.check();
    await flush();
    expect(updater.getState().status).toBe("checking");
    // Asserted again before every check: the engine flips it by itself in some settings.
    expect(fake.engine.allowDowngrade).toBe(false);
    vi.setSystemTime(START + 1500);
    fake.offerNothing(feed("1.4.0"));
    const state = await pending;

    expect(state).toMatchObject({
      status: "not-available",
      checkedAt: START + 1500,
    });
    expect(statuses()).toEqual(["checking", "not-available"]);
  });

  test("should describe the update the feed offers", async () => {
    const { updater, fake, log } = await started();

    const pending = updater.check();
    await flush();
    fake.offer(feed("1.5.0", { releaseNotes: "<p>E-fatura eklendi.</p>" }));
    const state = await pending;

    expect(state).toMatchObject({
      status: "available",
      update: { ...UPDATE, releaseNotes: "E-fatura eklendi." },
      checkedAt: START,
    });
    expect(fake.engine.downloadUpdate).not.toHaveBeenCalled();
    expect(log.scoped.info).toHaveBeenCalledWith("status changed", {
      from: "checking",
      to: "available",
      version: "1.5.0",
    });
  });

  test("should run one check for any number of impatient clicks", async () => {
    const { updater, fake, states } = await started();

    const clicks = [updater.check(), updater.check(), updater.check()];
    await flush();
    fake.offerNothing();
    const answers = await Promise.all(clicks);

    expect(fake.engine.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(new Set(answers).size).toBe(1);
    expect(states.map((state) => state.status)).toEqual([
      "checking",
      "not-available",
    ]);
  });

  test("should keep a failure of the schedule to itself and put back what was shown", async () => {
    const { updater, fake, log, statuses } = await started();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(updater.getState().status).toBe("checking");

    fake.failCheck(engineError("ENOTFOUND", "getaddrinfo ENOTFOUND"));
    await flush();

    expect(updater.getState().status).toBe("idle");
    expect(statuses()).toEqual(["checking", "idle"]);
    expect(log.contextOf("warn", "the update check failed")).toEqual({
      code: "OFFLINE",
      shown: false,
      causeCode: "ENOTFOUND",
      cause: "getaddrinfo ENOTFOUND",
    });
  });

  test("should keep the known update on screen when a later check of the schedule fails", async () => {
    const { updater, fake } = await withUpdate();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(updater.getState().status).toBe("checking");
    fake.failCheck(engineError("HTTP_ERROR_502"));
    await flush();

    expect(updater.getState()).toMatchObject({
      status: "available",
      update: UPDATE,
    });
  });

  test("should show the failure of a check somebody asked for", async () => {
    const { updater, fake, states } = await started();

    const pending = updater.check();
    await flush();
    fake.failCheck(engineError("ERR_INTERNET_DISCONNECTED"));
    const state = await pending;

    expect(state).toMatchObject({
      status: "error",
      error: {
        code: "OFFLINE",
        message: expect.stringContaining("İnternet") as string,
      },
      update: null,
    });
    // The event and the rejection are one failure.
    expect(states.filter(({ status }) => status === "error")).toHaveLength(1);
  });

  test("should show the failure of a scheduled check that a click joined", async () => {
    const { updater, fake } = await started();
    await vi.advanceTimersByTimeAsync(10_000);

    const pending = updater.check();
    await flush();
    fake.failCheck(engineError("HTTP_ERROR_500"));

    expect(await pending).toMatchObject({
      status: "error",
      error: { code: "SERVER" },
    });
    expect(fake.engine.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  test("should handle a check that only rejects, without the event", async () => {
    const { updater, fake } = await started();

    const pending = updater.check();
    await flush();
    fake.checks[0]?.reject(engineError("ERR_UPDATER_INVALID_UPDATE_INFO"));

    expect(await pending).toMatchObject({
      status: "error",
      error: { code: "INVALID_FEED" },
    });
  });

  test("should never write the home folder of a customer to the log", async () => {
    const { updater, fake, log } = await started();

    const pending = updater.check();
    await flush();
    fake.failCheck(
      new Error(`ENOENT: no such file, open '${homedir()}/AppData/x.yml'`)
    );
    await pending;

    expect(log.contextOf("warn", "the update check failed")).toMatchObject({
      cause: "ENOENT: no such file, open '~/AppData/x.yml'",
    });
  });

  test("should read a feed that has no file for this platform yet as no update, not as an error", async () => {
    const { updater, fake, log } = await started();

    const pending = updater.check();
    await flush();
    fake.failCheck(engineError("ERR_UPDATER_CHANNEL_FILE_NOT_FOUND"));

    expect((await pending).status).toBe("not-available");
    expect(log.messages("warn")).toContain(
      "the feed has no file for this channel and platform"
    );
  });

  test.each([["1.4.0"], ["1.3.9"], ["1.4.0-beta.2"]])(
    "should refuse to go back to %s, whatever the engine thinks",
    async (version) => {
      const { updater, fake, log } = await started();

      const pending = updater.check();
      await flush();
      fake.offer(feed(version));

      expect((await pending).status).toBe("not-available");
      expect(
        log.contextOf(
          "warn",
          "the feed offers a version that is not newer; ignored"
        )
      ).toEqual({ offered: version });
      expect(fake.engine.downloadUpdate).not.toHaveBeenCalled();
    }
  );

  test("should report a feed whose version is not a version as a broken feed", async () => {
    const { updater, fake } = await started();

    const pending = updater.check();
    await flush();
    fake.offer(feed("latest"));

    expect(await pending).toMatchObject({
      status: "error",
      error: { code: "INVALID_FEED" },
    });
  });

  test("should conclude that there is nothing when the engine resolves without saying anything", async () => {
    const { updater, fake } = await started();

    const pending = updater.check();
    await flush();
    fake.checks[0]?.resolve({ updateInfo: feed("1.4.0") });

    expect((await pending).status).toBe("not-available");
  });

  test("should check again from an error and from an available update", async () => {
    const { updater, fake } = await started();
    let pending = updater.check();
    await flush();
    fake.failCheck(engineError("ENOTFOUND"));
    await pending;

    pending = updater.check();
    await flush();
    fake.offer(feed("1.5.0"));
    await pending;

    pending = updater.check();
    await flush();
    fake.offer(feed("1.6.0"));

    expect(await pending).toMatchObject({
      status: "available",
      update: { version: "1.6.0" },
    });
    expect(fake.engine.checkForUpdates).toHaveBeenCalledTimes(3);
  });

  test("should not check while a download runs or waits to be installed", async () => {
    const { updater, fake } = await whileDownloading();

    expect((await updater.check()).status).toBe("downloading");
    await vi.advanceTimersByTimeAsync(7 * HOUR_MS);
    fake.finishDownload(feed("1.5.0"));
    await flush();
    expect((await updater.check()).status).toBe("downloaded");
    await vi.advanceTimersByTimeAsync(7 * HOUR_MS);

    // The engine keeps one update at a time: a check would replace the one being downloaded.
    expect(fake.engine.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  test("should take the feed's word even when nobody asked this updater to check", async () => {
    const { updater, fake } = await started();

    fake.emit("update-available", feed("1.5.0"));
    expect(updater.getState().status).toBe("available");

    fake.emit("update-not-available", feed("1.4.0"));
    expect(updater.getState().status).toBe("not-available");
  });

  test("should ignore a failure of the engine that belongs to nothing", async () => {
    const { updater, fake, log, states } = await started();

    fake.emit("error", engineError("EPERM", "stray"));

    expect(updater.getState().status).toBe("idle");
    expect(states).toHaveLength(0);
    expect(
      log.contextOf(
        "warn",
        "the engine failed outside a check or a download; ignored"
      )
    ).toEqual({ code: "DISK", causeCode: "EPERM", cause: "stray" });
  });
});

describe("createUpdater: downloading", () => {
  test("should not download on its own: a small business may be on a metered line", async () => {
    const { fake } = await withUpdate();
    await vi.advanceTimersByTimeAsync(7 * HOUR_MS);

    expect(fake.engine.downloadUpdate).not.toHaveBeenCalled();
  });

  test("should download when asked, report the progress and end up downloaded", async () => {
    const { updater, fake, statuses } = await withUpdate();

    const state = await updater.download();
    expect(state).toMatchObject({
      status: "downloading",
      update: UPDATE,
      progress: {
        percent: 0,
        transferredBytes: 0,
        totalBytes: 0,
        bytesPerSecond: 0,
      },
    });
    await flush();
    fake.progress(50);
    expect(updater.getState()).toMatchObject({
      status: "downloading",
      progress: {
        percent: 50,
        transferredBytes: 42_100_000,
        totalBytes: 84_200_000,
        bytesPerSecond: 1_200_000,
      },
    });
    fake.finishDownload(feed("1.5.0"));
    await flush();

    expect(updater.getState()).toMatchObject({
      status: "downloaded",
      update: UPDATE,
      isInstallPending: false,
    });
    expect(statuses()).toEqual([
      "checking",
      "available",
      "downloading",
      "downloaded",
    ]);
    expect(fake.engine.quitAndInstall).not.toHaveBeenCalled();
  });

  test("should start one download for a double click", async () => {
    const { updater, fake } = await withUpdate();

    await Promise.all([updater.download(), updater.download()]);
    await flush();
    await updater.download();
    await flush();

    expect(fake.engine.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  test("should have nothing to download before the feed offered something", async () => {
    const { updater, fake } = await started();

    expect((await updater.download()).status).toBe("idle");
    await flush();

    expect(fake.engine.downloadUpdate).not.toHaveBeenCalled();
    expect(fake.engine.checkForUpdates).not.toHaveBeenCalled();
  });

  test("should download as soon as an update is found when the program chose so", async () => {
    const { updater, fake } = await started({ autoDownload: true });

    await vi.advanceTimersByTimeAsync(10_000);
    fake.offer(feed("1.5.0"));
    await flush();

    expect(updater.getState().status).toBe("downloading");
    expect(fake.engine.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  test("should keep the update with a failed download, so that retrying is one click", async () => {
    const { updater, fake, log, states } = await whileDownloading();
    fake.progress(40);

    fake.failDownload(engineError("ECONNRESET", "socket hang up"));
    await flush();

    expect(updater.getState()).toMatchObject({
      status: "error",
      error: { code: "OFFLINE" },
      update: UPDATE,
    });
    expect(states.filter(({ status }) => status === "error")).toHaveLength(1);
    expect(log.contextOf("error", "the update download failed")).toEqual({
      code: "OFFLINE",
      causeCode: "ECONNRESET",
      cause: "socket hang up",
    });
  });

  test("should read the feed again before retrying a failed download, and download what it offers now", async () => {
    const { updater, fake } = await whileDownloading();
    fake.failDownload(engineError("ERR_CHECKSUM_MISMATCH"));
    await flush();
    expect(updater.getState()).toMatchObject({ error: { code: "CHECKSUM" } });

    expect((await updater.download()).status).toBe("checking");
    await flush();
    // In the meantime 1.5.1 replaced the files of 1.5.0 on the server.
    fake.offer(feed("1.5.1"));
    await flush();

    expect(updater.getState()).toMatchObject({
      status: "downloading",
      update: { version: "1.5.1" },
    });
    expect(fake.engine.downloadUpdate).toHaveBeenCalledTimes(2);
  });

  test("should forget the retry when the feed has nothing any more", async () => {
    const { updater, fake } = await whileDownloading();
    fake.failDownload(engineError("ENOTFOUND"));
    await flush();

    await updater.download();
    await flush();
    fake.offerNothing();
    await flush();
    expect(updater.getState().status).toBe("not-available");

    // The wish to download died with that answer: a later check only reports.
    const pending = updater.check();
    await flush();
    fake.offer(feed("1.5.0"));
    await pending;
    expect(updater.getState().status).toBe("available");
    expect(fake.engine.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  test("should show why a retry could not even read the feed", async () => {
    const { updater, fake } = await whileDownloading();
    fake.failDownload(engineError("ENOTFOUND"));
    await flush();

    await updater.download();
    await flush();
    fake.failCheck(engineError("ENOTFOUND"));
    await flush();

    expect(updater.getState()).toMatchObject({
      status: "error",
      error: { code: "OFFLINE" },
      update: null,
    });
  });

  test("should handle a download that only rejects, without the event", async () => {
    const { updater, fake } = await whileDownloading();

    fake.downloads[0]?.reject(engineError("ENOSPC"));
    await flush();

    expect(updater.getState()).toMatchObject({
      status: "error",
      error: { code: "DISK" },
      update: UPDATE,
    });
  });

  test("should count a download that resolves without the event as downloaded", async () => {
    const { updater, fake } = await whileDownloading();

    fake.downloads[0]?.resolve(["/cache/update.exe"]);
    await flush();

    expect(updater.getState()).toMatchObject({
      status: "downloaded",
      update: UPDATE,
    });
  });

  test("should fall back to available when the engine cancels the download", async () => {
    const { updater, fake } = await whileDownloading();

    fake.emit("update-cancelled", feed("1.5.0"));
    fake.downloads[0]?.reject(new Error("cancelled"));
    await flush();

    expect(updater.getState()).toMatchObject({
      status: "available",
      update: UPDATE,
    });

    await updater.download();
    await flush();
    expect(fake.engine.downloadUpdate).toHaveBeenCalledTimes(2);
  });

  test("should follow a download that was started on the engine directly", async () => {
    const { updater, fake } = await withUpdate();

    fake.progress(25);
    expect(updater.getState()).toMatchObject({
      status: "downloading",
      progress: { percent: 25 },
    });
    fake.emit("update-downloaded", feed("1.5.0"));

    expect(updater.getState().status).toBe("downloaded");
  });

  test("should become a build that cannot update itself when macOS refuses its signature after the download", async () => {
    const { updater, fake, log } = await whileDownloading({
      platform: "darwin",
      arch: "arm64",
    });
    // Squirrel.Mac checks the running app once the file is there: the event comes first.
    fake.emit("update-downloaded", feed("1.5.0"));
    expect(updater.getState().status).toBe("downloaded");

    const refusal = new Error(
      "Could not get code signature for running application"
    );
    fake.failDownload(refusal);
    await flush();

    expect(updater.getState()).toMatchObject({
      status: "unsupported",
      reason: "unsigned",
    });
    expect(
      log.contextOf("warn", "this build is not signed for updates")
    ).toEqual({ causeCode: "", cause: refusal.message });
  });

  test("should report a refused signature as an error on Windows, where the file is at fault", async () => {
    const { updater, fake } = await whileDownloading();

    fake.failDownload(engineError("ERR_UPDATER_INVALID_SIGNATURE"));
    await flush();

    expect(updater.getState()).toMatchObject({
      status: "error",
      error: { code: "SIGNATURE" },
    });
  });

  test("should not let the feed interrupt a download with news about the same or another version", async () => {
    const { updater, fake } = await whileDownloading({ autoDownload: true });
    fake.progress(30);

    fake.emit("update-available", feed("1.6.0"));
    fake.emit("update-not-available", feed("1.4.0"));

    expect(updater.getState()).toMatchObject({
      status: "downloading",
      update: UPDATE,
      progress: { percent: 30 },
    });
    expect(fake.engine.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  test("should ignore everything a download says after the program started to quit", async () => {
    const { updater, fake, states } = await whileDownloading();
    fake.progress(60);
    const published = states.length;

    updater.dispose();
    fake.downloads[0]?.resolve(["/cache/update.exe"]);
    await flush();

    expect(updater.getState()).toMatchObject({
      status: "downloading",
      progress: { percent: 60 },
    });
    expect(states).toHaveLength(published);
    expect(fake.listenerCount("update-downloaded")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("should ignore a download that fails after the program started to quit", async () => {
    const { updater, fake, log } = await whileDownloading();

    updater.dispose();
    fake.downloads[0]?.reject(engineError("ECONNRESET"));
    await flush();

    expect(updater.getState().status).toBe("downloading");
    expect(log.messages("error")).toEqual([]);
  });
});

describe("createUpdater: installing", () => {
  test("should restart into the update when asked, and only once for a double click", async () => {
    const { updater, fake, log } = await withDownload();

    const [state] = await Promise.all([updater.install(), updater.install()]);

    expect(state).toMatchObject({
      status: "downloaded",
      isInstallPending: true,
    });
    // Not silent: the customer sees the installer. Run after: the program comes back.
    expect(fake.engine.quitAndInstall).toHaveBeenCalledExactlyOnceWith(
      false,
      true
    );
    expect(log.messages("info")).toContain("restarting to install the update");
  });

  test("should run the Windows installer without its window when the program chose so", async () => {
    const { updater, fake } = await withDownload({ isSilentInstall: true });

    await updater.install();

    expect(fake.engine.quitAndInstall).toHaveBeenCalledExactlyOnceWith(
      true,
      true
    );
  });

  test("should offer the button again when the program is still there half a minute later", async () => {
    const { updater, fake, log } = await withDownload();
    await updater.install();

    await vi.advanceTimersByTimeAsync(29_999);
    expect(updater.getState().isInstallPending).toBe(true);
    await vi.advanceTimersByTimeAsync(1);

    expect(updater.getState()).toMatchObject({
      status: "downloaded",
      isInstallPending: false,
    });
    expect(log.messages("warn")).toContain(
      "the program is still running after the install was started"
    );

    await updater.install();
    expect(fake.engine.quitAndInstall).toHaveBeenCalledTimes(2);
  });

  test("should show an install that could not even start", async () => {
    const { updater, fake, log } = await withDownload();
    fake.engine.quitAndInstall.mockImplementationOnce(() => {
      throw new Error("spawn EBUSY");
    });

    const state = await updater.install();

    expect(state).toMatchObject({
      status: "error",
      error: { code: "INSTALL" },
      update: UPDATE,
      isInstallPending: false,
    });
    expect(log.messages("error")).toContain(
      "the update could not be installed"
    );
    // The half-minute guard went with the failure.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(log.messages("warn")).not.toContain(
      "the program is still running after the install was started"
    );
  });

  test("should name the reason when the install fails with a known one", async () => {
    const { updater, fake } = await withDownload({ platform: "darwin" });

    fake.emit(
      "error",
      new Error("Cannot update while running on a read-only volume")
    );

    expect(updater.getState()).toMatchObject({
      status: "error",
      error: { code: "NOT_IN_APPLICATIONS" },
      update: { version: "1.5.0" },
    });
  });

  test("should never restart a program that is in use when nobody asked", async () => {
    const { updater, fake } = await withDownload({ autoDownload: true });

    await vi.advanceTimersByTimeAsync(48 * HOUR_MS);

    expect(updater.getState().status).toBe("downloaded");
    expect(fake.engine.quitAndInstall).not.toHaveBeenCalled();
  });

  test.each([[undefined], [policyAnswer("1.5.0")]])(
    "should not arm a restart from 'available' while the update is not required",
    async (policy) => {
      const { updater, fake } = await withUpdate(
        policy === undefined ? {} : { policy }
      );

      const state = await updater.install();
      await flush();

      expect(state).toMatchObject({
        status: "available",
        isInstallPending: false,
      });
      expect(fake.engine.downloadUpdate).not.toHaveBeenCalled();
    }
  );
});

describe("createUpdater: installing a required update", () => {
  const REQUIRED = { policy: policyAnswer("1.5.0", "1.4.5") };

  /** Required, and the feed already answered the check the verdict triggered. */
  const requiredWith = async (
    answer: "update" | "nothing"
  ): Promise<Harness> => {
    const harness = await started(REQUIRED);
    expect(harness.updater.getState().status).toBe("checking");
    if (answer === "update") harness.fake.offer(feed("1.5.0"));
    else harness.fake.offerNothing();
    await flush();
    return harness;
  };

  test("should download and then restart on its own after one click on 'update now'", async () => {
    const { updater, fake, statuses } = await requiredWith("update");
    expect(fake.engine.downloadUpdate).not.toHaveBeenCalled();

    const state = await updater.install();
    expect(state).toMatchObject({
      status: "downloading",
      isInstallPending: true,
    });
    await flush();
    fake.progress(100);
    expect(fake.engine.quitAndInstall).not.toHaveBeenCalled();
    fake.finishDownload(feed("1.5.0"));
    await flush();

    expect(fake.engine.quitAndInstall).toHaveBeenCalledExactlyOnceWith(
      false,
      true
    );
    expect(updater.getState()).toMatchObject({
      status: "downloaded",
      isInstallPending: true,
    });
    expect(statuses()).toEqual([
      "checking",
      "available",
      "downloading",
      "downloaded",
    ]);
  });

  test("should read the feed first when nothing installable is known yet", async () => {
    const { updater, fake } = await requiredWith("nothing");

    const state = await updater.install();
    expect(state).toMatchObject({ status: "checking", isInstallPending: true });
    await flush();
    fake.offer(feed("1.5.0"));
    await flush();
    expect(updater.getState().status).toBe("downloading");
    fake.finishDownload(feed("1.5.0"));
    await flush();

    expect(fake.engine.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  test("should arm the restart for a download that is already running", async () => {
    const { updater, fake } = await requiredWith("update");
    await updater.download();
    await flush();

    const state = await updater.install();
    expect(state).toMatchObject({
      status: "downloading",
      isInstallPending: true,
    });
    fake.finishDownload(feed("1.5.0"));
    await flush();

    expect(fake.engine.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(fake.engine.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  test("should arm the restart for a check that is already running", async () => {
    const { updater, fake } = await started(REQUIRED);

    const state = await updater.install();
    expect(state).toMatchObject({ status: "checking", isInstallPending: true });
    fake.offer(feed("1.5.0"));
    await flush();

    expect(fake.engine.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(updater.getState().status).toBe("downloading");
  });

  test("should drop the wish when the feed still has nothing, and say so", async () => {
    const { updater, fake } = await requiredWith("nothing");

    await updater.install();
    await flush();
    fake.offerNothing();
    await flush();

    expect(updater.getState()).toMatchObject({
      status: "not-available",
      isInstallPending: false,
    });
  });

  test("should show the failure when the feed cannot be read, and not stay armed", async () => {
    const { updater, fake } = await requiredWith("nothing");

    await updater.install();
    await flush();
    fake.failCheck(engineError("ENOTFOUND"));
    await flush();

    expect(updater.getState()).toMatchObject({
      status: "error",
      error: { code: "OFFLINE" },
      isInstallPending: false,
    });
  });

  test("should not stay armed after a failed download", async () => {
    const { updater, fake } = await requiredWith("update");
    await updater.install();
    await flush();

    fake.failDownload(engineError("ECONNRESET"));
    await flush();

    expect(updater.getState()).toMatchObject({
      status: "error",
      update: UPDATE,
      isInstallPending: false,
    });

    // "Retry" on the gate asks for the install again: check, download, restart.
    await updater.install();
    await flush();
    fake.offer(feed("1.5.0"));
    await flush();
    fake.finishDownload(feed("1.5.0"));
    await flush();
    expect(fake.engine.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  test("should not stay armed after a cancelled download", async () => {
    const { updater, fake } = await requiredWith("update");
    await updater.install();
    await flush();

    fake.emit("update-cancelled", feed("1.5.0"));

    expect(updater.getState()).toMatchObject({
      status: "available",
      isInstallPending: false,
    });
  });

  test("should not restart any more once the backend stops requiring the update", async () => {
    const { updater, fake, getUpdatePolicy } = await requiredWith("update");
    await updater.install();
    await flush();
    expect(updater.getState().isInstallPending).toBe(true);

    // The minimum was set by mistake and taken back while the download ran.
    getUpdatePolicy.mockResolvedValue(policyAnswer("1.5.0"));
    await vi.advanceTimersByTimeAsync(7 * HOUR_MS);
    expect(updater.getState()).toMatchObject({
      status: "downloading",
      policy: { verdict: "recommended" },
      isInstallPending: false,
    });
    fake.finishDownload(feed("1.5.0"));
    await flush();

    expect(updater.getState().status).toBe("downloaded");
    expect(fake.engine.quitAndInstall).not.toHaveBeenCalled();
  });
});
