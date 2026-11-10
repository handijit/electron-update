import { describe, expect, test } from "vitest";

import isUpdateState from "../../lib/shared/is-update-state";
import { INVALID_STATES, VALID_STATES } from "./update-state.fixture";

describe("isUpdateState", () => {
  test.each(VALID_STATES.map((state) => [state.status, state] as const))(
    "should accept a complete %s state",
    (_status, state) => {
      expect(isUpdateState(state)).toBe(true);
    }
  );

  test.each(INVALID_STATES)("should refuse %s", (_name, value) => {
    expect(isUpdateState(value)).toBe(false);
  });

  test("should accept a download that just reached a hundred percent", () => {
    const downloading = VALID_STATES.find(
      (state) => state.status === "downloading"
    );

    expect(
      isUpdateState({
        ...downloading,
        progress: {
          percent: 100,
          transferredBytes: 10,
          totalBytes: 10,
          bytesPerSecond: 0,
        },
      })
    ).toBe(true);
  });
});
