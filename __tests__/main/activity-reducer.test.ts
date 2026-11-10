import { describe, expect, test } from "vitest";

import reduceActivity, {
  NO_PROGRESS,
  updateOf,
} from "../../lib/main/activity-reducer";
import type { ActivityEvent } from "../../lib/main/activity-reducer";
import type { UpdateActivity, UpdateInfo } from "../../lib/types";

const UPDATE: UpdateInfo = {
  version: "1.5.0",
  releaseDate: null,
  releaseNotes: null,
  sizeBytes: null,
};
const NEWER: UpdateInfo = { ...UPDATE, version: "1.6.0" };
const PROGRESS = {
  percent: 40,
  transferredBytes: 400,
  totalBytes: 1000,
  bytesPerSecond: 100,
};
const ERROR = { code: "OFFLINE", message: "Bağlantı yok." } as const;

const IDLE: UpdateActivity = { status: "idle" };
const CHECKING: UpdateActivity = { status: "checking" };
const NOT_AVAILABLE: UpdateActivity = { status: "not-available" };
const AVAILABLE: UpdateActivity = { status: "available", update: UPDATE };
const DOWNLOADING: UpdateActivity = {
  status: "downloading",
  update: UPDATE,
  progress: PROGRESS,
};
const DOWNLOADED: UpdateActivity = { status: "downloaded", update: UPDATE };
const FAILED: UpdateActivity = { status: "error", error: ERROR, update: null };
const UNSUPPORTED: UpdateActivity = {
  status: "unsupported",
  reason: "development",
};

const EVERY_STATUS = [
  IDLE,
  CHECKING,
  NOT_AVAILABLE,
  AVAILABLE,
  DOWNLOADING,
  DOWNLOADED,
  FAILED,
  UNSUPPORTED,
];
const EVERY_EVENT: ActivityEvent[] = [
  { type: "check-started" },
  { type: "check-abandoned", previous: IDLE },
  { type: "update-available", update: NEWER },
  { type: "update-not-available" },
  { type: "download-started" },
  { type: "download-progress", progress: PROGRESS },
  { type: "download-cancelled" },
  { type: "update-downloaded", update: NEWER },
  { type: "update-downloaded", update: null },
  { type: "failed", error: ERROR },
  { type: "unsupported", reason: "unsigned" },
];

describe("reduceActivity", () => {
  test("should start a check from every status that holds no download", () => {
    for (const from of [IDLE, NOT_AVAILABLE, AVAILABLE, FAILED]) {
      expect(reduceActivity(from, { type: "check-started" })).toEqual(CHECKING);
    }
  });

  test("should not let a check throw away a download in flight or a finished one", () => {
    for (const from of [DOWNLOADING, DOWNLOADED, CHECKING]) {
      expect(reduceActivity(from, { type: "check-started" })).toBe(from);
    }
  });

  test("should restore what was shown before a check that was abandoned", () => {
    expect(
      reduceActivity(CHECKING, { type: "check-abandoned", previous: AVAILABLE })
    ).toBe(AVAILABLE);
    expect(
      reduceActivity(DOWNLOADING, { type: "check-abandoned", previous: IDLE })
    ).toBe(DOWNLOADING);
  });

  test("should take the feed's answer in any status but a download", () => {
    for (const from of [IDLE, CHECKING, NOT_AVAILABLE, AVAILABLE, FAILED]) {
      expect(
        reduceActivity(from, { type: "update-available", update: NEWER })
      ).toEqual({ status: "available", update: NEWER });
      expect(reduceActivity(from, { type: "update-not-available" })).toEqual(
        NOT_AVAILABLE
      );
    }
    for (const from of [DOWNLOADING, DOWNLOADED]) {
      expect(
        reduceActivity(from, { type: "update-available", update: NEWER })
      ).toBe(from);
      expect(reduceActivity(from, { type: "update-not-available" })).toBe(from);
    }
  });

  test("should start a download only when an update is available", () => {
    expect(reduceActivity(AVAILABLE, { type: "download-started" })).toEqual({
      status: "downloading",
      update: UPDATE,
      progress: NO_PROGRESS,
    });
    for (const from of [IDLE, CHECKING, DOWNLOADING, DOWNLOADED, FAILED]) {
      expect(reduceActivity(from, { type: "download-started" })).toBe(from);
    }
  });

  test("should show progress for a download, even one started on the engine directly", () => {
    const event: ActivityEvent = {
      type: "download-progress",
      progress: { ...PROGRESS, percent: 80 },
    };

    expect(reduceActivity(DOWNLOADING, event)).toEqual({
      ...DOWNLOADING,
      progress: event.progress,
    });
    expect(reduceActivity(AVAILABLE, event)).toEqual({
      ...DOWNLOADING,
      progress: event.progress,
    });
    expect(reduceActivity(DOWNLOADED, event)).toBe(DOWNLOADED);
    expect(reduceActivity(IDLE, event)).toBe(IDLE);
  });

  test("should fall back to available when a download is cancelled", () => {
    expect(reduceActivity(DOWNLOADING, { type: "download-cancelled" })).toEqual(
      AVAILABLE
    );
    expect(reduceActivity(DOWNLOADED, { type: "download-cancelled" })).toBe(
      DOWNLOADED
    );
  });

  test("should finish a download with what the engine reports, else with what it was downloading", () => {
    expect(
      reduceActivity(DOWNLOADING, { type: "update-downloaded", update: NEWER })
    ).toEqual({ status: "downloaded", update: NEWER });
    expect(
      reduceActivity(DOWNLOADING, { type: "update-downloaded", update: null })
    ).toEqual(DOWNLOADED);
    // Nobody knows which version: the event is dropped rather than invented.
    expect(
      reduceActivity(IDLE, { type: "update-downloaded", update: null })
    ).toBe(IDLE);
  });

  test("should turn a failure into an error that keeps the update it belongs to", () => {
    const failed: ActivityEvent = { type: "failed", error: ERROR };

    expect(reduceActivity(CHECKING, failed)).toEqual(FAILED);
    expect(reduceActivity(DOWNLOADING, failed)).toEqual({
      status: "error",
      error: ERROR,
      update: UPDATE,
    });
    expect(reduceActivity(DOWNLOADED, failed)).toEqual({
      status: "error",
      error: ERROR,
      update: UPDATE,
    });
  });

  test("should ignore a failure that belongs to no check and no download", () => {
    for (const from of [IDLE, NOT_AVAILABLE, AVAILABLE, FAILED]) {
      expect(reduceActivity(from, { type: "failed", error: ERROR })).toBe(from);
    }
  });

  test("should become unsupported from anywhere and stay so whatever happens", () => {
    for (const from of EVERY_STATUS.filter(
      (status) => status !== UNSUPPORTED
    )) {
      expect(
        reduceActivity(from, { type: "unsupported", reason: "unsigned" })
      ).toEqual({ status: "unsupported", reason: "unsigned" });
    }
    for (const event of EVERY_EVENT) {
      expect(reduceActivity(UNSUPPORTED, event)).toBe(UNSUPPORTED);
    }
  });

  test("should always answer with a complete activity, in every status for every event", () => {
    for (const from of EVERY_STATUS) {
      for (const event of EVERY_EVENT) {
        const next = reduceActivity(from, event);

        expect(typeof next.status).toBe("string");
        if (next.status === "downloading") {
          expect(next.update).toBeDefined();
          expect(next.progress).toBeDefined();
        }
      }
    }
  });
});

describe("updateOf", () => {
  test("should name the update a status knows about", () => {
    expect(updateOf(AVAILABLE)).toBe(UPDATE);
    expect(updateOf(FAILED)).toBeNull();
    expect(updateOf(IDLE)).toBeNull();
  });
});
