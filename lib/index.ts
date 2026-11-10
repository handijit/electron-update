// The shared entry: constants, the state guard and types. No Node, no Electron, no Zod, so it
// loads in main, in a sandboxed preload and in the page alike.
export { default as isUpdateState } from "./shared/is-update-state";
export { default as UPDATE_CHANNELS } from "./shared/update-channels.constants";
export {
  UNSUPPORTED_REASONS,
  UPDATE_ERROR_CODES,
  UPDATE_STATUSES,
  UPDATE_VERDICTS,
} from "./shared/update-state.constants";
export { default as withUpdateChannels } from "./shared/with-update-channels";

export type { WithUpdateChannels } from "./shared/with-update-channels";
export type {
  ChannelList,
  UnsupportedReason,
  Unsubscribe,
  UpdateActivity,
  UpdateContext,
  UpdateContract,
  UpdateError,
  UpdateErrorCode,
  UpdateInfo,
  UpdatePolicyState,
  UpdateProgress,
  UpdateState,
  UpdateStatus,
  UpdateVerdict,
} from "./types";
