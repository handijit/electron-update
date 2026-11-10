import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const source = (path: string): string =>
  fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    // The entries import each other by their published names; the tests measure the sources.
    alias: {
      "@handijit/electron-update/renderer": source("./lib/renderer.ts"),
      "@handijit/electron-update/react": source("./lib/react.ts"),
    },
  },
  test: {
    // main, preload and the shared code run in node with `electron` mocked; the renderer,
    // the hook and the components run in a real DOM.
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["__tests__/**/*.test.ts"],
          exclude: ["__tests__/**/*.dom.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "jsdom",
          environment: "jsdom",
          include: ["__tests__/**/*.dom.test.{ts,tsx}"],
        },
      },
    ],
    restoreMocks: true,
    unstubGlobals: true,
    unstubEnvs: true,
    setupFiles: ["./vitest.setup.ts"],
    coverage: {
      provider: "v8",
      include: ["lib/**/*.{ts,tsx}"],
      // Type-only files have no behaviour; the logic-free barrels are measured by index.test.ts.
      exclude: [
        "lib/index.ts",
        "lib/main.ts",
        "lib/preload.ts",
        "lib/renderer.ts",
        "lib/react.ts",
        "lib/ui.ts",
        "lib/types/**",
      ],
      thresholds: { 100: true },
    },
  },
});
