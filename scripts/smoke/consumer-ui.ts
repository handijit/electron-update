// The components, as a page uses them. Checked with the bundler resolution only: a page is
// always bundled, and the declarations of @handijit/ui 2.0.0 do not resolve under Node's
// ES module resolution (extensionless relative imports in a "type": "module" package).
import { createUpdateClient } from "@handijit/electron-update/renderer";
import {
  DEFAULT_UPDATE_LABELS,
  UpdateButton,
  UpdateGate,
  type UpdateButtonProps,
  type UpdateGateProps,
  type UpdateLabels,
} from "@handijit/electron-update/ui";
import { UISize } from "@handijit/ui";
import { createElement, type ReactElement } from "react";

const client = createUpdateClient();
const labels: UpdateLabels = { ...DEFAULT_UPDATE_LABELS, retry: "Tekrar dene" };
const buttonProps: UpdateButtonProps = {
  client,
  isAlwaysVisible: true,
  size: UISize.MEDIUM,
  labels: { check: "Denetle" },
};
const gateProps: UpdateGateProps = { productName: "Ön Muhasebe", labels };
const gate: ReactElement = createElement(
  UpdateGate,
  gateProps,
  createElement(UpdateButton, buttonProps)
);

// @ts-expect-error the gate needs the program's name
createElement(UpdateGate, {});
// @ts-expect-error a size that @handijit/ui does not have must not compile
const wrong: UpdateButtonProps = { size: "huge" };

export { gate, wrong };
