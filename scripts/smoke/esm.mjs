import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as shared from "@handijit/electron-update";
import * as preload from "@handijit/electron-update/preload";
import * as react from "@handijit/electron-update/react";
import * as renderer from "@handijit/electron-update/renderer";
import * as ui from "@handijit/electron-update/ui";

const fail = (message) => {
  throw new Error(`ESM entry is broken: ${message}`);
};
const resolve = (specifier) => fileURLToPath(import.meta.resolve(specifier));

// The shared entry: the channel list and the state guard.
const channels = shared.withUpdateChannels({
  invoke: { "notes:list": true },
  events: {},
});
if (channels.invoke["notes:list"] !== true) fail("withUpdateChannels");
if (channels.invoke["update:install"] !== true) fail("withUpdateChannels");
if (channels.events["update:state-changed"] !== true) fail("events");
if (preload.withUpdateChannels !== shared.withUpdateChannels) {
  // Two copies are fine; two behaviours are not.
  if (preload.UPDATE_CHANNELS.invoke["update:check"] !== true) fail("preload");
}
if (shared.isUpdateState({ status: "idle" }) !== false) fail("isUpdateState");
if (!shared.UPDATE_STATUSES.includes("downloading")) fail("UPDATE_STATUSES");
if (!shared.UPDATE_ERROR_CODES.includes("CHECKSUM")) fail("UPDATE_ERROR_CODES");

// The renderer entry loads without a window. Without a bridge a subscriber hears nothing
// and the state stays null; an action says why it cannot work.
const client = renderer.createUpdateClient();
const unsubscribe = client.subscribe(() => fail("a state without a bridge"));
if (client.getState() !== null) fail("the client has a state without a bridge");
unsubscribe();
const refusal = await client.check().then(
  () => null,
  (cause) => String(cause)
);
if (refusal === null || !refusal.includes("window.desktop is missing")) {
  fail("check without a bridge");
}
if (renderer.updateClient.getState() !== null) fail("updateClient");

// The hook and the components build on the one client of the renderer entry.
if (typeof react.useUpdate !== "function") fail("useUpdate");
if (typeof ui.UpdateButton !== "function") fail("UpdateButton");
if (typeof ui.UpdateGate !== "function") fail("UpdateGate");
if (ui.DEFAULT_UPDATE_LABELS.gateTitle !== "Güncelleme gerekli") fail("labels");

// main imports `electron`, which only an Electron process can load: here it only has to
// resolve to the right file. The Electron smoke test loads it for real.
const main = resolve("@handijit/electron-update/main");
if (!main.endsWith("/build/main.mjs") || !existsSync(main)) fail("main");
const styles = resolve("@handijit/electron-update/styles.css");
if (!readFileSync(styles, "utf8").includes(".hdu-gate")) fail("styles.css");

console.log("ESM entries OK");
