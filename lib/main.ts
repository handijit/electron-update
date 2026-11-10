// The main-process entry: the updater, its IPC contract and the wiring for both.
export { default as createPolicyStore } from "./main/policy-store";
export { default as createUpdater } from "./main/create-updater";
export {
  createUpdateHandlers,
  default as registerUpdateIpc,
} from "./main/update-ipc";
export { default as updateContract } from "./main/update-contract";

export type { PolicyStoreOptions } from "./main/policy-store";
export type { StoredPolicy } from "./main/policy-verdict";
export type {
  PolicyStore,
  Updater,
  UpdaterEngine,
  UpdaterEngineLogger,
  UpdaterOptions,
} from "./main/types";
export type { RegisterUpdateIpcOptions } from "./main/update-ipc";
