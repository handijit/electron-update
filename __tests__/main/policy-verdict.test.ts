import { describe, expect, test } from "vitest";

import {
  evaluateStoredPolicy,
  isStoredPolicy,
} from "../../lib/main/policy-verdict";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 10, 8);

const evaluate = (
  stored: Parameters<typeof evaluateStoredPolicy>[0]["stored"],
  overrides: Partial<Parameters<typeof evaluateStoredPolicy>[0]> = {}
): ReturnType<typeof evaluateStoredPolicy> =>
  evaluateStoredPolicy({
    stored,
    currentVersion: "1.4.0",
    now: NOW,
    requiredTtlMs: 7 * DAY_MS,
    answeredAt: null,
    ...overrides,
  });

describe("evaluateStoredPolicy", () => {
  test("should never lock anyone out without a policy", () => {
    expect(evaluate(null)).toEqual({
      verdict: "ok",
      latestVersion: null,
      minSupportedVersion: null,
      checkedAt: null,
    });
    expect(evaluate(null, { answeredAt: NOW - 5 }).checkedAt).toBe(NOW - 5);
  });

  test("should say ok when the running version is the newest, or newer", () => {
    const stored = {
      latestVersion: "1.4.0",
      minSupportedVersion: "1.2.0",
      fetchedAt: NOW,
    };

    expect(evaluate(stored)).toEqual({
      verdict: "ok",
      latestVersion: "1.4.0",
      minSupportedVersion: "1.2.0",
      checkedAt: NOW,
    });
    expect(evaluate(stored, { currentVersion: "1.5.0-beta.1" }).verdict).toBe(
      "ok"
    );
  });

  test("should recommend when a newer version is published and the floor is met or absent", () => {
    expect(
      evaluate({
        latestVersion: "1.5.0",
        minSupportedVersion: null,
        fetchedAt: NOW,
      }).verdict
    ).toBe("recommended");
    expect(
      evaluate({
        latestVersion: "1.5.0",
        minSupportedVersion: "1.4.0",
        fetchedAt: NOW,
      }).verdict
    ).toBe("recommended");
  });

  test("should require below the floor while the answer is fresh", () => {
    const stored = {
      latestVersion: "1.5.0",
      minSupportedVersion: "1.4.5",
      fetchedAt: NOW - 7 * DAY_MS,
    };

    expect(evaluate(stored).verdict).toBe("required");
    expect(evaluate(stored).checkedAt).toBe(NOW - 7 * DAY_MS);
  });

  test("should weaken an unconfirmed requirement to a recommendation once it is too old", () => {
    expect(
      evaluate({
        latestVersion: "1.5.0",
        minSupportedVersion: "1.4.5",
        fetchedAt: NOW - 7 * DAY_MS - 1,
      }).verdict
    ).toBe("recommended");
  });

  test("should end the lock, not extend it, when the clock was moved back", () => {
    const stored = {
      latestVersion: "1.5.0",
      minSupportedVersion: "1.4.5",
      fetchedAt: NOW + 7 * DAY_MS + 1,
    };

    expect(evaluate(stored).verdict).toBe("recommended");
    expect(evaluate({ ...stored, fetchedAt: NOW + DAY_MS }).verdict).toBe(
      "required"
    );
  });

  test("should hold no requirement at all with a zero lifetime, except at the very moment", () => {
    const stored = {
      latestVersion: "1.5.0",
      minSupportedVersion: "1.4.5",
      fetchedAt: NOW - 1,
    };

    expect(evaluate(stored, { requiredTtlMs: 0 }).verdict).toBe("recommended");
  });
});

describe("isStoredPolicy", () => {
  test("should accept what this package writes", () => {
    expect(
      isStoredPolicy({
        latestVersion: "1.5.0",
        minSupportedVersion: null,
        fetchedAt: NOW,
      })
    ).toBe(true);
    expect(
      isStoredPolicy({
        latestVersion: "1.5.0",
        minSupportedVersion: "1.0.0",
        fetchedAt: 0,
      })
    ).toBe(true);
  });

  test.each([
    [null],
    ["1.5.0"],
    [{}],
    [{ latestVersion: "new", minSupportedVersion: null, fetchedAt: 1 }],
    [{ latestVersion: "1.5.0", minSupportedVersion: "old", fetchedAt: 1 }],
    [{ latestVersion: "1.5.0", fetchedAt: 1 }],
    [{ latestVersion: "1.5.0", minSupportedVersion: null, fetchedAt: "1" }],
    [
      {
        latestVersion: "1.5.0",
        minSupportedVersion: null,
        fetchedAt: Number.NaN,
      },
    ],
  ])("should refuse %j", (value) => {
    expect(isStoredPolicy(value)).toBe(false);
  });
});
