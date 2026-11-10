// The preload entry: exactly what a sandboxed preload needs, and nothing it cannot load.
export { default as UPDATE_CHANNELS } from "./shared/update-channels.constants";
export { default as withUpdateChannels } from "./shared/with-update-channels";

export type { WithUpdateChannels } from "./shared/with-update-channels";
export type { ChannelList } from "./types";
