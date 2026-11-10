// The page the screenshots are taken of: every state of the update button, in a title bar
// and in a settings row, and every status of the required-update gate. The scene and the
// theme come from the address: index.html?<scene>/<theme>.
import "@handijit/design/fonts.css";
import "@handijit/design/tokens.css";
import "@handijit/ui/styles.css";
import "@handijit/electron-update/styles.css";
import "./page.css";

import type { UpdateState } from "@handijit/electron-update";
import type { UpdateClient } from "@handijit/electron-update/renderer";
import { UpdateButton, UpdateGate } from "@handijit/electron-update/ui";
import type { ReactElement } from "react";
import { createRoot } from "react-dom/client";

const CONTEXT = {
  revision: 3,
  currentVersion: "1.4.0",
  policy: {
    verdict: "recommended",
    latestVersion: "1.5.0",
    minSupportedVersion: null,
    checkedAt: 1_800_000_000_000,
  },
  checkedAt: 1_800_000_000_000,
  isInstallPending: false,
} as const;

const REQUIRED = {
  ...CONTEXT,
  policy: {
    ...CONTEXT.policy,
    verdict: "required",
    minSupportedVersion: "1.4.5",
  },
} as const;

const UPDATE = {
  version: "1.5.0",
  releaseDate: "2026-11-09T10:00:00.000Z",
  releaseNotes: "E-fatura eklendi.",
  sizeBytes: 84_200_000,
};

const progress = (percent: number) => ({
  percent,
  transferredBytes: Math.round(842_000 * percent),
  totalBytes: 84_200_000,
  bytesPerSecond: percent === 0 ? 0 : 1_240_000,
});

const OFFLINE = {
  code: "OFFLINE",
  message:
    "İnternet bağlantısı kurulamadı. Bağlantınızı denetleyip yeniden deneyin.",
} as const;
const CHECKSUM = {
  code: "CHECKSUM",
  message: "İndirilen dosya doğrulanamadı. Yeniden indirmeyi deneyin.",
} as const;

// One line per state the button can be in, in the order a customer meets them.
const BUTTON_STATES: readonly (readonly [string, UpdateState])[] = [
  ["idle", { status: "idle", ...CONTEXT }],
  ["checking", { status: "checking", ...CONTEXT }],
  ["not-available", { status: "not-available", ...CONTEXT }],
  ["available", { status: "available", update: UPDATE, ...CONTEXT }],
  [
    "downloading 0 %",
    {
      status: "downloading",
      update: UPDATE,
      progress: progress(0),
      ...CONTEXT,
    },
  ],
  [
    "downloading 42 %",
    {
      status: "downloading",
      update: UPDATE,
      progress: progress(42),
      ...CONTEXT,
    },
  ],
  [
    "downloading 100 %",
    {
      status: "downloading",
      update: UPDATE,
      progress: progress(100),
      ...CONTEXT,
    },
  ],
  ["downloaded", { status: "downloaded", update: UPDATE, ...CONTEXT }],
  [
    "downloaded, restarting",
    {
      status: "downloaded",
      update: UPDATE,
      ...CONTEXT,
      isInstallPending: true,
    },
  ],
  [
    "error (check)",
    { status: "error", error: OFFLINE, update: null, ...CONTEXT },
  ],
  [
    "error (download)",
    { status: "error", error: CHECKSUM, update: UPDATE, ...CONTEXT },
  ],
  ["unsupported", { status: "unsupported", reason: "development", ...CONTEXT }],
];

const GATE_STATES: Readonly<Record<string, UpdateState>> = {
  checking: { status: "checking", ...REQUIRED },
  waiting: { status: "not-available", ...REQUIRED },
  available: { status: "available", update: UPDATE, ...REQUIRED },
  downloading: {
    status: "downloading",
    update: UPDATE,
    progress: progress(42),
    ...REQUIRED,
    isInstallPending: true,
  },
  downloaded: { status: "downloaded", update: UPDATE, ...REQUIRED },
  restarting: {
    status: "downloaded",
    update: UPDATE,
    ...REQUIRED,
    isInstallPending: true,
  },
  error: { status: "error", error: OFFLINE, update: null, ...REQUIRED },
  unsupported: { status: "unsupported", reason: "unsigned", ...REQUIRED },
};

// A client that always answers with one state: the components are drawn, not driven.
const clientOf = (state: UpdateState): UpdateClient => ({
  getState: () => state,
  subscribe: () => () => undefined,
  refresh: () => Promise.resolve(state),
  check: () => Promise.resolve(state),
  download: () => Promise.resolve(state),
  install: () => Promise.resolve(state),
  openDownloadPage: () => Promise.resolve(),
});

const WindowControls = (): ReactElement => (
  <span className="shot-controls" aria-hidden="true">
    <i />
    <i />
    <i />
  </span>
);

const TitleBar = ({ state }: { state?: UpdateState }): ReactElement => (
  <div className="shot-titlebar">
    <span className="shot-titlebar__name">Ön Muhasebe</span>
    <span className="shot-titlebar__end">
      {state === undefined ? null : <UpdateButton client={clientOf(state)} />}
      <WindowControls />
    </span>
  </div>
);

const Buttons = (): ReactElement => (
  <main className="shot-sheet">
    <div className="shot-row shot-row--head">
      <span>state</span>
      <span>title bar (default)</span>
      <span>settings page (isAlwaysVisible)</span>
    </div>
    {BUTTON_STATES.map(([name, state]) => (
      <div className="shot-row" key={name}>
        <code>{name}</code>
        <TitleBar state={state} />
        <div className="shot-setting">
          <span className="shot-setting__label">
            Güncellemeler
            <small>Kurulu sürüm {state.currentVersion}</small>
          </span>
          <UpdateButton client={clientOf(state)} isAlwaysVisible />
        </div>
      </div>
    ))}
  </main>
);

const Gate = ({ name }: { name: string }): ReactElement => {
  const state = GATE_STATES[name];
  if (state === undefined) throw new Error(`no gate scene called "${name}"`);
  return (
    <UpdateGate
      client={clientOf(state)}
      productName="Ön Muhasebe"
      titleBar={<TitleBar />}
    >
      <main className="shot-program">
        <h1>Faturalar</h1>
        <button type="button">Yeni fatura</button>
      </main>
    </UpdateGate>
  );
};

const [scene = "buttons", theme = "light"] = location.search
  .slice(1)
  .split("/");
document.documentElement.dataset["theme"] = theme;

const root = document.getElementById("root");
if (root === null) throw new Error("the page has no root");
createRoot(root).render(
  scene === "buttons" ? <Buttons /> : <Gate name={scene.replace("gate-", "")} />
);
