import { channelsOf } from "@handijit/electron";
import { describe, expect, test, vi } from "vitest";

import updateContract, {
  updateStateSchema,
} from "../../lib/main/update-contract";
import isUpdateState from "../../lib/shared/is-update-state";
import UPDATE_CHANNELS from "../../lib/shared/update-channels.constants";
import { UPDATE_STATUSES } from "../../lib/shared/update-state.constants";
import { INVALID_STATES, VALID_STATES } from "../shared/update-state.fixture";

vi.mock("electron", () => ({}));

describe("updateContract", () => {
  test("should have exactly the channels the preload exposes", () => {
    expect(Object.keys(updateContract.invoke).sort()).toEqual(
      Object.keys(UPDATE_CHANNELS.invoke).sort()
    );
    expect(Object.keys(updateContract.events).sort()).toEqual(
      Object.keys(UPDATE_CHANNELS.events).sort()
    );
    expect(channelsOf(updateContract)).toEqual(UPDATE_CHANNELS);
  });

  test("should take no argument on any channel: a page can ask, and nothing else", () => {
    for (const definition of Object.values(updateContract.invoke)) {
      expect("input" in definition).toBe(false);
    }
  });
});

describe("updateStateSchema", () => {
  test("should accept a state of every status, unchanged", () => {
    expect(
      [...new Set(VALID_STATES.map((state) => state.status))].sort()
    ).toEqual([...UPDATE_STATUSES].sort());
    for (const state of VALID_STATES) {
      expect(updateStateSchema.parse(state)).toEqual(state);
    }
  });

  test("should agree with the page's guard about what is a state and what is not", () => {
    for (const state of VALID_STATES) {
      expect(isUpdateState(state)).toBe(true);
    }
    for (const [name, value] of INVALID_STATES) {
      expect([name, updateStateSchema.safeParse(value).success]).toEqual([
        name,
        false,
      ]);
      expect([name, isUpdateState(value)]).toEqual([name, false]);
    }
  });

  test("should refuse a field main was not supposed to send", () => {
    const [idle] = VALID_STATES;

    expect(
      updateStateSchema.safeParse({ ...idle, installationId: "abc" }).success
    ).toBe(false);
  });
});
