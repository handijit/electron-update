import { describe, expect, test, vi } from "vitest";

import * as shared from "../lib/index";
import * as main from "../lib/main";
import * as preload from "../lib/preload";
import * as react from "../lib/react";
import * as renderer from "../lib/renderer";
import * as ui from "../lib/ui";

// The barrels only re-export; `electron` is mocked so that importing them has no side effect.
vi.mock("electron", () => ({
  app: {},
  ipcMain: {},
  shell: {},
  webContents: {},
}));

const names = (module: object): string[] => Object.keys(module).sort();

describe("the public API", () => {
  test("sentinel: the shared entry should export exactly its documented names", () => {
    expect(names(shared)).toEqual([
      "UNSUPPORTED_REASONS",
      "UPDATE_CHANNELS",
      "UPDATE_ERROR_CODES",
      "UPDATE_STATUSES",
      "UPDATE_VERDICTS",
      "isUpdateState",
      "withUpdateChannels",
    ]);
  });

  test("sentinel: the main entry should export exactly its documented names", () => {
    expect(names(main)).toEqual([
      "createPolicyStore",
      "createUpdateHandlers",
      "createUpdater",
      "registerUpdateIpc",
      "updateContract",
    ]);
  });

  test("sentinel: the preload entry should export exactly its documented names", () => {
    expect(names(preload)).toEqual(["UPDATE_CHANNELS", "withUpdateChannels"]);
  });

  test("sentinel: the renderer entry should export exactly its documented names", () => {
    expect(names(renderer)).toEqual([
      "createUpdateClient",
      "isUpdateState",
      "updateClient",
    ]);
  });

  test("sentinel: the react entry should export exactly its documented names", () => {
    expect(names(react)).toEqual(["useUpdate"]);
  });

  test("sentinel: the ui entry should export exactly its documented names", () => {
    expect(names(ui)).toEqual([
      "DEFAULT_UPDATE_LABELS",
      "UpdateButton",
      "UpdateGate",
    ]);
  });

  test("should hand the same values out of every entry that has them", () => {
    expect(preload.UPDATE_CHANNELS).toBe(shared.UPDATE_CHANNELS);
    expect(preload.withUpdateChannels).toBe(shared.withUpdateChannels);
    expect(renderer.isUpdateState).toBe(shared.isUpdateState);
  });

  test("should have a Turkish text for every label", () => {
    for (const [name, label] of Object.entries(ui.DEFAULT_UPDATE_LABELS)) {
      const text =
        typeof label === "function" ? label("1.5.0") : (label as string);
      expect([name, text.trim().length > 0]).toEqual([name, true]);
    }
  });
});
