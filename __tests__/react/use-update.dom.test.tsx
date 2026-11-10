import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, test } from "vitest";

import useUpdate from "../../lib/react/use-update";
import createUpdateClient from "../../lib/renderer/create-update-client";
import createFakeBridge from "../renderer/bridge.fixture";
import { stateOf, UPDATE } from "../shared/update-state.fixture";

const IDLE = stateOf({ status: "idle" }, { revision: 3 });
const AVAILABLE = stateOf(
  { status: "available", update: UPDATE },
  { revision: 5 }
);

describe("useUpdate", () => {
  test("should have no state at first, then the state main answers with", async () => {
    createFakeBridge(IDLE);
    const client = createUpdateClient();

    const { result } = renderHook(() => useUpdate(client));
    expect(result.current.state).toBeNull();

    await waitFor(() => {
      expect(result.current.state).toBe(IDLE);
    });
  });

  test("should follow every change", async () => {
    const bridge = createFakeBridge(IDLE);
    const client = createUpdateClient();
    const { result } = renderHook(() => useUpdate(client));
    await waitFor(() => {
      expect(result.current.state).toBe(IDLE);
    });

    act(() => {
      bridge.publish(AVAILABLE);
    });

    expect(result.current.state).toBe(AVAILABLE);
  });

  test("should hand out the client's actions, and the same object while nothing changes", async () => {
    const bridge = createFakeBridge(IDLE);
    const client = createUpdateClient();
    const { result, rerender } = renderHook(() => useUpdate(client));
    await waitFor(() => {
      expect(result.current.state).toBe(IDLE);
    });
    const before = result.current;

    rerender();
    expect(result.current).toBe(before);

    bridge.set(AVAILABLE);
    await act(async () => {
      expect(await result.current.check()).toBe(AVAILABLE);
    });
    expect(result.current.state).toBe(AVAILABLE);
    expect(result.current).not.toBe(before);
    expect(result.current.check).toBe(client.check);
    expect(result.current.download).toBe(client.download);
    expect(result.current.install).toBe(client.install);
    expect(result.current.openDownloadPage).toBe(client.openDownloadPage);
  });

  test("should share one connection between components, and close it with the last", async () => {
    const bridge = createFakeBridge(IDLE);
    const client = createUpdateClient();

    const first = renderHook(() => useUpdate(client));
    const second = renderHook(() => useUpdate(client));
    await waitFor(() => {
      expect(second.result.current.state).toBe(IDLE);
    });

    expect(bridge.on["update:state-changed"]).toHaveBeenCalledTimes(1);
    expect(bridge.invoke["update:get-state"]).toHaveBeenCalledTimes(1);
    first.unmount();
    expect(bridge.listenerCount()).toBe(1);
    second.unmount();
    expect(bridge.listenerCount()).toBe(0);
  });

  test("should survive StrictMode mounting it twice", async () => {
    const bridge = createFakeBridge(IDLE);
    const client = createUpdateClient();

    const { result, unmount } = renderHook(() => useUpdate(client), {
      wrapper: StrictMode,
    });
    await waitFor(() => {
      expect(result.current.state).toBe(IDLE);
    });

    expect(bridge.listenerCount()).toBe(1);
    act(() => {
      bridge.publish(AVAILABLE);
    });
    expect(result.current.state).toBe(AVAILABLE);
    unmount();
    expect(bridge.listenerCount()).toBe(0);
  });

  test("should render without a state on a server and outside Electron", () => {
    const Probe = (): string => {
      const { state } = useUpdate();
      return state === null ? "no state" : state.status;
    };

    expect(renderToString(<Probe />)).toBe("no state");

    const { result } = renderHook(() => useUpdate());
    expect(result.current.state).toBeNull();
  });

  test("should use the page's client when it is given none", async () => {
    const bridge = createFakeBridge(IDLE);

    const { result, unmount } = renderHook(() => useUpdate());

    await waitFor(() => {
      expect(result.current.state).toBe(IDLE);
    });
    unmount();
    expect(bridge.listenerCount()).toBe(0);
  });
});
