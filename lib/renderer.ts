// The renderer entry: the page's client over the bridge. No React, no Node, no Electron.
export {
  default as createUpdateClient,
  updateClient,
} from "./renderer/create-update-client";
export { default as isUpdateState } from "./shared/is-update-state";

export type { UpdateClient } from "./renderer/create-update-client";
export type {
  UnsupportedReason,
  Unsubscribe,
  UpdateError,
  UpdateErrorCode,
  UpdateInfo,
  UpdatePolicyState,
  UpdateProgress,
  UpdateState,
  UpdateStatus,
  UpdateVerdict,
} from "./types";
