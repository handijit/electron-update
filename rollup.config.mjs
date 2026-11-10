import { copyFileSync, mkdirSync } from "node:fs";
import { builtinModules } from "node:module";

import typescript from "@rollup/plugin-typescript";
import { dts } from "rollup-plugin-dts";

// One entry per process context, and one per optional peer. Each is bundled on its own, so no
// entry shares a chunk with another: the renderer file can never pull in code that was written
// for main, and the hook entry never pulls in the component library.
const ENTRIES = ["index", "main", "preload", "renderer", "react", "ui"];

// Peer dependencies and Node built-ins stay imports. So do this package's own entries: `react`
// reaches the client through `@handijit/electron-update/renderer` and `ui` reaches the hook
// through `@handijit/electron-update/react`, so a page that uses all three still holds one
// client and one IPC subscription instead of a copy per entry.
const EXTERNAL = [
  "electron",
  "zod",
  "react",
  "react/jsx-runtime",
  "@handijit/core",
  "@handijit/core/errors",
  "@handijit/core/version",
  "@handijit/electron",
  "@handijit/electron/main",
  "@handijit/electron/renderer",
  "@handijit/electron-update/renderer",
  "@handijit/electron-update/react",
  "@handijit/ui",
  ...builtinModules.map((name) => `node:${name}`),
];

// TypeScript alone downlevels to the tsconfig target; no Babel anywhere.
const ts = () => typescript({ tsconfig: "./tsconfig.json" });

// The stylesheet of the `ui` entry is plain CSS over the design tokens: it is shipped as
// written, next to the bundles, and the JavaScript never imports it.
const STYLESHEET = "./lib/ui/styles.css";
const stylesheet = () => ({
  name: "copy-stylesheet",
  buildStart() {
    this.addWatchFile(STYLESHEET);
  },
  writeBundle() {
    mkdirSync("./build", { recursive: true });
    copyFileSync(STYLESHEET, "./build/styles.css");
  },
});

export default ENTRIES.flatMap((entry) => [
  {
    input: `./lib/${entry}.ts`,
    external: EXTERNAL,
    output: [
      { file: `./build/${entry}.mjs`, format: "es", sourcemap: true },
      {
        file: `./build/${entry}.cjs`,
        format: "cjs",
        exports: "named",
        sourcemap: true,
      },
    ],
    plugins: entry === "ui" ? [ts(), stylesheet()] : [ts()],
  },
  {
    // One bundled declaration, written twice: TypeScript reads the format of a declaration file
    // from its extension, so the ESM entry needs a .d.mts next to the CommonJS .d.ts.
    input: `./lib/${entry}.ts`,
    external: EXTERNAL,
    output: [
      { file: `./build/${entry}.d.ts`, format: "es" },
      { file: `./build/${entry}.d.mts`, format: "es" },
    ],
    plugins: [dts({ tsconfig: "./tsconfig.json" })],
  },
]);
