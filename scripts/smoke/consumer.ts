import { createApiClient } from "@handijit/core";
import { defineContract, type ChannelMap } from "@handijit/electron";
import {
  startApp,
  type AppContext,
  type Handlers,
} from "@handijit/electron/main";
import { exposeBridge } from "@handijit/electron/preload";
import {
  UPDATE_CHANNELS,
  isUpdateState,
  withUpdateChannels,
  type UpdateErrorCode,
  type UpdateInfo,
  type UpdateState,
  type UpdateVerdict,
} from "@handijit/electron-update";
import {
  createPolicyStore,
  createUpdateHandlers,
  createUpdater,
  registerUpdateIpc,
  updateContract,
  type Updater,
  type UpdaterEngine,
  type UpdaterOptions,
} from "@handijit/electron-update/main";
import { withUpdateChannels as forPreload } from "@handijit/electron-update/preload";
import {
  useUpdate,
  type UseUpdateResult,
} from "@handijit/electron-update/react";
import {
  createUpdateClient,
  updateClient,
  type UpdateClient,
} from "@handijit/electron-update/renderer";
import { autoUpdater } from "electron-updater";
import { z } from "zod";

// main, the standalone wiring: electron-updater's autoUpdater is the engine as it is.
const engine: UpdaterEngine = autoUpdater;
const options: UpdaterOptions = {
  engine,
  product: "on-muhasebe",
  api: createApiClient(),
  logger: {} as AppContext<AppContract>["logger"],
  channel: "stable",
  autoDownload: false,
  policyStore: createPolicyStore({ directory: "/data" }),
};
const updater: Updater = createUpdater(options);
const started: Promise<UpdateState> = updater.start();
const stop: () => void = updater.onChange((state) => {
  if (state.status === "downloading") void state.progress.percent.toFixed(0);
  if (state.status === "error") {
    const code: UpdateErrorCode = state.error.code;
    const kept: UpdateInfo | null = state.update;
    void [code, kept];
  }
  const verdict: UpdateVerdict = state.policy.verdict;
  void verdict;
});

// main, the composed wiring: the fragment inside the program's own contract.
const contract = defineContract({
  invoke: {
    ...updateContract.invoke,
    "notes:count": { output: z.number() },
  },
  events: { ...updateContract.events },
});
type AppContract = typeof contract;
const handlers = (context: AppContext<AppContract>): Handlers<AppContract> => {
  updater.onChange((state) => {
    context.emitter.broadcast("update:state-changed", state);
  });
  return { ...createUpdateHandlers(updater), "notes:count": () => 0 };
};
const app: Promise<AppContext<AppContract> | null> = startApp({
  contract,
  handlers,
  rendererRoot: "/app/renderer",
  window: { preload: "/app/preload.cjs", width: 1100, height: 720 },
});
const unregister = (context: AppContext<AppContract>): (() => void) =>
  registerUpdateIpc({ updater, policy: context.policy });

// preload
const channels: ChannelMap<AppContract> = withUpdateChannels({
  invoke: { "notes:count": true },
  events: {},
});
exposeBridge(channels);
exposeBridge(forPreload({ invoke: {}, events: {} }));
const names: readonly string[] = Object.keys(UPDATE_CHANNELS.invoke);

// renderer
const client: UpdateClient = createUpdateClient();
const checked: Promise<UpdateState | null> = client.check();
const latest: UpdateState | null = updateClient.getState();
const isState: boolean = isUpdateState(latest);

// react; the components are in consumer-ui.ts
const hook = (): UseUpdateResult => useUpdate(client);

// @ts-expect-error the engine, the product, the client and the logger are required
const incomplete: UpdaterOptions = { engine, product: "on-muhasebe" };
// @ts-expect-error a status that does not exist must not compile
const impossible: UpdateState["status"] = "installing";
// @ts-expect-error a missing handler must not compile
const partial: Handlers<AppContract> = { ...createUpdateHandlers(updater) };
// @ts-expect-error a subpath the package does not export must not resolve
import("@handijit/electron-update/main/create-updater");

export {
  app,
  checked,
  hook,
  impossible,
  incomplete,
  isState,
  names,
  partial,
  started,
  stop,
  unregister,
};
