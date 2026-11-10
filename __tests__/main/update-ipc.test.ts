import { createUrlPolicy } from "@handijit/electron/main";
import { beforeEach, describe, expect, test, vi } from "vitest";

import type { Updater } from "../../lib/main/types";
import updateContract from "../../lib/main/update-contract";
import registerUpdateIpc, {
  createUpdateHandlers,
} from "../../lib/main/update-ipc";
import type { UpdateState } from "../../lib/types";
import { VALID_STATES } from "../shared/update-state.fixture";

type InvokeListener = (event: unknown, ...parameters: unknown[]) => unknown;

const { electron, listeners } = vi.hoisted(() => {
  const listeners = new Map<string, InvokeListener>();
  const electron = {
    app: { isPackaged: true },
    ipcMain: {
      handle: vi.fn((channel: string, listener: InvokeListener): void => {
        listeners.set(channel, listener);
      }),
      removeHandler: vi.fn((channel: string): void => {
        listeners.delete(channel);
      }),
    },
    webContents: { getAllWebContents: vi.fn<() => unknown[]>(() => []) },
  };
  return { electron, listeners };
});

vi.mock("electron", () => electron);

const APP_PAGE = "app://bundle/index.html";
const [IDLE, , , CHECKING, , AVAILABLE] = VALID_STATES as [
  UpdateState,
  UpdateState,
  UpdateState,
  UpdateState,
  UpdateState,
  UpdateState,
];

const createFakeUpdater = () => {
  const changeListeners = new Set<(state: UpdateState) => void>();
  const updater = {
    getState: vi.fn<Updater["getState"]>(() => IDLE),
    onChange: vi.fn<Updater["onChange"]>((listener) => {
      changeListeners.add(listener);
      return () => {
        changeListeners.delete(listener);
      };
    }),
    start: vi.fn<Updater["start"]>(() => Promise.resolve(IDLE)),
    check: vi.fn<Updater["check"]>(() => Promise.resolve(CHECKING)),
    download: vi.fn<Updater["download"]>(() => Promise.resolve(AVAILABLE)),
    install: vi.fn<Updater["install"]>(() => Promise.resolve(AVAILABLE)),
    openDownloadPage: vi.fn<Updater["openDownloadPage"]>(() =>
      Promise.resolve()
    ),
    dispose: vi.fn<Updater["dispose"]>(),
  };
  return {
    updater,
    publish: (state: UpdateState): void => {
      for (const listener of changeListeners) listener(state);
    },
    listenerCount: (): number => changeListeners.size,
  };
};

const createPage = (url: string) => ({
  isDestroyed: vi.fn(() => false),
  getURL: vi.fn(() => url),
  send: vi.fn<(channel: string, payload: unknown) => void>(),
});

const invokeFrom = (
  frameUrl: string,
  channel: string,
  ...parameters: unknown[]
): unknown => {
  const listener = listeners.get(channel);
  if (listener === undefined) throw new Error(`no handler for ${channel}`);
  return listener({ senderFrame: { url: frameUrl } }, ...parameters);
};

beforeEach(() => {
  listeners.clear();
});

describe("createUpdateHandlers", () => {
  test("should map every channel of the contract to the updater, and nothing else", async () => {
    const { updater } = createFakeUpdater();
    const handlers = createUpdateHandlers(updater);
    const event = {} as never;

    expect(Object.keys(handlers).sort()).toEqual(
      Object.keys(updateContract.invoke).sort()
    );
    expect(await handlers["update:get-state"](undefined, event)).toBe(IDLE);
    expect(await handlers["update:check"](undefined, event)).toBe(CHECKING);
    expect(await handlers["update:download"](undefined, event)).toBe(AVAILABLE);
    expect(await handlers["update:install"](undefined, event)).toBe(AVAILABLE);
    expect(
      await handlers["update:open-download-page"](undefined, event)
    ).toBeUndefined();
    expect(updater.check).toHaveBeenCalledTimes(1);
    expect(updater.download).toHaveBeenCalledTimes(1);
    expect(updater.install).toHaveBeenCalledTimes(1);
    expect(updater.openDownloadPage).toHaveBeenCalledTimes(1);
  });
});

describe("registerUpdateIpc", () => {
  test("should answer the program's page with the validated state", async () => {
    const { updater } = createFakeUpdater();
    registerUpdateIpc({ updater, policy: createUrlPolicy() });

    expect([...listeners.keys()].sort()).toEqual(
      Object.keys(updateContract.invoke).sort()
    );
    expect(await invokeFrom(APP_PAGE, "update:get-state")).toEqual(IDLE);
    expect(await invokeFrom(APP_PAGE, "update:check")).toEqual(CHECKING);
    expect(
      await invokeFrom(APP_PAGE, "update:open-download-page")
    ).toBeUndefined();
  });

  test("should refuse a page that is not the program's, and tell the program", async () => {
    const { updater } = createFakeUpdater();
    const onError = vi.fn();
    registerUpdateIpc({ updater, policy: createUrlPolicy(), onError });

    await expect(
      invokeFrom("https://evil.example/", "update:install")
    ).rejects.toThrow();

    expect(updater.install).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  test("should tell every window of the program about every change", () => {
    const { updater, publish } = createFakeUpdater();
    const page = createPage(APP_PAGE);
    const stranger = createPage("https://example.com/");
    electron.webContents.getAllWebContents.mockReturnValue([page, stranger]);
    registerUpdateIpc({ updater, policy: createUrlPolicy() });

    publish(AVAILABLE);

    expect(page.send).toHaveBeenCalledExactlyOnceWith(
      "update:state-changed",
      AVAILABLE
    );
    expect(stranger.send).not.toHaveBeenCalled();
  });

  test("should undo both the handlers and the broadcast", () => {
    const { updater, publish, listenerCount } = createFakeUpdater();
    const page = createPage(APP_PAGE);
    electron.webContents.getAllWebContents.mockReturnValue([page]);
    const unregister = registerUpdateIpc({
      updater,
      policy: createUrlPolicy(),
    });

    unregister();
    publish(AVAILABLE);

    expect(listeners.size).toBe(0);
    expect(listenerCount()).toBe(0);
    expect(page.send).not.toHaveBeenCalled();
  });
});
