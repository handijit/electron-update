"use strict";

const api = require("@handijit/core");
const desktopShared = require("@handijit/electron");
const desktop = require("@handijit/electron/main");
const shared = require("@handijit/electron-update");
const main = require("@handijit/electron-update/main");
const engineModule = require("electron-updater");
const { z } = require("zod");

const run = require("./scenario.cjs");

// The CommonJS build of the package, resolved through its "exports" map.
run({ api, desktop, desktopShared, engineModule, main, shared, z });
