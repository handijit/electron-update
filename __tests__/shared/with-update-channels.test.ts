import { describe, expect, test } from "vitest";

import UPDATE_CHANNELS from "../../lib/shared/update-channels.constants";
import withUpdateChannels from "../../lib/shared/with-update-channels";

describe("withUpdateChannels", () => {
  test("should add the updater's channels to the program's", () => {
    const channels = withUpdateChannels({
      invoke: { "customers:list": true },
      events: { "sync:progress": true },
    });

    expect(channels).toEqual({
      invoke: { "customers:list": true, ...UPDATE_CHANNELS.invoke },
      events: { "sync:progress": true, ...UPDATE_CHANNELS.events },
    });
  });

  test("should work for a program with no channel of its own, without touching its list", () => {
    const own = { invoke: {}, events: {} };

    expect(withUpdateChannels(own)).toEqual(UPDATE_CHANNELS);
    expect(own).toEqual({ invoke: {}, events: {} });
  });

  test.each([
    ["an invoke channel", { invoke: { "update:check": true }, events: {} }],
    ["an event", { invoke: {}, events: { "update:state-changed": true } }],
    [
      "an invoke name used as an event",
      { invoke: {}, events: { "update:install": true } },
    ],
  ])(
    "should refuse a list that already has %s of the updater",
    (_name, own) => {
      expect(() => withUpdateChannels(own)).toThrow(
        /^withUpdateChannels: channel "update:[a-z-]+" is already in the list/
      );
    }
  );

  test("should not be fooled by names on the prototype", () => {
    const invoke = Object.create({ "update:check": true }) as Record<
      string,
      true
    >;

    expect(() => withUpdateChannels({ invoke, events: {} })).not.toThrow();
  });
});

describe("UPDATE_CHANNELS", () => {
  test("should keep every name in the update: area", () => {
    const names = [
      ...Object.keys(UPDATE_CHANNELS.invoke),
      ...Object.keys(UPDATE_CHANNELS.events),
    ];

    expect(names).toEqual([
      "update:get-state",
      "update:check",
      "update:download",
      "update:install",
      "update:open-download-page",
      "update:state-changed",
    ]);
  });
});
