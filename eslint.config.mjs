import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import prettier from "eslint-config-prettier/flat";
import tseslint from "typescript-eslint";

// The layer rule of the package: which entry may import what.
const NODE_AND_ELECTRON = [
  { group: ["node:*"], message: "This layer must run without Node." },
  { regex: "^electron$", message: "This layer must run without Electron." },
];
const NO_SCHEMAS = { group: ["zod"], message: "Schemas stay in main." };
const OTHER_LAYERS = (layers) => ({
  group: layers.map((layer) => `**/${layer}/**`),
  message:
    "A layer imports only itself, shared/ and types/; another entry is imported by its published name.",
});
const restrict = (patterns) => ({
  "no-restricted-imports": ["error", { patterns }],
});

export default defineConfig([
  globalIgnores(["build/**", "coverage/**", "e2e/out/**"]),
  {
    files: ["**/*.ts", "**/*.mts", "**/*.tsx"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "no-console": "error",
    },
  },
  {
    // The public contract must not be a side effect of type inference.
    files: ["lib/**/*.ts", "lib/**/*.tsx"],
    rules: { "@typescript-eslint/explicit-module-boundary-types": "error" },
  },
  {
    // Pure: loaded by main, preload and renderer alike. Zod is allowed as a type only.
    files: ["lib/index.ts", "lib/shared/**/*.ts", "lib/types/**/*.ts"],
    rules: restrict([
      ...NODE_AND_ELECTRON,
      OTHER_LAYERS(["main", "preload", "renderer", "react", "ui"]),
      {
        group: ["zod"],
        allowTypeImports: true,
        message: "The shared entry carries no Zod at run time.",
      },
    ]),
  },
  {
    // A sandboxed preload can require `electron` and nothing else; this one needs nothing.
    files: ["lib/preload.ts", "lib/preload/**/*.ts"],
    rules: restrict([
      ...NODE_AND_ELECTRON,
      NO_SCHEMAS,
      OTHER_LAYERS(["main", "renderer", "react", "ui"]),
    ]),
  },
  {
    // A web page: no Node, no Electron, no schemas.
    files: ["lib/renderer.ts", "lib/renderer/**/*.ts"],
    rules: restrict([
      ...NODE_AND_ELECTRON,
      NO_SCHEMAS,
      OTHER_LAYERS(["main", "preload", "react", "ui"]),
    ]),
  },
  {
    // The hook: a web page with React, and still no component library.
    files: ["lib/react.ts", "lib/react/**/*.ts"],
    rules: restrict([
      ...NODE_AND_ELECTRON,
      NO_SCHEMAS,
      OTHER_LAYERS(["main", "preload", "renderer", "ui"]),
      { group: ["@handijit/ui"], message: "The hook entry stays UI-free." },
    ]),
  },
  {
    // The components: a web page with React and @handijit/ui.
    files: ["lib/ui.ts", "lib/ui/**/*.ts", "lib/ui/**/*.tsx"],
    rules: restrict([
      ...NODE_AND_ELECTRON,
      NO_SCHEMAS,
      OTHER_LAYERS(["main", "preload", "renderer", "react"]),
    ]),
  },
  {
    files: ["lib/main.ts", "lib/main/**/*.ts"],
    rules: restrict([OTHER_LAYERS(["preload", "renderer", "react", "ui"])]),
  },
  {
    // Build and release tooling and the Electron fixtures: plain scripts that report on the console.
    files: ["**/*.mjs", "**/*.cjs", "**/*.js"],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: {
        Buffer: "readonly",
        console: "readonly",
        process: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        URL: "readonly",
        require: "readonly",
        module: "readonly",
        __dirname: "readonly",
        window: "readonly",
        document: "readonly",
        location: "readonly",
        fetch: "readonly",
        requestAnimationFrame: "readonly",
      },
    },
  },
  prettier,
]);
