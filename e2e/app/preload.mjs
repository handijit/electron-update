import { exposeBridge } from "@handijit/electron/preload";
import { withUpdateChannels } from "@handijit/electron-update/preload";

import channels from "./channels.mjs";

// The whole preload of a program that updates itself: its own channels plus the updater's.
exposeBridge(withUpdateChannels(channels));
