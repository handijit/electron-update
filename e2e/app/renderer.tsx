// The page of the fixture program: a title bar with the update button, a settings row with
// the same button in its always-visible form, and the gate around all of it. Main drives it
// through executeJavaScript and reads the answers; every function returns plain data.
import "@handijit/design/fonts.css";
import "@handijit/design/tokens.css";
import "@handijit/ui/styles.css";
import "@handijit/electron-update/styles.css";

import { useUpdate } from "@handijit/electron-update/react";
import { updateClient } from "@handijit/electron-update/renderer";
import { UpdateButton, UpdateGate } from "@handijit/electron-update/ui";
import { StrictMode } from "react";
import type { ReactElement } from "react";
import { createRoot } from "react-dom/client";

type Bridge = {
  invoke: Record<string, unknown>;
  on: Record<string, unknown>;
};
type Action = "check" | "download" | "install" | "refresh";

const Status = (): ReactElement => {
  const { state } = useUpdate();
  return (
    <output id="hook">
      {state === null ? "none" : `${state.status}/${state.policy.verdict}`}
    </output>
  );
};

const App = (): ReactElement => (
  <UpdateGate productName="Demo">
    <header id="title-bar">
      <span>Demo</span>
      <UpdateButton />
    </header>
    <main>
      <section id="settings">
        <h2>Güncelleme</h2>
        <UpdateButton isAlwaysVisible />
      </section>
      <button type="button" id="work">
        Fatura kes
      </button>
      <Status />
    </main>
  </UpdateGate>
);

const textOf = (selector: string): string =>
  document.querySelector<HTMLElement>(selector)?.innerText.trim() ?? "";
// What a person can press: not behind the gate, not disabled.
const usableButtons = (): HTMLButtonElement[] =>
  [...document.querySelectorAll("button")].filter(
    (button) => button.closest("[inert]") === null && !button.disabled
  );
const statusOf = (state: { status: string } | null): string | null =>
  state?.status ?? null;

const smoke = {
  bridge: () => {
    const { desktop } = globalThis as unknown as { desktop: Bridge };
    return {
      invoke: Object.keys(desktop.invoke).sort(),
      on: Object.keys(desktop.on).sort(),
    };
  },
  state: () => updateClient.getState(),
  titleBar: () => textOf("#title-bar"),
  settings: () => textOf("#settings"),
  hook: () => textOf("#hook"),
  buttons: () => usableButtons().map((button) => button.innerText.trim()),
  click: (label: string): boolean => {
    const button = usableButtons().find(
      (candidate) => candidate.innerText.trim() === label
    );
    button?.click();
    return button !== undefined;
  },
  progress: () =>
    [...document.querySelectorAll('[role="progressbar"]')]
      .filter((bar) => bar.closest("[inert]") === null)
      .map((bar) => ({
        label: bar.getAttribute("aria-label"),
        now: bar.getAttribute("aria-valuenow"),
        text: bar.getAttribute("aria-valuetext"),
      })),
  gate: () => {
    const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]');
    if (dialog === null) return null;
    return {
      title: dialog.querySelector("h1")?.innerText ?? "",
      text: dialog.innerText,
      isProgramInert:
        document.querySelector(".hdu-gate__content")?.hasAttribute("inert") ===
        true,
      isFocusInside: dialog.contains(document.activeElement),
      focused: (document.activeElement as HTMLElement | null)?.innerText ?? "",
    };
  },
  // Calls an action of the client several times at once, the way a double click does.
  burst: (action: Action, times: number) =>
    Promise.all(
      Array.from({ length: times }, () => updateClient[action]())
    ).then(
      (states) => states.map(statusOf),
      (error: unknown) => `rejected: ${String(error)}`
    ),
};

Object.assign(globalThis, { __smoke: smoke });

createRoot(document.querySelector("#root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>
);
