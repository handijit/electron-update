import type { ApiClient } from "@handijit/core";
import { defineContract } from "@handijit/electron";
import type {
  EventPayload,
  InvokeArgs,
  InvokeChannel,
  InvokeResult,
} from "@handijit/electron";
import type { Handlers, Logger } from "@handijit/electron/main";
import type { Client } from "@handijit/electron/renderer";
import type { AppUpdater } from "electron-updater";
import { describe, expectTypeOf, test, vi } from "vitest";
import { z } from "zod";

import type {
  PolicyStore,
  Updater,
  UpdaterEngine,
  UpdaterOptions,
} from "../lib/main/types";
import updateContract from "../lib/main/update-contract";
import type { updateStateSchema } from "../lib/main/update-contract";
import type { createUpdateHandlers } from "../lib/main/update-ipc";
import type { UseUpdateResult } from "../lib/react/use-update";
import type { UpdateClient } from "../lib/renderer/create-update-client";
import type UPDATE_CHANNELS from "../lib/shared/update-channels.constants";
import withUpdateChannels from "../lib/shared/with-update-channels";
import type {
  UpdateContract,
  UpdateError,
  UpdateInfo,
  UpdateProgress,
  UpdateState,
  UpdateStatus,
} from "../lib/types";

vi.mock("electron", () => ({}));

describe("the engine", () => {
  test("should be satisfied by electron-updater's autoUpdater as it is", () => {
    expectTypeOf<AppUpdater>().toExtend<UpdaterEngine>();
    expectTypeOf<AppUpdater>().toExtend<UpdaterOptions["engine"]>();
  });

  test("should take the client of @handijit/core and the logger of @handijit/electron as they are", () => {
    expectTypeOf<ApiClient>().toExtend<UpdaterOptions["api"]>();
    expectTypeOf<Logger>().toExtend<UpdaterOptions["logger"]>();
  });

  test("should need only the engine, the product, the client and the logger", () => {
    expectTypeOf<
      Pick<UpdaterOptions, "engine" | "product" | "api" | "logger">
    >().toExtend<UpdaterOptions>();
  });
});

describe("the state", () => {
  test("should narrow by status", () => {
    type Of<S extends UpdateStatus> = Extract<UpdateState, { status: S }>;

    expectTypeOf<Of<"available">["update"]>().toEqualTypeOf<UpdateInfo>();
    expectTypeOf<
      Of<"downloading">["progress"]
    >().toEqualTypeOf<UpdateProgress>();
    expectTypeOf<Of<"error">["error"]>().toEqualTypeOf<UpdateError>();
    expectTypeOf<Of<"error">["update"]>().toEqualTypeOf<UpdateInfo | null>();
    expectTypeOf<Of<"idle">>().not.toHaveProperty("update");
    expectTypeOf<UpdateState["status"]>().toEqualTypeOf<UpdateStatus>();
  });

  test("should be exactly what the schema parses", () => {
    expectTypeOf<
      z.output<typeof updateStateSchema>
    >().toEqualTypeOf<UpdateState>();
    expectTypeOf<
      z.input<typeof updateStateSchema>
    >().toEqualTypeOf<UpdateState>();
  });

  test("should be what the updater, the client and the hook hand out", () => {
    expectTypeOf<
      ReturnType<Updater["getState"]>
    >().toEqualTypeOf<UpdateState>();
    expectTypeOf<
      Updater["check"]
    >().returns.resolves.toEqualTypeOf<UpdateState>();
    expectTypeOf<
      ReturnType<UpdateClient["getState"]>
    >().toEqualTypeOf<UpdateState | null>();
    expectTypeOf<
      UseUpdateResult["state"]
    >().toEqualTypeOf<UpdateState | null>();
    expectTypeOf<UseUpdateResult["install"]>().toEqualTypeOf<
      UpdateClient["install"]
    >();
    expectTypeOf<PolicyStore["read"]>().returns.resolves.toBeNullable();
  });
});

describe("the contract", () => {
  test("should type every channel on both sides", () => {
    expectTypeOf(updateContract).toEqualTypeOf<UpdateContract>();
    expectTypeOf<InvokeChannel<UpdateContract>>().toEqualTypeOf<
      | "update:get-state"
      | "update:check"
      | "update:download"
      | "update:install"
      | "update:open-download-page"
    >();
    expectTypeOf<
      InvokeResult<UpdateContract, "update:check">
    >().toEqualTypeOf<UpdateState>();
    expectTypeOf<
      InvokeResult<UpdateContract, "update:open-download-page">
    >().toEqualTypeOf<void>();
    expectTypeOf<InvokeArgs<UpdateContract, "update:install">>().toEqualTypeOf<
      []
    >();
    expectTypeOf<
      EventPayload<UpdateContract, "update:state-changed">
    >().toEqualTypeOf<UpdateState>();
  });

  test("should have the names of the channel list, and no other", () => {
    expectTypeOf<keyof UpdateContract["invoke"]>().toEqualTypeOf<
      keyof typeof UPDATE_CHANNELS.invoke
    >();
    expectTypeOf<keyof UpdateContract["events"]>().toEqualTypeOf<
      keyof typeof UPDATE_CHANNELS.events
    >();
  });

  test("should compose into a program's contract, handlers and client", () => {
    const contract = defineContract({
      invoke: {
        ...updateContract.invoke,
        "notes:count": { output: z.number() },
      },
      events: { ...updateContract.events, "notes:changed": z.number() },
    });
    type App = typeof contract;
    expectTypeOf(contract.invoke).toHaveProperty("update:get-state");

    expectTypeOf<
      InvokeResult<App, "update:download">
    >().toEqualTypeOf<UpdateState>();
    expectTypeOf<InvokeResult<App, "notes:count">>().toEqualTypeOf<number>();
    expectTypeOf<
      ReturnType<typeof createUpdateHandlers> & {
        "notes:count": () => number;
      }
    >().toExtend<Handlers<App>>();
    expectTypeOf<Client<App>>().toExtend<Client<UpdateContract>>();
  });

  test("should add its channels to a preload's list, keeping the program's", () => {
    const channels = withUpdateChannels({
      invoke: { "notes:count": true },
      events: { "notes:changed": true },
    });

    expectTypeOf(channels.invoke).toHaveProperty("notes:count");
    expectTypeOf(channels.invoke).toHaveProperty("update:install");
    expectTypeOf(channels.events).toHaveProperty("notes:changed");
    expectTypeOf(channels.events).toHaveProperty("update:state-changed");
  });
});
