import * as api from "@handijit/core";
import * as desktopShared from "@handijit/electron";
import * as desktop from "@handijit/electron/main";
import * as shared from "@handijit/electron-update";
import * as main from "@handijit/electron-update/main";
import engineModule from "electron-updater";
import { z } from "zod";

import run from "./scenario.cjs";

// The ES module build of the package, resolved through its "exports" map.
run({ api, desktop, desktopShared, engineModule, main, shared, z });
