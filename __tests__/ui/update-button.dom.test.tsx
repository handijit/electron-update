import { UISize } from "@handijit/ui";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { MockInstance } from "vitest";

import createUpdateClient from "../../lib/renderer/create-update-client";
import type { UpdateActivity } from "../../lib/types";
import UpdateButton from "../../lib/ui/update-button";
import { PROGRESS, stateOf, UPDATE } from "../shared/update-state.fixture";
import mount from "./render.fixture";

const AVAILABLE = stateOf({ status: "available", update: UPDATE });
const DOWNLOADING = stateOf({
  status: "downloading",
  update: UPDATE,
  progress: PROGRESS,
});
const DOWNLOADED = stateOf({ status: "downloaded", update: UPDATE });
const OFFLINE = stateOf({
  status: "error",
  error: { code: "OFFLINE", message: "İnternet bağlantısı yok." },
  update: null,
});
const BROKEN_DOWNLOAD = stateOf({
  status: "error",
  error: { code: "CHECKSUM", message: "İndirilen dosya bozuk." },
  update: UPDATE,
});

/** The live region every state of the button keeps. */
const announcement = (): string =>
  screen.getByRole("status", { name: "" }).textContent;

let complaints: MockInstance;

beforeEach(() => {
  complaints = vi.spyOn(console, "error");
});

afterEach(() => {
  // React and @handijit/ui report misuse on the console: none is expected.
  expect(complaints).not.toHaveBeenCalled();
});

describe("UpdateButton in a title bar", () => {
  test.each<[string, UpdateActivity]>([
    ["idle", { status: "idle" }],
    ["checking", { status: "checking" }],
    ["up to date", { status: "not-available" }],
    ["unable to update itself", { status: "unsupported", reason: "unsigned" }],
  ])("should show nothing while %s", async (_name, activity) => {
    const { container } = await mount(stateOf(activity), (client) => (
      <UpdateButton client={client} />
    ));

    expect(container.querySelector(".hdu-update")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(announcement()).toBe("");
  });

  test("should show nothing outside Electron, and nothing to trip over", () => {
    const { container } = render(
      <UpdateButton client={createUpdateClient()} />
    );

    expect(container.querySelector(".hdu-update")).toBeNull();
    expect(announcement()).toBe("");
  });

  test("should offer the published version and download it on a click", async () => {
    const { bridge, container } = await mount(AVAILABLE, (client) => (
      <UpdateButton client={client} />
    ));

    const button = screen.getByRole("button", { name: "Güncelle 1.5.0" });
    fireEvent.click(button);

    expect(bridge.invoke["update:download"]).toHaveBeenCalledTimes(1);
    expect(bridge.invoke["update:install"]).not.toHaveBeenCalled();
    expect(announcement()).toBe(
      "1.5.0 sürümü yayımlandı. Güncelleyebilirsiniz."
    );
    expect(
      container.querySelector(".hdu-update")?.getAttribute("data-status")
    ).toBe("available");
    expect(button.querySelector("svg")?.getAttribute("aria-hidden")).toBe(
      "true"
    );
  });

  test("should show the progress while downloading, as a bar a screen reader can ask", async () => {
    const { publish } = await mount(DOWNLOADING, (client) => (
      <UpdateButton client={client} />
    ));

    const bar = screen.getByRole("progressbar", {
      name: "Güncelleme indiriliyor",
    });
    expect(bar.getAttribute("aria-valuenow")).toBe("50");
    expect(bar.getAttribute("aria-valuetext")).toBe("%50");
    expect(screen.getByText("%50").getAttribute("aria-hidden")).toBe("true");
    expect(screen.queryByRole("button")).toBeNull();
    // A title bar has no room for words: the pointer gets them, the bar carries its name.
    expect(screen.getByTitle("Güncelleme indiriliyor").contains(bar)).toBe(
      true
    );
    expect(screen.queryByText("Güncelleme indiriliyor")).toBeNull();
    // Progress is not announced on every tick.
    expect(announcement()).toBe("");

    publish({ ...DOWNLOADING, progress: { ...PROGRESS, percent: 99.6 } });

    expect(bar.getAttribute("aria-valuetext")).toBe("%99");
    expect(screen.getByText("%99")).toBeTruthy();
  });

  test("should offer the restart once the update is downloaded", async () => {
    const { bridge } = await mount(DOWNLOADED, (client) => (
      <UpdateButton client={client} />
    ));

    fireEvent.click(screen.getByRole("button", { name: "Yeniden başlat" }));

    expect(bridge.invoke["update:install"]).toHaveBeenCalledTimes(1);
    expect(announcement()).toBe(
      "1.5.0 sürümü indirildi. Kurmak için programı yeniden başlatın."
    );
  });

  test("should be busy, and not clickable, while the program is quitting to install", async () => {
    const { bridge } = await mount(
      { ...DOWNLOADED, isInstallPending: true },
      (client) => <UpdateButton client={client} />
    );

    const button = screen.getByRole("button", {
      name: "Yeniden başlatılıyor…",
    });
    fireEvent.click(button);

    expect(button.hasAttribute("disabled")).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(bridge.invoke["update:install"]).not.toHaveBeenCalled();
  });

  test("should offer a new check after a failed check, with the reason attached", async () => {
    const { bridge } = await mount(OFFLINE, (client) => (
      <UpdateButton client={client} />
    ));

    const button = screen.getByRole("button", { name: "Yeniden dene" });
    fireEvent.click(button);

    expect(bridge.invoke["update:check"]).toHaveBeenCalledTimes(1);
    expect(bridge.invoke["update:download"]).not.toHaveBeenCalled();
    expect(button.getAttribute("title")).toBe("İnternet bağlantısı yok.");
    expect(announcement()).toBe("İnternet bağlantısı yok.");
    expect(
      document.getElementById(button.getAttribute("aria-describedby") ?? "")
        ?.textContent
    ).toBe("İnternet bağlantısı yok.");
    // In a title bar the sentence is not laid out next to the button.
    expect(screen.getAllByText("İnternet bağlantısı yok.")).toHaveLength(1);
  });

  test("should download again after a failed download", async () => {
    const { bridge } = await mount(BROKEN_DOWNLOAD, (client) => (
      <UpdateButton client={client} />
    ));

    fireEvent.click(screen.getByRole("button", { name: "Yeniden dene" }));

    expect(bridge.invoke["update:download"]).toHaveBeenCalledTimes(1);
    expect(bridge.invoke["update:check"]).not.toHaveBeenCalled();
  });

  test("should follow an update from published to ready", async () => {
    const { publish } = await mount(stateOf({ status: "idle" }), (client) => (
      <UpdateButton client={client} />
    ));
    expect(screen.queryByRole("button")).toBeNull();

    publish(AVAILABLE);
    expect(screen.getByRole("button", { name: "Güncelle 1.5.0" })).toBeTruthy();

    publish(DOWNLOADING);
    expect(screen.getByRole("progressbar")).toBeTruthy();

    publish(DOWNLOADED);
    expect(screen.getByRole("button", { name: "Yeniden başlat" })).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  test("should swallow a click main refuses: a rejection is not the page's problem", async () => {
    const { bridge } = await mount(AVAILABLE, (client) => (
      <UpdateButton client={client} />
    ));
    bridge.invoke["update:download"].mockRejectedValue(new Error("refused"));

    fireEvent.click(screen.getByRole("button", { name: "Güncelle 1.5.0" }));
    fireEvent.click(screen.getByRole("button", { name: "Güncelle 1.5.0" }));
    await waitFor(() => {
      expect(bridge.invoke["update:download"]).toHaveBeenCalledTimes(2);
    });

    expect(screen.getByRole("button", { name: "Güncelle 1.5.0" })).toBeTruthy();
  });

  test("should take a class, a size and other words", async () => {
    const { container, publish } = await mount(AVAILABLE, (client) => (
      <UpdateButton
        client={client}
        className="title-bar__update"
        size={UISize.MEDIUM}
        labels={{ update: (version) => `v${version} hazır` }}
      />
    ));

    expect(screen.getByRole("button", { name: "v1.5.0 hazır" })).toBeTruthy();
    expect(container.querySelector(".hdu-update")?.className).toBe(
      "hdu-update title-bar__update"
    );

    publish(DOWNLOADING);
    expect(
      container
        .querySelector(".hdu-update__progress")
        ?.getAttribute("data-size")
    ).toBe(UISize.MEDIUM);
    // What was not replaced stays Turkish.
    expect(
      screen.getByRole("progressbar", { name: "Güncelleme indiriliyor" })
    ).toBeTruthy();
  });

  test("should keep one connection to main in StrictMode, and close it on unmount", async () => {
    const { bridge, unmount } = await mount(AVAILABLE, (client) => (
      <StrictMode>
        <UpdateButton client={client} />
      </StrictMode>
    ));

    expect(bridge.listenerCount()).toBe(1);
    expect(screen.getAllByRole("button")).toHaveLength(1);
    unmount();
    expect(bridge.listenerCount()).toBe(0);
  });
});

describe("UpdateButton on a settings page", () => {
  test("should offer a check while idle", async () => {
    const { bridge, container } = await mount(
      stateOf({ status: "idle" }),
      (client) => <UpdateButton client={client} isAlwaysVisible />
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Güncellemeleri denetle" })
    );

    expect(bridge.invoke["update:check"]).toHaveBeenCalledTimes(1);
    expect(
      container.querySelector(".hdu-update")?.getAttribute("data-status")
    ).toBe("idle");
  });

  test("should offer a check outside Electron too, and survive the click", async () => {
    const { container } = render(
      <UpdateButton client={createUpdateClient()} isAlwaysVisible />
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Güncellemeleri denetle" })
    );
    await Promise.resolve();

    expect(
      container.querySelector(".hdu-update")?.getAttribute("data-status")
    ).toBe("unknown");
  });

  test("should say that it is checking, and take no click meanwhile", async () => {
    await mount(stateOf({ status: "checking" }), (client) => (
      <UpdateButton client={client} isAlwaysVisible />
    ));

    const button = screen.getByRole("button", { name: "Denetleniyor…" });

    expect(button.hasAttribute("disabled")).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
  });

  test("should say that the program is up to date, and still offer a check", async () => {
    const { bridge } = await mount(
      stateOf({ status: "not-available" }),
      (client) => <UpdateButton client={client} isAlwaysVisible />
    );

    expect(screen.getByText("Program güncel")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Güncellemeleri denetle" })
    );
    expect(bridge.invoke["update:check"]).toHaveBeenCalledTimes(1);
  });

  test("should say what the bar is while downloading", async () => {
    await mount(DOWNLOADING, (client) => (
      <UpdateButton client={client} isAlwaysVisible />
    ));

    const words = screen.getByText("Güncelleme indiriliyor");
    const bar = screen.getByRole("progressbar");
    // The words come first, so that what can be pressed stays at the end of the row.
    expect(
      words.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  test("should say that this build cannot update itself, without a button", async () => {
    await mount(
      stateOf({ status: "unsupported", reason: "development" }),
      (client) => <UpdateButton client={client} isAlwaysVisible />
    );

    expect(screen.getByText("Bu kurulum kendini güncelleyemiyor")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  test("should write the reason of a failure next to the retry button", async () => {
    await mount(OFFLINE, (client) => (
      <UpdateButton client={client} isAlwaysVisible />
    ));

    const retry = screen.getByRole("button", { name: "Yeniden dene" });
    // Once visible, once in the live region.
    const texts = screen.getAllByText("İnternet bağlantısı yok.");
    expect(texts).toHaveLength(2);
    expect(texts.at(1)?.getAttribute("role")).toBe("status");
    expect(
      (texts.at(0) as HTMLElement).compareDocumentPosition(retry) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });
});
