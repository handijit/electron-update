import { describe, expect, test, vi } from "vitest";

import createUpdateClient, {
  updateClient,
} from "../../lib/renderer/create-update-client";
import type { UpdateState } from "../../lib/types";
import { stateOf, UPDATE } from "../shared/update-state.fixture";
import createFakeBridge from "./bridge.fixture";

const IDLE = stateOf({ status: "idle" }, { revision: 3 });
const CHECKING = stateOf({ status: "checking" }, { revision: 4 });
const AVAILABLE = stateOf(
  { status: "available", update: UPDATE },
  { revision: 5 }
);

/** Lets the answers that are ready arrive. */
const settle = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

describe("createUpdateClient", () => {
  test("should touch nothing until someone listens", () => {
    const bridge = createFakeBridge(IDLE);

    const client = createUpdateClient();

    expect(client.getState()).toBeNull();
    expect(bridge.on["update:state-changed"]).not.toHaveBeenCalled();
    expect(bridge.invoke["update:get-state"]).not.toHaveBeenCalled();
  });

  test("should connect with the first listener and hand it the current state", async () => {
    const bridge = createFakeBridge(IDLE);
    const client = createUpdateClient();
    const listener = vi.fn();

    client.subscribe(listener);
    await settle();

    expect(bridge.on["update:state-changed"]).toHaveBeenCalledTimes(1);
    expect(bridge.invoke["update:get-state"]).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledExactlyOnceWith(IDLE);
    expect(client.getState()).toBe(IDLE);
  });

  test("should pass every change main announces to every listener", async () => {
    const bridge = createFakeBridge(IDLE);
    const client = createUpdateClient();
    const first = vi.fn();
    const second = vi.fn();
    client.subscribe(first);
    client.subscribe(second);
    await settle();

    bridge.publish(AVAILABLE);

    expect(first.mock.calls).toEqual([[IDLE], [AVAILABLE]]);
    expect(second.mock.calls).toEqual([[IDLE], [AVAILABLE]]);
    expect(client.getState()).toBe(AVAILABLE);
    expect(bridge.on["update:state-changed"]).toHaveBeenCalledTimes(1);
    expect(bridge.invoke["update:get-state"]).toHaveBeenCalledTimes(1);
  });

  test("should disconnect when the last listener leaves, and connect again for the next", async () => {
    const bridge = createFakeBridge(IDLE);
    const client = createUpdateClient();
    const stopFirst = client.subscribe(vi.fn());
    const stopSecond = client.subscribe(vi.fn());
    await settle();

    stopFirst();
    expect(bridge.listenerCount()).toBe(1);
    stopFirst();
    expect(bridge.listenerCount()).toBe(1);
    stopSecond();
    expect(bridge.listenerCount()).toBe(0);

    const late = vi.fn();
    client.subscribe(late);
    bridge.publish(AVAILABLE);

    expect(bridge.listenerCount()).toBe(1);
    expect(late).toHaveBeenCalledExactlyOnceWith(AVAILABLE);
  });

  test("should count one function subscribed twice as two listeners", async () => {
    const bridge = createFakeBridge(IDLE);
    const client = createUpdateClient();
    const listener = vi.fn();
    const stopFirst = client.subscribe(listener);
    const stopSecond = client.subscribe(listener);
    await settle();
    expect(listener).toHaveBeenCalledTimes(2);

    stopFirst();
    bridge.publish(AVAILABLE);

    expect(listener).toHaveBeenCalledTimes(3);
    stopSecond();
    expect(bridge.listenerCount()).toBe(0);
  });

  test("should let a listener leave while the listeners are being told", async () => {
    const bridge = createFakeBridge(IDLE);
    const client = createUpdateClient();
    const seen: string[] = [];
    const stop = client.subscribe((state) => {
      seen.push(`first:${state.status}`);
      stop();
    });
    client.subscribe((state) => seen.push(`second:${state.status}`));
    await settle();

    bridge.publish(AVAILABLE);

    expect(seen).toEqual(["first:idle", "second:idle", "second:available"]);
  });

  test("should let the revision decide when an answer and an event cross", async () => {
    const bridge = createFakeBridge(IDLE);
    const client = createUpdateClient();
    const listener = vi.fn();
    client.subscribe(listener);
    // The event with the newer state arrives before the answer with the older one.
    bridge.publish(AVAILABLE);
    bridge.set(IDLE);
    await settle();

    expect(client.getState()).toBe(AVAILABLE);
    expect(listener).toHaveBeenCalledExactlyOnceWith(AVAILABLE);

    bridge.publish(CHECKING);
    bridge.publish({ ...AVAILABLE });

    expect(client.getState()).toBe(AVAILABLE);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["nothing", null],
    ["a state of an older main", { status: "idle", version: "1.4.0" }],
    ["text", "available"],
  ])("should ignore %s where a state should be", async (_name, payload) => {
    const bridge = createFakeBridge(payload);
    const client = createUpdateClient();
    const listener = vi.fn();
    client.subscribe(listener);
    await settle();

    bridge.publish(payload);

    expect(await client.check()).toBeNull();
    expect(client.getState()).toBeNull();
    expect(listener).not.toHaveBeenCalled();
  });

  test.each([
    ["refresh", "update:get-state"],
    ["check", "update:check"],
    ["download", "update:download"],
    ["install", "update:install"],
  ] as const)(
    "should %s through its channel and resolve with the newest state",
    async (action, channel) => {
      const bridge = createFakeBridge(AVAILABLE);
      const client = createUpdateClient();
      const listener = vi.fn();
      client.subscribe(listener);
      await settle();
      listener.mockClear();
      bridge.invoke[channel].mockClear();

      // Main answers with a state the page already has a newer one of.
      bridge.set(IDLE);
      expect(await client[action]()).toBe(AVAILABLE);
      expect(bridge.invoke[channel]).toHaveBeenCalledExactlyOnceWith(undefined);
      expect(listener).not.toHaveBeenCalled();

      const next: UpdateState = { ...AVAILABLE, revision: 9 };
      bridge.set(next);
      expect(await client[action]()).toBe(next);
      expect(listener).toHaveBeenCalledExactlyOnceWith(next);
    }
  );

  test("should work without a listener: an action alone still returns the state", async () => {
    const bridge = createFakeBridge(AVAILABLE);
    const client = createUpdateClient();

    expect(await client.check()).toBe(AVAILABLE);
    expect(client.getState()).toBe(AVAILABLE);
    expect(bridge.listenerCount()).toBe(0);
  });

  test("should ask main to open the download page", async () => {
    const bridge = createFakeBridge(IDLE);
    const client = createUpdateClient();

    expect(await client.openDownloadPage()).toBeUndefined();
    expect(bridge.invoke["update:open-download-page"]).toHaveBeenCalledTimes(1);
  });

  test("should pass on what main refuses", async () => {
    const bridge = createFakeBridge(IDLE);
    bridge.invoke["update:install"].mockRejectedValue(new Error("refused"));
    const client = createUpdateClient();

    await expect(client.install()).rejects.toThrow("refused");
  });

  test("should stay quiet when the first answer never comes", async () => {
    const bridge = createFakeBridge(IDLE);
    bridge.invoke["update:get-state"].mockRejectedValue(new Error("refused"));
    const client = createUpdateClient();
    const listener = vi.fn();

    client.subscribe(listener);
    await settle();

    expect(client.getState()).toBeNull();
    bridge.publish(AVAILABLE);
    expect(listener).toHaveBeenCalledExactlyOnceWith(AVAILABLE);
  });

  test("should stay quiet outside Electron, and say why to whoever asks", async () => {
    const client = createUpdateClient();
    const listener = vi.fn();

    const stop = client.subscribe(listener);
    await settle();

    expect(client.getState()).toBeNull();
    expect(listener).not.toHaveBeenCalled();
    expect(() => {
      stop();
    }).not.toThrow();
    await expect(client.refresh()).rejects.toThrow(
      /window\.desktop is missing/
    );
    await expect(client.check()).rejects.toThrow(/window\.desktop is missing/);
    expect(() => client.openDownloadPage()).toThrow(
      /window\.desktop is missing/
    );
  });
});

describe("updateClient", () => {
  test("should be the page's one client, created without touching the bridge", async () => {
    const bridge = createFakeBridge(IDLE);

    expect(updateClient.getState()).toBeNull();
    expect(await updateClient.refresh()).toBe(IDLE);
    expect(bridge.invoke["update:get-state"]).toHaveBeenCalledTimes(1);
  });
});
