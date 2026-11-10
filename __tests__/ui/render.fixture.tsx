import { act, render, waitFor } from "@testing-library/react";
import type { RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { expect } from "vitest";

import createUpdateClient from "../../lib/renderer/create-update-client";
import type { UpdateClient } from "../../lib/renderer/create-update-client";
import type { UpdateState } from "../../lib/types";
import createFakeBridge from "../renderer/bridge.fixture";
import type { FakeBridge } from "../renderer/bridge.fixture";

type Mounted = RenderResult & {
  readonly bridge: FakeBridge;
  readonly client: UpdateClient;
  /** Main announces a new state; the revision is taken care of. */
  readonly publish: (state: UpdateState) => void;
};

/**
 * Renders a component over the real client and a scripted bridge, and waits until the state
 * main answers with has reached the page.
 */
const mount = async (
  state: UpdateState,
  element: (client: UpdateClient) => ReactElement
): Promise<Mounted> => {
  const bridge = createFakeBridge(state);
  const client = createUpdateClient();
  const view = render(element(client));
  await waitFor(() => {
    expect(client.getState()).not.toBeNull();
  });
  let revision = state.revision;

  return {
    ...view,
    bridge,
    client,
    publish: (next) => {
      revision += 1;
      act(() => {
        bridge.publish({ ...next, revision });
      });
    },
  };
};

export type { Mounted };
export default mount;
