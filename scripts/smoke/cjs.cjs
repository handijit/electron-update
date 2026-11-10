const { readFileSync } = require("node:fs");
const shared = require("@handijit/electron-update");
const preload = require("@handijit/electron-update/preload");
const react = require("@handijit/electron-update/react");
const renderer = require("@handijit/electron-update/renderer");
const ui = require("@handijit/electron-update/ui");

const fail = (message) => {
  throw new Error(`CJS entry is broken: ${message}`);
};

if (shared.UPDATE_CHANNELS.invoke["update:get-state"] !== true)
  fail("UPDATE_CHANNELS");
if (
  preload.withUpdateChannels({ invoke: {}, events: {} }).events[
    "update:state-changed"
  ] !== true
)
  fail("preload");
if (renderer.updateClient.getState() !== null) fail("renderer");
if (typeof react.useUpdate !== "function") fail("react");
if (typeof ui.UpdateGate !== "function") fail("ui");
if (
  !require.resolve("@handijit/electron-update/main").endsWith("/build/main.cjs")
)
  fail("main");
if (
  !readFileSync(
    require.resolve("@handijit/electron-update/styles.css"),
    "utf8"
  ).includes(".hdu-gate")
)
  fail("styles.css");
require("@handijit/electron-update/package.json");

console.log("CJS entries OK");
