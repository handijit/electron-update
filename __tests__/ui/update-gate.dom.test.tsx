import { fireEvent, render, screen, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { MockInstance } from "vitest";

import createUpdateClient from "../../lib/renderer/create-update-client";
import type { UpdateActivity, UpdateContext } from "../../lib/types";
import UpdateGate from "../../lib/ui/update-gate";
import {
  PROGRESS,
  REQUIRED,
  stateOf,
  UPDATE,
} from "../shared/update-state.fixture";
import mount from "./render.fixture";

const required = <A extends UpdateActivity>(
  activity: A,
  isInstallPending = false
): A & UpdateContext => stateOf(activity, { ...REQUIRED, isInstallPending });

const AVAILABLE = required({ status: "available", update: UPDATE });
const DOWNLOADING = required({
  status: "downloading",
  update: UPDATE,
  progress: PROGRESS,
});
const DOWNLOADED = required({ status: "downloaded", update: UPDATE });
const FAILED = required({
  status: "error",
  error: { code: "OFFLINE", message: "İnternet bağlantısı yok." },
  update: null,
});

const Program = (): React.ReactElement => (
  <main>
    <label>
      Müşteri adı
      <input defaultValue="" />
    </label>
  </main>
);

const gate = (): HTMLElement =>
  screen.getByRole("alertdialog", { name: "Güncelleme gerekli" });

/** The version rows of the gate as `label: value` lines. */
const versions = (): string[] =>
  [...gate().querySelectorAll("dl > div")].map(
    (row) =>
      `${row.querySelector("dt")?.textContent ?? ""}: ${row.querySelector("dd")?.textContent ?? ""}`
  );

const note = (): string =>
  gate().querySelector(".hdu-gate__note")?.textContent ?? "";

let complaints: MockInstance;

beforeEach(() => {
  complaints = vi.spyOn(console, "error");
});

afterEach(() => {
  // React and @handijit/ui report misuse on the console: none is expected.
  expect(complaints).not.toHaveBeenCalled();
});

describe("UpdateGate while the version is supported", () => {
  test.each([
    ["nothing is known yet", stateOf({ status: "idle" })],
    [
      "an update is merely recommended",
      stateOf({ status: "available", update: UPDATE }),
    ],
  ])("should show only the program while %s", async (_name, state) => {
    const { container } = await mount(state, (client) => (
      <UpdateGate client={client} productName="Ön Muhasebe">
        <Program />
      </UpdateGate>
    ));

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Müşteri adı" })).toBeTruthy();
    expect(
      container.querySelector(".hdu-gate__content")?.hasAttribute("inert")
    ).toBe(false);
  });

  test("should show only the program outside Electron", () => {
    render(
      <UpdateGate client={createUpdateClient()} productName="Ön Muhasebe">
        <Program />
      </UpdateGate>
    );

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Müşteri adı" })).toBeTruthy();
  });
});

describe("UpdateGate while an update is required", () => {
  test("should cover the program, say why, and offer exactly one way on", async () => {
    const { bridge, container } = await mount(AVAILABLE, (client) => (
      <UpdateGate client={client} productName="Ön Muhasebe">
        <Program />
      </UpdateGate>
    ));

    const dialog = gate();
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(
      document.getElementById(dialog.getAttribute("aria-describedby") ?? "")
        ?.textContent
    ).toBe(
      "Ön Muhasebe programının kurulu sürümü artık desteklenmiyor. Kullanmaya devam etmek için programı güncelleyin."
    );
    expect(versions()).toEqual(["Kurulu sürüm: 1.4.0", "Yeni sürüm: 1.5.0"]);
    expect(note()).toBe("İndirme boyutu 80,3 MB.");
    expect(
      container.querySelector(".hdu-gate")?.getAttribute("data-status")
    ).toBe("available");

    const buttons = within(dialog).getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual([
      "Şimdi güncelle",
    ]);
    expect(document.activeElement).toBe(buttons[0]);

    fireEvent.click(buttons[0] as HTMLElement);
    expect(bridge.invoke["update:install"]).toHaveBeenCalledTimes(1);
    expect(bridge.invoke["update:download"]).not.toHaveBeenCalled();
  });

  test("should keep the program mounted behind it, out of reach", async () => {
    const { container, publish } = await mount(
      stateOf({ status: "idle" }),
      (client) => (
        <UpdateGate client={client} productName="Ön Muhasebe">
          <Program />
        </UpdateGate>
      )
    );
    const field = screen.getByRole<HTMLInputElement>("textbox");
    fireEvent.change(field, { target: { value: "Yıldız Ticaret" } });

    publish(AVAILABLE);

    const content = container.querySelector(".hdu-gate__content");
    expect(content?.hasAttribute("inert")).toBe(true);
    expect(content?.contains(field)).toBe(true);
    expect(field.value).toBe("Yıldız Ticaret");
    expect(content?.contains(gate())).toBe(false);

    // The policy was raised by mistake and lowered again: the program is back, untouched.
    publish(stateOf({ status: "available", update: UPDATE }));

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(content?.hasAttribute("inert")).toBe(false);
    expect(screen.getByRole<HTMLInputElement>("textbox").value).toBe(
      "Yıldız Ticaret"
    );
  });

  test("should say nothing about the size when the feed does not know it", async () => {
    await mount(
      required({
        status: "available",
        update: { ...UPDATE, sizeBytes: null },
      }),
      (client) => <UpdateGate client={client} productName="Ön Muhasebe" />
    );

    expect(note()).toBe("");
  });

  test("should be busy once the update was asked for, until the download starts", async () => {
    const { bridge } = await mount(
      required({ status: "available", update: UPDATE }, true),
      (client) => <UpdateGate client={client} productName="Ön Muhasebe" />
    );

    const button = within(gate()).getByRole("button", {
      name: "Şimdi güncelle",
    });
    fireEvent.click(button);

    expect(button.hasAttribute("disabled")).toBe(true);
    expect(bridge.invoke["update:install"]).not.toHaveBeenCalled();
  });

  test("should show that it is looking for the new version", async () => {
    await mount(required({ status: "checking" }), (client) => (
      <UpdateGate client={client} productName="Ön Muhasebe" />
    ));

    const bar = within(gate()).getByRole("progressbar", {
      name: "Yeni sürüm aranıyor…",
    });
    expect(bar.hasAttribute("aria-valuenow")).toBe(false);
    expect(note()).toBe("Yeni sürüm aranıyor…");
    expect(within(gate()).queryByRole("button")).toBeNull();
    // Nothing can be done: the gate itself holds the focus.
    expect(document.activeElement).toBe(gate());
    // The policy names the version before the feed does.
    expect(versions()).toEqual(["Kurulu sürüm: 1.4.0", "Yeni sürüm: 1.5.0"]);
  });

  test("should show the download with its size and speed, and say that the restart follows", async () => {
    const { publish } = await mount(
      { ...DOWNLOADING, isInstallPending: true },
      (client) => <UpdateGate client={client} productName="Ön Muhasebe" />
    );

    const bar = within(gate()).getByRole("progressbar", {
      name: "Güncelleme indiriliyor",
    });
    expect(bar.getAttribute("aria-valuenow")).toBe("50");
    expect(bar.getAttribute("aria-valuetext")).toBe("%50");
    expect(note()).toBe(
      "Güncelleme indiriliyor. İndirme bitince program kendiliğinden yeniden başlayacak."
    );
    const meter = gate().querySelector(".hdu-gate__meter");
    expect(meter?.textContent).toBe("40,1 MB / 80,3 MB · 1,1 MB/sn");
    expect(meter?.getAttribute("aria-hidden")).toBe("true");
    expect(within(gate()).queryByRole("button")).toBeNull();

    // A download someone else started (the button, auto-download) promises no restart.
    publish(DOWNLOADING);
    expect(note()).toBe("Güncelleme indiriliyor");
  });

  test("should leave out what the download does not know yet", async () => {
    const { publish } = await mount(
      required({
        status: "downloading",
        update: UPDATE,
        progress: {
          percent: 0,
          transferredBytes: 300 * 1024,
          totalBytes: 0,
          bytesPerSecond: 0,
        },
      }),
      (client) => <UpdateGate client={client} productName="Ön Muhasebe" />
    );
    const meter = (): string =>
      gate().querySelector(".hdu-gate__meter")?.textContent ?? "";

    expect(meter()).toBe("300 KB");

    publish(
      required({
        status: "downloading",
        update: UPDATE,
        progress: { ...PROGRESS, bytesPerSecond: 0 },
      })
    );
    expect(meter()).toBe("40,1 MB / 80,3 MB");
  });

  test("should offer the restart once the update is downloaded", async () => {
    const { bridge, publish } = await mount(DOWNLOADED, (client) => (
      <UpdateGate client={client} productName="Ön Muhasebe" />
    ));

    const button = within(gate()).getByRole("button", {
      name: "Yeniden başlat ve güncelle",
    });
    expect(document.activeElement).toBe(button);
    expect(note()).toBe(
      "1.5.0 sürümü indirildi. Kurmak için programı yeniden başlatın."
    );
    fireEvent.click(button);
    expect(bridge.invoke["update:install"]).toHaveBeenCalledTimes(1);

    publish({ ...DOWNLOADED, isInstallPending: true });

    // The program is quitting: nothing is left to press, and the focus is not left behind.
    expect(within(gate()).queryByRole("button")).toBeNull();
    expect(note()).toBe("Yeniden başlatılıyor…");
    expect(
      within(gate())
        .getByRole("progressbar", { name: "Yeniden başlatılıyor…" })
        .hasAttribute("aria-valuenow")
    ).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole("alertdialog"));
  });

  test("should show a failure with a retry and the way around it", async () => {
    const { bridge } = await mount(FAILED, (client) => (
      <UpdateGate client={client} productName="Ön Muhasebe" />
    ));

    const alert = within(gate()).getByRole("alert");
    expect(alert.textContent).toBe("Güncellenemediİnternet bağlantısı yok.");
    const retry = within(gate()).getByRole("button", { name: "Yeniden dene" });
    expect(document.activeElement).toBe(retry);
    expect(note()).toBe("");
    // No update is known: the policy still names the version.
    expect(versions()).toEqual(["Kurulu sürüm: 1.4.0", "Yeni sürüm: 1.5.0"]);

    fireEvent.click(retry);
    fireEvent.click(
      within(gate()).getByRole("button", { name: "Yeni sürümü indir" })
    );

    // While required, "install" is the one action: main checks or downloads as needed.
    expect(bridge.invoke["update:install"]).toHaveBeenCalledTimes(1);
    expect(bridge.invoke["update:open-download-page"]).toHaveBeenCalledTimes(1);
  });

  test("should send a build that cannot update itself to the download page", async () => {
    const { bridge } = await mount(
      required({ status: "unsupported", reason: "unsigned" }),
      (client) => <UpdateGate client={client} productName="Ön Muhasebe" />
    );

    const buttons = within(gate()).getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual([
      "Yeni sürümü indir",
    ]);
    expect(document.activeElement).toBe(buttons[0]);
    expect(note()).toBe(
      "Bu kurulum kendini güncelleyemiyor. Yeni sürümü indirip kurun; verileriniz yerinde kalır."
    );

    fireEvent.click(buttons[0] as HTMLElement);
    expect(bridge.invoke["update:open-download-page"]).toHaveBeenCalledTimes(1);
  });

  test.each<[string, UpdateActivity]>([
    ["has not answered yet", { status: "idle" }],
    ["has nothing newer yet", { status: "not-available" }],
  ])(
    "should explain the wait and offer both ways while the feed %s",
    async (_name, activity) => {
      const { bridge } = await mount(required(activity), (client) => (
        <UpdateGate client={client} productName="Ön Muhasebe" />
      ));

      expect(note()).toMatch(/^Yeni sürüm bu bilgisayara henüz ulaşmadı\./);
      const retry = within(gate()).getByRole("button", {
        name: "Yeniden dene",
      });
      expect(document.activeElement).toBe(retry);

      fireEvent.click(retry);
      fireEvent.click(
        within(gate()).getByRole("button", { name: "Yeni sürümü indir" })
      );

      expect(bridge.invoke["update:check"]).toHaveBeenCalledTimes(1);
      expect(bridge.invoke["update:open-download-page"]).toHaveBeenCalledTimes(
        1
      );
    }
  );

  test("should leave the new version out when nobody named it", async () => {
    await mount(
      stateOf(
        { status: "unsupported", reason: "platform" },
        {
          policy: {
            verdict: "required",
            latestVersion: null,
            minSupportedVersion: "1.4.5",
            checkedAt: null,
          },
        }
      ),
      (client) => <UpdateGate client={client} productName="Ön Muhasebe" />
    );

    expect(versions()).toEqual(["Kurulu sürüm: 1.4.0"]);
  });

  test("should name the version the feed offers, not the one the policy knows", async () => {
    await mount(
      required({
        status: "available",
        update: { ...UPDATE, version: "1.5.1" },
      }),
      (client) => <UpdateGate client={client} productName="Ön Muhasebe" />
    );

    expect(versions()).toEqual(["Kurulu sürüm: 1.4.0", "Yeni sürüm: 1.5.1"]);
  });

  test("should move the focus to whatever can be done next", async () => {
    const { publish } = await mount(AVAILABLE, (client) => (
      <UpdateGate client={client} productName="Ön Muhasebe" />
    ));
    expect(document.activeElement?.textContent).toBe("Şimdi güncelle");

    publish(DOWNLOADING);
    expect(document.activeElement).toBe(gate());

    publish({ ...DOWNLOADING, progress: { ...PROGRESS, percent: 80 } });
    expect(document.activeElement).toBe(gate());

    publish(DOWNLOADED);
    expect(document.activeElement?.textContent).toBe(
      "Yeniden başlat ve güncelle"
    );
  });

  test("should swallow a click main refuses", async () => {
    const { bridge } = await mount(AVAILABLE, (client) => (
      <UpdateGate client={client} productName="Ön Muhasebe" />
    ));
    bridge.invoke["update:install"].mockRejectedValue(new Error("refused"));

    fireEvent.click(
      within(gate()).getByRole("button", { name: "Şimdi güncelle" })
    );
    await Promise.resolve();

    expect(gate()).toBeTruthy();
  });

  test("should give a frameless window its controls back, above the gate", async () => {
    const { container } = await mount(AVAILABLE, (client) => (
      <UpdateGate
        client={client}
        productName="Ön Muhasebe"
        titleBar={<button type="button">Pencereyi kapat</button>}
      />
    ));

    expect(
      within(
        container.querySelector(".hdu-gate__bar") as HTMLElement
      ).getByRole("button", { name: "Pencereyi kapat" })
    ).toBeTruthy();
    // The gate's own action keeps the focus.
    expect(document.activeElement?.textContent).toBe("Şimdi güncelle");
  });

  test("should have no bar without window controls", async () => {
    const { container } = await mount(AVAILABLE, (client) => (
      <UpdateGate client={client} productName="Ön Muhasebe" />
    ));

    expect(container.querySelector(".hdu-gate__bar")).toBeNull();
  });

  test("should take other words", async () => {
    await mount(AVAILABLE, (client) => (
      <UpdateGate
        client={client}
        productName="Stok"
        labels={{
          gateTitle: "Sürüm eskidi",
          gateBody: (name) => `${name} güncellenmeli.`,
        }}
      />
    ));

    const dialog = screen.getByRole("alertdialog", { name: "Sürüm eskidi" });
    expect(within(dialog).getByText("Stok güncellenmeli.")).toBeTruthy();
    expect(
      within(dialog).getByRole("button", { name: "Şimdi güncelle" })
    ).toBeTruthy();
  });

  test("should work in StrictMode: one gate, one connection, closed on unmount", async () => {
    const { bridge, unmount } = await mount(AVAILABLE, (client) => (
      <StrictMode>
        <UpdateGate client={client} productName="Ön Muhasebe">
          <Program />
        </UpdateGate>
      </StrictMode>
    ));

    expect(screen.getAllByRole("alertdialog")).toHaveLength(1);
    expect(bridge.listenerCount()).toBe(1);
    expect(document.activeElement?.textContent).toBe("Şimdi güncelle");
    unmount();
    expect(bridge.listenerCount()).toBe(0);
  });
});
