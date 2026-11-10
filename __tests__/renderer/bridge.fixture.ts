import { vi } from "vitest";

import { stateOf } from "../shared/update-state.fixture";

/**
 * `window.desktop` as the preload of `@handijit/electron` exposes it, with main played by the
 * test: every invoke answers with the current state, `publish` sends the event.
 */
const createFakeBridge = (initial: unknown = stateOf({ status: "idle" })) => {
  let current = initial;
  const listeners = new Set<(payload: unknown) => void>();
  const answer = (): Promise<unknown> => Promise.resolve(current);

  const invoke = {
    "update:get-state": vi.fn(answer),
    "update:check": vi.fn(answer),
    "update:download": vi.fn(answer),
    "update:install": vi.fn(answer),
    "update:open-download-page": vi.fn((): Promise<unknown> =>
      Promise.resolve(undefined)
    ),
  };
  const on = {
    "update:state-changed": vi.fn((listener: (payload: unknown) => void) => {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    }),
  };
  vi.stubGlobal("desktop", { invoke, on });

  return {
    invoke,
    on,
    /** Changes what main answers, without telling the page. */
    set: (state: unknown): void => {
      current = state;
    },
    /** Changes the state and sends the event, as main does. */
    publish: (state: unknown): void => {
      current = state;
      for (const listener of [...listeners]) listener(state);
    },
    listenerCount: (): number => listeners.size,
  };
};

type FakeBridge = ReturnType<typeof createFakeBridge>;

export type { FakeBridge };
export default createFakeBridge;
